package com.latexsnipper.app.ocr;

import android.content.Context;
import android.graphics.Bitmap;
import android.util.Log;
import android.webkit.JavascriptInterface;

import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;

/**
 * NativeOcrBridge — exposes OCR engine to JavaScript via Android's @JavascriptInterface.
 * <p>
 * Heavy inference runs on a background thread pool. The JS side calls the method and
 * immediately returns a "pending" token, then polls getResult() for completion.
 * This prevents WebView thread blocking.
 */
public class NativeOcrBridge {

    private static final String TAG = "NativeOcrBridge";
    private static final long RECOGNITION_TIMEOUT_MS = 30000;

    private final OcrEngine ocrEngine;
    private final QuestionModifierEngine questionModifierEngine;
    private volatile ExecutorService executor = Executors.newFixedThreadPool(1);
    /** Separate from {@link #executor} so generation and OCR never block each other. */
    private volatile ExecutorService generationExecutor = Executors.newFixedThreadPool(1);
    private Context context;

    // Async result store: per-request registry (no shared single-slot state).
    private final AsyncOperationRegistry operations = new AsyncOperationRegistry();
    /** Keystore-backed API key storage; never holds plaintext at rest. */
    private final SecretStore secrets;
    /** Collaborators extracted from this class in P1-01; see each for its scope. */
    private final ModelFileWriter modelFileWriter;
    private final DownloadExporter downloadExporter;
    private final DownloadNotifier downloadNotifier;
    private final LogBuffer logs = new LogBuffer();

    public NativeOcrBridge(Context ctx) {
        this.context = ctx;
        this.ocrEngine = new OcrEngine();
        this.questionModifierEngine = new QuestionModifierEngine(ctx);
        this.secrets = new SecretStore(ctx);
        this.modelFileWriter = new ModelFileWriter(ctx);
        this.downloadExporter = new DownloadExporter(ctx);
        // Deliberately the raw ctx, not the application context: requesting the
        // notification permission needs an Activity.
        this.downloadNotifier = new DownloadNotifier(ctx);
    }

    public OcrEngine getEngine() { return ocrEngine; }

    private volatile boolean loadingStarted = false;

    private void addLog(String tag, String msg) {
        logs.append(tag, msg);
    }

    /**
     * Turns a native-initialisation failure into something the user can act on.
     *
     * A raw UnsatisfiedLinkError message names a .so path and says nothing about
     * why. The common cause on current devices is page size: some bundled
     * libraries are built with 4KB ELF segment alignment and cannot be mapped on
     * a 16KB-page device, so naming that explicitly saves a long diagnosis.
     */
    static String describeLoadFailure(Throwable e) {
        String message = e.getMessage() == null ? e.getClass().getSimpleName() : e.getMessage();
        if (e instanceof UnsatisfiedLinkError || e instanceof LinkageError) {
            return "NATIVE_LIBRARY_UNAVAILABLE: " + message
                + " (this device may use 16KB memory pages, which some bundled"
                + " libraries were not built for)";
        }
        return message;
    }

    /** JS calls this to push a log line from the JavaScript side into the native buffer */
    @JavascriptInterface
    public void addLog(String msg) {
        addLog("JS", msg);
    }

    /** JS calls this to retrieve accumulated native logs for export */
    @JavascriptInterface
    public String getLogs() {
        String logs = this.logs.drain();
        // Also append OcrEngine file log
        try {
            java.io.File logFile = new java.io.File(context.getFilesDir(), "ocr-debug.log");
            if (logFile.exists()) {
                java.io.BufferedReader br = new java.io.BufferedReader(new java.io.FileReader(logFile));
                StringBuilder sb = new StringBuilder();
                String line;
                while ((line = br.readLine()) != null) sb.append(line).append("\n");
                br.close();
                if (sb.length() > 0) logs += "\n\n=== OcrEngine Debug Log ===\n" + sb.toString();
                logFile.delete(); // Clear after reading
            }
        } catch (Exception e) { /* ignore */ }
        return logs;
    }

    @JavascriptInterface
    public boolean isReady() {
        return ocrEngine.isReady();
    }

    @JavascriptInterface
    public String getModelStatus() {
        try {
            org.json.JSONObject status = new org.json.JSONObject();
            status.put("formulaDet", ocrEngine.getRunner().isFormulaDetReady());
            status.put("formulaRec", ocrEngine.getRunner().isFormulaRecReady());
            status.put("textDet", ocrEngine.getRunner().isTextDetReady());
            status.put("textRec", ocrEngine.getRunner().isTextRecReady());
            status.put("docOri", ocrEngine.getRunner().isDocOriReady());
            return status.toString();
        } catch (Exception e) {
            return "{}";
        }
    }

