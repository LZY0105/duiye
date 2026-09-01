package com.latexsnipper.app.ocr;

import java.math.BigInteger;
import java.util.ArrayList;
import java.util.List;

/**
 * Deterministic answer-constraint verifier (rectification P1-03..P1-07).
 *
 * Verifies that a generated question still has the user's answer as its correct
 * answer. Pure JVM, no Android dependencies, no model self-assessment involved.
 *
 * First-version scope (everything else returns UNSUPPORTED):
 * - integers, signs, finite decimals, a/b fractions, \frac{a}{b};
 * - parentheses and + - * / arithmetic (also × ÷ · \\times \\cdot);
 * - single-variable (x) linear and quadratic equations, including x^2;
 * - equivalence normalization: 1/2 == 0.5 == \frac{1}{2}.
 *
 * Multi-solution rule: a set-shaped answer is compared as a full solution set
 * (normalized, deduplicated, order-free). A single-value answer against an
 * equation with multiple distinct roots requires explicit "one solution"
 * wording ("求一个解"/"任一解"…) to allow set membership; "解方程"/"全部解"
 * wording with a single value fails; without any wording the result is
 * UNSUPPORTED. Floating point equality is never used — all arithmetic runs on
 * exact BigInteger rationals.
 */
public final class AnswerConstraintVerifier {

    public static final String VERSION = "answer-verifier-v1";

    public static final String VERIFIED = "VERIFIED";
    public static final String FAILED = "FAILED";
    public static final String UNSUPPORTED = "UNSUPPORTED";
    public static final String ERROR = "ERROR";
    public static final String NOT_APPLICABLE = "NOT_APPLICABLE";

    /** Structured verification outcome. */
    public static final class Result {
        public final String status;
        public final String verifierVersion = VERSION;
        public final String questionType;   // ARITHMETIC | LINEAR_EQUATION | QUADRATIC_EQUATION
        public final String method;         // EXACT_RATIONAL_*
        public final String detail;
        public final String normalizedAnswer; // canonical form of the user answer

        Result(String status, String questionType, String method, String detail) {
            this(status, questionType, method, detail, "");
        }

        Result(String status, String questionType, String method, String detail, String normalizedAnswer) {
            this.status = status;
            this.questionType = questionType == null ? "" : questionType;
            this.method = method == null ? "" : method;
            this.detail = detail == null ? "" : detail;
            this.normalizedAnswer = normalizedAnswer == null ? "" : normalizedAnswer;
        }
    }

    private AnswerConstraintVerifier() { }

    public static Result verify(String modifiedQuestion, String answer) {
        if (answer == null || answer.trim().isEmpty()) {
            return new Result(NOT_APPLICABLE, "", "", "未提供答案，无答案约束");
        }
        try {
            return verifyInternal(modifiedQuestion, answer);
        } catch (UnsupportedMathException e) {
            return new Result(UNSUPPORTED, e.questionType, "", e.getMessage());
        } catch (Throwable t) {
            return new Result(ERROR, "", "", "验证过程异常: " + t.getClass().getSimpleName());
        }
    }

    // ── internal ────────────────────────────────────────────────────────────

    private static final class UnsupportedMathException extends RuntimeException {
        final String questionType;

        UnsupportedMathException(String questionType, String message) {
            super(message);
            this.questionType = questionType == null ? "" : questionType;
        }
    }

    private static UnsupportedMathException unsupported(String questionType, String message) {
        return new UnsupportedMathException(questionType, message);
    }

