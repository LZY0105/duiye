package com.latexsnipper.app.ocr;

import org.json.JSONObject;

import java.io.File;

import ai.onnxruntime.genai.Generator;
import ai.onnxruntime.genai.GeneratorParams;
import ai.onnxruntime.genai.Model;
import ai.onnxruntime.genai.Sequences;
import ai.onnxruntime.genai.Tokenizer;
import ai.onnxruntime.genai.TokenizerStream;

/**
 * ONNX Runtime GenAI fallback adapter (rectification P0-04..P0-07).
 *
 * Packages are accepted only when they declare a strict
 * {@code question-modifier.json} descriptor whose backend/format match this
 * adapter. The chat template comes from the descriptor's registered template
 * id; the generation budget is computed from the real prompt token count and
 * the declared context window. Over-long prompts fail closed with
 * {@code QUESTION_PROMPT_TOO_LONG} instead of producing empty output.
 */
final class OnnxGenAiQuestionModifierAdapter implements QuestionModifierBackend {
    private static final int MAX_OUTPUT_CHARS = 16000;

    @Override
    public String id() {
        return "onnxruntime-genai";
    }

    @Override
    public String format() {
        return "onnx";
    }

    @Override
    public boolean supportsPackage(File modelDir) {
        if (modelDir == null || !modelDir.isDirectory()) return false;
        if (!new File(modelDir, "config.json").isFile()) return false;
        File[] models = modelDir.listFiles((dir, name) ->
            name.toLowerCase(java.util.Locale.ROOT).endsWith(".onnx") ||
                name.toLowerCase(java.util.Locale.ROOT).endsWith(".bin"));
        if (models == null || models.length == 0) return false;
        try {
            QuestionModelDescriptor d = QuestionModelDescriptor.fromDir(modelDir);
            return d != null && d.declares(id(), format());
        } catch (IllegalArgumentException e) {
            return false;
        }
    }

    @Override
    public boolean isRuntimeAvailable() {
        return true;
    }

    @Override
    public String generate(File modelDir, QuestionModelDescriptor descriptor, JSONObject request) throws Exception {
        String system = request.optString("system", "");
        String user = request.optString("user", "");

        // Supplied by the caller — no longer re-read from disk here.
        if (descriptor == null || !descriptor.declares(id(), format())) {
            throw new IllegalArgumentException("QUESTION_MODEL_INVALID");
        }
        // Template selection is data-driven; unknown ids fail closed here.
        String prompt = PromptTemplates.build(descriptor.promptTemplate, system, user);

        try (Model model = new Model(modelDir.getAbsolutePath());
             Tokenizer tokenizer = new Tokenizer(model);
             Sequences input = tokenizer.encode(prompt)) {

            int promptTokens = input.getSequence(0).length;
            QuestionModelDescriptor.ensureRoomForOutput(
                promptTokens, descriptor.contextLength, descriptor.maxOutputTokens);
            int maxLength = QuestionModelDescriptor.computeMaxLength(
                promptTokens, descriptor.contextLength, descriptor.maxOutputTokens);

            try (GeneratorParams params = new GeneratorParams(model)) {
                params.setSearchOption("max_length", maxLength);
                params.setSearchOption("temperature", 0.1);
                params.setSearchOption("do_sample", false);
                try (Generator generator = new Generator(model, params);
                     TokenizerStream stream = tokenizer.createStream()) {
                    generator.appendTokenSequences(input);
                    StringBuilder output = new StringBuilder();
                    while (!generator.isDone() && output.length() < MAX_OUTPUT_CHARS) {
                        generator.generateNextToken();
                        output.append(stream.decode(generator.getLastTokenInSequence(0)));
                    }
                    if (output.length() == 0) {
                        throw new IllegalStateException("QUESTION_GENERATION_EMPTY");
                    }
                    return QuestionModifierOutput.extractJson(output.toString());
                }
            }
        }
    }
}
