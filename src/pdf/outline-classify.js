// What kind of thing is this bookmark?
//
// The engine previously answered this with one rule: a node carrying an id at
// the deepest outline depth is a question, everything else is a section. On the
// 2023 books that rule is right, because their questions genuinely sit at depth
// 2. On a book whose question bookmarks are simply ABSENT it is catastrophically
// wrong — the deepest surviving depth is then the SECTION level, and every
// section becomes a question.
//
// Measured consequence, from the 2023/2025 whole-book test report: an exercise
// book with 18 section bookmarks and no question bookmarks produced 18
// "questions", which matched against the answer key's real question ids and
// yielded 479 accepted matches at HIGH confidence, every one of them wrong, at a
// true-question recall of 0/573. Chapter "1.2 一元函数微分学" was being matched as
// question "1.2".
//
// The same defect costs coverage as well as precision: while the 18 sections are
// being consumed as questions they are not available as SECTION anchors, which
// is what the region locator needs to tell a reader which pages of the answer
// key to turn to. Correct classification is therefore not a precision/coverage
// trade — it is the same fix on both axes.
//
// ── the discriminators, from the real corpus ──
//
//   section   "1.1 极限与连续函数"      id, then descriptive text
//   section   "第一章  2023 年数学分析真题分类"   chapter marker, no id
//   section   "题号索引"                 no id at all
//   question  "例题 1.1"                 question marker, id, nothing else
//
// The descriptive residue is the signal that survives the loss of the question
// level: a section title says what the section is about, and a question bookmark
// does not. It is available with no children, no siblings and no page spans, and
// it is what separates the truncated case the depth rule cannot see.
//
// ── which way to be wrong ──
//
// Typing a question as a section costs COVERAGE: it stops being matchable and
// becomes a location anchor instead. Typing a section as a question costs
// PRECISION: it enters the question index and matches something. Under "a wrong
// match is worse than no match" those are not symmetric, so every ambiguous
// cohort resolves to SECTION and `UNKNOWN` never enters the question index.

import { idFromOutlineTitle } from './question-id.js';

/** What an outline node represents. */
export const NODE_KIND = Object.freeze({
  /** The whole volume, or a top-level part. */
  BOOK: 'BOOK',
  /** A chapter or section: contains questions, is not one. */
  SECTION: 'SECTION',
  /** A grouping by question type ("计算题", "证明题"). Not a question either. */
  QUESTION_TYPE: 'QUESTION_TYPE',
  /** An actual question. Only these may enter the question index. */
  QUESTION: 'QUESTION',
  /** Undecidable. Treated as SECTION for safety; never as a question. */
  UNKNOWN: 'UNKNOWN',
});

/**
 * Markers that name a node as a question outright.
 *
 * 例题 is the form the 2023 and 2024 books use. The others are included because
 * they are the conventional alternatives in the same publishing tradition and
 * cost nothing to accept; none of them appears in a section title in this corpus.
 */
const QUESTION_MARKER = /(例题|习题|练习题|例\s*\d|第\s*\d{1,4}\s*题|Example|Exercise|Problem)/i;

/** Markers that name a node as structure outright. */
const SECTION_MARKER =
  /(^第\s*[0-9一二三四五六七八九十百]+\s*[章节部编篇]|^Chapter|^Part|^Section|索引|目\s*录|Contents|Index)/i;

/** Groupings by question type — structure, not questions. */
const TYPE_MARKER = /(计算题|证明题|填空题|选择题|解答题|应用题|综合题)/;

/**
 * Characters that count as a description rather than as an identifier.
 *
 * Digits and punctuation are excluded because an id is made of them. What is
 * left is the prose a section title carries and a question bookmark does not.
 */
const DESCRIPTIVE = /[\p{Script=Han}\p{Letter}]/u;

