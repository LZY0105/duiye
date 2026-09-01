package com.latexsnipper.app.ocr;

/**
 * Prompt-template registry (rectification P0-07).
 *
 * Chat templates are selected by the package descriptor's {@code promptTemplate}
 * field — never inferred from file names and never hard-coded in generation
 * flows. Only templates that are actually accepted in this release are
 * registered; unknown values fail closed.
 *
 * Current registry: chatml (Qwen/ChatML family). Supporting more model families
 * requires adding a template here AND documenting the family in the model
 * manifest, UI and docs.
 */
final class PromptTemplates {

    @FunctionalInterface
    interface Builder {
        String build(String system, String user);
    }

    private static final java.util.Map<String, Builder> REGISTRY = new java.util.HashMap<>();

    static {
        // ChatML: Qwen-style instruction models.
        REGISTRY.put("chatml", (system, user) ->
            "<|im_start|>system\n" + system +
                "\n<|im_end|>\n<|im_start|>user\n" + user +
                "\n<|im_end|>\n<|im_start|>assistant\n");
    }

    private PromptTemplates() { }

    /** Returns true when the template id is registered. */
    static boolean isSupported(String promptTemplate) {
        return promptTemplate != null && REGISTRY.containsKey(promptTemplate);
    }

    /**
     * Builds a complete prompt using the registered template.
     *
     * @throws IllegalArgumentException {@code QUESTION_PROMPT_TEMPLATE_UNSUPPORTED}
     *                                  for unregistered template ids.
     */
    static String build(String promptTemplate, String system, String user) {
        Builder builder = promptTemplate == null ? null : REGISTRY.get(promptTemplate);
        if (builder == null) {
            throw new IllegalArgumentException("QUESTION_PROMPT_TEMPLATE_UNSUPPORTED");
        }
        return builder.build(system, user);
    }
}
