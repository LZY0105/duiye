package com.latexsnipper.app.ocr;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

/**
 * Tests for the layout heuristics extracted from OcrEngine.
 *
 * These decide whether two bands of ink are one line or two, which changes what
 * the recogniser is asked to read — a wrong split turns a fraction into two
 * unrelated lines. They were previously unreachable from a test, buried in a
 * 1636-line class that needs a loaded ONNX session to construct.
 */
public class LayoutGeometryTest {

    /** Builds an occupancy mask and fills a rectangle with ink. */
    private static boolean[] mask(int width, int height, int[]... rects) {
        boolean[] m = new boolean[width * height];
        for (int[] r : rects) {
            for (int y = r[1]; y <= r[3]; y++) {
                for (int x = r[0]; x <= r[2]; x++) m[y * width + x] = true;
            }
        }
        return m;
    }

    // ── continuousColsThroughGap ──────────────────────────────────────────

    @Test
    public void aBlankGapBetweenTwoLinesHasNoColumnsCrossingIt() {
        // Two separate bands with a clear gap at rows 10..19.
        boolean[] m = mask(100, 40, new int[]{0, 0, 99, 9}, new int[]{0, 20, 99, 39});
        assertEquals(0, LayoutGeometry.continuousColsThroughGap(10, 19, 100, m));
    }

    @Test
    public void aFractionBarKeepsItsColumnsInkedThroughTheGap() {
        // A vertical stroke running through the gap — the inside of a tall
        // structure, not a line break.
        boolean[] m = mask(100, 40,
            new int[]{0, 0, 99, 9},
            new int[]{40, 10, 45, 19},   // stroke crossing the gap
            new int[]{0, 20, 99, 39});
        assertTrue(LayoutGeometry.continuousColsThroughGap(10, 19, 100, m) >= 6);
    }

    @Test
    public void anInvertedGapIsNotAnError() {
        boolean[] m = mask(10, 10);
        assertEquals(0, LayoutGeometry.continuousColsThroughGap(8, 3, 10, m));
    }

    // ── horizontalExtent ──────────────────────────────────────────────────

    @Test
    public void extentFindsTheInkedSpanAndReportsBlankBands() {
        boolean[] m = mask(100, 10, new int[]{20, 0, 60, 9});
        int[] extent = LayoutGeometry.horizontalExtent(0, 9, 100, m);
        assertEquals(20, extent[0]);
        assertEquals(60, extent[1]);
        assertEquals(null, LayoutGeometry.horizontalExtent(0, 9, 100, mask(100, 10)));
    }

    // ── xOverlapRatio ─────────────────────────────────────────────────────

    @Test
    public void aSuperscriptSitsWithinItsBaseSpan() {
        boolean[] m = mask(100, 40,
            new int[]{10, 0, 20, 4},     // small band, inside the base's span
            new int[]{0, 10, 90, 30});   // the base line
        float ratio = LayoutGeometry.xOverlapRatio(0, 4, 10, 30, 100, m);
        assertTrue("expected strong overlap, got " + ratio, ratio > 0.8f);
    }

    @Test
    public void twoSeparateColumnsDoNotOverlap() {
        boolean[] m = mask(100, 40,
            new int[]{0, 0, 30, 10},
            new int[]{60, 20, 95, 30});
        assertEquals(0f, LayoutGeometry.xOverlapRatio(0, 10, 20, 30, 100, m), 1e-6);
    }

    @Test
    public void aBlankBandOverlapsNothing() {
        boolean[] m = mask(100, 40, new int[]{0, 20, 90, 30});
        assertEquals(0f, LayoutGeometry.xOverlapRatio(0, 5, 20, 30, 100, m), 1e-6);
    }

    // ── isFragment ────────────────────────────────────────────────────────

    @Test
    public void aWideTallBandIsAFullLine() {
        boolean[] m = mask(500, 60, new int[]{0, 0, 449, 39});
        assertFalse(LayoutGeometry.isFragment(0, 39, 500, m));
    }

    @Test
    public void narrowOrShortBandsAreFragments() {
        // Too narrow: a stray mark or an exponent.
        boolean[] m1 = mask(500, 60, new int[]{0, 0, 99, 39});
        assertTrue(LayoutGeometry.isFragment(0, 39, 500, m1));

        // Wide enough but only a few pixels tall.
        boolean[] m2 = mask(500, 60, new int[]{0, 0, 449, 5});
        assertTrue(LayoutGeometry.isFragment(0, 5, 500, m2));
    }

    @Test
    public void anEmptyBandIsAFragment() {
        assertTrue(LayoutGeometry.isFragment(0, 5, 500, mask(500, 10)));
    }

    // ── stableSoftmax ─────────────────────────────────────────────────────

    @Test
    public void softmaxProducesADistribution() {
        float[] p = LayoutGeometry.stableSoftmax(new float[]{1f, 1f});
        assertEquals(0.5f, p[0], 1e-6);
        assertEquals(1f, p[0] + p[1], 1e-6);
    }

    @Test
    public void softmaxSurvivesLargeLogits() {
        // Without subtracting the max, exp(800) overflows to Infinity and the
        // result is NaN — which here would silently misclassify a region.
        float[] p = LayoutGeometry.stableSoftmax(new float[]{800f, 799f});
        assertFalse("must not be NaN", Float.isNaN(p[0]));
        assertEquals(1f, p[0] + p[1], 1e-5);
        assertTrue(p[0] > p[1]);
    }

    @Test
    public void softmaxHandlesDegenerateInputWithoutThrowing() {
        // The previous implementation indexed logits[0] and logits[1]
        // unconditionally and would throw on anything shorter.
        assertEquals(0, LayoutGeometry.stableSoftmax(new float[0]).length);
        assertEquals(1f, LayoutGeometry.stableSoftmax(new float[]{5f})[0], 1e-6);
    }
}