const THRESHOLDS = Object.freeze({
  /**
   * Descriptive characters above which a title is describing a topic.
   *
   * Two, because the shortest real section title in the corpus is 极限 (2) and
   * every question bookmark reduces to 0 once its marker and id are removed.
   */
  minDescriptive: 2,
  /**
   * Pages a single question may span.
   *
   * Questions in this corpus span 1-3 pages. A node covering more is describing
   * a region of the book, not asking something.
   */
  maxQuestionSpan: 8,
  /** Share of a cohort that must carry a question marker for the cohort to be questions. */
  markerShare: 0.5,
  /** Share of a cohort that must be descriptive for the cohort to be sections. */
  descriptiveShare: 0.5,
  /**
   * Nodes needed before an unmarked, non-descriptive cohort may be read as
   * questions on its shape alone. A handful of bare numeric bookmarks is far
   * more likely to be a truncated section list than a very short exercise book.
   */
  minBareQuestionCohort: 20,
});

/** Title with question/section markers and every numeric id token removed. */
function residueOf(title) {
  return String(title ?? '')
    .replace(QUESTION_MARKER, ' ')
    .replace(TYPE_MARKER, ' ')
    .replace(SECTION_MARKER, ' ')
    .replace(/\d{1,4}(?:[.．]\d{1,4})*/g, ' ')
    .replace(/[\s.．、,，:：;；()（）\[\]【】-]+/g, '');
}

/** How many characters of description a title carries beyond its identifier. */
export function descriptiveLength(title) {
  const residue = residueOf(title);
  let n = 0;
  for (const ch of residue) if (DESCRIPTIVE.test(ch)) n++;
  return n;
}

function flatten(outline) {
  const out = [];
  const walk = (items, depth, path) => {
    for (const item of items || []) {
      if (!item?.title) continue;
      const node = {
        title: item.title,
        pageNumber: item.pageNumber,
        endPage: item.endPage,
        depth: item.depth ?? depth,
        childCount: item.children?.length ?? 0,
        sectionPath: path,
        raw: item,
      };
      out.push(node);
      if (item.children?.length) walk(item.children, depth + 1, [...path, item.title]);
    }
  };
  walk(outline?.items, 0, []);
  return out;
}

/**
 * Page span of each node, inferred from the next node at the same-or-shallower
 * depth. Bookmark trees rarely carry an end page, and the span is one of the
 * few signals available when the title is uninformative.
 */
function withSpans(nodes, numPages) {
  const sorted = [...nodes].sort((a, b) =>
    (a.pageNumber ?? 0) - (b.pageNumber ?? 0) || (a.depth ?? 0) - (b.depth ?? 0));
  return sorted.map((node, i) => {
    if (Number.isFinite(node.endPage)) return { ...node, span: node.endPage - node.pageNumber + 1 };
    const next = sorted.slice(i + 1).find(n => (n.pageNumber ?? 0) > (node.pageNumber ?? 0));
    const end = next ? next.pageNumber - 1 : (numPages || node.pageNumber);
    return { ...node, endPage: Math.max(node.pageNumber ?? 0, end), span: Math.max(1, end - (node.pageNumber ?? 0) + 1) };
  });
}

/**
 * Decides one depth level at a time.
 *
 * Per-node rules alone are brittle: a single oddly-titled bookmark flips, and a
 * question index gains an entry it should not have. A bookmark tree is written
 * by one tool following one convention, so the level is the unit that actually
 * carries the convention — and aggregate signals (what share of this level
 * carries a marker, how many nodes there are, what the median span is) are far
 * more stable than any individual title.
 */
