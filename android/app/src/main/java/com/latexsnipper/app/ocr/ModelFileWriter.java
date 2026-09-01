package com.latexsnipper.app.ocr;

import android.content.Context;
import android.util.Base64;
import android.util.Log;

import java.io.File;
import java.io.FileOutputStream;

/**
 * Chunked model-file writing (rectification P1-01).
 *
 * Model packages are hundreds of megabytes, so the web layer streams them in
 * base64 chunks rather than materialising one enormous string. Extracted from
 * NativeOcrBridge so the path-safety rules can be stated — and tested — in one
 * place rather than inline among unrelated bridge methods.
 *
 * The path rules matter: category, variantId and filename all come from the web
 * layer and are concatenated into a filesystem path, so without validation a
 * crafted value could escape the models directory entirely.
 */
final class ModelFileWriter {

    private static final String TAG = "ModelFileWriter";

    private final Context context;
    private FileOutputStream stream;

    ModelFileWriter(Context context) {
        this.context = context.getApplicationContext();
    }

    /**
     * Rejects a path segment that could escape its parent directory.
     *
     * Package-visible and static so it is unit-testable without a Context —
     * this is the check that stops "../../databases" from being a valid
     * category name.
     */
    static boolean isSafeSegment(String value) {
        return value != null
            && !value.isEmpty()
            && !value.contains("/")
            && !value.contains("\\")
            && !value.equals(".")
            && !value.equals("..")
            && value.indexOf('\0') < 0;
    }

    static void requireSafeSegment(String value, String label) {
        if (!isSafeSegment(value)) {
            throw new IllegalArgumentException("MODEL_PATH_INVALID_" + label);
        }
    }

    File modelsRoot() {
        return new File(context.getFilesDir(), "models");
    }

    /**
     * Opens a file for writing under models/{category}/{variantId}/{filename}.
     * @return "ok", or an "error:…" string the web layer already understands
     */
    String begin(String category, String variantId, String filename) {
        try {
            requireSafeSegment(category, "category");
            requireSafeSegment(variantId, "variantId");
            requireSafeSegment(filename, "filename");

            File root = modelsRoot();
            File dir = new File(root, category + "/" + variantId);
            File file = new File(dir, filename);

            // Belt and braces after the segment checks: confirm the resolved
            // path really does sit inside models/.
            String rootPath = root.getCanonicalPath() + File.separator;
            if (!file.getCanonicalPath().startsWith(rootPath)) {
                return "error:MODEL_PATH_OUTSIDE_ROOT";
            }

            // A stream left open by an abandoned upload would leak its file
            // descriptor when this overwrote the field.
            close();
            dir.mkdirs();
            stream = new FileOutputStream(file);
            return "ok";
        } catch (Exception e) {
            Log.e(TAG, "begin failed: " + e.getMessage());
            return "error:" + e.getMessage();
        }
    }

    String writeChunk(String base64Chunk) {
        if (stream == null) return "error:no stream";
        try {
            stream.write(Base64.decode(base64Chunk, Base64.NO_WRAP));
            return "ok";
        } catch (Exception e) {
            Log.e(TAG, "writeChunk failed: " + e.getMessage());
            return "error:" + e.getMessage();
        }
    }

    String finish() {
        try {
            if (stream != null) {
                stream.flush();
                stream.close();
            }
            return "ok";
        } catch (Exception e) {
            Log.e(TAG, "finish failed: " + e.getMessage());
            return "error:" + e.getMessage();
        } finally {
            // Cleared even when flush/close throws; leaving it set meant the
            // next chunk kept appending to a broken stream.
            stream = null;
        }
    }

    /** Closes any open stream, swallowing close failures. */
    void close() {
        if (stream == null) return;
        try {
            stream.close();
        } catch (Exception e) {
            Log.w(TAG, "closing stale stream failed: " + e.getMessage());
        } finally {
            stream = null;
        }
    }
}
