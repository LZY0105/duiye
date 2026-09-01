package com.latexsnipper.app.ocr;

/** Normalizes model output to the JSON object expected by the web layer. */
final class QuestionModifierOutput {
    private QuestionModifierOutput() { }

    static String extractJson(String generated) {
        String text = generated == null ? "" : generated;
        int start = text.indexOf('{');
        int end = text.lastIndexOf('}');
        if (start >= 0 && end > start) return text.substring(start, end + 1);
        return text.trim();
    }
}