function classifyCohort(cohort) {
  const n = cohort.length;
  if (n === 0) return { kind: NODE_KIND.UNKNOWN, reason: 'empty' };

  const withId = cohort.filter(c => c.questionId);
  const marked = cohort.filter(c => QUESTION_MARKER.test(c.title));
  const typed = cohort.filter(c => TYPE_MARKER.test(c.title));
  const structural = cohort.filter(c => SECTION_MARKER.test(c.title));
  const descriptive = cohort.filter(c => descriptiveLength(c.title) >= THRESHOLDS.minDescriptive);
  const parents = cohort.filter(c => c.childCount > 0);
  const spans = cohort.map(c => c.span ?? 1).sort((a, b) => a - b);
  const medianSpan = spans[Math.floor(spans.length / 2)] ?? 1;

  // A node that contains other nodes is a container. Questions contain nothing.
  if (parents.length > n / 2) {
    return { kind: NODE_KIND.SECTION, reason: 'cohort has children' };
  }
  if (structural.length > n / 2) {
    return { kind: NODE_KIND.SECTION, reason: 'chapter/index markers' };
  }
  if (typed.length > n / 2) {
    return { kind: NODE_KIND.QUESTION_TYPE, reason: 'question-type grouping' };
  }
  // An explicit question marker outranks the shape signals: "例题 1.1" is a
  // question even when the level it sits on looks unusual.
  if (marked.length >= n * THRESHOLDS.markerShare) {
    return { kind: NODE_KIND.QUESTION, reason: 'question markers' };
  }
  if (withId.length === 0) {
    return { kind: NODE_KIND.SECTION, reason: 'no identifiers' };
  }
  // The signal that survives losing the question level. "1.1 极限与连续函数"
  // describes a topic; "例题 1.1" does not.
  if (descriptive.length >= n * THRESHOLDS.descriptiveShare) {
    return { kind: NODE_KIND.SECTION, reason: 'titles describe a topic' };
  }
  if (medianSpan > THRESHOLDS.maxQuestionSpan) {
    return { kind: NODE_KIND.SECTION, reason: `median span ${medianSpan} pages` };
  }
  if (n >= THRESHOLDS.minBareQuestionCohort) {
    return { kind: NODE_KIND.QUESTION, reason: 'dense short-span identifier cohort' };
  }
  // Undecidable. Deliberately not a question: see the module header on which
  // way to be wrong.
  return { kind: NODE_KIND.UNKNOWN, reason: 'insufficient evidence; withheld from question index' };
}

/**
 * Classifies every node of an outline.
 *
 * @param {object} outline the document's outline: { available, items }
 * @param {{numPages?: number}} options
 * @returns {{
 *   nodes: Array,            every node with .kind
 *   questions: Array,        kind === QUESTION, in book order
 *   sections: Array,         kind === SECTION or BOOK, in book order
 *   cohorts: Array,          per-depth verdicts, for diagnostics
 *   hasQuestionLevel: boolean
 * }}
 */
export function classifyOutline(outline, { numPages } = {}) {
  const flat = flatten(outline);
  const empty = { nodes: [], questions: [], sections: [], cohorts: [], hasQuestionLevel: false };
  if (flat.length === 0) return empty;

  const spanned = withSpans(flat, numPages).map(node => ({
    ...node,
    questionId: idFromOutlineTitle(node.title),
  }));

  const depths = [...new Set(spanned.map(n => n.depth))].sort((a, b) => a - b);
  const cohorts = [];
  const byDepth = new Map();
  for (const depth of depths) {
    const cohort = spanned.filter(n => n.depth === depth);
    const verdict = classifyCohort(cohort);
    // The shallowest level of a multi-level tree is the volume's own structure.
    const kind = (depth === 0 && depths.length > 1 && verdict.kind === NODE_KIND.SECTION)
      ? NODE_KIND.BOOK
      : verdict.kind;
    byDepth.set(depth, kind);
    cohorts.push({ depth, kind, count: cohort.length, reason: verdict.reason });
  }

  const nodes = spanned.map((node) => {
    let kind = byDepth.get(node.depth) ?? NODE_KIND.UNKNOWN;
    // Per-node override in the safe direction only. A node with children cannot
    // be a question however its cohort was read; the reverse override is not
    // offered, because promoting a node INTO the question index is exactly the
    // move that produced the 479 wrong matches.
    if (kind === NODE_KIND.QUESTION && node.childCount > 0) kind = NODE_KIND.SECTION;
    if (kind === NODE_KIND.QUESTION && !node.questionId) kind = NODE_KIND.UNKNOWN;
    return { ...node, kind };
  });

  const inOrder = (a, b) => (a.pageNumber ?? 0) - (b.pageNumber ?? 0);
  const questions = nodes.filter(n => n.kind === NODE_KIND.QUESTION).sort(inOrder);
  const sections = nodes
    .filter(n => n.kind === NODE_KIND.SECTION || n.kind === NODE_KIND.BOOK
      || n.kind === NODE_KIND.QUESTION_TYPE)
    .sort(inOrder);

  return {
    nodes,
    questions,
    sections,
    cohorts,
    hasQuestionLevel: questions.length > 0,
  };
}
