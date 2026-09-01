package com.latexsnipper.app.ocr;

import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.graphics.Matrix;
import android.util.Base64;

/**
 * Base64 image decoding with EXIF orientation applied (rectification P1-01).
 *
 * Extracted from NativeOcrBridge, which was carrying a hand-rolled JPEG/TIFF
 * parser alongside WebView, OCR, model and notification concerns.
 *
 * The orientation parsing is deliberately kept rather than replaced with
 * ExifInterface: the input is a base64 data URI already in memory, and
 * ExifInterface would require writing it to a temporary file or wrapping it in
 * a stream for every recognition.
 *
 * The byte-level parsing is static and Android-free, so it is unit-testable
 * with synthetic headers — worthwhile because malformed EXIF from an arbitrary
 * camera app must degrade to "no rotation" rather than throwing or reading out
 * of bounds.
 */
final class ExifImageDecoder {

    private ExifImageDecoder() { }

    /** Result of a decode: the bitmap plus whether EXIF rotation was applied. */
    static final class Decoded {
        final Bitmap bitmap;
        final boolean exifApplied;

        Decoded(Bitmap bitmap, boolean exifApplied) {
            this.bitmap = bitmap;
            this.exifApplied = exifApplied;
        }
    }

    /**
     * Decodes a data URI or bare base64 string into an oriented bitmap.
     * @throws IllegalArgumentException when the bytes are not a decodable image
     */
    static Decoded decode(String dataUri) {
        String base64 = dataUri != null && dataUri.contains(",")
            ? dataUri.substring(dataUri.indexOf(',') + 1)
            : dataUri;
        byte[] decoded = Base64.decode(base64, Base64.DEFAULT);

        int orientation = 1;
        try {
            orientation = readOrientation(decoded);
        } catch (Exception e) {
            // Not a JPEG, or the EXIF block is malformed. Unrotated is the
            // correct fallback; refusing the image would be worse.
            orientation = 1;
        }

        Bitmap bitmap = BitmapFactory.decodeByteArray(decoded, 0, decoded.length);
        if (bitmap == null) throw new IllegalArgumentException("Failed to decode image");
        if (orientation == 1) return new Decoded(bitmap, false);

        Matrix matrix = new Matrix();
        switch (orientation) {
            case 3: matrix.postRotate(180); break;
            case 6: matrix.postRotate(90); break;
            case 8: matrix.postRotate(270); break;
            case 2: matrix.preScale(-1, 1); break;
            case 4: matrix.preScale(1, -1); break;
            case 5: matrix.postRotate(90); matrix.preScale(-1, 1); break;
            case 7: matrix.postRotate(270); matrix.preScale(-1, 1); break;
            default: return new Decoded(bitmap, false);
        }
        Bitmap rotated = Bitmap.createBitmap(
            bitmap, 0, 0, bitmap.getWidth(), bitmap.getHeight(), matrix, true);
        if (rotated != bitmap) bitmap.recycle();
        return new Decoded(rotated, true);
    }

    /** EXIF orientation tag from JPEG bytes, or 1 when absent or unreadable. */
    static int readOrientation(byte[] jpeg) {
        if (jpeg == null || jpeg.length < 4
            || (jpeg[0] & 0xFF) != 0xFF || (jpeg[1] & 0xFF) != 0xD8) {
            return 1; // not a JPEG
        }
        int offset = 2;
        int length = jpeg.length;
        while (offset + 8 < length) {
            int marker = (jpeg[offset] & 0xFF) << 8 | (jpeg[offset + 1] & 0xFF);
            int segLen = (jpeg[offset + 2] & 0xFF) << 8 | (jpeg[offset + 3] & 0xFF);
            if (marker == 0xFFE1
                && offset + 10 < length
                && jpeg[offset + 4] == 'E' && jpeg[offset + 5] == 'x'
                && jpeg[offset + 6] == 'i' && jpeg[offset + 7] == 'f') {
                // APP1 layout: FF E1 | len(2) | "Exif\0\0"(6) | TIFF header.
                // The identifier is six bytes, not four, so the TIFF header
                // begins at offset+10. The version inherited from the original
                // bridge passed offset+8, landing on the two NUL padding bytes:
                // the byte-order check then failed, and every image was treated
                // as unrotated. Extracting this made it testable, which is how
                // the off-by-two surfaced.
                return parseTiffOrientation(jpeg, offset + 10, offset + 2 + segLen);
            }
            if (segLen < 2) break;         // corrupt length; stop rather than loop
            offset += 2 + segLen;
            if (marker == 0xFFDA) break;   // start of scan: no metadata beyond here
        }
        return 1;
    }

    private static int parseTiffOrientation(byte[] data, int tiffStart, int end) {
        if (tiffStart + 8 > end || tiffStart + 8 > data.length) return 1;
        boolean littleEndian = data[tiffStart] == 'I' && data[tiffStart + 1] == 'I';
        int ifdOffset = readInt(data, tiffStart + 4, littleEndian, 4) + tiffStart;
        if (ifdOffset < tiffStart + 8 || ifdOffset + 2 > end) return 1;

        int entries = readInt(data, ifdOffset, littleEndian, 2);
        int ifdPtr = ifdOffset + 2;
        for (int i = 0; i < entries && ifdPtr + 12 <= end; i++) {
            int tag = readInt(data, ifdPtr, littleEndian, 2);
            int type = readInt(data, ifdPtr + 2, littleEndian, 2);
            int count = readInt(data, ifdPtr + 4, littleEndian, 4);
            if (tag == 0x0112 && type == 3 && count == 1) {
                return readInt(data, ifdPtr + 8, littleEndian, 2);
            }
            ifdPtr += 12;
        }
        return 1;
    }

    /** Reads an unsigned integer, treating out-of-range bytes as zero. */
    static int readInt(byte[] data, int offset, boolean littleEndian, int numBytes) {
        int value = 0;
        for (int i = 0; i < numBytes; i++) {
            int b = (offset + i >= 0 && offset + i < data.length) ? (data[offset + i] & 0xFF) : 0;
            if (littleEndian) value |= b << (i * 8);
            else value = (value << 8) | b;
        }
        return value;
    }
}