    private static Result verifyInternal(String modifiedQuestion, String rawAnswer) {
        String question = normalizeText(modifiedQuestion);
        AnswerValue answer = parseAnswer(rawAnswer);
        String canonicalAnswer = canonicalOf(answer);
        String body = extractMathBody(question);

        if (!body.contains("=")) {
            Parser p = new Parser(body, "ARITHMETIC");
            Rational expr = p.parseExpression();
            if (!p.atEnd()) {
                throw unsupported("ARITHMETIC", "表达式含无法解析的剩余内容");
            }
            if (expr == null) {
                throw unsupported("ARITHMETIC", "不是可求解的算术表达式");
            }
            if (answer.isSet) {
                throw unsupported("ARITHMETIC", "算术题不接受集合型答案");
            }
            if (expr.equals(answer.value)) {
                return new Result(VERIFIED, "ARITHMETIC",
                    "EXACT_RATIONAL_EVALUATION", "表达式值精确等于目标答案", canonicalAnswer);
            }
            return new Result(FAILED, "ARITHMETIC",
                "EXACT_RATIONAL_EVALUATION", "表达式值 " + expr + " 不等于目标答案 " + answer.value, canonicalAnswer);
        }

        String[] sides = body.split("=");
        if (sides.length != 2) {
            throw unsupported("", "不支持多段等式或包含比较符的题目");
        }
        // Each side must be consumed ENTIRELY. Without this, a parser that stops
        // early silently discards the rest: "x)=2" parsed as "x", dropping the
        // stray bracket, and could then be reported VERIFIED. The arithmetic
        // branch above and the answer parser both already check this; the
        // equation branch did not.
        Polynomial left = parseSideFully(sides[0], body);
        Polynomial right = parseSideFully(sides[1], body);
        Polynomial diff = left.subtract(right);

        String type = diff.degree() == 2 ? "QUADRATIC_EQUATION"
            : diff.degree() == 1 ? "LINEAR_EQUATION"
            : diff.degree() == 0 ? "ARITHMETIC" : "";

        List<Rational> roots = solve(diff, type);
        return checkSolutions(roots, answer, question, type, canonicalAnswer);
    }

    /**
     * Safely extracts the verifiable math body from a natural-language stem
     * (rectification P0-04). Only removes meta annotations in parentheses and
     * leading/trailing prompt text; if any natural-language text remains that
     * could change semantics, the question is UNSUPPORTED instead of guessed.
     */
    /**
     * Parses one side of an equation, requiring the whole side to be consumed.
     *
     * Refusing leftover input is the difference between "I could not read this"
     * and "I read part of this and assumed the rest away" — the second is how a
     * malformed question earns a VERIFIED verdict it does not deserve.
     */
    private static Polynomial parseSideFully(String side, String context) {
        Parser parser = new Parser(side, context);
        Polynomial polynomial = parser.parsePolynomial();
        if (!parser.atEnd()) {
            throw unsupported("", "等式一侧含无法解析的剩余内容: " + side);
        }
        return polynomial;
    }

    static String extractMathBody(String question) {
        String t = stripAnnotationGroups(question, '（', '）');
        t = stripAnnotationGroups(t, '(', ')');
        t = t.replace('＝', '=').replace('－', '-').replace('＋', '+')
             .replace('（', '(').replace('）', ')')
             .replace('：', ':').replace('？', '?').replace('！', '!');
        int start = -1;
        for (int i = 0; i < t.length(); i++) {
            if (isMathChar(t.charAt(i))) {
                start = i;
                break;
            }
        }
        if (start < 0) {
            throw unsupported("", "题干中未找到可验证的数学主体");
        }
        int end = t.length();
        while (end > start && !isMathChar(t.charAt(end - 1))) {
            end--;
        }
        String body = t.substring(start, end).trim();
        for (int i = 0; i < body.length(); i++) {
            char c = body.charAt(i);
            if (isCjk(c) || c == '?' || c == '!' || c == ':' || c == '；' || c == '、') {
                throw unsupported("", "题干含无法安全剥离的自然语言文本，拒绝猜测数学主体");
            }
        }
        return body;
    }

