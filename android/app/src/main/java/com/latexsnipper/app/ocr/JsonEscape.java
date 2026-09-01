package com.latexsnipper.app.ocr;

import java.util.Locale;

/**
 * JSON string escaping for hand-built payloads (rectification P1-01).
 *
 * Extracted from NativeOcrBridge, where it sat among WebView, OCR, model and
 * notification concerns. It is pure and has no Android dependency, so it can be
 * unit-tested in plain JVM — which matters, because every async result the web
 * layer parses passes through here and a single unescaped character produces a
 * SyntaxError on the other side.
 */
final class JsonEscape {

    private JsonEscape() { }

    /** Escapes a string for inclusion between double quotes in JSON. */
    static String escape(String s) {
        if (s == null) return "";
        StringBuilder sb = new StringBuilder(s.length() + 16);
        for (int i = 0; i < s.length(); i++) {
            int cp = s.codePointAt(i);
            // Supplementary characters occupy two chars; skip the low surrogate
            // so it is not emitted a second time.
            if (cp > 0xFFFF) i++;
            switch (cp) {
                case '\\': sb.append("\\\\"); break;
                case '"':  sb.append("\\\""); break;
                case '\n': sb.append("\\n"); break;
                case '\r': sb.append("\\r"); break;
                case '\t': sb.append("\\t"); break;
                case '\b': sb.append("\\b"); break;
                case '\f': sb.append("\\f"); break;
                default:
                    if (cp < 0x20) {
                        // Locale.ROOT: the default locale can render %x with
                        // non-ASCII digits, which would emit invalid JSON.
                        sb.append(String.format(Locale.ROOT, "\\u%04x", cp));
                    } else {
                        sb.appendCodePoint(cp);
                    }
            }
        }
        return sb.toString();
    }

    /** Builds {"error":"..."} with the reason escaped. */
    static String errorObject(String reason) {
        return "{\"error\":\"" + escape(reason) + "\"}";
    }

    /** Builds a coded error envelope matching the web layer's expected shape. */
    static String errorObject(String code, String reason) {
        return "{\"status\":\"error\",\"code\":\"" + escape(code)
            + "\",\"reason\":\"" + escape(reason) + "\"}";
    }
}
