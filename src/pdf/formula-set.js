// Every complete expression in a question, and whether the candidate has them.
//
// Three safety probes in the expanded test report all failed the same way. A
// question carrying two expressions — f(x)=x^2+1 and g(x)=sin(x) — matched a
// candidate that held only the first, and matched another whose two expressions
// both CONFLICTED (x^3+1, cos(x)), and both came back HIGH. The exact-label path
// returned before anything looked at the mathematics.
//
// ── what this gate does and does not do ──
//
// It does NOT require text. That distinction is the whole design. On the corpus
// this engine was built for, all 508 / 470 / 413 questions of the three valid
// pairs resolve from bookmark identifiers alone, at p95 0.0 ms, without reading
// a character — and on a book whose CJK mapping is broken there is no readable
// text to gate on. Requiring formula coverage before any AUTO_MATCH would turn
// the one configuration that works into a refusal.
//
// The rule that survived measurement is narrow: a candidate that shares almost
// NONE of the question's mathematics caps at REVIEW. Everything else is recorded
// as evidence and left to the rest of the engine.
//
// It had to be narrow. The requirement as originally specified — every
// expression present, zero structural conflicts — was scored against 788
// known-correct pairs and would have refused 218 of 400 correct 2023 pairs and
// every correct pair in both 2024 books. An answer entry routinely states only
// its result, so demanding the question's expressions back is demanding
// something the corpus does not contain.
//
// ── how an expression is compared ──
//
// By SKELETON first, then operands. The skeleton is the ordered sequence of
// operators with operands blanked out, so x^2+1 and x^3+1 share a skeleton and
// differ only in what hangs off it. That is precisely the pair the probes are
// built from, and precisely the pair whole-string similarity scores at 0.468 —
// high enough to look like agreement.
//
//   x^2+1   skeleton ^+   operands x,2,1
//   x^3+1   skeleton ^+   operands x,3,1   -> same skeleton, different operands
//   sin(x)  skeleton ()   operands sin,x
//   cos(x)  skeleton ()   operands cos,x   -> same skeleton, different operands
//
// Same skeleton with different operands is a CONFLICT; no matching skeleton at
// all is MISSING. Both are reported, and neither caps on its own — conflict
// fires constantly on real answer text, which restates an expression through its
// intermediate steps. Only total absence of shared mathematics caps.

import { extractMathFragments, similarity } from './question-matcher.js';

/** Operators that form an expression's skeleton. */
const OPERATOR = /[+\-*/=^_<>|∫∑∏√±×÷≤≥≠]/;

const THRESHOLDS = Object.freeze({
  /**
   * Share of the question's expressions that must have a counterpart.
   *
   * Measured, not stipulated. See formulaCeiling for the separation table: at
   * 0.10 this refuses 99.0% of decoys and 0.25% of known-correct pairs, while
   * the specified 1.0 refuses every correct 2024 pair in the corpus.
   *
   * Conflicts are still counted and reported as evidence, but no longer cap on
   * their own: same-skeleton-different-operands fires constantly on real answer
   * text, which restates an expression through its intermediate steps, and
   * capping on it refused 218 of 400 correct 2023 pairs.
   */
  coverage: 0.1,
  /** Fragments shorter than this are page numbers and list markers, not maths. */
  minLength: 3,
  /**
   * How close two expressions must read before they are the same expression.
   *
   * Exact string equality is too strict for two typesettings of one formula.
   * Even with page numbers and running heads cleaned out, the two books break
   * lines differently, so one side arrives as f(x)=x^2+1 and the other with a
   * stray glyph or a merged neighbour character.
   *
   * Measured over the three valid pairs — share of KNOWN-CORRECT pairs reaching
   * full coverage, against share of DECOYS doing the same:
   *
   *   threshold   true full%            decoy full%
   *   1.00        74.7 / 46.8 / 69.0    0.0 / 0.0 / 0.0
   *   0.90        83.5 / 50.6 / 70.5    0.0 / 0.0 / 0.0
   *   0.80        92.4 / 57.7 / 76.5    0.0 / 0.0 / 0.0
   *   0.70        95.3 / 62.6 / 80.5    0.0 / 0.0 / 0.5
   *
   * Decoys do not follow true pairs up. 0.80 takes most of the available gain
   * while leaving every decoy population at zero; 0.70 begins to admit them.
   */
  expressionMatch: 0.8,
  /**
   * Expressions needed before coverage means anything.
   *
   * One, deliberately. Raising it to two was tried and reverted: it silenced the
   * veto on every single-expression question, and measured on the reversed-chapter
   * fixture that let all 120 of the positional prior's wrong answers through
   * again. The noise cases it was meant to fix — prose question 2.206, whose lone
   * "expression" was 3×3a= scavenged from a neighbour — are handled where they
   * belong, by not letting the veto override a structural id at all.
   */
  minExpressions: 1,
});

