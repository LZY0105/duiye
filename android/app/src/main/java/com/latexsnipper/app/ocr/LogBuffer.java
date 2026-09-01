package com.latexsnipper.app.ocr;

/**
 * Bounded in-memory log buffer exported to the web layer (rectification P1-01).
 *
 * Extracted from NativeOcrBridge so the trimming rule can be unit-tested. The
 * buffer must not grow without bound — it accumulates for the whole session and
 * an OCR run logs per page — so it discards its oldest quarter when full rather
 * than either growing forever or dropping everything at once.
 *
 * Draining on read is deliberate: the web layer exports logs and then expects a
 * fresh buffer, so returning the same lines twice would duplicate them in every
 * subsequent export.
 */
final class LogBuffer {

    static final int MAX_CHARS = 50000;

    private final StringBuilder buffer = new StringBuilder();
    private final int maxChars;

    LogBuffer() {
        this(MAX_CHARS);
    }

    LogBuffer(int maxChars) {
        this.maxChars = Math.max(1024, maxChars);
    }

    synchronized void append(String tag, String message) {
        String line = System.currentTimeMillis() + "  [" + tag + "] " + message;
        if (buffer.length() + line.length() > maxChars) {
            buffer.delete(0, buffer.length() / 4);
        }
        buffer.append(line).append("\n");
    }

    /** Returns everything accumulated and empties the buffer. */
    synchronized String drain() {
        String logs = buffer.toString();
        buffer.setLength(0);
        return logs;
    }

    synchronized int length() {
        return buffer.length();
    }
}