    /**
     * Removes only parenthesised natural-language annotations, e.g. （求全部解）.
     *
     * A group qualifies as an annotation solely when its content carries CJK text.
     * Purely mathematical groups such as {@code (1/2 + 1/3)} or {@code (-3)} are
     * structural and must survive verbatim — deleting them silently changed the
     * arithmetic of the question (rectification P0-02). Unbalanced or nested
     * groups are left untouched so the downstream parser reports them honestly
     * rather than this pass guessing.
     */
    private static String stripAnnotationGroups(String text, char open, char close) {
        StringBuilder out = new StringBuilder(text.length());
        int i = 0;
        while (i < text.length()) {
            char c = text.charAt(i);
            if (c != open) {
                out.append(c);
                i++;
                continue;
            }
            int closeAt = text.indexOf(close, i + 1);
            if (closeAt < 0) {           // unbalanced — keep, let the parser complain
                out.append(c);
                i++;
                continue;
            }
            String inner = text.substring(i + 1, closeAt);
            if (inner.indexOf(open) >= 0) { // nested — out of this pass's scope
                out.append(c);
                i++;
                continue;
            }
            if (containsCjk(inner)) {
                i = closeAt + 1;          // annotation: drop it
            } else {
                out.append(text, i, closeAt + 1); // math: keep it
                i = closeAt + 1;
            }
        }
        return out.toString();
    }

    private static boolean containsCjk(String s) {
        for (int i = 0; i < s.length(); i++) {
            if (isCjk(s.charAt(i))) return true;
        }
        return false;
    }

