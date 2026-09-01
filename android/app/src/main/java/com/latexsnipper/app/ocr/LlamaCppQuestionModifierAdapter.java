package com.latexsnipper.app.ocr;

import android.content.Context;

import com.latexsnipper.llamaruntime.QuestionLlamaRuntime;

import org.json.JSONObject;

import java.io.File;
import java.util.Locale;

/** Preferred GGUF adapter backed by the pinned llama.cpp Android runtime. */
final class LlamaCppQuestionModifierAdapter implements QuestionModifierBackend {
    private final Context context;

    LlamaCppQuestionModifierAdapter(Context context) {
        this.context = context.getApplicationContext();
    }

    @Override
    public String id() {
        return "llama.cpp";
    }

    @Override
    public String format() {
        return "gguf";
    }

    @Override
    public boolean supportsPackage(File modelDir) {
        File gguf = findSingleGguf(modelDir);
        if (gguf == null) return false;
        // Uniform strict admission: every package must declare a valid descriptor
        // matching this backend — a bare GGUF without one is rejected fail-closed.
        try {
            QuestionModelDescriptor d = QuestionModelDescriptor.fromDir(modelDir);
            return d != null && d.declares(id(), format());
        } catch (IllegalArgumentException e) {
            return false;
        }
    }

    @Override
    public boolean isRuntimeAvailable() {
        return QuestionLlamaRuntime.isSupportedAbi();
    }

    @Override
    public String generate(File modelDir, QuestionModelDescriptor descriptor, JSONObject request) {
        File modelFile = findSingleGguf(modelDir);
        if (modelFile == null) throw new IllegalArgumentException("QUESTION_GGUF_PACKAGE_INVALID");
        if (descriptor == null || !descriptor.declares(id(), format())) {
            throw new IllegalArgumentException("QUESTION_MODEL_INVALID");
        }
        // Honour the package's declared output budget instead of a hardcoded
        // constant. This is the default backend, so ignoring the descriptor here
        // meant the token budget the descriptor validates was never applied on
        // the path almost every install actually takes.
        //
        // Prompt-token gating (ensureRoomForOutput / QUESTION_PROMPT_TOO_LONG)
        // stays ONNX-only on purpose: llama.cpp applies its own chat template
        // and tokenises inside the runtime, so there is no honest prompt-token
        // count available here. Estimating one would fabricate precision, so the
        // budget is enforced only where it can be measured.
        String output = QuestionLlamaRuntime.generate(
            context,
            modelFile.getAbsolutePath(),
            request.optString("system", ""),
            request.optString("user", ""),
            descriptor.maxOutputTokens
        );
        if (output == null || output.trim().isEmpty()) {
            throw new IllegalStateException("QUESTION_GENERATION_EMPTY");
        }
        return QuestionModifierOutput.extractJson(output);
    }

    private File findSingleGguf(File modelDir) {
        if (modelDir == null || !modelDir.isDirectory()) return null;
        File[] files = modelDir.listFiles((dir, name) ->
            name.toLowerCase(Locale.ROOT).endsWith(".gguf"));
        return files != null && files.length == 1 ? files[0] : null;
    }
}
