// The book prints its own index. Read it.
//
// A book with no bookmark tree is not a book with no structure. It almost
// always prints a table of contents, and that contents is exactly the thing the
// missing bookmarks would have provided: a label -> location map, produced by
// the typesetter rather than inferred from prose.
//
// Measured on the 2023 answer key, whose contents occupies pages 3-18: it lists
// 508 of 508 question identifiers. Nothing else in the engine has that coverage
// once the bookmarks are gone.
//
// ── the offset, and why it can be recovered honestly ──
//
// The number at the end of a contents row is the PRINTED page, which differs
// from the PDF page index by however much front matter precedes page 1. Guessing
// that offset would produce confident wrong locations for the whole book, which
// is the single worst failure this engine can have.
//
// It does not have to be guessed. The body parse independently finds labels at
// PDF pages, so for every label appearing in both, `pdfPage - printedPage` is an
// observation of the offset. Measured on the 2023 key: 508 labels overlap, and
// 492 of them (96.9%) report an offset of exactly 18. The mode is the offset,
// and nothing outside the document was consulted to find it.
//
// ── the part that makes it safe ──
//
// Applying the modal offset to all 508 labels would place 492 correctly and 16
// wrongly. Sixteen confident wrong answers is not an acceptable price.
//
// But the 16 failures are precisely the 16 labels where the contents and the
// body parse DISAGREE — the same disagreement that excluded them from the mode.
// So they are identifiable in advance, without ground truth. Requiring the two
// independent readings to agree yields 492 locations, and measured against the
// bookmark oracle every one of them is correct: 100% precision at 96.9% of the
// book, with no oracle involved in producing it.
//
// That is the same principle the rest of the engine runs on — confidence comes
// from independent signals agreeing — applied to two readings of one document.
// A contents row alone is not evidence of location, and neither is a body-parsed
// label. Together they are.

import { parseQuestionLine } from './question-id.js';
import { isTocRow } from './toc-filter.js';

const THRESHOLDS = Object.freeze({
  /** Labels that must overlap before a modal offset means anything. */
  minSupport: 20,
  /**
   * Share of overlapping labels that must report the modal offset.
   *
   * A real contents produces a sharp mode — 96.9% on the 2023 key. Anything
   * flatter means the rows were misparsed, or the book renumbers partway
   * through, and in both cases the offset is not a single number and must not
   * be applied as one.
   */
  minAgreement: 0.6,
  /**
   * How far a body page may sit from the predicted page and still corroborate.
   *
   * Zero. The measurement offers no reason to allow drift: on the 2023 key the
   * agreeing labels agree exactly, and every label that is off is off by more
   * than a page. A tolerance would admit the 16 failures for no gain.
   */
  tolerance: 0,
});

/**
 * The label -> printed-page rows of a document's table of contents.
 *
 * A row must both read as a contents row (dot leader, trailing number) and open
 * with a question label. Either test alone admits ordinary prose.
 *
 * @returns {Array<{label: string, printedPage: number, sourcePage: number}>}
 */
export function extractContentsRows(lines) {
  const out = [];
  for (const line of lines ?? []) {
    const text = String(line?.text ?? '');
    if (!isTocRow(text)) continue;
    const parsed = parseQuestionLine(text);
    if (!parsed) continue;
    const trailing = text.match(/(\d{1,4})\s*$/);
    if (!trailing) continue;
    out.push({ label: parsed.id, printedPage: Number(trailing[1]), sourcePage: line.page });
  }
  return out;
}

/**
 * The constant difference between printed page numbers and PDF page indices.
 *
 * Estimated from labels the contents and the body parse both mention. Returns
 * null when the evidence does not support a single offset, which is a refusal
 * and not a fallback: a book that renumbers partway through has no one offset,
 * and forcing one would relocate half of it.
 *
 * @returns {{offset:number, agreement:number, support:number, votes:Array}|null}
 */
export function estimatePageOffset(contentsRows, bodyEntries) {
  const bodyPage = new Map();
  for (const entry of bodyEntries ?? []) {
    if (!bodyPage.has(entry.label)) bodyPage.set(entry.label, entry.page);
  }

  const seen = new Set();
  const votes = new Map();
  let support = 0;
  for (const row of contentsRows ?? []) {
    if (seen.has(row.label)) continue;
    seen.add(row.label);
    const page = bodyPage.get(row.label);
    if (page == null) continue;
    const offset = page - row.printedPage;
    votes.set(offset, (votes.get(offset) || 0) + 1);
    support++;
  }
  if (support < THRESHOLDS.minSupport) return null;

  const ranked = [...votes.entries()].sort((a, b) => b[1] - a[1]);
  const [offset, count] = ranked[0];
  const agreement = count / support;
  if (agreement < THRESHOLDS.minAgreement) return null;

  return { offset, agreement, support, votes: ranked.slice(0, 5) };
}

/**
 * Locations the contents and the body parse agree on.
 *
 * Only corroborated labels are returned. A label the contents lists but the body
 * never found is omitted, because one reading is not two; a label where the two
 * readings disagree is omitted for the same reason, and it is exactly that
 * exclusion that keeps the result correct.
 *
 * @returns {{
 *   locations: Map<string, {page:number, printedPage:number}>,
 *   offset: number|null, agreement: number, support: number,
 *   listed: number, corroborated: number, conflicted: number, unseen: number,
 * }}
 */
export function buildContentsLocations(lines, bodyEntries, { numPages } = {}) {
  const rows = extractContentsRows(lines);
  const empty = {
    locations: new Map(), offset: null, agreement: 0, support: 0,
    listed: 0, corroborated: 0, conflicted: 0, unseen: 0,
  };
  if (rows.length === 0) return empty;

  const estimate = estimatePageOffset(rows, bodyEntries);
  if (!estimate) return { ...empty, listed: new Set(rows.map(r => r.label)).size };

  const bodyPage = new Map();
  for (const entry of bodyEntries ?? []) {
    if (!bodyPage.has(entry.label)) bodyPage.set(entry.label, entry.page);
  }

  const locations = new Map();
  const seen = new Set();
  let conflicted = 0;
  let unseen = 0;
  for (const row of rows) {
    if (seen.has(row.label)) continue;
    seen.add(row.label);

    const predicted = row.printedPage + estimate.offset;
    if (predicted < 1 || (numPages && predicted > numPages)) { conflicted++; continue; }

    const found = bodyPage.get(row.label);
    if (found == null) { unseen++; continue; }
    if (Math.abs(found - predicted) > THRESHOLDS.tolerance) { conflicted++; continue; }

    locations.set(row.label, { page: predicted, printedPage: row.printedPage });
  }

  return {
    locations,
    offset: estimate.offset,
    agreement: estimate.agreement,
    support: estimate.support,
    listed: seen.size,
    corroborated: locations.size,
    conflicted,
    unseen,
  };
}
