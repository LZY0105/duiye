package com.latexsnipper.app.ocr;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

/**
 * Tests for the units extracted from NativeOcrBridge (rectification P1-01).
 *
 * These behaviours were previously unreachable from a unit test: they lived
 * inside a 889-line class that needed an Android Context, a WebView and a
 * loaded OCR engine to instantiate. Being able to test them at all is the point
 * of the split — the review asked for modules that "可独立纯 JVM 测试".
 */
public class BridgeCollaboratorsTest {

    // ── JsonEscape ────────────────────────────────────────────────────────

    @Test
    public void escapesTheCharactersThatWouldBreakJson() {
        assertEquals("a\\\"b", JsonEscape.escape("a\"b"));
        assertEquals("a\\\\b", JsonEscape.escape("a\\b"));
        assertEquals("line1\\nline2", JsonEscape.escape("line1\nline2"));
        assertEquals("a\\tb", JsonEscape.escape("a\tb"));
    }

    @Test
    public void escapesControlCharactersAsUnicode() {
        // A raw control character inside a JSON string is invalid and makes
        // JSON.parse throw on the web side.
        assertEquals("\\u0001", JsonEscape.escape(""));
        assertEquals("\\u001f", JsonEscape.escape(""));
    }

    @Test
    public void passesThroughTextThatNeedsNoEscaping() {
        assertEquals("解方程 2x + 1 = 5", JsonEscape.escape("解方程 2x + 1 = 5"));
        assertEquals("", JsonEscape.escape(null));
    }

    @Test
    public void preservesSupplementaryCharacters() {
        // Emoji are surrogate pairs; mishandling them corrupts the output.
        String emoji = "😀";
        assertEquals(emoji, JsonEscape.escape(emoji));
    }

    @Test
    public void buildsErrorEnvelopesWithTheirReasonEscaped() {
        assertEquals("{\"error\":\"bad \\\"input\\\"\"}", JsonEscape.errorObject("bad \"input\""));
        assertTrue(JsonEscape.errorObject("CODE", "why").contains("\"code\":\"CODE\""));
    }

    // ── LogBuffer ─────────────────────────────────────────────────────────

    @Test
    public void logBufferDrainsAndEmptiesOnRead() {
        LogBuffer buffer = new LogBuffer();
        buffer.append("OCR", "first");
        buffer.append("OCR", "second");

        String drained = buffer.drain();
        assertTrue(drained.contains("first"));
        assertTrue(drained.contains("second"));
        assertTrue("[OCR] tag must be present", drained.contains("[OCR]"));
        // A second read must not repeat what was already exported.
        assertEquals("", buffer.drain());
    }

    @Test
    public void logBufferStaysBoundedUnderSustainedLogging() {
        LogBuffer buffer = new LogBuffer(2048);
        for (int i = 0; i < 500; i++) {
            buffer.append("OCR", "a fairly long log line number " + i);
        }
        assertTrue("buffer must not grow without bound", buffer.length() <= 2048);
        // It must still hold the most recent lines rather than being emptied.
        assertTrue(buffer.drain().contains("number 499"));
    }

    // ── ModelFileWriter path safety ───────────────────────────────────────

    @Test
    public void acceptsOrdinaryPathSegments() {
        assertTrue(ModelFileWriter.isSafeSegment("question-modifier"));
        assertTrue(ModelFileWriter.isSafeSegment("qwen2.5-0.5b"));
        assertTrue(ModelFileWriter.isSafeSegment("model.onnx"));
    }

    @Test
    public void rejectsSegmentsThatCouldEscapeTheModelsDirectory() {
        // These all come from the web layer and land in a filesystem path.
        assertFalse(ModelFileWriter.isSafeSegment(".."));
        assertFalse(ModelFileWriter.isSafeSegment("."));
        assertFalse(ModelFileWriter.isSafeSegment("../databases"));
        assertFalse(ModelFileWriter.isSafeSegment("a/b"));
        assertFalse(ModelFileWriter.isSafeSegment("a\\b"));
        assertFalse(ModelFileWriter.isSafeSegment("bad\0name"));
        assertFalse(ModelFileWriter.isSafeSegment(""));
        assertFalse(ModelFileWriter.isSafeSegment(null));
    }

    @Test
    public void unsafeSegmentsRaiseACodedError() {
        try {
            ModelFileWriter.requireSafeSegment("../etc", "category");
            throw new AssertionError("expected an exception");
        } catch (IllegalArgumentException e) {
            assertEquals("MODEL_PATH_INVALID_category", e.getMessage());
        }
    }

