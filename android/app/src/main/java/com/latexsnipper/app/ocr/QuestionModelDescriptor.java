package com.latexsnipper.app.ocr;

import java.io.File;

/**
 * Strict per-package descriptor for a question-modifier model package
 * (rectification P0-06).
 *
 * Every package must ship a {@code question-modifier.json} declaring its
 * backend, format, model family, prompt template and token budgets. Missing,
 * unknown or conflicting fields fail closed with a coded message; nothing is
 * ever guessed from file names.
 */
final class QuestionModelDescriptor {
    /** Minimum output tokens reserved for generation inside the context window. */
    static final int MIN_OUTPUT_TOKENS = 64;

    final String backend;
    final String format;
    final String modelFamily;
    final String promptTemplate;
    final int contextLength;
    final int maxOutputTokens;

    private QuestionModelDescriptor(String backend, String format, String modelFamily,
                                    String promptTemplate, int contextLength, int maxOutputTokens) {
        this.backend = backend;
        this.format = format;
        this.modelFamily = modelFamily;
        this.promptTemplate = promptTemplate;
        this.contextLength = contextLength;
        this.maxOutputTokens = maxOutputTokens;
    }

    /**
     * Raised by a {@link JsonSource} when the underlying document cannot supply a
     * field as the requested type. Checked on purpose: every caller must decide how
     * to surface the failure, and the only sanctioned answer is to convert it into a
     * coded {@code QUESTION_MODEL_INVALID} validation error (rectification P0-01).
     */
    static final class JsonReadException extends Exception {
        JsonReadException(String message, Throwable cause) {
            super(message, cause);
        }
    }

    interface JsonSource {
        boolean has(String key);

        String getString(String key) throws JsonReadException;

        int getInt(String key) throws JsonReadException;
    }

    /**
     * Parses and strictly validates a descriptor from an already-opened JSON source.
     * Returns {@code null} when the package does not declare a descriptor.
     */
    static QuestionModelDescriptor parse(JsonSource json, File modelDir) {
        if (!json.has("backend")) return null;
        return validate(
            text(json, "backend", modelDir),
            text(json, "format", modelDir),
            text(json, "modelFamily", modelDir),
            text(json, "promptTemplate", modelDir),
            positiveInt(json, "contextLength", modelDir),
            positiveInt(json, "maxOutputTokens", modelDir),
            modelDir
        );
    }

    static QuestionModelDescriptor validate(String backend, String format, String modelFamily,
                                            String promptTemplate, int contextLength,
                                            int maxOutputTokens, File modelDir) {
        String where = modelDir == null ? "" : " in " + modelDir.getName();
        requireNonEmpty(backend, "backend", where);
        requireNonEmpty(format, "format", where);
        requireNonEmpty(modelFamily, "modelFamily", where);
        requireNonEmpty(promptTemplate, "promptTemplate", where);
        if (contextLength <= 0) {
            throw new IllegalArgumentException("QUESTION_MODEL_INVALID: contextLength must be > 0" + where);
        }
        if (maxOutputTokens <= 0 || maxOutputTokens > contextLength) {
            throw new IllegalArgumentException("QUESTION_MODEL_INVALID: maxOutputTokens must be within (0, contextLength]" + where);
        }
        // Strict admission (rectification P0-06/七): unknown values are rejected,
        // never guessed from file names.
        if (!"llama.cpp".equals(backend) && !"onnxruntime-genai".equals(backend)) {
            throw new IllegalArgumentException("QUESTION_MODEL_INVALID: unsupported backend '" + backend + "'" + where);
        }
        if (!"gguf".equals(format) && !"onnx".equals(format)) {
            throw new IllegalArgumentException("QUESTION_MODEL_INVALID: unsupported format '" + format + "'" + where);
        }
        boolean backendFormatMatches =
            ("llama.cpp".equals(backend) && "gguf".equals(format))
                || ("onnxruntime-genai".equals(backend) && "onnx".equals(format));
        if (!backendFormatMatches) {
            throw new IllegalArgumentException("QUESTION_MODEL_INVALID: backend/format combination '"
                + backend + "/" + format + "' is not supported" + where);
        }
        if (!SUPPORTED_MODEL_FAMILIES.contains(modelFamily)) {
            throw new IllegalArgumentException("QUESTION_MODEL_INVALID: unsupported modelFamily '" + modelFamily + "'" + where);
        }
        if (!PromptTemplates.isSupported(promptTemplate)) {
            throw new IllegalArgumentException("QUESTION_MODEL_INVALID: unsupported promptTemplate '" + promptTemplate + "'" + where);
        }
        if (!FAMILY_TEMPLATES.get(modelFamily).contains(promptTemplate)) {
            throw new IllegalArgumentException("QUESTION_MODEL_INVALID: promptTemplate '" + promptTemplate
                + "' is not valid for modelFamily '" + modelFamily + "'" + where);
        }
        return new QuestionModelDescriptor(backend, format, modelFamily, promptTemplate,
            contextLength, maxOutputTokens);
    }

