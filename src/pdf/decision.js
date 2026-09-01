// What the engine is willing to assert, separated from what it managed to find.
//
// The engine used to have two answers: here is the entry, or nothing. That
// forced a false choice. Measured on the real books, the regime where the answer
// key has no bookmarks refuses 858 of 872 attempts and resolves 8 distinct
// questions — while the table-of-contents alignment that could have said WHICH
// PAGES to turn to was working the whole time and had nowhere to put its answer.
//
// So there is a rung between "here is your answer" and "no". It is not a weaker
// match; it is a different kind of claim:
//
//   AUTO_MATCH   this entry is the answer            can be wrong the costly way
//   REVIEW       one of these few is the answer      asserts no choice
//   LOCATED      the answer is in these pages        asserts a range, not an identity
//   REFUSED      not enough to say anything          asserts nothing
//   BLOCKED      these two books do not belong together
//
// Only AUTO_MATCH can be wrong in the way the governing rule cares about — a
// student believing a wrong solution. A LOCATED that points at the wrong section
// is still an error, but it costs a few page turns and the reader sees it
// immediately. That difference is why the rungs get different thresholds, and it
// is the entire reason coverage can rise while strict precision does not move.
//
// Three rules, which the rest of the engine is expected to honour:
//
//   1. A rung is a CEILING, not a target. Nothing may promote a result to a
//      higher rung to make a coverage number look better.
//   2. Lower rungs carry their evidence. A refusal that discards what it saw
//      makes the next stage rediscover it.
//   3. Only AUTO_MATCH counts in strict precision. LOCATED and REVIEW are scored
//      separately, so improving them can never disguise a precision regression.

/** What the engine is willing to assert about one question. */
export const RUNG = Object.freeze({
  AUTO_MATCH: 'AUTO_MATCH',
  REVIEW: 'REVIEW',
  LOCATED: 'LOCATED',
  REFUSED: 'REFUSED',
  BLOCKED: 'BLOCKED',
});

/** Whether the two documents have been established to belong together. */
export const PAIR_STATUS = Object.freeze({
  VERIFIED_PAIR: 'VERIFIED_PAIR',
  UNKNOWN_PAIR: 'UNKNOWN_PAIR',
  REJECTED_PAIR: 'REJECTED_PAIR',
});

/** Strongest first. A cap can only move a result down this list. */
const ORDER = [RUNG.AUTO_MATCH, RUNG.REVIEW, RUNG.LOCATED, RUNG.REFUSED, RUNG.BLOCKED];

const rank = (rung) => {
  const i = ORDER.indexOf(rung);
  return i < 0 ? ORDER.length : i;
};

/**
 * Which rungs a pair status permits.
 *
 * This is what stops document-level gating from becoming blanket rejection. An
 * unverified pair may not hand over an answer — but it can still say which pages
 * to turn to, and refusing to do that would delete the product's coverage on any
 * book whose identity cannot be established yet, in exchange for safety the
 * AUTO_MATCH ban already provides.
 */
export function permittedRungs(pairStatus) {
  switch (pairStatus) {
    case PAIR_STATUS.VERIFIED_PAIR:
      return [RUNG.AUTO_MATCH, RUNG.REVIEW, RUNG.LOCATED];
    case PAIR_STATUS.UNKNOWN_PAIR:
      return [RUNG.REVIEW, RUNG.LOCATED];
    default:
      return [];
  }
}

/**
 * Lowers `rung` to `ceiling` when the ceiling is stricter. Never raises.
 *
 * @returns {{rung: string, cappedBy: string|null}}
 */
export function capRung(rung, ceiling, reason) {
  if (!ceiling || rank(ceiling) <= rank(rung)) return { rung, cappedBy: null };
  return { rung: ceiling, cappedBy: reason ?? 'capped' };
}

/**
 * Applies pair permissions to a rung.
 *
 * A rejected pair blocks outright. Otherwise the result falls to the strongest
 * permitted rung it still qualifies for — which for an unverified pair means an
 * AUTO_MATCH becomes a REVIEW rather than disappearing.
 */
export function applyPairPermissions(rung, pairStatus, { hasRegion = false } = {}) {
  if (pairStatus === PAIR_STATUS.REJECTED_PAIR) {
    return { rung: RUNG.BLOCKED, cappedBy: 'PAIR_IDENTITY_MISMATCH' };
  }
  const allowed = permittedRungs(pairStatus);
  if (allowed.includes(rung)) return { rung, cappedBy: null };

  const fallback = allowed.find(r => rank(r) > rank(rung));
  if (fallback === RUNG.LOCATED && !hasRegion) {
    return { rung: RUNG.REFUSED, cappedBy: 'PAIR_IDENTITY_UNKNOWN' };
  }
  return fallback
    ? { rung: fallback, cappedBy: 'PAIR_IDENTITY_UNKNOWN' }
    : { rung: RUNG.REFUSED, cappedBy: 'PAIR_IDENTITY_UNKNOWN' };
}

/**
 * The rung a legacy confidence label corresponds to.
 *
 * The ordinal bands stay the decision mechanism — they are what currently
 * produces zero wrong matches, and the corpus cannot yet support replacing them
 * with a fitted probability. This maps them onto the ladder without changing
 * what any of them means.
 *
 * LOW deliberately does not reach AUTO_MATCH: a single weak signal is a review
 * candidate, not an answer.
 */
export function rungForConfidence(confidence, matched) {
  if (!matched) return RUNG.REFUSED;
  switch (confidence) {
    case 'HIGH': return RUNG.AUTO_MATCH;
    case 'MEDIUM': return RUNG.AUTO_MATCH;
    case 'LOW': return RUNG.REVIEW;
    default: return RUNG.REFUSED;
  }
}

/** True when a result may be displayed to a reader as the answer. */
export function isAnswer(rung) {
  return rung === RUNG.AUTO_MATCH;
}

/** True when the result carries something the reader can act on. */
export function isActionable(rung) {
  return rung === RUNG.AUTO_MATCH || rung === RUNG.REVIEW || rung === RUNG.LOCATED;
}
