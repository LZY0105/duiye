// Hierarchical question identifiers.
//
// A question in these books is numbered 1.1, 1.200, 2.231 — chapter and
// position within it, not a bare ordinal. Truncating 1.200 to 1 collapses two
// hundred distinct questions onto a single identifier, and a matcher that then
// finds "1" three times in the answer key has no way back to the right one.
// Measured on the 2023 set: 508 questions, 508 distinct hierarchical ids, and
// exactly 2 distinct leading segments. The hierarchy IS the identity.
//
// Subquestions — (1), (2) beneath a question — restart at 1 inside every
// question. Promoting them to top-level entries manufactures hundreds of
// duplicate "1"s, which is worse than not parsing them at all: it converts a
// clean unique-id lookup into a mass of forced ambiguity.

/** One or more dot-separated numeric segments: 1, 1.31, 1.200, 2.231. */
const ID_BODY = String.raw`\d{1,4}(?:[.．]\d{1,4})*`;

/**
 * Line-anchored patterns that open a new numbered question.
 *
 * Order matters only for readability — each pattern carries the lookaheads that
 * stop it consuming a prefix of a longer id. The hierarchical forms are allowed
 * to end at whitespace because "1.31 求导" is unambiguously a label; the flat
 * form is not, because a bare "12 " at the start of a line is far more likely to
 * be part of the mathematics than a question number.
 */
export const LABEL_PATTERNS = [
  // 第 9 题 / 第9题.
  new RegExp(String.raw`^\s*第\s*(${ID_BODY})\s*题\s*[.．、:：]?\s*`),
  // 例题 1.31 — the form the PDF bookmarks use.
  new RegExp(String.raw`^\s*例\s*题\s*(${ID_BODY})\s*[.．、:：]?\s*`),
  // 1.31  /  1.31.  /  1.31、  — hierarchical, terminator optional.
  // (?!\d) blocks backtracking into a shorter id: without it, "1.31 求导"
  // happily matches as label "1" with body "31 求导".
  /^\s*(\d{1,4}(?:[.．]\d{1,4})+)(?!\d)\s*[.．、)）:：]?\s*/,
  // 12.  /  12、  /  12)  — flat, terminator REQUIRED, and never when a dot and
  // another digit follow, which would mean this is really a hierarchical id.
  /^\s*(\d{1,4})(?!\d)(?![.．]\d)\s*[.．、)）:：]\s*/,
];

/**
 * (1) （2） — a subquestion of whichever question is currently open.
 * Never a question in its own right; see the module comment.
 */
export const SUBQUESTION_PATTERN = /^\s*[(（]\s*(\d{1,3})\s*[)）]\s*[.．、:：]?\s*/;

/**
 * Canonical form of a hierarchical id: per-segment leading zeros stripped.
 *
 * Stripping is per segment so that 1.1 and 1.10 stay distinct — a whole-string
 * numeric normalisation would fold them together, which is the same class of
 * error as truncating 1.200.
 *
 * @returns {string} canonical id, or '' when the input is not an id
 */
export function normalizeId(raw) {
  const text = String(raw ?? '').trim();
  if (!text) return '';
  const segments = text.split(/[.．]/);
  if (segments.length === 0) return '';
  const out = [];
  for (const segment of segments) {
    if (!/^\d{1,4}$/.test(segment)) return '';
    out.push(String(parseInt(segment, 10)));
  }
  return out.join('.');
}

/** Segments of a canonical id as numbers: "1.200" -> [1, 200]. */
export function idSegments(raw) {
  const canonical = normalizeId(raw);
  return canonical ? canonical.split('.').map(Number) : [];
}

/** True when two ids denote the same question. Empty never equals anything. */
export function sameQuestionId(a, b) {
  const x = normalizeId(a);
  const y = normalizeId(b);
  return !!x && x === y;
}

/**
 * Book order for two ids, segment by segment.
 * 1.9 precedes 1.10, which string comparison gets backwards.
 */
export function compareIds(a, b) {
  const x = idSegments(a);
  const y = idSegments(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const dx = x[i] ?? -1;
    const dy = y[i] ?? -1;
    if (dx !== dy) return dx - dy;
  }
  return 0;
}

/** The addressable key for a question or one of its subquestions. */
export function questionKey(id, sub) {
  const canonical = normalizeId(id);
  if (!canonical) return '';
  const s = String(sub ?? '').trim();
  return s ? `${canonical}(${parseInt(s, 10)})` : canonical;
}

/**
 * Parses a line that opens a numbered question.
 * @returns {{id: string, body: string}|null}
 */
export function parseQuestionLine(line) {
  const text = String(line ?? '');
  for (const pattern of LABEL_PATTERNS) {
    const match = text.match(pattern);
    if (!match) continue;
    const id = normalizeId(match[1]);
    if (!id) continue;
    return { id, body: text.slice(match[0].length).trim() };
  }
  return null;
}

/**
 * Parses a line that opens a subquestion.
 * @returns {{sub: string, body: string}|null}
 */
export function parseSubQuestionLine(line) {
  const text = String(line ?? '');
  const match = text.match(SUBQUESTION_PATTERN);
  if (!match) return null;
  return { sub: String(parseInt(match[1], 10)), body: text.slice(match[0].length).trim() };
}

/**
 * Pulls a question id out of a bookmark title.
 *
 * Bookmarks are the authoritative source of ids on this corpus, because the
 * text layer's CJK mapping is broken often enough that body-text detection
 * cannot be trusted on its own. A title that is a section heading rather than a
 * question ("1.1 极限与连续函数") yields an id too — the caller separates the two
 * by outline depth, which is structural and does not depend on the font.
 *
 * @returns {string} canonical id, or '' when the title carries none
 */
export function idFromOutlineTitle(title) {
  const text = String(title ?? '').trim();
  if (!text) return '';
  const example = text.match(new RegExp(String.raw`例\s*题\s*(${ID_BODY})`));
  if (example) return normalizeId(example[1]);
  const leading = text.match(new RegExp(String.raw`^\s*(${ID_BODY})(?!\d)`));
  if (leading) return normalizeId(leading[1]);
  return '';
}
