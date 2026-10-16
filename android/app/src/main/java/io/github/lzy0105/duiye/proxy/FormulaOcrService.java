package io.github.lzy0105.duiye.proxy;

import android.content.Context;
import android.content.res.AssetManager;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.os.SystemClock;
import android.util.Base64;
import android.util.Log;

import com.answermatcher.ocr.FormulaImagePreprocessor;
import com.answermatcher.ocr.ScratchFormulaRecognizer;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.FloatBuffer;
import java.util.Map;
import java.util.Properties;
import java.util.concurrent.CancellationException;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * 原生代理层的 ocr 那一位：自建公式模型（题目答案匹配引擎 ocr/，第十轮，带缓存的 INT8 包）。
 *
 * C++ 那边的 ocr 还是空位（NullService），这一位由 Java 接管：运行器 ScratchFormulaRecognizer 本来就是 Java
 * 写的，ONNX Runtime 也有现成的 Android 包，绕到 C++ 再回来只是多一层。NativeProxyPlugin 把 service 为
 * "ocr" 的请求截下来交到这里，describe 也由这里报；网页那一侧（src/ocr/ocr-native.js）看不出区别。
 *
 * 一次认一个印刷公式：圈里那一块整体当一个公式交给模型，回 ScratchFormulaRecognizer 原样的结果
 * （latex、endedWithEos、meanLogProbability、reasonCodes），网页那边认这种回法。
 *
 * 模型包随 APK 走（assets/ocr/formula），第一次用时拷到私有目录：运行器要按文件读、按文件核哈希。
 * 加载放在后台线程里预热，开机不卡；识别也都在同一条后台线程上排队，一次只跑一件。
 */
final class FormulaOcrService {

    static final String NAME = "ocr";

    private static final String TAG = "DuiyeOcr";
    private static final String ASSET_DIR = "ocr/formula";
    /** 除了编码器、解码器以外随包拷的文件；那两个的文件名从 model.properties 读（ORT 格式的包是 .ort）。 */
    private static final String[] BUNDLE_FILES = {"tokenizer.json", "model.properties", "metadata.json"};
    /** 推理线程数。这台平板八核，四条够了，剩下的留给翻页和写字。 */
    private static final int THREADS = 4;

    private final Context context;
    private final boolean packaged;
    private final String engine;
    private final ExecutorService worker = Executors.newSingleThreadExecutor(runnable -> {
        Thread thread = new Thread(runnable, "duiye-ocr");
        thread.setDaemon(true);
        return thread;
    });
    /** requestId → 这件活被撤了没有。 */
    private final Map<String, AtomicBoolean> running = new ConcurrentHashMap<>();

    private volatile ScratchFormulaRecognizer recognizer;
    private volatile String failure;

    FormulaOcrService(Context context) {
        this.context = context.getApplicationContext();
        Properties properties = readPackagedProperties();
        this.packaged = properties != null;
        this.engine = properties == null ? null : properties.getProperty("architecture");
        // 预热：拷模型、建会话。放在后台，开机不等它；第一次识别要是赶在它前面，会在同一条线程上排在它后面。
        if (packaged) worker.execute(this::ensureLoaded);
    }

    /** 这个构建带没带模型。带了，原生代理层就算「在」。 */
    boolean packaged() {
        return packaged;
    }

    /** 给 describe 的那一条，形状与 C++ 那边每个服务的 describe() 一样。 */
    JSONObject describe() throws JSONException {
        JSONObject entry = new JSONObject();
        entry.put("name", NAME);
        String problem = !packaged ? "model is not packaged in this build" : failure;
        entry.put("ready", problem == null);
        if (problem != null) entry.put("reason", problem);
        if (engine != null) entry.put("engine", engine);
        entry.put("kind", "formula");
        return entry;
    }

    /** @return 收下了没有；false 只有一个原因：这个编号已经有一件活在飞。 */
    boolean submit(String op, String payload, String requestId, NativeProxy.EventSink sink) {
        AtomicBoolean cancelled = new AtomicBoolean();
        if (running.putIfAbsent(requestId, cancelled) != null) return false;
        worker.execute(() -> {
            try {
                run(op, payload, requestId, sink, cancelled);
            } finally {
                running.remove(requestId);
            }
        });
        return true;
    }