    @JavascriptInterface
    public String loadModels() {
        if (ocrEngine.isReady()) return "ok";
        if (loadingStarted) return "loading";
        loadingStarted = true;

        new Thread(() -> {
            try {
                addLog("MODEL", "Loading models synchronously...");
                ocrEngine.loadAllModelsSync(context);
                addLog("MODEL", "All models loaded successfully");
                Log.d(TAG, "All models loaded");
            } catch (Throwable e) {
                // Throwable, not Exception. Loading models initialises ONNX
                // Runtime, and a native library that cannot be mapped raises
                // UnsatisfiedLinkError — an Error, which `catch (Exception)`
                // does not catch. Uncaught on a raw thread that kills the whole
                // process, so a device the libraries do not support would fail
                // to start rather than simply lose OCR.
                addLog("MODEL", "FAILED: " + describeLoadFailure(e));
                Log.e(TAG, "loadModels failed", e);
            }
        }, "model-loader").start();
        return "loading";
    }

    @JavascriptInterface
    public String reloadModels() {
        loadingStarted = true;
        new Thread(() -> {
            try {
                addLog("MODEL", "Reloading models...");
                ocrEngine.reloadModels(context);
                addLog("MODEL", "Models reloaded");
                Log.d(TAG, "Models reloaded");
            } catch (Throwable e) {
                // See loadModels: a native-load Error must not kill the process.
                addLog("MODEL", "Reload FAILED: " + describeLoadFailure(e));
                Log.e(TAG, "reloadModels failed", e);
            }
        }, "model-reloader").start();
        return "loading";
    }

    @JavascriptInterface
    public String getStatus() {
        if (ocrEngine.isReady()) return "ready";
        if (loadingStarted) return "loading";
        return "idle";
    }

    // ═══ Async recognition helpers ═══

    private interface Recognizer {
        String run(Bitmap bitmap) throws Exception;
    }

    private String launchAsync(String type, String base64Image, Recognizer rec) {
        operations.purgeExpired(System.currentTimeMillis());
        String key = operations.create("ocr-" + type);
        final String logKey = key;
        Log.d(TAG, "Starting " + type + " (key=" + logKey + ")");
        addLog("OCR", "Starting " + type + " recognition");
        inferenceExecutor().submit(() -> {
            Bitmap bitmap = null;
            try {
                long t0 = System.currentTimeMillis();
                ExifImageDecoder.Decoded decoded = ExifImageDecoder.decode(base64Image);
                bitmap = decoded.bitmap;
                boolean[] exifApplied = { decoded.exifApplied };
                addLog("OCR", type + " decode " + (System.currentTimeMillis()-t0) + "ms "
                    + bitmap.getWidth() + "x" + bitmap.getHeight());

                // Skip auto-orient: camera crop already handles rotation correctly.
                // Doc-orient model is unreliable for cropped regions and can rotate
                // correctly-oriented images to wrong orientation (e.g. landscape→portrait).
                if (exifApplied[0]) {
                    addLog("OCR", "EXIF already oriented: " + bitmap.getWidth() + "x" + bitmap.getHeight());
                }

                addLog("OCR", type + " starting inference, bitmap=" + bitmap.getWidth() + "x" + bitmap.getHeight());
                t0 = System.currentTimeMillis();
                String result = rec.run(bitmap);
                long elapsed = System.currentTimeMillis()-t0;
                addLog("OCR", type + " done " + elapsed + "ms, result length=" + (result != null ? result.length() : 0));
                // Log first 200 chars of result for debugging
                if (result != null && result.length() > 0) {
                    addLog("OCR", type + " result preview: " + result.substring(0, Math.min(200, result.length())));
                }
                operations.complete(key, result, null);
            } catch (Throwable e) {
                // Throwable so a native-load Error still COMPLETES the request.
                // Catching only Exception left the operation permanently
                // pending: the executor captures the Error in its Future, the
                // web layer polls an id that never resolves, and the user waits
                // out the whole timeout with no explanation.
                Log.e(TAG, type + " FAILED (key=" + logKey + ")", e);
                addLog("OCR", type + " FAILED: " + e.getClass().getSimpleName() + ": " + e.getMessage());
                operations.complete(key, JsonEscape.errorObject(describeLoadFailure(e)), "OCR_ERROR");
            } finally {
                // The bitmap was recycled only on the success path, so any failure
                // inside rec.run() leaked its native buffer — repeated failures
                // walked the app into an OOM.
                if (bitmap != null && !bitmap.isRecycled()) bitmap.recycle();
            }
        });
        return key;
    }

