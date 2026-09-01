package com.latexsnipper.app.ocr;

import org.json.JSONObject;

import java.io.File;

/** Backend seam for local, text-only question modification. */
interface QuestionModifierBackend {
    String id();

    String format();

    boolean supportsPackage(File modelDir);

    boolean isRuntimeAvailable();

    /**
     * Generates against an already-validated package.
     *
     * The descriptor is supplied by the caller rather than re-read here: it was
     * previously loaded and parsed up to three times per request (selection,
     * admission, then generation), and each adapter was free to disagree about
     * what the package declared. It is never null — selection rejects packages
     * without a valid descriptor before reaching this point.
     */
    String generate(File modelDir, QuestionModelDescriptor descriptor, JSONObject request) throws Exception;
}
