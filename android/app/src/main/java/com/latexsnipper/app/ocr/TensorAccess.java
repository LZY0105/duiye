package com.latexsnipper.app.ocr;

import ai.onnxruntime.OnnxTensor;
import ai.onnxruntime.OrtSession;

import java.nio.FloatBuffer;

/**
 * Reading values out of an ONNX Runtime result.
 *
 * Extracted from OcrEngine, which carried FOUR of these: tensorData and
 * tensorDataStatic were byte-identical, as were tensorShape and
 * tensorShapeStatic. The pair existed only because some call sites were static
 * and some were not — an accessibility problem solved by duplicating the body
 * rather than by moving it somewhere both could reach.
 */
final class TensorAccess {

    private TensorAccess() { }

    /** Copies a named float output into a plain array. */
    static float[] data(OrtSession.Result result, String name) {
        FloatBuffer buf = ((OnnxTensor) result.get(name).get()).getFloatBuffer();
        float[] out = new float[buf.remaining()];
        buf.get(out);
        return out;
    }

    /** Shape of a named output. */
    static long[] shape(OrtSession.Result result, String name) {
        return ((OnnxTensor) result.get(name).get()).getInfo().getShape();
    }
}
