// Running heads, footers and watermarks are not content.
//
// Every page of these books carries the chapter title as a running head, and the
// 2024 volumes carry a publisher watermark on 80% of their pages. Extraction
// returns those lines exactly like any other, so they end up inside entry text —
// where they do two kinds of damage:
//
//   They manufacture similarity. Two questions from different chapters still
//   share whatever boilerplate their pages carry, which raises every score by a
//   constant and narrows the margin the matcher is trying to read.
//
//   They manufacture ENTRIES. A body-parsed entry whose text is nothing but a
//   running head is a candidate that matches anything sharing that head.
//   Measured: with the contents rows removed, question 2.206 matched an entry on
//   answer page 25 whose entire text was "7 第一章 2023 年数学分析真题分类" — a
//   running head — at similarity 0.574, and returned it at MEDIUM. One wrong
//   answer, produced entirely by boilerplate matching boilerplate.
//
// ── the signal, and why frequency alone is not it ──
//
// A repeated line is not necessarily boilerplate. Measured across the corpus,
// real mathematics repeats too:
//
//   line                                    pages   at page edge
//   公众号：八一考研数学竞赛 (watermark)        80%          80%
//   第一章 2023 年数学分析真题分类 (head)       27%         100%
//   1.1 极限与连续函数 (section head)            6%         100%
//   n→∞ n→∞                                    19%           0%
//   x→+∞                                       17%           2%
//
// Frequency puts n→∞ above the section head. POSITION separates them completely:
// boilerplate is what sits at the top or bottom of the page, and mathematics is
// what sits in the middle. Every boilerplate line measured is at an edge on at
// least 63% of its occurrences; every real repeated expression is at an edge on
// at most 8%. The threshold sits in the middle of that gap and is not delicate.
//
// ── the exemption that matters ──
//
// A line that OPENS A QUESTION is never boilerplate, however often it repeats.
// "例题 1.31 2023. 大连理工大学 原 PDF 第 25 页" recurs on 18 pages because many
// questions come from the same university, and it sits at an edge 64% of the
// time — it would be stripped, taking the question's own label with it. Carrying
// a label is what makes a line structural, so labelled lines are exempt before
// any of the other tests run.

import { parseQuestionLine, parseSubQuestionLine } from './question-id.js';

const THRESHOLDS = Object.freeze({
  /** Distinct pages a line must appear on before repetition means anything. */
  minPages: 8,
  /** ...and that many pages must be this share of the book. */
  minPageShare: 0.05,
  /**
   * Share of a line's occurrences that must sit at the top or bottom of a page.
   *
   * Measured gap: real repeated mathematics reaches 8%, the least edge-bound
   * boilerplate reaches 63%. Half sits in the middle of that and is not a
   * tuned value.
   */
  minEdgeShare: 0.5,
  /** How many lines from the top or bottom counts as the edge. */
  edgeDepth: 2,
  /**
   * Lines a page needs before its positions mean anything.
   *
   * With edgeDepth 2 a four-line page is ALL edge, so every repeated line on it
   * would read as a running head — including real content. Sparse pages are not
   * hypothetical: the scanned 2025 exercise book extracts 65 lines across 465
   * pages. A page with no middle contributes no position evidence at all, which
   * errs toward keeping content rather than stripping it.
   */
  minLinesForPosition: 5,
  /** Shorter normalized forms are too common to judge. */
  minLength: 4,
});

/** Digits removed, because a running head differs only by its page number. */
const normalize = (text) => String(text ?? '').replace(/\d+/g, '').replace(/\s+/g, '').trim();

/** A line carrying a question or subquestion label is structural, never boilerplate. */
function carriesLabel(text) {
  return !!parseQuestionLine(text) || !!parseSubQuestionLine(text);
}

/**
 * The normalized line forms that are running heads, footers or watermarks.
 *
 * @param {Array<{page:number,text:string}>} lines in document order
 * @returns {{forms: Set<string>, report: Array}}
 */
export function findBoilerplate(lines) {
  const byPage = new Map();
  for (const line of lines ?? []) {
    if (!byPage.has(line.page)) byPage.set(line.page, []);
    byPage.get(line.page).push(line);
  }
  const pageCount = byPage.size;
  if (pageCount === 0) return { forms: new Set(), report: [] };

  const stats = new Map();
  for (const [page, pageLines] of byPage) {
    // A page too short to have a middle cannot say where its lines sit.
    if (pageLines.length < THRESHOLDS.minLinesForPosition) continue;
    pageLines.forEach((line, i) => {
      if (carriesLabel(line.text)) return;
      const form = normalize(line.text);
      if (form.length < THRESHOLDS.minLength) return;

      if (!stats.has(form)) stats.set(form, { pages: new Set(), edge: 0, total: 0 });
      const s = stats.get(form);
      s.pages.add(page);
      s.total++;
      const fromEnd = pageLines.length - 1 - i;
      if (i < THRESHOLDS.edgeDepth || fromEnd < THRESHOLDS.edgeDepth) s.edge++;
    });
  }

  const forms = new Set();
  const report = [];
  for (const [form, s] of stats) {
    const pages = s.pages.size;
    if (pages < THRESHOLDS.minPages) continue;
    if (pages / pageCount < THRESHOLDS.minPageShare) continue;
    const edgeShare = s.edge / s.total;
    if (edgeShare < THRESHOLDS.minEdgeShare) continue;
    forms.add(form);
    report.push({ form, pages, pageShare: pages / pageCount, edgeShare });
  }
  report.sort((a, b) => b.pages - a.pages);
  return { forms, report };
}

/**
 * A predicate that recognises this document's boilerplate lines.
 *
 * Given to the indexers so they can keep segmenting on the full line stream —
 * a question's boundaries are defined by the lines that are actually there —
 * while excluding boilerplate from the text that gets compared. Removing the
 * lines outright instead moves entry boundaries, which measurably cost regime C
 * 33 of 77 resolved questions: the structure and the comparison need different
 * inputs.
 *
 * @returns {(line: {text: string}) => boolean}
 */
export function boilerplateFilter(lines) {
  const { forms } = findBoilerplate(lines);
  if (forms.size === 0) return () => false;
  return (line) => !carriesLabel(line?.text) && forms.has(normalize(line?.text));
}

/**
 * Removes running heads, footers and watermarks.
 *
 * Returns a new array; the caller's lines are not modified, because the quality
 * gate measures the text layer as extracted and must not see a cleaned version
 * of it.
 *
 * @returns {{lines: Array, removed: number, report: Array}}
 */
export function stripBoilerplate(lines) {
  const { forms, report } = findBoilerplate(lines);
  if (forms.size === 0) return { lines: lines ?? [], removed: 0, report: [] };

  const kept = [];
  let removed = 0;
  for (const line of lines ?? []) {
    if (!carriesLabel(line.text) && forms.has(normalize(line.text))) { removed++; continue; }
    kept.push(line);
  }
  return { lines: kept, removed, report };
}
