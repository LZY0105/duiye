package com.latexsnipper.app.ocr;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNotEquals;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

/**
 * Pure-JVM tests for AnswerConstraintVerifier (rectification P1-04..P1-07).
 * Exact rational arithmetic only — no floating point, no Android stubs.
 */
public class AnswerConstraintVerifierTest {

    private static String status(String question, String answer) {
        return AnswerConstraintVerifier.verify(question, answer).status;
    }

    // ── NOT_APPLICABLE ──

    @Test
    public void noAnswerIsNotApplicable() {
        assertEquals(AnswerConstraintVerifier.NOT_APPLICABLE,
            status("计算 3 + 4", ""));
        assertEquals(AnswerConstraintVerifier.NOT_APPLICABLE,
            status("解方程 x+1=3", null));
    }

    // ── arithmetic evaluation ──

    @Test
    public void arithmeticExactEvaluation() {
        assertEquals(AnswerConstraintVerifier.VERIFIED, status("计算 3 + 4 \\times 2", "11"));
        assertEquals(AnswerConstraintVerifier.FAILED, status("计算 3 + 4 \\times 2", "14"));
        assertEquals(AnswerConstraintVerifier.VERIFIED, status("计算 (1/2 + 1/3)", "5/6"));
        assertEquals(AnswerConstraintVerifier.VERIFIED, status("计算 0.5 + 0.25", "\\frac{3}{4}"));
        assertEquals(AnswerConstraintVerifier.FAILED, status("计算 1 - 2", "1"));
    }

    // ── linear equations ──

    @Test
    public void linearEquationSingleRoot() {
        assertEquals(AnswerConstraintVerifier.VERIFIED, status("解方程 2x + 1 = 5", "x=2"));
        assertEquals(AnswerConstraintVerifier.FAILED, status("解方程 2x + 1 = 5", "x=3"));
        assertEquals(AnswerConstraintVerifier.VERIFIED, status("x = \\frac{6}{4}", "3/2"));
        assertEquals(AnswerConstraintVerifier.VERIFIED, status("解方程 3x - 4 = -19", "-5"));
    }

    // ── quadratic equations ──

    @Test
    public void quadraticWithRationalRoots() {
        // x^2 - 3x + 2 = 0 → roots {1, 2}
        assertEquals(AnswerConstraintVerifier.VERIFIED,
            status("解方程 x^2 - 3x + 2 = 0（求全部解）", "{1, 2}"));
        assertEquals(AnswerConstraintVerifier.VERIFIED,
            status("解方程 x^2 - 3x + 2 = 0（求全部解）", "{2,1}")); // order free
        assertEquals(AnswerConstraintVerifier.FAILED,
            status("解方程 x^2 - 3x + 2 = 0（求全部解）", "{1, 3}")); // wrong set
        assertEquals(AnswerConstraintVerifier.FAILED,
            status("解方程 x^2 - 3x + 2 = 0（求全部解）", "{1}"));     // missing solution
        assertEquals(AnswerConstraintVerifier.FAILED,
            status("解方程 x^2 - 3x + 2 = 0（求全部解）", "{1, 2, 3}")); // extra solution
    }

    @Test
    public void multiSolutionIntentRules() {
        // Explicit "one solution" wording allows membership.
        assertEquals(AnswerConstraintVerifier.VERIFIED,
            status("解方程 x^2 - 3x + 2 = 0，求其中一个解", "2"));
        // Explicit "all solutions" wording with single value fails.
        assertEquals(AnswerConstraintVerifier.FAILED,
            status("解方程 x^2 - 3x + 2 = 0，求所有解", "2"));
        // Ambiguous intent is UNSUPPORTED, never silently membership-checked.
        assertEquals(AnswerConstraintVerifier.UNSUPPORTED,
            status("解方程 x^2 - 3x + 2 = 0", "2"));
        // Double root counts as a unique solution.
        assertEquals(AnswerConstraintVerifier.VERIFIED,
            status("解方程 x^2 - 4x + 4 = 0", "2"));
    }

    @Test
    public void irrationalRootsAreUnsupportedNotFailed() {
        // x^2 - 2 = 0 → ±√2 outside exact-rational scope.
        assertEquals(AnswerConstraintVerifier.UNSUPPORTED,
            status("解方程 x^2 - 2 = 0", "1.41"));
        assertEquals(AnswerConstraintVerifier.UNSUPPORTED,
            status("解方程 x^2 + x + 1 = 0", "0"));
    }

    // ── equivalence normalization ──

    @Test
    public void equivalentFormsNormalize() {
        assertEquals(AnswerConstraintVerifier.VERIFIED, status("x = 0.5", "\\frac{1}{2}"));
        assertEquals(AnswerConstraintVerifier.VERIFIED, status("x = \\frac{50}{100}", "1/2"));
        assertEquals(AnswerConstraintVerifier.VERIFIED, status("x = -0.75", "-\\frac{3}{4}"));
    }

    // ── out-of-scope questions ──

    @Test
    public void outOfScopeReturnsUnsupported() {
        assertEquals(AnswerConstraintVerifier.UNSUPPORTED, status("\\sqrt{2} + x = 3", "1"));
        assertEquals(AnswerConstraintVerifier.UNSUPPORTED, status("\\sin(x) = 1", "90"));
        assertEquals(AnswerConstraintVerifier.UNSUPPORTED, status("x^3 = 8", "2"));
        assertEquals(AnswerConstraintVerifier.UNSUPPORTED, status("x > 3", "4"));
    }