    /** 撤回。拦得住就停（每生成一个记号前看一次），拦不住也没关系：网页那边不收迟到的结果。 */
    void cancel(String requestId) {
        AtomicBoolean cancelled = running.get(requestId);
        if (cancelled != null) cancelled.set(true);
    }

    void close() {
        worker.shutdownNow();
        ScratchFormulaRecognizer current = recognizer;
        recognizer = null;
        if (current != null) {
            try {
                current.close();
            } catch (Exception ignored) {
                // 关不掉也只是进程退出时多占一会儿内存
            }
        }
    }

    private void run(String op, String payload, String requestId, NativeProxy.EventSink sink,
                     AtomicBoolean cancelled) {
        if (cancelled.get()) return;
        if (!"recognize".equals(op)) {
            fail(sink, requestId, "BAD_REQUEST", "ocr only supports op \"recognize\"");
            return;
        }
        long started = SystemClock.elapsedRealtime();
        ScratchFormulaRecognizer model = ensureLoaded();
        if (model == null) {
            fail(sink, requestId, "MODEL_UNAVAILABLE", failure == null ? "model is not packaged" : failure);
            return;
        }
        int[] argb;
        int width;
        int height;
        try {
            JSONObject request = new JSONObject(payload);
            String format = request.optString("format", "png-base64");
            if (!"png-base64".equals(format)) {
                fail(sink, requestId, "BAD_REQUEST", "unsupported image format " + format);
                return;
            }
            byte[] png = Base64.decode(request.getString("image"), Base64.DEFAULT);
            BitmapFactory.Options options = new BitmapFactory.Options();
            options.inPreferredConfig = Bitmap.Config.ARGB_8888;
            // 要未预乘的颜色：半透明的地方由预处理照 Pillow 的算法合成到白底。
            options.inPremultiplied = false;
            options.inScaled = false;
            Bitmap bitmap = BitmapFactory.decodeByteArray(png, 0, png.length, options);
            if (bitmap == null) {
                fail(sink, requestId, "BAD_IMAGE", "image could not be decoded");
                return;
            }
            width = bitmap.getWidth();
            height = bitmap.getHeight();
            argb = new int[width * height];
            bitmap.getPixels(argb, 0, width, 0, 0, width, height);
            bitmap.recycle();
        } catch (JSONException | IllegalArgumentException problem) {
            fail(sink, requestId, "BAD_REQUEST", "payload is not a png-base64 image: " + problem.getMessage());
            return;
        }
        if (cancelled.get()) return;

        float[] tensor;
        try {
            tensor = FormulaImagePreprocessor.preprocess(argb, width, height, model.imageHeight(), model.imageWidth());
        } catch (FormulaImagePreprocessor.BlankImageException empty) {
            // 圈里没有比白底深的东西：当作没认出（网页那边 EMPTY 就是「这一块没认出文字或公式」）。
            sink.onEvent(requestId, "done",
                    "{\"latex\":\"\",\"endedWithEos\":true,\"meanLogProbability\":0,\"reasonCodes\":[\"EMPTY\"]}");
            return;
        }
        sink.onEvent(requestId, "chunk", "{\"progress\":0.2}");

        try {
            ScratchFormulaRecognizer.Prediction prediction = model.recognize(
                    FloatBuffer.wrap(tensor), model.maximumOutputTokens(), cancelled::get);
            if (cancelled.get()) return;
            JSONObject result = new JSONObject();
            result.put("latex", prediction.latex);
            result.put("tokenIds", new JSONArray(prediction.tokenIds));
            result.put("endedWithEos", prediction.endedWithEos);
            result.put("meanLogProbability", prediction.meanLogProbability);
            result.put("modelTrainingStatus", prediction.modelTrainingStatus);
            result.put("reviewRequired", true);
            result.put("reasonCodes", new JSONArray(prediction.reasonCodes));
            if (engine != null) result.put("engine", engine);
            result.put("elapsedMs", SystemClock.elapsedRealtime() - started);
            sink.onEvent(requestId, "done", result.toString());
        } catch (CancellationException stopped) {
            // 人撤了：什么都不回，网页那边已经当它取消了。
        } catch (Exception problem) {
            Log.w(TAG, "recognition failed", problem);
            fail(sink, requestId, "RECOGNITION_FAILED", String.valueOf(problem.getMessage()));
        }
    }

