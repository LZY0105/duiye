package com.latexsnipper.app.ocr;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertThrows;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

/** Pure-JVM tests for the strict package descriptor and token budget rules. */
public class QuestionModelDescriptorTest {

    private static QuestionModelDescriptor valid() {
        return QuestionModelDescriptor.validate(
            "onnxruntime-genai", "onnx", "qwen", "chatml", 4096, 512, null);
    }

    @Test
    public void validateAcceptsCompleteDescriptor() {
        QuestionModelDescriptor d = valid();
        assertEquals("onnxruntime-genai", d.backend);
        assertEquals("qwen", d.modelFamily);
        assertEquals(4096, d.contextLength);
        assertEquals(512, d.maxOutputTokens);
        assertTrue(d.declares("onnxruntime-genai", "onnx"));
        assertFalse(d.declares("llama.cpp", "gguf"));
    }

    @Test
    public void missingFieldIsRejected() {
        assertThrows(IllegalArgumentException.class, () ->
            QuestionModelDescriptor.validate(null, "onnx", "qwen", "chatml", 4096, 512, null));
        assertThrows(IllegalArgumentException.class, () ->
            QuestionModelDescriptor.validate("onnxruntime-genai", "", "qwen", "chatml", 4096, 512, null));
        assertThrows(IllegalArgumentException.class, () ->
            QuestionModelDescriptor.validate("onnxruntime-genai", "onnx", " ", "chatml", 4096, 512, null));
    }

    @Test
    public void invalidTokenBudgetsAreRejected() {
        assertThrows(IllegalArgumentException.class, () ->
            QuestionModelDescriptor.validate("b", "f", "m", "t", 0, 512, null));
        assertThrows(IllegalArgumentException.class, () ->
            QuestionModelDescriptor.validate("b", "f", "m", "t", 4096, 0, null));
        assertThrows(IllegalArgumentException.class, () ->
            QuestionModelDescriptor.validate("b", "f", "m", "t", 4096, 4097, null));
    }

    @Test
    public void maxLengthNeverExceedsContextWindow() {
        assertEquals(4096, QuestionModelDescriptor.computeMaxLength(4000, 4096, 512));
        // Room available: prompt + declared output budget.
        assertEquals(1024, QuestionModelDescriptor.computeMaxLength(512, 4096, 512));
        // Prompt alone already exceeds the window: budget clamps to contextLength,
        // but ensureRoomForOutput must reject this case before generation.
        assertEquals(4096, QuestionModelDescriptor.computeMaxLength(5000, 4096, 512));
    }

    @Test
    public void overLongPromptFailsClosedWithCodedError() {
        // Prompt leaves no room for the reserved minimum output.
        IllegalArgumentException e = assertThrows(IllegalArgumentException.class, () ->
            QuestionModelDescriptor.ensureRoomForOutput(4088, 4096, 512));
        assertTrue(e.getMessage().contains("QUESTION_PROMPT_TOO_LONG"));

        // Prompt exactly at the boundary with enough room is accepted.
        QuestionModelDescriptor.ensureRoomForOutput(
            4096 - QuestionModelDescriptor.MIN_OUTPUT_TOKENS, 4096, 512);
    }

    @Test
    public void fromDirReturnsNullWhenNoDescriptorDeclared() throws Exception {
        java.io.File empty = java.nio.file.Files.createTempDirectory("p1desc").toFile();
        empty.deleteOnExit();
        assertNull(QuestionModelDescriptor.fromDir(empty));
    }

    @Test
    public void unknownValuesAreRejected() {
        // Unknown backend
        assertThrows(IllegalArgumentException.class, () ->
            QuestionModelDescriptor.validate("openai", "gguf", "qwen", "chatml", 4096, 512, null));
        // Backend/format combination mismatch
        assertThrows(IllegalArgumentException.class, () ->
            QuestionModelDescriptor.validate("llama.cpp", "onnx", "qwen", "chatml", 4096, 512, null));
        // Unknown model family
        assertThrows(IllegalArgumentException.class, () ->
            QuestionModelDescriptor.validate("llama.cpp", "gguf", "llama3", "chatml", 4096, 512, null));
        // Unknown prompt template
        assertThrows(IllegalArgumentException.class, () ->
            QuestionModelDescriptor.validate("llama.cpp", "gguf", "qwen", "llama3", 4096, 512, null));
        // Family/template combination mismatch
        assertThrows(IllegalArgumentException.class, () ->
            QuestionModelDescriptor.validate("onnxruntime-genai", "onnx", "qwen", "mistral", 4096, 512, null));
    }

    @Test
    public void supportedCombinationsAreAccepted() {
        assertTrue(QuestionModelDescriptor.validate(
            "llama.cpp", "gguf", "qwen", "chatml", 4096, 512, null) != null);
        assertTrue(QuestionModelDescriptor.validate(
            "onnxruntime-genai", "onnx", "qwen", "chatml", 8192, 1024, null) != null);
    }
}