    @JavascriptInterface
    public String recognizeFormula(String base64Image) {
        return launchAsync("formula", base64Image, (bitmap) -> {
            OcrEngine.RecognizeResult result = ocrEngine.recognizeFormula(bitmap);
            return "{\"done\":true,\"latex\":\"" + JsonEscape.escape(result.text)
                + "\",\"confidence\":" + result.confidence
                + ",\"timeMs\":" + result.timeMs + "}";
        });
    }

    @JavascriptInterface
    public String recognizeText(String base64Image) {
        return launchAsync("text", base64Image, (bitmap) -> {
            OcrEngine.RecognizeResult result = ocrEngine.recognizeText(bitmap);
            return "{\"done\":true,\"text\":\"" + JsonEscape.escape(result.text)
                + "\",\"confidence\":" + result.confidence
                + ",\"timeMs\":" + result.timeMs + "}";
        });
    }

    @JavascriptInterface
    public String recognizeMixed(String base64Image) {
        return launchAsync("mixed", base64Image, (bitmap) -> {
            addLog("OCR", "mixed: calling ocrEngine.recognizeMixed, bitmap=" + bitmap.getWidth() + "x" + bitmap.getHeight());
            OcrEngine.MixedResult mixed = ocrEngine.recognizeMixed(bitmap);
            addLog("OCR", "mixed: regions=" + mixed.regions.size() + " confidence=" + mixed.confidence + " timeMs=" + mixed.timeMs);
            for (int i = 0; i < mixed.regions.size(); i++) {
                OcrEngine.MixedResult.RegionResult r = mixed.regions.get(i);
                addLog("OCR", "mixed region[" + i + "]: type=" + r.type + " text=" + (r.text != null ? r.text.substring(0, Math.min(50, r.text.length())) : "null") + " conf=" + r.confidence);
            }
            StringBuilder sb = new StringBuilder("{\"done\":true,\"text\":\"");
            sb.append(JsonEscape.escape(mixed.formattedText != null ? mixed.formattedText : ""));
            sb.append("\",\"regions\":[");
            for (int i = 0; i < mixed.regions.size(); i++) {
                if (i > 0) sb.append(",");
                OcrEngine.MixedResult.RegionResult r = mixed.regions.get(i);
                sb.append("{\"x\":").append(r.x)
                  .append(",\"y\":").append(r.y)
                  .append(",\"w\":").append(r.w)
                  .append(",\"h\":").append(r.h)
                  .append(",\"type\":\"").append(r.type)
                  .append("\",\"text\":\"").append(JsonEscape.escape(r.text))
                  .append("\",\"confidence\":").append(r.confidence)
                  .append("}");
            }
            sb.append("],\"confidence\":").append(mixed.confidence)
              .append(",\"timeMs\":").append(mixed.timeMs).append("}");
            return sb.toString();
        });
    }

    /**
     * JS polls this to get the result. Returns empty until the request with
     * exactly this id completes; the result is consumed on first read.
     * Polling never deletes a pending task.
     */
    @JavascriptInterface
    public String getResult(String key) {
        String r = operations.poll(key);
        return r != null ? r : "";
    }

    /** JS cancels a no-longer-wanted request (e.g. after its own timeout). */
    @JavascriptInterface
    public void cancelOperation(String key) {
        if (operations.cancel(key)) {
            addLog("QUESTION", "Cancelled operation " + key);
        }
    }

    @JavascriptInterface
    public String saveSettings(String json) {
        try {
            context.getSharedPreferences("LaTeXSnipperSettings", Context.MODE_PRIVATE)
                .edit().putString("settings_json", json).apply();
            return "ok";
        } catch (Exception e) {
            return "error:" + e.getMessage();
        }
    }

    @JavascriptInterface
    public String loadSettings() {
        try {
            return context.getSharedPreferences("LaTeXSnipperSettings", Context.MODE_PRIVATE)
                .getString("settings_json", "{}");
        } catch (Exception e) {
            return "{}";
        }
    }

    @JavascriptInterface
    public String getQuestionModifierStatus() {
        return questionModifierEngine.getStatus().toString();
    }