    /** Model families accepted in this release. */
    private static final java.util.Set<String> SUPPORTED_MODEL_FAMILIES =
        java.util.Collections.unmodifiableSet(new java.util.HashSet<>(java.util.Arrays.asList("qwen")));

    /** Allowed promptTemplate per model family. */
    private static final java.util.Map<String, java.util.Set<String>> FAMILY_TEMPLATES;
    static {
        java.util.Map<String, java.util.Set<String>> m = new java.util.HashMap<>();
        m.put("qwen", java.util.Collections.unmodifiableSet(new java.util.HashSet<>(java.util.Arrays.asList("chatml"))));
        FAMILY_TEMPLATES = java.util.Collections.unmodifiableMap(m);
    }

    private static void requireNonEmpty(String value, String field, String where) {
        if (value == null || value.trim().isEmpty()) {
            throw new IllegalArgumentException("QUESTION_MODEL_INVALID: missing or empty field '" + field + "'" + where);
        }
    }

    /** Location suffix for coded messages; tolerates an absent model directory. */
    private static String where(File modelDir) {
        return modelDir == null ? "" : " in " + modelDir.getName();
    }

    private static String text(JsonSource json, String key, File modelDir) {
        if (!json.has(key)) {
            throw new IllegalArgumentException("QUESTION_MODEL_INVALID: missing field '" + key + "'" + where(modelDir));
        }
        try {
            return json.getString(key);
        } catch (JsonReadException e) {
            throw new IllegalArgumentException("QUESTION_MODEL_INVALID: field '" + key + "' must be a string" + where(modelDir), e);
        }
    }

    private static int positiveInt(JsonSource json, String key, File modelDir) {
        if (!json.has(key)) {
            throw new IllegalArgumentException("QUESTION_MODEL_INVALID: missing field '" + key + "'" + where(modelDir));
        }
        try {
            return json.getInt(key);
        } catch (JsonReadException e) {
            throw new IllegalArgumentException("QUESTION_MODEL_INVALID: field '" + key + "' must be an integer" + where(modelDir), e);
        }
    }

    /** Loads and validates the descriptor from a model directory.
     *
     * @return the parsed descriptor, or {@code null} when the package declares none.
     * @throws IllegalArgumentException with a coded message on invalid content.
     */
    static QuestionModelDescriptor fromDir(File modelDir) {
        java.io.File file = new java.io.File(modelDir, "question-modifier.json");
        if (!file.isFile()) return null;
        try {
            org.json.JSONObject obj = new org.json.JSONObject(
                new String(java.nio.file.Files.readAllBytes(file.toPath()), java.nio.charset.StandardCharsets.UTF_8));
            return parse(new JsonSource() {
                @Override public boolean has(String key) { return obj.has(key); }

                @Override public String getString(String key) throws JsonReadException {
                    try {
                        return obj.getString(key);
                    } catch (org.json.JSONException e) {
                        throw new JsonReadException("field '" + key + "' is not a string", e);
                    }
                }

                @Override public int getInt(String key) throws JsonReadException {
                    try {
                        return obj.getInt(key);
                    } catch (org.json.JSONException e) {
                        throw new JsonReadException("field '" + key + "' is not an integer", e);
                    }
                }
            }, modelDir);
        } catch (IllegalArgumentException e) {
            throw e;
        } catch (Exception e) {
            throw new IllegalArgumentException("QUESTION_MODEL_INVALID: question-modifier.json is not valid JSON in " + modelDir.getName());
        }
    }
    /** True when this descriptor declares exactly the given backend/format pair. */
    boolean declares(String expectedBackend, String expectedFormat) {
        return expectedBackend.equals(backend) && expectedFormat.equals(format);
    }

    /**
     * Token budget rule (rectification P0-04):
     * maxLength = min(contextLength, promptTokens + maxOutputTokens).
     */
    static int computeMaxLength(int promptTokens, int contextLength, int maxOutputTokens) {
        return Math.min(contextLength, promptTokens + maxOutputTokens);
    }

    /**
     * Fails closed before any generation attempt when the prompt leaves no room
     * for the reserved minimum output. Never silently truncates input.
     */
    static void ensureRoomForOutput(int promptTokens, int contextLength, int reservedOutputTokens) {
        int remaining = contextLength - promptTokens;
        int required = Math.min(MIN_OUTPUT_TOKENS, Math.max(1, reservedOutputTokens));
        if (remaining < required) {
            throw new IllegalArgumentException("QUESTION_PROMPT_TOO_LONG");
        }
    }
}
