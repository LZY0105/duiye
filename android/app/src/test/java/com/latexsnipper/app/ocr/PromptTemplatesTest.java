package com.latexsnipper.app.ocr;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertThrows;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

/** Template registry must fail closed for unregistered prompt templates. */
public class PromptTemplatesTest {

    @Test
    public void chatmlIsRegisteredAndBuildsChatMlFraming() {
        assertTrue(PromptTemplates.isSupported("chatml"));
        String prompt = PromptTemplates.build("chatml", "sys", "usr");
        assertTrue(prompt.startsWith("<|im_start|>system\nsys"));
        assertTrue(prompt.contains("\n<|im_end|>\n<|im_start|>user\nusr"));
        assertTrue(prompt.endsWith("\n<|im_end|>\n<|im_start|>assistant\n"));
    }

    @Test
    public void unknownTemplateFailsClosedWithCodedError() {
        assertFalse(PromptTemplates.isSupported("llama3"));
        IllegalArgumentException e = assertThrows(IllegalArgumentException.class, () ->
            PromptTemplates.build("llama3", "s", "u"));
        assertTrue(e.getMessage().contains("QUESTION_PROMPT_TEMPLATE_UNSUPPORTED"));
    }

    @Test
    public void nullTemplateFailsClosed() {
        assertFalse(PromptTemplates.isSupported(null));
        assertThrows(IllegalArgumentException.class, () ->
            PromptTemplates.build(null, "s", "u"));
    }
}