    // ── DownloadExporter MIME mapping ─────────────────────────────────────

    @Test
    public void mapsExtensionsToMimeTypes() {
        assertEquals("image/png", DownloadExporter.guessMimeType("a.png"));
        assertEquals("image/png", DownloadExporter.guessMimeType("A.PNG"));
        assertEquals("image/jpeg", DownloadExporter.guessMimeType("photo.jpeg"));
        assertEquals("application/zip", DownloadExporter.guessMimeType("models.zip"));
        assertEquals("application/pdf", DownloadExporter.guessMimeType("book.pdf"));
    }

    @Test
    public void unknownExtensionsFallBackToBinary() {
        assertEquals("application/octet-stream", DownloadExporter.guessMimeType("model.onnx"));
        assertEquals("application/octet-stream", DownloadExporter.guessMimeType("noextension"));
        assertEquals("application/octet-stream", DownloadExporter.guessMimeType(null));
    }

    // ── ExifImageDecoder header parsing ───────────────────────────────────

    @Test
    public void nonJpegBytesReportNoRotation() {
        assertEquals(1, ExifImageDecoder.readOrientation(new byte[]{0, 1, 2, 3}));
        assertEquals(1, ExifImageDecoder.readOrientation(new byte[0]));
        assertEquals(1, ExifImageDecoder.readOrientation(null));
    }

    @Test
    public void truncatedJpegDoesNotThrowOrReadOutOfBounds() {
        // A camera app can hand over a partial or corrupt file; unrotated is the
        // correct answer, a crash is not.
        byte[] truncated = { (byte) 0xFF, (byte) 0xD8, (byte) 0xFF, (byte) 0xE1, 0x00 };
        assertEquals(1, ExifImageDecoder.readOrientation(truncated));
    }

    @Test
    public void readsBothByteOrders() {
        // 0x01020304 big-endian, and the same bytes read little-endian.
        byte[] data = { 0x01, 0x02, 0x03, 0x04 };
        assertEquals(0x01020304, ExifImageDecoder.readInt(data, 0, false, 4));
        assertEquals(0x04030201, ExifImageDecoder.readInt(data, 0, true, 4));
    }

    @Test
    public void readIntTreatsOutOfRangeBytesAsZeroRatherThanThrowing() {
        byte[] data = { 0x01 };
        assertEquals(0x0100, ExifImageDecoder.readInt(data, 0, false, 2));
        assertEquals(0, ExifImageDecoder.readInt(data, 99, false, 4));
    }

    @Test
    public void parsesOrientationFromAWellFormedExifHeader() {
        assertEquals(6, ExifImageDecoder.readOrientation(jpegWithOrientation(6)));
        assertEquals(3, ExifImageDecoder.readOrientation(jpegWithOrientation(3)));
        assertEquals(1, ExifImageDecoder.readOrientation(jpegWithOrientation(1)));
    }

    /**
     * Builds a minimal JPEG whose APP1 segment carries one big-endian TIFF IFD
     * with a single Orientation tag (0x0112).
     */
    private static byte[] jpegWithOrientation(int orientation) {
        byte[] out = new byte[64];
        int i = 0;
        out[i++] = (byte) 0xFF; out[i++] = (byte) 0xD8;   // SOI
        out[i++] = (byte) 0xFF; out[i++] = (byte) 0xE1;   // APP1
        out[i++] = 0x00; out[i++] = 0x2A;                 // segment length (42)
        out[i++] = 'E'; out[i++] = 'x'; out[i++] = 'i'; out[i++] = 'f';
        out[i++] = 0x00; out[i++] = 0x00;

        int tiff = i;                                     // TIFF header starts here
        out[i++] = 'M'; out[i++] = 'M';                   // big-endian
        out[i++] = 0x00; out[i++] = 0x2A;                 // magic 42
        out[i++] = 0x00; out[i++] = 0x00; out[i++] = 0x00; out[i++] = 0x08; // IFD at +8

        int ifd = tiff + 8;
        out[ifd] = 0x00; out[ifd + 1] = 0x01;             // one entry
        int e = ifd + 2;
        out[e] = 0x01; out[e + 1] = 0x12;                 // tag 0x0112 Orientation
        out[e + 2] = 0x00; out[e + 3] = 0x03;             // type SHORT
        out[e + 4] = 0x00; out[e + 5] = 0x00; out[e + 6] = 0x00; out[e + 7] = 0x01; // count 1
        out[e + 8] = 0x00; out[e + 9] = (byte) orientation;
        return out;
    }
}