    private static boolean isMathChar(char c) {
        return (c >= '0' && c <= '9') || (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z')
            || c == '\\' || c == '(' || c == ')' || c == '{' || c == '}'
            || c == '+' || c == '-' || c == '*' || c == '/' || c == '^'
            || c == '=' || c == '.' || c == '×' || c == '÷' || c == '·';
    }

    private static boolean isCjk(char c) {
        Character.UnicodeBlock block = Character.UnicodeBlock.of(c);
        return block == Character.UnicodeBlock.CJK_UNIFIED_IDEOGRAPHS
            || block == Character.UnicodeBlock.CJK_UNIFIED_IDEOGRAPHS_EXTENSION_A
            || block == Character.UnicodeBlock.CJK_COMPATIBILITY_IDEOGRAPHS;
    }

    private static String canonicalOf(AnswerValue answer) {
        if (!answer.isSet) {
            return answer.value.toString();
        }
        StringBuilder sb = new StringBuilder("{");
        for (int i = 0; i < answer.setValues.size(); i++) {
            if (i > 0) sb.append(", ");
            sb.append(answer.setValues.get(i));
        }
        return sb.append("}").toString();
    }

    private static List<Rational> solve(Polynomial poly, String type) {
        if (poly.isZeroPolynomial()) {
            throw unsupported(type, "恒等式（0=0）没有确定解集");
        }
        int deg = poly.degree();
        if (deg == 0) {
            return new ArrayList<>(); // contradiction like 0x+1=2 → no solution
        }
        if (deg == 1) {
            List<Rational> roots = new ArrayList<>();
            // a*x + b = 0 → x = -b/a
            Rational a = poly.coefficient(1);
            Rational b = poly.coefficient(0);
            if (a.isZero()) throw unsupported(type, "一次项系数为零");
            roots.add(b.negate().divide(a));
            return roots;
        }
        if (deg == 2) {
            Rational a = poly.coefficient(2);
            Rational b = poly.coefficient(1);
            Rational c = poly.coefficient(0);
            // Discriminant b^2-4ac must be a perfect square for rational roots;
            // irrational or complex roots are outside first-version scope.
            Rational disc = b.multiply(b).subtract(a.multiply(c).multiply(Rational.of(4)));
            if (disc.sign() < 0) {
                throw unsupported(type, "判别式为负（复数根超出第一版范围）");
            }
            Rational sqrtDisc = disc.perfectSquareRootOrNull();
            if (sqrtDisc == null) {
                throw unsupported(type, "判别式不是完全平方数（无理根超出第一版范围）");
            }
            Rational twoA = a.multiply(Rational.of(2));
            List<Rational> roots = new ArrayList<>();
            roots.add(b.negate().add(sqrtDisc).divide(twoA));
            roots.add(b.negate().add(sqrtDisc.negate()).divide(twoA));
            return roots;
        }
        throw unsupported(type, "多项式次数 " + deg + " 超出一次/二次范围");
    }

    private static Result checkSolutions(List<Rational> roots, AnswerValue answer,
                                         String question, String type, String canonicalAnswer) {
        // Intent must come from explicit quantifier wording only. A bare "解方程"
        // states the task, not how many roots are wanted, so treating it as "all
        // solutions" made 求一个解 unreachable and silently failed valid answers
        // (rectification P0-02). Absent both, the outcome is UNSUPPORTED below.
        boolean asksOneSolution = containsAny(question, "一个解", "一个根", "任一解", "任一根", "任意一个解", "任意解");
        boolean asksAllSolutions = containsAny(question, "全部解", "全部的解", "所有解", "所有的解", "全部根", "所有根");

        if (answer.isSet) {
            // Set answer ⇒ claim of a complete solution set (dedup + order free).
            List<Rational> uniqueRoots = dedupe(roots);
            if (uniqueRoots.size() != answer.setValues.size()) {
                return new Result(FAILED, type, "EXACT_RATIONAL_ROOT_SET_COMPARE",
                    "解集大小不一致: 题目 " + uniqueRoots.size() + " 个解 vs 答案 " + answer.setValues.size() + " 个值", canonicalAnswer);
            }
            boolean allMatch = true;
            List<Rational> remaining = new ArrayList<>(answer.setValues);
            for (Rational root : uniqueRoots) {
                if (!remaining.remove(root)) {
                    allMatch = false;
                    break;
                }
            }
            if (allMatch) {
                return new Result(VERIFIED, type, "EXACT_RATIONAL_ROOT_SET_COMPARE",
                    "完整解集精确相等（规范化、去重、无序比较）", canonicalAnswer);
            }
            return new Result(FAILED, type, "EXACT_RATIONAL_ROOT_SET_COMPARE",
                "解集元素不完全相等", canonicalAnswer);
        }

        // Single-value answer.
        List<Rational> uniqueRoots = dedupe(roots);
        if (uniqueRoots.isEmpty()) {
            return new Result(FAILED, type, "EXACT_RATIONAL_SUBSTITUTION", "题目无解，与答案矛盾", canonicalAnswer);
        }
        if (uniqueRoots.size() == 1) {
            boolean match = uniqueRoots.get(0).equals(answer.value);
            return match
                ? new Result(VERIFIED, type, "EXACT_RATIONAL_SUBSTITUTION", "唯一解精确等于目标答案", canonicalAnswer)
                : new Result(FAILED, type, "EXACT_RATIONAL_SUBSTITUTION",
                    "唯一解 " + uniqueRoots.get(0) + " 不等于目标答案 " + answer.value, canonicalAnswer);
        }
        // Multiple distinct roots + single-value answer: intent must be stated.
        if (asksOneSolution && !asksAllSolutions) {
            boolean member = uniqueRoots.contains(answer.value);
            return member
                ? new Result(VERIFIED, type, "EXACT_RATIONAL_SET_MEMBERSHIP", "目标答案是解集中的一个解（题目要求求一个解）", canonicalAnswer)
                : new Result(FAILED, type, "EXACT_RATIONAL_SET_MEMBERSHIP", "目标答案不属于该题的解集", canonicalAnswer);
        }
        if (asksAllSolutions) {
            return new Result(FAILED, type, "EXACT_RATIONAL_ROOT_SET_COMPARE",
                "题目要求全部解而答案只给了一个值（缺失其他解）", canonicalAnswer);
        }
        throw unsupported(type, "多解题目且未说明要求一个解还是全部解");
    }

    private static boolean containsAny(String text, String... needles) {
        for (String n : needles) {
            if (text.contains(n)) return true;
        }
        return false;
    }

    private static List<Rational> dedupe(List<Rational> values) {
        List<Rational> out = new ArrayList<>();
        for (Rational v : values) {
            if (!out.contains(v)) out.add(v);
        }
        return out;
    }

    // ── answer parsing ──────────────────────────────────────────────────────

    private static final class AnswerValue {
        final Rational value;          // null when set
        final List<Rational> setValues; // null when single
        final boolean isSet;

        AnswerValue(Rational value) {
            this.value = value;
            this.setValues = null;
            this.isSet = false;
        }

        AnswerValue(List<Rational> setValues) {
            this.value = null;
            this.setValues = setValues;
            this.isSet = true;
        }
    }

    private static AnswerValue parseAnswer(String rawAnswer) {
        String s = normalizeAnswerText(rawAnswer);
        if (s.isEmpty()) throw unsupported("", "答案为空");

        // Strip optional variable prefix per element: x=5 / y=3/4
        List<String> parts = splitAnswerParts(s);
        List<Rational> values = new ArrayList<>();
        for (String part : parts) {
            String p = part.trim();
            // Prefix match (not String.matches, which requires the WHOLE string):
            // accepts x=2, x = -1/2, y=0.5; rejects multi-letter or illegal prefixes.
            java.util.regex.Matcher varPrefix =
                java.util.regex.Pattern.compile("^([a-zA-Z])\\s*=").matcher(p);
            if (varPrefix.find()) {
                p = p.substring(varPrefix.end()).trim();
            } else if (p.contains("=")) {
                throw unsupported("", "答案变量前缀非法: " + part);
            }
            try {
                Parser parser = new Parser(p, "");
                Rational v = parser.parseExpression();
                if (v == null || !parser.atEnd()) {
                    throw unsupported("", "答案片段无法解析为数值: " + part);
                }
                values.add(v);
            } catch (UnsupportedMathException e) {
                throw e;
            } catch (RuntimeException e) {
                throw unsupported("", "答案片段解析失败: " + part);
            }
        }
        if (values.size() > 1) return new AnswerValue(values);
        return new AnswerValue(values.get(0));
    }

    private static List<String> splitAnswerParts(String s) {
        List<String> out = new ArrayList<>();
        String t = s;
        if (t.startsWith("{") && t.endsWith("}")) {
            t = t.substring(1, t.length() - 1);
        } else if (t.startsWith("[") && t.endsWith("]")) {
            t = t.substring(1, t.length() - 1);
        }
        StringBuilder current = new StringBuilder();
        int braceDepth = 0;
        for (int i = 0; i < t.length(); i++) {
            char c = t.charAt(i);
            if (c == '{') braceDepth++;
            if (c == '}') braceDepth--;
            if ((c == ',' || c == '，' || c == ';') && braceDepth == 0) {
                if (current.toString().trim().isEmpty()) {
                    throw unsupported("", "答案集合含空元素");
                }
                out.add(current.toString());
                current.setLength(0);
            } else {
                current.append(c);
            }
        }
        if (current.toString().trim().isEmpty() && !out.isEmpty()) {
            throw unsupported("", "答案集合含空元素");
        }
        out.add(current.toString());
        return out;
    }

    private static String normalizeAnswerText(String s) {
        String t = s == null ? "" : s;
        t = t.replace("\\left", "").replace("\\right", "");
        t = t.replace("$", "").replace(" ", "").replace("\t", "");
        t = t.replace("，", ",");
        return t.trim();
    }

    private static String normalizeText(String s) {
        String t = s == null ? "" : s;
        t = t.replace("\\left", "").replace("\\right", "");
        t = t.replace("$", "");
        t = t.replaceAll("\\s+", "");
        return t;
    }

    // ── exact rational arithmetic ───────────────────────────────────────────

    static final class Rational {
        final BigInteger num; // always normalized, sign carried here
        final BigInteger den; // always positive

        private Rational(BigInteger num, BigInteger den) {
            if (den.signum() == 0) throw new ArithmeticException("division by zero");
            if (num.signum() == 0) {
                this.num = BigInteger.ZERO;
                this.den = BigInteger.ONE;
                return;
            }
            BigInteger gcd = num.gcd(den);
            if (den.signum() < 0) {
                num = num.negate();
                den = den.negate();
            }
            this.num = num.divide(gcd);
            this.den = den.divide(gcd);
        }

        static Rational of(long v) {
            return new Rational(BigInteger.valueOf(v), BigInteger.ONE);
        }

        static Rational of(BigInteger num, BigInteger den) {
            return new Rational(num, den);
        }

        boolean isZero() {
            return num.signum() == 0;
        }

        int sign() {
            return num.signum();
        }

        Rational add(Rational o) {
            return new Rational(num.multiply(o.den).add(o.num.multiply(den)), den.multiply(o.den));
        }

        Rational subtract(Rational o) {
            return new Rational(num.multiply(o.den).subtract(o.num.multiply(den)), den.multiply(o.den));
        }

        Rational negate() {
            return new Rational(num.negate(), den);
        }

        Rational multiply(Rational o) {
            return new Rational(num.multiply(o.num), den.multiply(o.den));
        }

        Rational divide(Rational o) {
            if (o.isZero()) throw new ArithmeticException("division by zero");
            return new Rational(num.multiply(o.den), den.multiply(o.num));
        }

        @Override
        public boolean equals(Object o) {
            return o instanceof Rational && ((Rational) o).num.equals(num) && ((Rational) o).den.equals(den);
        }

        @Override
        public int hashCode() {
            return num.hashCode() * 31 + den.hashCode();
        }

        @Override
        public String toString() {
            return den.equals(BigInteger.ONE) ? num.toString() : num + "/" + den;
        }

        /**
         * Exact square root when this is a non-negative perfect square of a
         * rational, else null. Uses BOTH the numerator root and the denominator
         * root: √(n/d) = √n / √d.
         */
        Rational perfectSquareRootOrNull() {
            if (sign() < 0) return null;
            BigInteger n = isqrtOrNull(num);
            if (n == null) return null;
            BigInteger d = isqrtOrNull(den);
            if (d == null) return null;
            return new Rational(n, d);
        }

        private BigInteger isqrtOrNull(BigInteger v) {
            // √0 = 0. Without this the Newton loop drives the guess to zero and
            // then evaluates v.divide(0), turning every double root (discriminant
            // exactly 0) into an ERROR instead of a verified unique solution.
            if (v.signum() == 0) return BigInteger.ZERO;
            if (v.signum() < 0) return null;
            BigInteger guess = BigInteger.ZERO.setBit(Math.max(1, v.bitLength() / 2 + 1));
            BigInteger prev;
            do {
                prev = guess;
                guess = prev.add(v.divide(prev)).shiftRight(1);
            } while (guess.compareTo(prev) < 0);
            guess = prev;
            return guess.multiply(guess).equals(v) ? guess : null;
        }
    }

    // ── polynomial ──────────────────────────────────────────────────────────

    /** Dense polynomial in x over rationals, degree ≤ 2 enforced at construction sites. */
    static final class Polynomial {
        private final Rational[] coeffs; // index = power of x

        Polynomial(Rational[] coeffs) {
            int last = -1;
            for (int i = 0; i < coeffs.length; i++) {
                if (!coeffs[i].isZero()) last = i;
            }
            if (last >= 3) {
                throw unsupported("", "三次及以上多项式超出第一版验证范围");
            }
            this.coeffs = coeffs;
        }

        int degree() {
            for (int i = coeffs.length - 1; i >= 0; i--) {
                if (!coeffs[i].isZero()) return i;
            }
            return -1;
        }

        boolean isZeroPolynomial() {
            return degree() < 0;
        }

        Rational coefficient(int power) {
            return power < coeffs.length ? coeffs[power] : Rational.of(0);
        }

        Polynomial subtract(Polynomial o) {
            int n = Math.max(coeffs.length, o.coeffs.length);
            Rational[] out = new Rational[n];
            for (int i = 0; i < n; i++) {
                out[i] = coefficient(i).subtract(o.coefficient(i));
            }
            return new Polynomial(out);
        }
    }

    // ── recursive-descent parser ────────────────────────────────────────────

    /**
     * Parses expressions over {numbers, fractions, x, + - * / ^2, parentheses}
     * into either a Rational (no x present) or a Polynomial (degree ≤ 2).
     */
    static final class Parser {
        private final String s;
        private final String questionTypeContext;
        private int pos;

        Parser(String s, String questionTypeContext) {
            this.s = s;
            this.questionTypeContext = questionTypeContext;
        }

        boolean atEnd() {
            skipSpaces();
            return pos >= s.length();
        }

        private void fail(String message) {
            throw unsupported(questionTypeContext, message);
        }

        private void skipSpaces() {
            while (pos < s.length() && Character.isWhitespace(s.charAt(pos))) pos++;
        }

        private boolean eat(String token) {
            skipSpaces();
            if (s.startsWith(token, pos)) {
                pos += token.length();
                return true;
            }
            return false;
        }

        /** Parses expression; returns constant value when no x appears, else null via exception path. */
        Rational parseExpression() {
            Polynomial poly = parsePolynomial();
            if (poly.degree() > 0) {
                throw unsupported(questionTypeContext, "表达式含未知数，不是纯数值");
            }
            return poly.coefficient(0);
        }

        Polynomial parsePolynomial() {
            Polynomial value = parseTerm();
            while (true) {
                skipSpaces();
                if (eat("+")) {
                    value = addPoly(value, parseTerm(), 1);
                } else if (eat("-")) {
                    value = addPoly(value, parseTerm(), -1);
                } else {
                    return value;
                }
            }
        }

        private Polynomial addPoly(Polynomial a, Polynomial b, int sign) {
            int n = Math.max(a.coeffs.length, b.coeffs.length);
            Rational[] out = new Rational[n];
            for (int i = 0; i < n; i++) {
                Rational av = a.coefficient(i);
                Rational bv = b.coefficient(i);
                out[i] = sign > 0 ? av.add(bv) : av.add(bv.negate());
            }
            return new Polynomial(out);
        }

        private Polynomial parseTerm() {
            Polynomial value = parseFactor();
            while (true) {
                skipSpaces();
                if (eat("\\times") || eat("\\cdot") || eat("*") || eat("×") || eat("·")) {
                    value = mulPoly(value, parseFactor());
                } else if (eat("\\div") || eat("/") || eat("÷")) {
                    value = divPoly(value, parseFactor());
                } else if (peekImplicitMultiplication()) {
                    // Omitted multiplication sign: 2x, 3x^2, \frac{1}{2}x^2, 2(x+1).
                    // Declared as supported in the class contract, so it is
                    // implemented rather than rejected (rectification P0-02).
                    // parseFactor always consumes at least one character or fails,
                    // so this loop cannot spin.
                    value = mulPoly(value, parseFactor());
                } else {
                    return value;
                }
            }
        }

        private boolean peekImplicitMultiplication() {
            skipSpaces();
            if (pos >= s.length()) return false;
            char c = s.charAt(pos);
            boolean startsFactor = Character.isLetterOrDigit(c) || c == '\\' || c == '(';
            return startsFactor
                && !s.startsWith("\\times", pos) && !s.startsWith("\\div", pos)
                && !s.startsWith("\\cdot", pos);
        }

        private Polynomial mulPoly(Polynomial a, Polynomial b) {
            if (a.degree() + b.degree() > 2) {
                throw unsupported(questionTypeContext, "乘积次数超过二次");
            }
            Rational[] out = new Rational[3];
            for (int i = 0; i < 3; i++) out[i] = Rational.of(0);
            for (int i = 0; i <= Math.min(2, a.coeffs.length - 1); i++) {
                for (int j = 0; j <= Math.min(2 - i, b.coeffs.length - 1); j++) {
                    out[i + j] = out[i + j].add(a.coefficient(i).multiply(b.coefficient(j)));
                }
            }
            return new Polynomial(out);
        }

        private Polynomial divPoly(Polynomial a, Polynomial b) {
            if (b.degree() > 0) {
                throw unsupported(questionTypeContext, "除数含未知数超出第一版范围");
            }
            Rational divisor = b.coefficient(0);
            Rational[] out = new Rational[a.coeffs.length];
            for (int i = 0; i < a.coeffs.length; i++) {
                out[i] = a.coefficient(i).divide(divisor);
            }
            return new Polynomial(out);
        }

        private Polynomial parseFactor() {
            skipSpaces();
            if (eat("+")) return parseFactor();
            if (eat("-")) {
                return scale(parseFactor(), Rational.of(-1));
            }
            Polynomial base = parseAtom();
            skipSpaces();
            if (eat("^")) {
                skipSpaces();
                int exponent = readIntLiteral();
                if (exponent < 0 || exponent > 2) {
                    throw unsupported(questionTypeContext, "仅支持 0~2 次幂");
                }
                return pow(base, exponent);
            }
            return base;
        }

        private Polynomial pow(Polynomial base, int exponent) {
            Rational[] out = new Rational[3];
            out[0] = Rational.of(1);
            out[1] = Rational.of(0);
            out[2] = Rational.of(0);
            Polynomial result = new Polynomial(out);
            for (int i = 0; i < exponent; i++) {
                result = mulPoly(result, base);
            }
            return result;
        }

        private Polynomial scale(Polynomial p, Rational k) {
            Rational[] out = new Rational[p.coeffs.length];
            for (int i = 0; i < p.coeffs.length; i++) {
                out[i] = p.coefficient(i).multiply(k);
            }
            return new Polynomial(out);
        }

        private Polynomial parseAtom() {
            skipSpaces();
            if (eat("(")) {
                Polynomial inner = parsePolynomial();
                if (!eat(")")) fail("括号不匹配");
                return inner;
            }
            if (eat("\\frac")) {
                skipSpaces();
                if (!eat("{")) fail("\\frac 缺少 {");
                Rational num = parseExpression();
                if (!eat("}")) fail("\\frac 分子缺少 }");
                skipSpaces();
                if (!eat("{")) fail("\\frac 缺少分母 {");
                Rational den = parseExpression();
                if (!eat("}")) fail("\\frac 分母缺少 }");
                if (den.isZero()) throw new ArithmeticException("division by zero");
                Rational value = num.divide(den);
                return constant(value);
            }
            if (eat("x")) {
                return monomial(); // x^exponent applied by caller via '^'
                // Note: exponent handling occurs in parseFactor after returning x.
            }
            Rational number = parseNumberLiteral();
            if (number == null) {
                fail("出现无法识别的记号（如函数、根式或不等号）");
            }
            return constant(number);
        }

        private Polynomial monomial() {
            Rational[] out = new Rational[2];
            out[0] = Rational.of(0);
            out[1] = Rational.of(1);
            return new Polynomial(out);
        }

        private Polynomial constant(Rational v) {
            return new Polynomial(new Rational[]{v});
        }

        private int readIntLiteral() {
            skipSpaces();
            int start = pos;
            while (pos < s.length() && Character.isDigit(s.charAt(pos))) pos++;
            if (start == pos) fail("^ 后必须是整数指数");
            return Integer.parseInt(s.substring(start, pos));
        }

        private Rational parseNumberLiteral() {
            skipSpaces();
            int start = pos;
            // Optional leading sign is handled by parseFactor's unary minus;
            // here accept bare digits with optional decimal point or a/b fraction.
            while (pos < s.length() && (Character.isDigit(s.charAt(pos)) || s.charAt(pos) == '.')) pos++;
            if (start == pos) return null;
            String digits = s.substring(start, pos);
            if (digits.indexOf('.') != digits.lastIndexOf('.')) fail("非法的小数格式");
            Rational value = decimalToRational(digits);

            // Fraction shorthand a/b
            skipSpaces();
            if (pos < s.length() && s.charAt(pos) == '/' ) {
                pos++;
                Rational denominator = parseNumberLiteral();
                if (denominator == null || denominator.isZero()) {
                    throw new ArithmeticException("division by zero");
                }
                value = value.divide(denominator);
            }
            return value;
        }

        private Rational decimalToRational(String digits) {
            int dot = digits.indexOf('.');
            if (dot < 0) {
                return Rational.of(new BigInteger(digits), BigInteger.ONE);
            }
            String intPart = digits.substring(0, dot);
            String fracPart = digits.substring(dot + 1);
            BigInteger unscaled = new BigInteger((intPart.isEmpty() ? "0" : intPart)
                + (fracPart.isEmpty() ? "0" : fracPart));
            BigInteger scale = BigInteger.TEN.pow(fracPart.length());
            return Rational.of(unscaled, scale);
        }
    }
}