/**
 * Sub-question markers, which are enumeration and not mathematics.
 *
 * A question with parts prints "(1) … (2) … (3) …", and extraction merges those
 * markers into whatever expression they abut. The two books number their parts
 * at different points in the character stream, so one side arrives as "lim-(3)"
 * and the other as "lim-(1)" — the same expression, reading as a structural
 * CONFLICT because the digits differ.
 *
 * Measured on the 2024 Mathematical Analysis pair before removal, these markers
 * were the single largest cause of residual disagreement between known-correct
 * pairs.
 *
 * Only a marker: a bracketed number NOT preceded by an identifier character, so
 * f(1), a(2) and x(3) — where the bracket is function application or a
 * subscript — are untouched.
 */
const SUBQUESTION_MARKER = /(?<![0-9A-Za-z\u4e00-\u9fff])[(（]\s*\d{1,2}\s*[)）]/g;

/** The operator sequence of a fragment, with operands removed. */
function skeletonOf(fragment) {
  let out = '';
  for (const ch of fragment) if (OPERATOR.test(ch)) out += ch;
  return out;
}

/** The non-operator runs of a fragment, in order. */
function operandsOf(fragment) {
  return fragment.split(new RegExp(`[${'+\\-*/=^_<>|∫∑∏√±×÷≤≥≠'}]`))
    .map(s => s.trim()).filter(Boolean);
}

/**
 * The complete mathematical expressions in a text.
 *
 * Built on the same fragment extraction the matcher already uses, so an
 * expression here is the same object the rest of the engine scores — a second,
 * differently-tokenised notion of "expression" would let the two disagree about
 * what was compared.
 *
 * @returns {{expressions: Array, complete: boolean, count: number}}
 */
export function extractFormulaSet(text) {
  const fragments = extractMathFragments(text ?? '')
    .filter(f => f.length >= THRESHOLDS.minLength);

  const expressions = fragments
    .map(f => f.replace(SUBQUESTION_MARKER, ''))
    .filter(f => f.length >= THRESHOLDS.minLength)
    .map((fragment, i) => ({
      id: `e${i}`,
      fragment,
      skeleton: skeletonOf(fragment),
      operands: operandsOf(fragment),
    }))
    .filter(e => e.skeleton.length > 0);

  // Truncation is visible in the raw text, not in the fragments: an expression
  // running off the end of an OCR line leaves an unbalanced bracket behind.
  const raw = String(text ?? '');
  const opens = (raw.match(/[([{]/g) ?? []).length;
  const closes = (raw.match(/[)\]}]/g) ?? []).length;
  const complete = opens === closes;

  return { expressions, complete, count: expressions.length };
}

/**
 * How much of the question's mathematics the candidate actually carries.
 *
 * @returns {{
 *   coverage: number, matched: number, total: number,
 *   missing: Array, conflicts: Array, sufficient: boolean,
 * }}
 */
