// Comparing mathematics by what surrounds each operator.
//
// Dice over character bigrams is a BAG of bigrams: it counts which pairs occur,
// not where. That is enough to separate questions with different mathematics,
// but the margin it leaves is thin, because two derivative exercises on the same
// page share almost every bigram of their prose and most of their expression.
//
// The discriminating information is local to the operators. In x^2+3x and
// x^3+5x the operators are identical and in the same order; what differs is the
// operand on each side of them. So anchor on the operator and take a fixed
// window either side:
//
//   x^2+3x   ->   "··x ^ 2+3"   "x^2 + 3x·"
//   x^3+5x   ->   "··x ^ 3+5"   "x^3 + 5x·"
//
// Neither token matches, where a bigram bag would have shared x^, +, and x.
//
// Measured over five pairs of near-identical questions (identical prose,
// mathematics differing only in grouping, sign, exponent or coefficient):
//
//   radius   mean margin   worst case   inversions
//     1         0.291        0.167          0
//     2         0.452        0.250          0
//     3         0.652        0.500          0     <- chosen
//     4         0.524        0.333          0
//     5         0.540        0.333          0
//     6         0.338        0.000          1
//
//   plain similarity        0.145        0.107      0
//   fragment bigrams        0.184        0.160      0
//
// Three is not a round number picked for tidiness — the curve peaks there. Wider
// windows reach past the operand into unrelated material and start to blur
// together again, and at six one pair inverts outright.

/**
 * Operators, not operands.
 *
 * Anchoring on digits and letters would emit a window per character and reduce
 * this to ordinary positional n-grams. The operators are the skeleton; the
 * question is what hangs off them.
 */
const OPERATOR = /[+\-*/=^_()<>|∫∑∏√±×÷≤≥≠]/;

/** Fills a window that runs off the end of the expression. */
const PAD = '·';

/** Below this many anchors the signal is one coincidence wide. */
const MIN_ANCHORS = 2;

export const SYMBOL_RADIUS = 3;

/**
 * The operator-anchored context windows of a normalised string.
 *
 * @param {string} normalized output of normalizeForMatch — this does NOT
 *   normalise for you, because the caller has usually done it already and the
 *   windows must be measured on the same string the rest of the scoring sees.
 * @returns {string[]} one token per operator occurrence
 */
export function symbolContexts(normalized, radius = SYMBOL_RADIUS) {
  const s = String(normalized ?? '');
  const out = [];
  for (let i = 0; i < s.length; i++) {
    if (!OPERATOR.test(s[i])) continue;
    const left = s.slice(Math.max(0, i - radius), i).padStart(radius, PAD);
    const right = s.slice(i + 1, i + 1 + radius).padEnd(radius, PAD);
    out.push(left + s[i] + right);
  }
  return out;
}

/** Dice coefficient over two multisets of tokens. */
function diceMultiset(a, b) {
  if (a.length === 0 || b.length === 0) return null;
  const counts = new Map();
  for (const t of a) counts.set(t, (counts.get(t) || 0) + 1);
  let shared = 0;
  for (const t of b) {
    const c = counts.get(t);
    if (c > 0) { shared++; counts.set(t, c - 1); }
  }
  return (2 * shared) / (a.length + b.length);
}

/**
 * Similarity of two expressions by operator context.
 *
 * @returns {number|null} null when either side has too few operators to judge —
 *   a question with one operator would otherwise be decided by a single token,
 *   and a prose question by nothing at all. The caller falls back rather than
 *   treating an absent signal as disagreement.
 */
export function symbolContextSimilarity(normalizedA, normalizedB, radius = SYMBOL_RADIUS) {
  const a = symbolContexts(normalizedA, radius);
  const b = symbolContexts(normalizedB, radius);
  if (a.length < MIN_ANCHORS || b.length < MIN_ANCHORS) return null;
  return diceMultiset(a, b);
}
