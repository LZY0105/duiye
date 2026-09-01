package com.latexsnipper.app.ocr;

import android.content.ContentValues;
import android.content.Context;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.provider.MediaStore;
import android.util.Base64;
import android.util.Log;

import java.io.File;
import java.io.FileOutputStream;
import java.io.OutputStream;
import java.util.Locale;

/**
 * Saves exported files to the device's Downloads folder (rectification P1-01).
 *
 * Extracted from NativeOcrBridge. Two storage models are handled because they
 * are genuinely different APIs, not merely different versions: Android 10+
 * writes through MediaStore (no storage permission needed, and the file appears
 * in the Files app), while older releases write directly to external storage.
 */
final class DownloadExporter {

    private static final String TAG = "DownloadExporter";

    private final Context context;

    DownloadExporter(Context context) {
        this.context = context.getApplicationContext();
    }

    /** Pure and testable: extension → MIME type, defaulting to binary. */
    static String guessMimeType(String filename) {
        String lower = filename == null ? "" : filename.toLowerCase(Locale.ROOT);
        if (lower.endsWith(".png")) return "image/png";
        if (lower.endsWith(".svg")) return "image/svg+xml";
        if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
        if (lower.endsWith(".txt")) return "text/plain";
        if (lower.endsWith(".md")) return "text/markdown";
        if (lower.endsWith(".pdf")) return "application/pdf";
        if (lower.endsWith(".zip")) return "application/zip";
        if (lower.endsWith(".json")) return "application/json";
        return "application/octet-stream";
    }

    /**
     * @return "ok", or an "error: …" string the web layer already understands,
     *         plus the byte count written for logging
     */
    Result save(String base64Data, String filename) {
        try {
            byte[] decoded = Base64.decode(base64Data, Base64.DEFAULT);
            String mimeType = guessMimeType(filename);

            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                return saveViaMediaStore(decoded, filename, mimeType);
            }
            return saveToExternalStorage(decoded, filename);
        } catch (Exception e) {
            Log.e(TAG, "save failed", e);
            return Result.error("error: " + e.getMessage());
        }
    }

    private Result saveViaMediaStore(byte[] data, String filename, String mimeType) throws Exception {
        ContentValues values = new ContentValues();
        values.put(MediaStore.Downloads.DISPLAY_NAME, filename);
        values.put(MediaStore.Downloads.MIME_TYPE, mimeType);
        values.put(MediaStore.Downloads.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS);
        // IS_PENDING hides a half-written file from other apps until complete.
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            values.put(MediaStore.Downloads.IS_PENDING, 1);
        }

        Uri uri = context.getContentResolver()
            .insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values);
        if (uri == null) return Result.error("error: ContentResolver insert returned null");

        try (OutputStream os = context.getContentResolver().openOutputStream(uri)) {
            if (os == null) return Result.error("error: openOutputStream null");
            os.write(data);
            os.flush();
        }

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            values.clear();
            values.put(MediaStore.Downloads.IS_PENDING, 0);
            context.getContentResolver().update(uri, values, null, null);
        }
        return Result.ok(filename, data.length);
    }

    private Result saveToExternalStorage(byte[] data, String filename) throws Exception {
        File dir = Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS);
        if (!dir.exists()) dir.mkdirs();
        File out = new File(dir, filename);
        try (FileOutputStream fos = new FileOutputStream(out)) {
            fos.write(data);
        }
        return Result.ok(out.getAbsolutePath(), data.length);
    }

    /** Outcome plus enough detail for the caller to log it meaningfully. */
    static final class Result {
        final String status;
        final String detail;
        final int bytes;

        private Result(String status, String detail, int bytes) {
            this.status = status;
            this.detail = detail;
            this.bytes = bytes;
        }

        static Result ok(String detail, int bytes) { return new Result("ok", detail, bytes); }
        static Result error(String message) { return new Result(message, message, 0); }

        boolean isOk() { return "ok".equals(status); }
    }
}
