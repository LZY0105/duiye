// The text that belongs to ONE question, rather than to the page it sits on.
//
// An outline entry knows its page range and nothing finer, so its text has
// always been every line on those pages. On a book that prints several questions
// per page that is mostly somebody else's material, and the consequences reached
// much further than they looked:
//
//   Formula coverage on KNOWN-CORRECT pairs sat at a median of 0.41-0.89,
//   because the expressions extracted for a question were partly its neighbours'.
//   That is what made the agreed "every expression must match" rule look
//   unenforceable — it was being measured against text the question did not own.
//
//   The formula veto capped two of 508 correct 2023 matches. Question 1.255's
//   expressions belonged to 1.254; prose question 2.206's sole "expression" was
//   3×3a=, scavenged from an adjoining question.
//
//   The content oracle could not confirm 2 of 470 and 2 of 413 correct answers,
//   because the entry's page range did not include its own printed heading.
//
// One root cause, three symptoms. This module addresses the cause.
//
// ── how a boundary is found ──
//
// The book prints its own boundaries. A question's text begins at the line whose
// printed label is that question's, and ends where the next question's printed
// label appears. Both are located with the same parser the index already uses,
// so nothing here invents a second notion of "where a question starts".
//
// Measured on the three valid pairs, the printed heading is locatable for 99.1%
// to 100% of entries. Where it is not, the page range is used unchanged — a
// wider window is a worse window, never a wrong one.
//
// ── what is stripped ──
//
// Running heads, section titles and page numbers are not merely on the page,
// they are interleaved INTO the character stream, so line-level filtering cannot
// reach them:
//
//   question  ...limf(x)=limf(x)=limf(x)=0x
//   answer    ...limf(x)=limf(x)=limf(x)=035x      <- "35" is the page number
//   answer    ...华东师范大学1.1). 设 极限与连续函数f (x)  <- running head, mid-line
//
// Those two artefacts alone accounted for most of the residual coverage gap.
// Removing them is not cosmetic: an expression differing from its counterpart
// only by an embedded page number reads as a structural CONFLICT, which is the
// strongest negative signal the formula gate has.

import { parseQuestionLine } from './question-id.js';
import { findBoilerplate } from './boilerplate.js';

/** Lines whose printed label is exactly this entry's. */
function headingIndex(window, label, fromIndex = 0) {
  for (let i = fromIndex; i < window.length; i++) {
    const parsed = parseQuestionLine(window[i].text);
    if (parsed && parsed.id === label) return i;
  }
  return -1;
}

/**
 * Section titles as printed, plus their descriptive half.
 *
 * "1.1 极限与连续函数" appears both whole and as a bare "极限与连续函数" running
 * head, and both forms turn up glued inside body lines.
 *
 * SECTION titles only. Question bookmarks are titled "例题 1.6", and an earlier
 * version derived this list from the whole outline — so the cleaner deleted each
 * question's own printed heading. That silently destroyed the boundary this
 * module locates entries by, took the content oracle from 100% to 0%, and
 * changed the role classifier's inputs enough to reject two valid pairs. The
 * caller passes the classified sections; nothing here walks the tree itself.
 */
export function sectionTitleForms(titles) {
  const out = new Set();
  for (const raw of titles ?? []) {
    const title = String(raw ?? '').trim();
    if (!title) continue;
    out.add(title);
    const bare = title.replace(/^\s*\d+(?:[.．]\d+)*\s*/, '').trim();
    if (bare.length >= 2) out.add(bare);
  }
  // Longest first, so "1.1 极限与连续函数" is removed before "极限与连续函数"
  // can match half of it and leave a fragment behind.
  return [...out].sort((a, b) => b.length - a.length);
}

/**
 * Builds a cleaner that removes interleaved structure from a document's text.
 *
 * @param {{outline?: object, lines?: Array}} doc
 * @returns {(text: string, pages?: number[]) => string}
 */
export function createTextCleaner({ sectionTitles, lines } = {}) {
  const { report } = findBoilerplate(lines ?? []);
  const forms = report.map(r => r.form).filter(f => f && f.length >= 4);
  const titles = sectionTitleForms(sectionTitles);

  const patterns = [...titles, ...forms]
    .filter(Boolean)
    .map((piece) => {
      // Boilerplate forms arrive with digits and whitespace already stripped, so
      // they are matched loosely enough to find the printed original.
      const escaped = piece.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s*');
      try { return new RegExp(escaped, 'g'); } catch { return null; }
    })
    .filter(Boolean);

  return (text, pages = []) => {
    let s = String(text ?? '');
    for (const re of patterns) s = s.replace(re, ' ');
    // The entry's own page numbers, which the extractor drops into the middle of
    // expressions. Only these numbers: stripping digits generally would destroy
    // the mathematics this exists to protect.
    for (const page of pages) {
      s = s.replace(new RegExp(`(?<![0-9])${page}(?![0-9])`, 'g'), ' ');
    }
    return s.replace(/\s+/g, ' ').trim();
  };
}

/**
 * The lines belonging to one entry, bounded by printed headings.
 *
 * @param {Array<{page:number,text:string}>} lines the whole document
 * @param {{label:string,page:number,endPage:number}} entry
 * @param {object|null} next the following entry in book order
 * @returns {{lines: Array, scoped: boolean}}
 */
export function entryLines(lines, entry, next) {
  const from = entry.page;
  const to = entry.endPage ?? entry.page;
  // The window may run into the next entry's first page: a question that shares
  // a page with its successor ends partway down it.
  const upper = next ? Math.max(to, next.page) : to;
  const window = (lines ?? []).filter(l => l.page >= from && l.page <= upper);

  const start = headingIndex(window, entry.label);
  if (start < 0) return { lines: window, scoped: false };

  let end = window.length;
  if (next) {
    const nextAt = headingIndex(window, next.label, start + 1);
    if (nextAt > start) end = nextAt;
  }
  return { lines: window.slice(start, end), scoped: true };
}

/**
 * Entry-scoped, structure-cleaned text for one entry.
 *
 * @returns {{text: string, scoped: boolean}}
 */
export function entryText(lines, entry, next, clean) {
  const { lines: own, scoped } = entryLines(lines, entry, next);
  const pages = [];
  for (let p = entry.page; p <= (entry.endPage ?? entry.page); p++) pages.push(p);
  const joined = own.map(l => l.text).join(' ').trim();

  // Vertical extent PER PAGE, when the adapter reports line geometry. This is
  // what lets a tap select one question rather than the whole page.
  //
  // Per page, not once for the entry: a question spanning two pages occupies a
  // different band on each, and an earlier version recorded only its first
  // page's extent — so a tap on its second page was compared against
  // coordinates from the page before and selected everything. Adapters that
  // report text only produce no spans at all, and the region selector reports
  // REGION_UNSUPPORTED_BY_ADAPTER rather than pretending it selected.
  const byPage = new Map();
  for (const line of own) {
    const top = line.top ?? line.y;
    const bottom = line.bottom
      ?? (Number.isFinite(line.y) && Number.isFinite(line.height) ? line.y + line.height : undefined);
    if (!Number.isFinite(top) || !Number.isFinite(bottom)) continue;
    const slot = byPage.get(line.page);
    if (slot) {
      slot.top = Math.min(slot.top, top);
      slot.bottom = Math.max(slot.bottom, bottom);
    } else {
      byPage.set(line.page, { page: line.page, top, bottom });
    }
  }
  const spans = [...byPage.values()].sort((a, b) => a.page - b.page);

  return {
    text: clean ? clean(joined, pages) : joined,
    scoped,
    spans,
  };
}