    @JavascriptInterface
    public String modifyQuestion(String requestJson) {
        operations.purgeExpired(System.currentTimeMillis());
        // The registry entry is created only once we know work will actually be
        // submitted. Creating it before this check leaked a pending slot on every
        // rejected call — nothing ever completed or cancelled it.
        org.json.JSONObject modifierStatus = questionModifierEngine.getStatus();
        if (!"READY".equals(modifierStatus.optString("status"))) {
            String reason = modifierStatus.optString("code", "QUESTION_MODEL_MISSING");
            addLog("QUESTION", "Rejected local modification: " + reason);
            try {
                org.json.JSONObject error = new org.json.JSONObject();
                error.put("status", "error");
                error.put("code", "NOT_CONFIGURED");
                error.put("reason", reason);
                error.put("message", modifierStatus.optString("message", "Local question modifier is unavailable"));
                return error.toString();
            } catch (Exception ignored) {
                return "{\"status\":\"error\",\"code\":\"NOT_CONFIGURED\",\"reason\":\"QUESTION_MODEL_MISSING\"}";
            }
        }
        String backend = modifierStatus.optString("backend", "unknown");
        String variant = modifierStatus.optString("variant", "unknown");
        addLog("QUESTION", "Starting local modification: backend=" + backend + ", variant=" + variant);
        final String key = operations.create("question");
        generationExecutor().submit(() -> {
            try {
                operations.complete(key, verifyGeneratedQuestion(requestJson, questionModifierEngine.generate(requestJson)), null);
            } catch (Throwable e) {
                Log.e(TAG, "question modification failed", e);
                operations.complete(key, "{\"status\":\"error\",\"code\":\"API_ERROR\",\"reason\":\"" + JsonEscape.escape(e.getMessage()) + "\"}", "API_ERROR");
            }
        });
        return "{\"status\":\"pending\",\"key\":\"" + key + "\",\"backend\":\"" +
            JsonEscape.escape(backend) + "\",\"variant\":\"" + JsonEscape.escape(variant) + "\"}";
    }

    /**
     * Runs the native AnswerConstraintVerifier on the generated question before
     * the result is stored (rectification P1-03). The JS layer only displays the
     * verdict; publishability is decided here, so calling the native interface
     * directly can never yield an unverified publishable result.
     */
    private String verifyGeneratedQuestion(String requestJson, String generatedJson) {
        try {
            org.json.JSONObject request = new org.json.JSONObject(requestJson);
            org.json.JSONObject result = new org.json.JSONObject(generatedJson);
            if (result.has("status") && "error".equals(result.optString("status"))) {
                return result.toString();
            }
            String answer = request.optString("answer", "");
            String question = result.optString("question", "");
            AnswerConstraintVerifier.Result verdict =
                AnswerConstraintVerifier.verify(question, answer);

            org.json.JSONObject verifier = new org.json.JSONObject();
            verifier.put("status", verdict.status);
            verifier.put("version", verdict.verifierVersion);
            verifier.put("questionType", verdict.questionType);
            verifier.put("method", verdict.method);
            verifier.put("detail", verdict.detail);
            verifier.put("normalizedAnswer", verdict.normalizedAnswer);
            result.put("verifier", verifier);
            // Only a verified answer (or no answer at all) is publishable.
            boolean publishable = AnswerConstraintVerifier.VERIFIED.equals(verdict.status)
                || AnswerConstraintVerifier.NOT_APPLICABLE.equals(verdict.status);
            result.put("publishable", publishable);
            addLog("QUESTION", "Verifier: " + verdict.status + " (" + verdict.method + ") publishable=" + publishable);
            return result.toString();
        } catch (Exception e) {
            Log.e(TAG, "verifier integration failed", e);
            return "{\"status\":\"error\",\"code\":\"VERIFIER_ERROR\",\"reason\":\""
                + JsonEscape.escape(e.getMessage()) + "\"}";
        }
    }

    // ── Keystore-backed secrets (API keys) ────────────────────────────────
    //
    // Keys are held encrypted under an Android Keystore key that never enters
    // this process. The web layer can store, use and delete a secret by id but
    // has no way to enumerate secret VALUES, so a compromised page cannot dump
    // every configured key at once.

    @JavascriptInterface
    public boolean putSecret(String id, String value) {
        boolean stored = secrets.put(id, value);
        addLog("SECRET", "put " + id + " -> " + (stored ? "ok" : "failed"));
        return stored;
    }

    @JavascriptInterface
    public String getSecret(String id) {
        String value = secrets.get(id);
        return value == null ? "" : value;
    }

    @JavascriptInterface
    public boolean hasSecret(String id) {
        return secrets.has(id);
    }

    @JavascriptInterface
    public void deleteSecret(String id) {
        secrets.remove(id);
        addLog("SECRET", "deleted " + id);
    }