export function compareFormulaSets(questionSet, candidateSet) {
  const qs = questionSet?.expressions ?? [];
  const as = candidateSet?.expressions ?? [];

  if (qs.length < THRESHOLDS.minExpressions) {
    // A question with no mathematics cannot be gated on mathematics. Prose and
    // identifiers carry it, as they always did.
    return {
      coverage: 1, matched: 0, total: 0,
      missing: [], conflicts: [], sufficient: false,
    };
  }

  const pool = as.map(e => ({ ...e, taken: false }));
  const missing = [];
  const conflicts = [];
  let matched = 0;

  // A multiset, not a set: an expression appearing twice in the question needs
  // two counterparts, and `taken` is what enforces that.
  for (const q of qs) {
    // The closest unused candidate, not merely an identical one.
    let best = null;
    let bestScore = 0;
    for (const a of pool) {
      if (a.taken) continue;
      const score = a.fragment === q.fragment ? 1 : similarity(q.fragment, a.fragment);
      if (score > bestScore) { bestScore = score; best = a; }
    }

    if (best && bestScore >= THRESHOLDS.expressionMatch) {
      best.taken = true;
      matched++;
      continue;
    }

    // Same skeleton, different operands: the candidate holds this expression's
    // shape but not its content. That is a contradiction, not an absence.
    const sameShape = pool.filter(a => !a.taken && a.skeleton === q.skeleton);
    if (sameShape.length > 0) {
      const near = sameShape[0];
      near.taken = true;
      conflicts.push({
        expressionId: q.id,
        question: q.fragment,
        candidate: near.fragment,
        skeleton: q.skeleton,
        similarity: Number(bestScore.toFixed(3)),
      });
      continue;
    }

    missing.push({ expressionId: q.id, question: q.fragment, skeleton: q.skeleton });
  }

  return {
    coverage: qs.length ? matched / qs.length : 1,
    matched,
    total: qs.length,
    missing,
    conflicts,
    sufficient: true,
  };
}

/**
 * The rung ceiling this evidence permits.
 *
 * Returns null when the mathematics has nothing to say — no expressions, or no
 * candidate text to compare against — so the caller proceeds on the evidence it
 * already had rather than treating silence as disagreement.
 *
 * @param {string} questionText
 * @param {string} candidateText
 * @param {{coverage?: number}} options
 * @returns {{ceiling: 'REVIEW'|'REFUSED'|null, reason: string|null, evidence: object}}
 */
export const FORMULA_POLICY = Object.freeze({
  /**
   * The agreed product rule: every complete expression in the question must have
   * a counterpart, no structural conflicts, and no exemption for any other kind
   * of evidence. An identifier does not excuse mathematics that does not
   * correspond.
   */
  STRICT: 'STRICT',
  /**
   * Coverage at the measured separation point instead of at 1.0, and structural
   * identifiers exempt. Retained because the recall difference is large and is a
   * product decision; see the table in formulaCeiling.
   */
  CALIBRATED: 'CALIBRATED',
});

export function formulaCeiling(questionText, candidateText, {
  coverage = THRESHOLDS.coverage,
  policy = FORMULA_POLICY.STRICT,
} = {}) {
  const required = policy === FORMULA_POLICY.STRICT ? 1 : coverage;
  const q = extractFormulaSet(questionText);
  const a = extractFormulaSet(candidateText);

  if (q.count === 0 || !candidateText) {
    return { ceiling: null, reason: null, evidence: { coverage: null, conflicts: 0, missing: 0 } };
  }

  const cmp = compareFormulaSets(q, a);
  const evidence = {
    coverage: Number(cmp.coverage.toFixed(3)),
    conflicts: cmp.conflicts.length,
    missing: cmp.missing.length,
    total: cmp.total,
    complete: q.complete && a.complete,
  };

  // A structural conflict is contradictory evidence and caps under either
  // policy: an expression whose counterpart differs in exponent, sign, bound or
  // operand says the candidate is not this question's answer.
  if (cmp.conflicts.length > 0) {
    return { ceiling: 'REVIEW', reason: 'FORMULA_CONFLICT', evidence };
  }
  if (!q.complete || !a.complete) {
    return { ceiling: 'REVIEW', reason: 'FORMULA_EXTRACTION_INCOMPLETE', evidence };
  }

  // Coverage. Under STRICT this is the agreed rule at 1.0.
  //
  // What that costs is measured, not assumed. Share of KNOWN-CORRECT pairs
  // reaching full coverage, after entry-scoped text, structure cleaning and
  // fuzzy expression matching:
  //
  //   pair     full coverage    by question size: 1-2 exprs   11+ exprs
  //   2023          92.5%
  //   2024 MA       60.5%                            76.7%        12.9%
  //   2024 ALG      78.8%
  //
  // The rule fails MULTIPLICATIVELY with question size, because each expression
  // carries an independent chance of an extraction artefact. That is a property
  // of requiring all of N things from noisy input, not evidence that the answer
  // is wrong — every one of those pairs is bookmark-confirmed correct. The cost
  // is therefore a recall decision, and it is surfaced rather than absorbed.
  if (cmp.sufficient && cmp.coverage < required) {
    return { ceiling: 'REVIEW', reason: 'FORMULA_SET_MISSING', evidence };
  }
  return { ceiling: null, reason: null, evidence };
}
