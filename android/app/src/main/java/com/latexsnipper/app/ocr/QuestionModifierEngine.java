package com.latexsnipper.app.ocr;

import android.content.Context;
import android.util.Log;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.File;
import java.util.Arrays;
import java.util.List;

/**
 * Backend-neutral local question modifier.
 *
 * llama.cpp/GGUF is preferred for automatic selection. ONNX Runtime GenAI remains
 * available as a package-selection fallback. Runtime failures are fail-closed and
 * never trigger a network request or an unreported switch to another model.
 */
public final class QuestionModifierEngine {
    public static final String CATEGORY = "question-modifier";
    private static final String TAG = "QuestionModifierEngine";

    private final ModelManager modelManager;
    private final List<QuestionModifierBackend> backends;

    public QuestionModifierEngine(Context context) {
        Context appContext = context.getApplicationContext();
        this.modelManager = new ModelManager(appContext);
        this.backends = Arrays.asList(
            new LlamaCppQuestionModifierAdapter(appContext),
            new OnnxGenAiQuestionModifierAdapter()
        );
    }

    public synchronized JSONObject getStatus() {
        JSONObject status = new JSONObject();
        try {
            Selection selection = resolveSelection();
            status.put("preferredBackend", "llama.cpp");
            status.put("fallbackBackend", "onnxruntime-genai");
            status.put("fallbackPolicy", "selection-only");
            status.put("supportedBackends", new JSONArray(Arrays.asList("llama.cpp", "onnxruntime-genai")));
            if (selection == null) {
                boolean packagePresent = modelManager.listInstalled(CATEGORY).length > 0;
                status.put("status", "NOT_CONFIGURED");
                status.put("code", packagePresent ? "QUESTION_BACKEND_UNAVAILABLE" : "QUESTION_MODEL_MISSING");
                status.put("message", packagePresent
                    ? "No installed question model can run on this device ABI"
                    : "No local question modifier model is installed");
                return status;
            }
            status.put("status", "READY");
            status.put("backend", selection.backend.id());
            status.put("format", selection.backend.format());
            status.put("variant", selection.modelDir.getName());
            status.put("path", selection.modelDir.getAbsolutePath());
            // Rectification P0-05: expose the model's real token budget so the
            // UI can align input limits instead of guessing from char counts.
            if (selection.descriptor != null) {
                status.put("modelFamily", selection.descriptor.modelFamily);
                status.put("promptTemplate", selection.descriptor.promptTemplate);
                status.put("contextLength", selection.descriptor.contextLength);
                status.put("maxOutputTokens", selection.descriptor.maxOutputTokens);
            }
        } catch (Exception e) {
            try {
                status.put("status", "ERROR");
                status.put("code", "QUESTION_MODEL_INVALID");
                status.put("message", safeMessage(e));
            } catch (Exception ignored) { }
        }
        return status;
    }

    public synchronized String generate(String requestJson) throws Exception {
        Selection selection = resolveSelection();
        if (selection == null) throw new IllegalStateException("QUESTION_BACKEND_UNAVAILABLE");
        JSONObject request = new JSONObject(requestJson == null ? "{}" : requestJson);
        Log.d(TAG, "Generating local question edit with " + selection.backend.id() +
            ", variant=" + selection.modelDir.getName());
        String raw = selection.backend.generate(selection.modelDir, selection.descriptor, request);
        if (raw == null || raw.trim().isEmpty()) {
            // extractJson returns "" when the model produced nothing brace-shaped;
            // surface a coded failure instead of letting new JSONObject("") throw
            // a raw parser message at the web layer.
            throw new IllegalStateException("QUESTION_GENERATION_EMPTY");
        }
        JSONObject result;
        try {
            result = new JSONObject(raw);
        } catch (org.json.JSONException e) {
            throw new IllegalStateException("QUESTION_OUTPUT_NOT_JSON");
        }
        result.put("backend", selection.backend.id());
        result.put("modelVariant", selection.modelDir.getName());
        return result.toString();
    }

    private Selection resolveSelection() {
        String active = modelManager.getActiveVariant(CATEGORY);
        if (active != null && !active.isEmpty()) {
            Selection selected = select(new File(modelManager.getCategoryDir(CATEGORY), active));
            if (selected != null) return selected;
        }

        // Auto discovery goes through the same strict select() path as explicit
        // selection, so descriptor validation and admission rules never diverge.
        String[] installed = modelManager.listInstalled(CATEGORY);
        for (String variant : installed) {
            Selection candidate = select(new File(modelManager.getCategoryDir(CATEGORY), variant));
            if (candidate != null) return candidate;
        }
        return null;
    }

    private Selection select(File modelDir) {
        QuestionModelDescriptor descriptor;
        try {
            descriptor = QuestionModelDescriptor.fromDir(modelDir);
        } catch (IllegalArgumentException e) {
            return null;
        }
        // Every backend requires a descriptor, so a package without one is not
        // selectable. Rejecting it here makes the non-null descriptor promised
        // by QuestionModifierBackend.generate true by construction.
        if (descriptor == null) return null;
        for (QuestionModifierBackend backend : backends) {
            if (backend.isRuntimeAvailable() && backend.supportsPackage(modelDir)) {
                return new Selection(backend, modelDir, descriptor);
            }
        }
        return null;
    }

    private String safeMessage(Exception e) {
        String message = e.getMessage();
        return message == null || message.isEmpty() ? e.getClass().getSimpleName() : message;
    }

    private static final class Selection {
        final QuestionModifierBackend backend;
        final File modelDir;
        final QuestionModelDescriptor descriptor;

        Selection(QuestionModifierBackend backend, File modelDir, QuestionModelDescriptor descriptor) {
            this.backend = backend;
            this.modelDir = modelDir;
            this.descriptor = descriptor;
        }
    }
}