    @JavascriptInterface
    public void setAcceleration(String mode) {
        ocrEngine.getRunner().setAccelerationMode(mode);
    }

    @JavascriptInterface
    public String getModelsDir() {
        return context.getFilesDir() + "/models";
    }

    @JavascriptInterface
    public String getInstalledModels() {
        ModelManager mm = new ModelManager(context);
        org.json.JSONObject result = new org.json.JSONObject();
        try {
            String[] categories = {"formula-det", "formula-rec", "text-det", "text-rec", "doc-ori", "question-modifier"};
            for (String cat : categories) {
                result.put(cat, new org.json.JSONArray(mm.listInstalled(cat)));
            }
        } catch (Exception e) {
            return "{}";
        }
        return result.toString();
    }

    @JavascriptInterface
    public String getActiveModels() {
        ModelManager mm = new ModelManager(context);
        org.json.JSONObject result = new org.json.JSONObject();
        try {
            String[] categories = {"formula-det", "formula-rec", "text-det", "text-rec", "doc-ori", "question-modifier"};
            for (String cat : categories) {
                String active = mm.getActiveVariant(cat);
                if (active != null) result.put(cat, active);
            }
        } catch (Exception e) {
            return "{}";
        }
        return result.toString();
    }

    @JavascriptInterface
    public String setActiveModel(String category, String variantId) {
        ModelManager mm = new ModelManager(context);
        mm.setActiveVariant(category, variantId);
        return "ok";
    }

    @JavascriptInterface
    public String deleteModel(String category, String variantId) {
        ModelManager mm = new ModelManager(context);
        boolean ok = mm.deleteVariant(category, variantId);
        if (ok) {
            // Release cached sessions so deleted model can't be used from memory
            ocrEngine.release();
        }
        return ok ? "ok" : "error:delete failed";
    }

    @JavascriptInterface
    public void release() {
        ocrEngine.release();
        // Drop every pending/completed entry so late completions are ignored,
        // then stop running tasks; executors are recreated lazily on next use.
        operations.clear();
        executor.shutdownNow();
        generationExecutor.shutdownNow();
        // An upload abandoned by a teardown would otherwise leak its descriptor.
        modelFileWriter.close();
    }

    private synchronized ExecutorService inferenceExecutor() {
        if (executor.isShutdown()) {
            executor = Executors.newFixedThreadPool(1);
        }
        return executor;
    }

    /**
     * Question generation runs on its own thread.
     *
     * It previously shared the single OCR thread, so one long local generation
     * blocked every recognition behind it and JS could hit its 60–180s timeout
     * purely from queueing rather than from real work. The two are independent
     * workloads and must not serialise against each other.
     */
    private synchronized ExecutorService generationExecutor() {
        if (generationExecutor.isShutdown()) {
            generationExecutor = Executors.newFixedThreadPool(1);
        }
        return generationExecutor;
    }

    // ══════════════════════════════════════════════════════════════════════
    // Delegating @JavascriptInterface surface.
    //
    // These must stay on this class: JS calls window.NativeOcr.<name>, so the
    // method set is the web layer's contract and cannot move. What DID move is
    // the implementation behind each one — this layer now only converts
    // parameters and orchestrates calls, which is what P1-01 asked for.
    // ══════════════════════════════════════════════════════════════════════

    // ── Chunked model file writing ────────────────────────────────────────

    @JavascriptInterface
    public String startModelWrite(String category, String variantId, String filename) {
        return modelFileWriter.begin(category, variantId, filename);
    }

    @JavascriptInterface
    public String writeModelChunk(String base64Chunk) {
        return modelFileWriter.writeChunk(base64Chunk);
    }

    @JavascriptInterface
    public String finishModelWrite() {
        return modelFileWriter.finish();
    }

    // ── File export ───────────────────────────────────────────────────────

    @JavascriptInterface
    public String saveFile(String base64Data, String filename) {
        DownloadExporter.Result result = downloadExporter.save(base64Data, filename);
        if (result.isOk()) {
            addLog("SAVE", "Saved: " + result.detail + " (" + result.bytes + " bytes)");
            return "ok";
        }
        return result.status;
    }

    // ── Notifications ─────────────────────────────────────────────────────

    @JavascriptInterface
    public void showNotification(String title, int progress, int max) {
        downloadNotifier.show(title, progress, max);
    }

    @JavascriptInterface
    public void hideNotification() {
        downloadNotifier.hide();
    }

    @JavascriptInterface
    public boolean requestNotificationPermission() {
        return downloadNotifier.requestPermission();
    }
}