    /** 拷模型、建会话；只在后台线程上调。失败了记下原因，以后每次都照实说。 */
    private ScratchFormulaRecognizer ensureLoaded() {
        if (recognizer != null || !packaged) return recognizer;
        if (failure != null) return null;
        try {
            File directory = extractModel();
            recognizer = new ScratchFormulaRecognizer(directory, THREADS);
            Log.i(TAG, "formula model loaded: " + engine);
        } catch (Throwable problem) {
            // UnsatisfiedLinkError（库对不上架构）也在这里：识别不了，但书照样能读。
            failure = problem.getClass().getSimpleName() + ": " + problem.getMessage();
            Log.w(TAG, "formula model could not be loaded", problem);
        }
        return recognizer;
    }

    /**
     * 把 assets 里的模型包拷到私有目录。目录名带编码器哈希的前 12 位：换了模型就是一个新目录，旧的顺手删掉；
     * 同一个模型第二次开机不再拷。运行器加载时还会逐个核哈希，拷坏了会在那里被拦下。
     */
    private File extractModel() throws IOException {
        Properties properties = readPackagedProperties();
        String hash = properties == null ? null : properties.getProperty("encoder_sha256");
        if (hash == null || hash.length() < 12) throw new IOException("model.properties has no encoder_sha256");
        File root = new File(context.getNoBackupFilesDir(), "ocr");
        File directory = new File(root, "formula-" + hash.substring(0, 12));
        File done = new File(directory, ".complete");
        if (done.exists()) return directory;
        File[] stale = root.listFiles();
        if (stale != null) {
            for (File old : stale) {
                if (!old.equals(directory)) deleteRecursively(old);
            }
        }
        if (!directory.mkdirs() && !directory.isDirectory()) throw new IOException("cannot create " + directory);
        AssetManager assets = context.getAssets();
        byte[] buffer = new byte[1 << 16];
        java.util.List<String> files = new java.util.ArrayList<>(java.util.Arrays.asList(BUNDLE_FILES));
        files.add(properties.getProperty("encoder_file", "encoder.onnx"));
        files.add(properties.getProperty("decoder_file", "decoder.onnx"));
        for (String name : files) {
            // 文件名只能是包目录里的一个名字（运行器加载时还会再核一次）
            if (!name.matches("[A-Za-z0-9][A-Za-z0-9._-]*")) throw new IOException("bad model file name " + name);
            try (InputStream in = assets.open(ASSET_DIR + "/" + name);
                 OutputStream out = new FileOutputStream(new File(directory, name))) {
                int count;
                while ((count = in.read(buffer)) != -1) out.write(buffer, 0, count);
            }
        }
        if (!done.createNewFile() && !done.exists()) throw new IOException("cannot mark " + directory);
        return directory;
    }

    private Properties readPackagedProperties() {
        try (InputStream in = context.getAssets().open(ASSET_DIR + "/model.properties")) {
            Properties properties = new Properties();
            properties.load(in);
            return properties;
        } catch (IOException missing) {
            return null;
        }
    }

    private static void deleteRecursively(File file) {
        File[] children = file.listFiles();
        if (children != null) for (File child : children) deleteRecursively(child);
        //noinspection ResultOfMethodCallIgnored
        file.delete();
    }

    private static void fail(NativeProxy.EventSink sink, String requestId, String code, String message) {
        JSONObject error = new JSONObject();
        try {
            error.put("code", code);
            error.put("message", message);
        } catch (JSONException ignored) {
            // put 只在键为空时抛
        }
        sink.onEvent(requestId, "error", error.toString());
    }
}
