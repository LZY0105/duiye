// Which body lines actually open a question?
//
// The outline classifier settled this for bookmark trees: a node carrying an id
// is not a question just because it carries an id. The body parser never learned
// the same lesson, and it costs more here than it did there.
//
// Measured on the 2023 exercise book with its bookmarks stripped: the section
// running head "1.1 极限与连续函数" is printed on 22 pages, parses as question
// "1.1" on every one of them, and 205 of 712 body entries open with a line of
// that kind. Under the strict metric those become 188 accepted results that no
// ground truth can confirm — 74.3% strict precision in a regime that is
// otherwise correct.
//
// It survives the boilerplate filter because of an exemption added to protect
// question openers: a line carrying a question label is never treated as
// boilerplate, so "例题 1.31 2023. 大连理工大学 原 PDF 第 25 页" keeps its label.
// A section running head carries a label too, and inherited the same protection.
//
// ── two independent disqualifiers ──
//
// **Repetition.** A question is printed once. A running head is printed on every
// page of its section. Measured: "1.1 极限与连续函数" on 22 pages, "1.2 一元函数
// 微分学" on 19, while real question openers appear on exactly one page each.
// This test needs no vocabulary and works in any language.
//
// **Marker discipline.** Where a book marks its questions — 例题, 习题, 第 N 题,
// Example, Exercise, Problem — a labelled line WITHOUT such a marker but WITH a
// descriptive title is a heading. "1.1 极限与连续函数" describes a topic;
// "例题 1.1" does not. This is the same descriptive-residue test the outline
// classifier uses, applied to body text.
//
// Either disqualifier is sufficient. They are independent: repetition catches a
// heading in a book that marks nothing, and marker discipline catches a heading
// that happens to appear only once.
//
// ── which way to be wrong ──
//
// Rejecting a real question opener costs coverage; accepting a heading costs
// precision, and the heading will then match something. The marker rule
// therefore only engages when the document has demonstrated that it marks its
// questions, so a book that numbers questions "1.31 求下列函数的导数" with no
// marker at all is left alone rather than emptied.

import { descriptiveLength } from './outline-classify.js';
import { parseQuestionLine } from './question-id.js';

const QUESTION_MARKER = /(例\s*题|习\s*题|练习题|第\s*\d{1,4}\s*题|Example|Exercise|Problem)/i;

const THRESHOLDS = Object.freeze({
  /**
   * Distinct pages a labelled line may appear on before it is a running head.
   *
   * Four. Measured separation is wide — real question openers appear on exactly
   * one page, section running heads on 13 to 22 — so this sits well clear of the
   * legitimate case. A question genuinely spanning four pages still opens on
   * only one of them.
   */
  maxPagesForQuestion: 4,
  /**
   * Share of labelled lines that must carry a question marker before absence of
   * a marker is taken as evidence.
   *
   * Below this the book does not mark its questions and the rule is withheld
   * rather than applied to a convention the document does not follow.
   */
  markerShare: 0.2,
  /** Descriptive characters that make a labelled line read as a topic heading. */
  minDescriptive: 2,
});

/**
 * The identity of a printed line, for deciding whether it repeats.
 *
 * The line AS PRINTED, normalized only for whitespace. Digits are deliberately
 * kept.
 *
 * An earlier version stripped them, reasoning that a running head differs only
 * by its page number. That is true of unlabelled heads, which the boilerplate
 * filter already handles — and false here in two directions. It made every
 * question from one university identical ("例题 ?.? 2023. 大连理工大学 原 PDF 第
 * ? 页"), deleting 495 of 508 real questions; and in a book whose numbering
 * restarts each chapter it collapsed question 1 of every chapter onto one key,
 * because chapter number and exponent are both digits.
 *
 * A section running head is literally the same string on every page it appears
 * on. A question opener never is: it carries its own number, and usually a
 * source and a page reference too. Comparing the printed line is therefore both
 * simpler and stricter than trying to guess which digits are incidental.
 */
function repetitionKey(text) {
  if (!parseQuestionLine(text)) return null;
  return String(text ?? "").replace(/\s+/g, " ").trim();
}

/** True when a line names itself a question. */
export function carriesQuestionMarker(text) {
  return QUESTION_MARKER.test(String(text ?? ''));
}

/**
 * Builds a per-document predicate deciding whether a line opens a question.
 *
 * Document-level rather than line-level on purpose: both disqualifiers depend on
 * what the rest of the book does. A line cannot be known to repeat, or to be
 * missing a convention, without seeing the convention.
 *
 * @param {Array<{page:number,text:string}>} lines
 * @returns {{
 *   opensQuestion: (line: {page:number,text:string}) => boolean,
 *   marksQuestions: boolean,
 *   headings: number,
 *   report: Array,
 * }}
 */
export function bodyQuestionFilter(lines) {
  const list = lines ?? [];

  const pagesByForm = new Map();
  let labelled = 0;
  let marked = 0;
  for (const line of list) {
    if (!parseQuestionLine(line?.text)) continue;
    labelled++;
    if (carriesQuestionMarker(line.text)) marked++;
    const form = repetitionKey(line.text);
    if (!form) continue;
    if (!pagesByForm.has(form)) pagesByForm.set(form, new Set());
    pagesByForm.get(form).add(line.page);
  }

  const marksQuestions = labelled > 0 && (marked / labelled) >= THRESHOLDS.markerShare;

  const report = [];
  const repeated = new Set();
  for (const [form, pages] of pagesByForm) {
    if (pages.size > THRESHOLDS.maxPagesForQuestion) {
      repeated.add(form);
      report.push({ form, pages: pages.size, reason: 'repeats across pages' });
    }
  }
  report.sort((a, b) => b.pages - a.pages);

  const opensQuestion = (line) => {
    const text = String(line?.text ?? '');
    if (!parseQuestionLine(text)) return false;
    // A question is printed once; a running head is printed on every page of
    // its section.
    if (repeated.has(repetitionKey(text))) return false;
    // Where the book marks its questions, an unmarked line that describes a
    // topic is a heading.
    if (marksQuestions
      && !carriesQuestionMarker(text)
      && descriptiveLength(text) >= THRESHOLDS.minDescriptive) return false;
    return true;
  };

  return { opensQuestion, marksQuestions, headings: repeated.size, report };
}