    // ── natural-language stems (rectification P0-04) ──

    @Test
    public void chineseStemsAreStrippedSafely() {
        assertEquals(AnswerConstraintVerifier.VERIFIED, status("计算 3 + 4。", "7"));
        assertEquals(AnswerConstraintVerifier.VERIFIED, status("解方程 x + 1 = 2？", "1"));
        assertEquals(AnswerConstraintVerifier.VERIFIED, status("解方程：x + 1 = 2", "x=1"));
        assertEquals(AnswerConstraintVerifier.FAILED, status("计算：5 - 8。", "-4"));
    }

    @Test
    public void parentheticalAnnotationsAreRemovedBeforeParsing() {
        assertEquals(AnswerConstraintVerifier.VERIFIED,
            status("解方程 x + 1 = 2（求一个解）", "1"));
        assertEquals(AnswerConstraintVerifier.VERIFIED,
            status("x^2 - 3x + 2 = 0（求全部解）", "{1, 2}"));
    }

    @Test
    public void unstrippableStemIsUnsupportedNotGuessed() {
        assertEquals(AnswerConstraintVerifier.UNSUPPORTED,
            status("已知 a、b 满足 a+b=3 且 a-b=1，求 ab 的值", "2"));
    }

    // ── fractional discriminant (rectification P0 六) ──

    @Test
    public void fractionalDiscriminantIsHandledExactly() {
        // (1/2)x² - (3/2)x + 1 = 0 → disc = 9/4 - 2 = 1/4 → √disc = 1/2 → roots {1, 2}
        assertEquals(AnswerConstraintVerifier.VERIFIED,
            status("\\frac{1}{2}x^2 - \\frac{3}{2}x + 1 = 0（求全部解）", "{1, 2}"));
        assertEquals(AnswerConstraintVerifier.FAILED,
            status("\\frac{1}{2}x^2 - \\frac{3}{2}x + 1 = 0（求全部解）", "{1, 3}"));
    }

    @Test
    public void subtractionAcrossSignsAndZero() {
        assertEquals(AnswerConstraintVerifier.VERIFIED, status("计算 0 - 5", "-5"));
        assertEquals(AnswerConstraintVerifier.VERIFIED, status("计算 -3 - (-3)", "0"));
        assertEquals(AnswerConstraintVerifier.VERIFIED, status("计算 \\frac{1}{4} - \\frac{3}{4}", "-\\frac{1}{2}"));
    }

    @Test
    public void unparseableAnswerIsUnsupportedOrErrorNeverVerified() {
        String s1 = status("解方程 x + 1 = 3", "这是一段文字答案");
        assertTrue(s1.equals(AnswerConstraintVerifier.UNSUPPORTED) || s1.equals(AnswerConstraintVerifier.ERROR));
        String s2 = status("解方程 x + 1 = 3", "x === ");
        assertTrue(s2.equals(AnswerConstraintVerifier.UNSUPPORTED) || s2.equals(AnswerConstraintVerifier.ERROR));
    }

    // ── result contract ──

    @Test
    public void resultCarriesVersionTypeAndMethod() {
        AnswerConstraintVerifier.Result r =
            AnswerConstraintVerifier.verify("解方程 2x + 1 = 5", "x=2");
        assertEquals(AnswerConstraintVerifier.VERIFIED, r.status);
        assertEquals(AnswerConstraintVerifier.VERSION, r.verifierVersion);
        assertEquals("LINEAR_EQUATION", r.questionType);
        assertEquals("EXACT_RATIONAL_SUBSTITUTION", r.method);
        assertEquals("2", r.normalizedAnswer);
    }

    @Test
    public void setResultCarriesNormalizedSet() {
        AnswerConstraintVerifier.Result r =
            AnswerConstraintVerifier.verify("x^2 - 3x + 2 = 0（求全部解）", "{2, 1}");
        assertEquals(AnswerConstraintVerifier.VERIFIED, r.status);
        assertEquals("{2, 1}", r.normalizedAnswer);
    }

    /**
     * A side that does not parse completely must never be VERIFIED.
     *
     * The parser stops at the first token it cannot use. Without an explicit
     * end-of-input check the remainder was silently discarded, so "x)=2" was
     * read as "x", solved as x=2, and approved — a malformed question earning a
     * verdict it does not deserve.
     */
    @Test
    public void leftoverInputOnEitherSideIsNeverVerified() {
        for (String question : new String[]{
            "x)=2",          // stray closing bracket
            "x=2)",          // stray bracket on the answer side
            "2x+1=5 5",      // trailing token
            "x=2=3",         // handled earlier, but must not be VERIFIED
        }) {
            String status = status(question, "2");
            assertNotEquals("must not verify malformed input: " + question,
                AnswerConstraintVerifier.VERIFIED, status);
        }
    }

    @Test
    public void wellFormedEquationsStillVerify() {
        // The end-of-input check must not reject legitimate spacing or brackets.
        assertEquals(AnswerConstraintVerifier.VERIFIED, status("(2x + 1) = 5", "2"));
        assertEquals(AnswerConstraintVerifier.VERIFIED, status(" 2x+1 = 5 ", "2"));
    }

    @Test
    public void divisionByZeroBecomesErrorNotCrash() {
        String s = status("计算 1 ÷ 0", "5");
        assertTrue(s.equals(AnswerConstraintVerifier.ERROR) || s.equals(AnswerConstraintVerifier.UNSUPPORTED));
    }
}
