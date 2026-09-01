package com.latexsnipper.app.ocr;

/**
 * Pure geometry over an occupancy mask, used to split a page into lines and
 * regions (rectification P1-01, applied to OcrEngine).
 *
 * Extracted from OcrEngine, where 1636 lines mixed model loading, inference,
 * pixel analysis, layout heuristics, result formatting and tensor access.
 *
 * Everything here operates on a {@code boolean[]} occupancy mask in row-major
 * order rather than on a Bitmap, so it has no Android dependency and is
 * unit-testable in a plain JVM. These are the layout heuristics that decide
 * whether two bands of ink are one line or two — worth being able to test
 * directly, since a wrong split changes what the recogniser is asked to read.
 */
final class LayoutGeometry {

    private LayoutGeometry() { }

    /** Content bounds must be at least this wide to count as a full line. */
    static final int MIN_FULL_LINE_WIDTH = 300;
    /** …and at least this tall. */
    static final int MIN_FULL_LINE_HEIGHT = 20;

    /**
     * Columns whose ink runs through a horizontal gap.
     *
     * A gap crossed by many columns is not a line break — it is the inside of a
     * tall structure such as a fraction, matrix or large bracket, where the
     * blank band between numerator and denominator would otherwise look exactly
     * like the space between two lines.
     *
     * A column counts when it is inked through at least 30% of the gap, which
     * tolerates antialiasing without admitting stray specks.
     */
    static int continuousColsThroughGap(int gapY1, int gapY2, int width, boolean[] hasContent) {
        if (gapY1 > gapY2) return 0;
        int gapHeight = gapY2 - gapY1 + 1;
        int needed = Math.max(1, gapHeight * 3 / 10);
        int crossing = 0;
        for (int x = 0; x < width; x++) {
            int inked = 0;
            for (int y = gapY1; y <= gapY2; y++) {
                if (hasContent[y * width + x]) inked++;
            }
            if (inked >= needed) crossing++;
        }
        return crossing;
    }

    /** Horizontal extent of the ink in a band, or null when the band is blank. */
    static int[] horizontalExtent(int y1, int y2, int width, boolean[] hasContent) {
        int x1 = width;
        int x2 = 0;
        for (int y = y1; y <= y2; y++) {
            int row = y * width;
            for (int x = 0; x < width; x++) {
                if (hasContent[row + x]) {
                    if (x < x1) x1 = x;
                    if (x > x2) x2 = x;
                }
            }
        }
        return x1 <= x2 ? new int[]{ x1, x2 } : null;
    }

    /**
     * How much two bands overlap horizontally, as a fraction of the narrower.
     *
     * Used to decide whether a small band belongs to the line above it: a
     * superscript sits within its base's span, whereas a genuinely separate
     * line usually starts at the margin.
     */
    static float xOverlapRatio(int y1a, int y2a, int y1b, int y2b, int width, boolean[] hasContent) {
        int[] a = horizontalExtent(y1a, y2a, width, hasContent);
        int[] b = horizontalExtent(y1b, y2b, width, hasContent);
        if (a == null || b == null) return 0;
        int aWidth = a[1] - a[0] + 1;
        int bWidth = b[1] - b[0] + 1;
        if (aWidth <= 1 || bWidth <= 1) return 0;

        int left = Math.max(a[0], b[0]);
        int right = Math.min(a[1], b[1]);
        if (left >= right) return 0;
        return (float) (right - left) / Math.min(aWidth, bWidth);
    }

    /**
     * True when a band is too small to be a line of its own — a stray mark, an
     * exponent, or the dot of an "i" separated by the row scan.
     */
    static boolean isFragment(int y1, int y2, int width, boolean[] hasContent) {
        int[] extent = horizontalExtent(y1, y2, width, hasContent);
        int bandWidth = extent == null ? 1 : extent[1] - extent[0] + 1;
        return bandWidth < MIN_FULL_LINE_WIDTH || (y2 - y1 + 1) < MIN_FULL_LINE_HEIGHT;
    }

    /**
     * Numerically stable softmax.
     *
     * The maximum is subtracted before exponentiating: a logit around 800 would
     * otherwise overflow to Infinity and yield NaN probabilities, which here
     * would silently misclassify a region as formula or text.
     */
    static float[] stableSoftmax(float[] logits) {
        if (logits == null || logits.length == 0) return new float[0];
        float max = Float.NEGATIVE_INFINITY;
        for (float v : logits) if (v > max) max = v;

        float sum = 0f;
        float[] out = new float[logits.length];
        for (int i = 0; i < logits.length; i++) {
            out[i] = (float) Math.exp(logits[i] - max);
            sum += out[i];
        }
        if (sum <= 0f) return out;
        for (int i = 0; i < out.length; i++) out[i] /= sum;
        return out;
    }
}
