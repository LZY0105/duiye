// PDF Module — answer-book indexing.
//
// Turns an answer PDF into labelled entries the matcher can work against.
//
// The governing rule is that a WRONG match is worse than no match. If the wrong
// answer is handed to the grader, every later stage — verification, error
// localization, feedback — is confidently wrong, and the student is told their
// correct work is mistaken. So this module only reports a match it can justify,
// and reports ambiguity as ambiguity.
//
// Two things drive the shape of this file, both learned from the real books
// rather than from synthetic fixtures:
//
//   1. The bookmark tree is the reliable source of question ids. Measured on the
//      2023 set, the outline yields 508 questions with 508 DISTINCT hierarchical
//      ids and no duplicates, on both the exercise book and the key. The body
//      text yields nothing trustworthy at all, because —
//
//   2. — the text layer's CJK mapping is broken. All four books in the corpus
//      extract with 0–1.9% Han characters. Matching against that is matching
//      against noise, and the noise scores in the normal range.
//
// So: outline first, body text only as a supplement, and never any content
// comparison at all when the quality gate says the text cannot be trusted.

import { classifyOutline } from './outline-classify.js';
import { suppressContentsRows } from './toc-filter.js';
import { boilerplateFilter } from './boilerplate.js';
import { bodyQuestionFilter } from './body-structure.js';
import { buildContentsLocations } from './contents-index.js';
import { createTextSource } from './text-source.js';
import { createTextCleaner, entryText } from './entry-text.js';
import {
  compareIds,
  normalizeId,
  parseQuestionLine,
  parseSubQuestionLine,
  questionKey,
} from './question-id.js';
import {
  TEXT_QUALITY,
  alphabetOfLines,
  assessTextQuality,
  compareAlphabets,
  requiresRecognizer,
  textIsComparable,
  textMayBeComparable,
} from './text-quality.js';

export { TEXT_QUALITY } from './text-quality.js';

/** Where an index's entries came from. Governs how far they can be trusted. */
export const INDEX_SOURCE = Object.freeze({
  /** From the PDF bookmark tree. Ids are stable and structural. */
  OUTLINE: 'OUTLINE',
  /** Parsed out of the text layer. Ids are only as good as the extraction. */
  BODY: 'BODY',
  /**
   * Parsed from the text layer and corroborated by the book's printed contents.
   *
   * Two independent readings of the same document agreeing on where a label
   * lives. Structurally this is what a bookmark tree provides, and it is treated
   * as one. See src/contents-index.js.
   */
  CONTENTS: 'CONTENTS',
  /** Nothing usable. The reason says which of the four failures this is. */
  NONE: 'NONE',
});

/**
 * Strips an answer-book prefix at the start of an entry.
 *
 * 答案 is distinctive enough to strip on its own. The single-character markers
 * are not: 答 and 解 open ordinary words, and stripping them bare turned
 * "解答过程中没有标记" into "答过程中没有标记" — an answer silently missing its
 * first character. They must be followed by a delimiter or whitespace to count
 * as a marker rather than as the start of a word.
 */
const ANSWER_PREFIXES =
  /^\s*(?:答案\s*[:：.．、]?\s*|(?:答|解|Answer|Ans)\s*(?:[:：.．、]\s*|\s+))/i;

/**
 * The same marker appearing mid-line, as in "求 f(x) 的导数，答案：2x+3".
 * A colon is required here: 答 and 解 occur constantly in ordinary prose, and
 * without the colon this would cut answers out of the middle of explanations.
 */
const ANSWER_INLINE = /(?:答案|答|解|Answer|Ans)\s*[:：]\s*/i;

/**
 * Parses one line into {label, body} when it opens a new numbered entry.
 *
 * `label` is a canonical hierarchical id — "1.200" stays "1.200" rather than
 * collapsing to "1". Subquestion openers "(1)" return null here; they belong to
 * whichever question is already open and are handled by buildAnswerIndex.
 *
 * @returns {{label: string, body: string}|null}
 */
export function parseLabelledLine(line) {
  const parsed = parseQuestionLine(line);
  return parsed ? { label: parsed.id, body: parsed.body } : null;
}

/**
 * Builds an index from extracted lines.
 *
 * Lines following a label are appended to that entry until the next label, so a
 * multi-line answer stays whole. A "(1)"/"(2)" opener does not start a new
 * entry — it opens a subquestion of the entry already in progress, recorded
 * separately so the caller can address it without it ever competing as a
 * top-level id.
 *
 * @param {Array<{page:number, text:string}>} lines from document.extractText()
 * @returns {{entries: Array, duplicates: string[], byLabel: Map, source: string}}
 */
export function buildAnswerIndex(lines, {
  isBoilerplate = () => false,
  opensQuestion = null,
} = {}) {
  const collected = [];
  let current = null;
  // A labelled line is not automatically a question opener: a section running
  // head carries a label too, and is printed on every page of its section. See
  // src/body-structure.js.
  const opens = opensQuestion ?? bodyQuestionFilter(lines).opensQuestion;

  for (const { page, text } of lines ?? []) {
    const labelled = opens({ page, text }) ? parseLabelledLine(text) : null;
    if (labelled) {
      if (current) collected.push(current);
      current = {
        label: labelled.label,
        page,
        endPage: page,
        lines: labelled.body ? [labelled.body] : [],
        subQuestions: [],
      };
      continue;
    }

    if (!current) continue;
    current.endPage = page;
    // Running heads and watermarks bound the entry — the page they sit on is
    // still part of it — but they are not its content and must not be compared.
    if (isBoilerplate({ page, text })) continue;

    const sub = parseSubQuestionLine(text);
    if (sub) {
      current.subQuestions.push({ sub: sub.sub, text: sub.body });
      if (sub.body) current.lines.push(sub.body);
      continue;
    }

    // Continuation of whatever is open — the question body, or the most recent
    // subquestion of it.
    current.lines.push(text);
    const openSub = current.subQuestions[current.subQuestions.length - 1];
    if (openSub) openSub.text = `${openSub.text} ${text}`.trim();
  }
  if (current) collected.push(current);

  const parsed = collected
    .map((entry, ordinal) => finalizeEntry(entry, ordinal, INDEX_SOURCE.BODY))
    .filter(entry => entry.text.length > 0);

  // The book's own table of contents lists every question id, so without this
  // every label is found twice and a unique id looks ambiguous. Measured on the
  // 2023 key: 825 of 872 lookups returned two candidates, one of them a contents
  // row, and refused. See src/toc-filter.js.
  const { entries, suppressed, pages } = suppressContentsRows(parsed);

  return {
    entries,
    ...labelStatistics(entries),
    source: INDEX_SOURCE.BODY,
    contentsPages: pages,
    contentsRowsSuppressed: suppressed.length,
  };
}

/**
 * Builds an index from the PDF bookmark tree.
 *
 * Question bookmarks are told apart from section headings structurally, not by
 * reading them: either they carry the 例题 marker, or they sit at the deepest
 * level of the outline. Both tests survive a broken font, which is the whole
 * reason for preferring the outline in the first place.
 *
 * Body text is attached per question only when the quality gate allows it. When
 * it does not, entries still carry their ids and page ranges — that is enough
 * for an exact-id match, and an exact-id match is what this corpus needs.
 */
export function buildOutlineIndex(outline, lines, {
  numPages, quality, isBoilerplate, scopeText = true,
} = {}) {
  const none = () => ({
    entries: [], duplicates: [], byLabel: new Map(), source: INDEX_SOURCE.NONE,
  });

  // Structural classification, not "deepest id-bearing depth". The old rule
  // silently turned a section list into a question index whenever the question
  // level was missing; see src/outline-classify.js for what that cost.
  const classified = classifyOutline(outline, { numPages });
  if (!classified.hasQuestionLevel) {
    return { ...none(), sections: classified.sections, cohorts: classified.cohorts };
  }

  const questions = classified.questions
    .map(item => ({ ...item, id: item.questionId }))
    .filter(item => item.id);
  if (questions.length === 0) {
    return { ...none(), sections: classified.sections, cohorts: classified.cohorts };
  }

  const ordered = [...questions].sort((a, b) =>
    (a.pageNumber - b.pageNumber) || compareIds(a.id, b.id));

  const usable = isBoilerplate ? (lines ?? []).filter(l => !isBoilerplate(l)) : lines;
  const linesByPage = textMayBeComparable(quality) ? groupByPage(usable) : null;
  // Text is attributed to the question that OWNS it, bounded by the printed
  // headings the book itself supplies, and cleaned of structure that the
  // extractor interleaved into the character stream. See src/entry-text.js.
  const cleaner = scopeText
    ? createTextCleaner({
      sectionTitles: classified.sections.map(s => s.title),
      lines: usable ?? [],
    })
    : null;
  const lastPage = numPages || ordered[ordered.length - 1]?.pageNumber || 0;

  const entries = ordered.map((item, i) => {
    const next = ordered[i + 1];
    // Consecutive questions routinely share a page, so a question's range runs
    // up to and INCLUDING the next one's page rather than stopping before it.
    const endPage = next ? Math.max(item.pageNumber, next.pageNumber) : lastPage;

    // Two texts, for two different jobs, and conflating them was a mistake.
    //
    // The entry text stays the PAGE RANGE. Every threshold in the engine — role
    // classification, content similarity, the contents corroboration — was
    // calibrated against it, and narrowing it silently moved all of them at
    // once: measured, the 2024 answer keys fell from 3,265 to 587 characters per
    // entry and stopped reading as answer keys at all, rejecting two valid pairs.
    //
    // scopedText is the question's OWN material, bounded by printed headings
    // and cleaned of interleaved structure. It exists for evidence that must not
    // be contaminated by neighbours — formula extraction above all, where a page
    // number glued into an expression reads as a structural conflict.
    const text = linesByPage ? collectText(linesByPage, item.pageNumber, endPage) : '';

    let scopedText = '';
    let scoped = false;
    let geometry = {};
    if (linesByPage && cleaner) {
      const own = entryText(
        usable ?? [],
        { label: item.id, page: item.pageNumber, endPage },
        next ? { label: next.id, page: next.pageNumber } : null,
        cleaner,
      );
      scopedText = own.text;
      scoped = own.scoped;
      geometry = own.spans.length ? { spans: own.spans } : {};
    }
    return {
      ...finalizeEntry({
        label: item.id,
        page: item.pageNumber,
        endPage,
        lines: text ? [text] : [],
        subQuestions: [],
        depth: item.depth ?? 0,
        title: item.title,
      }, i, INDEX_SOURCE.OUTLINE),
      // The question's own material, and whether it could actually be bounded.
      // The formula gate needs both: evidence drawn from a page range says
      // nothing reliable about the question that happens to start on it.
      scopedText,
      textScoped: scoped,
      // Where this question sits on each page it occupies, when the adapter says.
      ...geometry,
    };
  });

  return {
    entries,
    ...labelStatistics(entries),
    source: INDEX_SOURCE.OUTLINE,
    sections: classified.sections,
    cohorts: classified.cohorts,
  };
}

function finalizeEntry(entry, ordinal, source) {
  const text = entry.lines.join(' ').trim();
  const label = normalizeId(entry.label) || String(entry.label ?? '');
  return {
    // Unique per entry. Page and label together are NOT unique — a page can
    // carry the same label twice in a damaged extraction — so the ordinal is
    // part of the identity.
    id: `${source}:${ordinal}#${label}@${entry.page}`,
    label,
    key: questionKey(label) || label,
    // Position in book order. The only anchor left when there is no outline and
    // the numbering restarts every chapter; see src/positional-prior.js.
    ordinal,
    page: entry.page,
    endPage: entry.endPage ?? entry.page,
    depth: entry.depth ?? null,
    title: entry.title ?? null,
    text,
    answer: extractAnswer(text),
    source,
    subQuestions: entry.subQuestions ?? [],
  };
}

/**
 * Marks entries whose location the printed contents independently confirms, and
 * resolves duplicates in favour of the confirmed one.
 *
 * The duplicate resolution is the point as much as the mark is. Body parsing
 * finds a label more than once — a restatement inside an answer, a subquestion
 * marker that survived — and a duplicated label is refused rather than guessed.
 * When exactly one of those copies sits where the contents says the answer is,
 * the ambiguity is not a judgement call any more.
 */
function applyContentsLocations(entries, locations) {
  if (!(locations instanceof Map) || locations.size === 0) {
    return { entries, marked: 0 };
  }
  const marked = [];
  let count = 0;
  const byLabel = new Map();
  for (const entry of entries) {
    const loc = locations.get(entry.label);
    const structural = !!loc && loc.page === entry.page;
    if (structural) count++;
    const next = { ...entry, structural, printedPage: loc?.printedPage ?? null };
    marked.push(next);
    if (!byLabel.has(entry.label)) byLabel.set(entry.label, []);
    byLabel.get(entry.label).push(next);
  }

  // Where a label has several parses and exactly one is confirmed, the others
  // are extraction artefacts and are dropped rather than left to create an
  // ambiguity the engine would have to refuse.
  const drop = new Set();
  for (const [, bucket] of byLabel) {
    if (bucket.length < 2) continue;
    const confirmed = bucket.filter(e => e.structural);
    if (confirmed.length !== 1) continue;
    for (const e of bucket) if (!e.structural) drop.add(e.id);
  }

  return { entries: marked.filter(e => !drop.has(e.id)), marked: count };
}

/**
 * The label -> entries map, plus the labels that repeat.
 *
 * Built once at index time so a lookup is O(1). Previously every lookup scanned
 * and scored the whole entry list, which on a 508-question book meant doing the
 * expensive thing before checking whether the cheap exact answer existed.
 */
function labelStatistics(entries) {
  const byLabel = new Map();
  for (const entry of entries) {
    const bucket = byLabel.get(entry.label);
    if (bucket) bucket.push(entry);
    else byLabel.set(entry.label, [entry]);
  }
  const duplicates = [...byLabel.entries()]
    .filter(([, bucket]) => bucket.length > 1)
    .map(([label]) => label);
  return { byLabel, duplicates };
}

/**
 * Recognises a document page by page through the injected recognizer.
 *
 * Failures are contained rather than propagated: a recognizer that throws on one
 * page must not abort the whole document, and a recognizer that throws on EVERY
 * page must not look like a document with no text. Both end at the same place —
 * an unusable result and OCR_REQUIRED still set — but the counts distinguish
 * them for diagnosis.
 *
 * @returns {{lines, assessment, usable, pagesRecognised, pagesFailed, truncated, reason}}
 */
async function recogniseDocument(doc, recognizer, { expectScript, budget }) {
  const total = doc.numPages ?? 0;
  const limit = Math.min(total, budget);
  const lines = [];
  let pagesRecognised = 0;
  let pagesFailed = 0;

  // The recognizer is called directly rather than through createTextSource,
  // for one reason that matters: pageText JOINS a page's lines into a single
  // string. Every label parser in this engine is anchored to the start of a
  // line, and the start of a joined page is its running head — so a page whose
  // second line reads "例题 1.78 ..." yields no question at all. Measured, that
  // turned 400 successfully recognised pages into 0 indexed questions.
  //
  // A document that reaches here has already been judged unable to serve its own
  // text, so there is no layer for createTextSource to prefer and nothing lost by
  // going straight to the recogniser.
  for (let page = 1; page <= limit; page++) {
    let text = '';
    try {
      const got = await recognizer(page);
      text = Array.isArray(got)
        ? got.map(r => r?.text ?? '').join('\n')
        : String(got ?? '');
    } catch {
      pagesFailed++;
      continue;
    }

    const pageLines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
    if (pageLines.length === 0) { pagesFailed++; continue; }
    for (const line of pageLines) lines.push({ page, text: line });
    pagesRecognised++;
  }

  const assessment = assessTextQuality(lines, { expectScript, pagesRead: limit });
  const usable = pagesRecognised > 0 && !requiresRecognizer(assessment.quality);
  return {
    lines,
    assessment,
    usable,
    pagesRecognised,
    pagesFailed,
    truncated: limit < total,
    reason: usable ? null
      : (pagesRecognised === 0 ? 'OCR 未返回任何文本' : `OCR 结果仍不可用：${assessment.reason}`),
  };
}

/**
 * Reads a handful of pages spread through the book, to judge the text layer.
 *
 * A 372-page book's corruption rate is not a different number when measured on
 * twelve pages spread through it, and measuring it on twelve avoids paying for
 * 372 before deciding they cannot be used.
 */
async function sampleText(doc, samplePages, from, to) {
  const first = from ?? 1;
  const last = to ?? doc.numPages ?? 0;
  if (!(last >= first)) return [];
  const span = last - first + 1;
  const stride = Math.max(1, Math.floor(span / Math.max(1, samplePages)));
  const out = [];
  for (let page = first; page <= last; page += stride) {
    const lines = await doc.extractText({ from: page, to: page });
    out.push(...(lines ?? []));
    if (out.length > 4000) break;
  }
  return out;
}

function flattenOutline(outline) {
  const out = [];
  const walk = (items, depth) => {
    for (const item of items || []) {
      if (item?.title) out.push({ ...item, depth: item.depth ?? depth });
      if (item?.children?.length) walk(item.children, depth + 1);
    }
  };
  walk(outline?.items, 0);
  return out;
}

function groupByPage(lines) {
  const map = new Map();
  for (const { page, text } of lines ?? []) {
    const bucket = map.get(page);
    if (bucket) bucket.push(text);
    else map.set(page, [text]);
  }
  return map;
}

function collectText(linesByPage, from, to) {
  const parts = [];
  for (let page = from; page <= to; page++) {
    const bucket = linesByPage.get(page);
    if (bucket) parts.push(bucket.join(' '));
  }
  return parts.join(' ').trim();
}

/**
 * Pulls the answer value out of an entry's prose.
 *
 * Handles both layouts seen in these books: a leading "答案：" opening the
 * entry, and the inline "题干，答案：结果" where the question is restated first.
 * Deliberately conservative beyond that — it does not attempt to parse the
 * mathematics, because guessing here would hide a parse failure behind a
 * plausible-looking string.
 */
export function extractAnswer(text) {
  const raw = String(text ?? '').trim();
  if (!raw) return '';

  let body;
  const leading = raw.match(ANSWER_PREFIXES);
  if (leading) {
    body = raw.slice(leading[0].length);
  } else {
    const inline = raw.match(ANSWER_INLINE);
    body = inline ? raw.slice(inline.index + inline[0].length) : raw;
  }

  body = body.trim();
  if (!body) return '';
  // Stop at a sentence break so an explanation following the answer is dropped.
  const stop = body.search(/[。；;]|\s{2,}/);
  return (stop > 0 ? body.slice(0, stop) : body).trim();
}

export const MATCH = Object.freeze({
  MATCHED: 'MATCHED',
  NOT_FOUND: 'NOT_FOUND',
  AMBIGUOUS: 'AMBIGUOUS',
  NO_INDEX: 'NO_INDEX',
  /** A text layer exists but cannot be trusted; nothing was indexed from it. */
  UNUSABLE_TEXT: 'UNUSABLE_TEXT',
});

/**
 * Finds the answer for a question id.
 *
 * O(1) against the label map built at index time. Returns AMBIGUOUS rather than
 * picking one when an id repeats, and carries the candidates' ids and pages so
 * a human can choose — an abstention that discards its own evidence just makes
 * the same question unanswerable twice.
 */
export function findAnswer(index, label) {
  if (!index || !Array.isArray(index.entries)) return { status: MATCH.NO_INDEX };
  if (index.entries.length === 0) {
    return index.quality && !textIsComparable(index.quality)
      ? { status: MATCH.UNUSABLE_TEXT, reason: index.reason ?? '文本层不可用' }
      : { status: MATCH.NO_INDEX };
  }

  const wanted = normalizeId(label);
  if (!wanted) return { status: MATCH.NOT_FOUND };

  const byLabel = index.byLabel instanceof Map
    ? index.byLabel
    : labelStatistics(index.entries).byLabel;

  const hits = byLabel.get(wanted) ?? [];
  if (hits.length === 0) return { status: MATCH.NOT_FOUND };
  if (hits.length > 1) {
    return {
      status: MATCH.AMBIGUOUS,
      candidates: hits,
      candidateIds: hits.map(e => e.id),
      candidatePages: hits.map(e => e.page),
      reason: `答案册中有 ${hits.length} 个第 ${wanted} 题，无法确定`,
    };
  }
  return { status: MATCH.MATCHED, entry: hits[0] };
}

/**
 * Indexes an answer document, outline first.
 *
 * The four ways this can come back with nothing are kept distinct, because they
 * need four different messages and three different remedies:
 *
 *   SCANNED  no text layer at all          -> OCR
 *   BLANK    text layer present but empty  -> nothing to say; the range is empty
 *   CORRUPT  text present but not the book's characters -> bookmarks, or OCR
 *   NONE     no outline and no usable text -> genuinely cannot proceed
 */
export async function indexAnswerDocument(doc, options = {}) {
  return indexDocument(doc, options);
}

/**
 * Indexes an EXERCISE book's numbered questions.
 *
 * Structurally the same problem as indexing an answer book — numbered entries
 * whose body continues until the next number — so it shares the implementation.
 * The difference is what the body is FOR: here it is question text used to
 * match against the key, so the answer-prefix stripping is simply unused.
 */
export async function indexQuestionDocument(doc, options = {}) {
  return indexDocument(doc, options);
}

async function indexDocument(doc, {
  from,
  to,
  expectScript = 'auto',
  preferOutline = true,
  // A recognizer is USED, not merely noted. Passing one used to clear
  // OCR_REQUIRED without a single page ever being recognised, so a host that
  // supplied a broken or empty recogniser silently lost the fail-closed
  // behaviour that OCR_REQUIRED exists to provide.
  recognizer = null,
  /** Pages to recognise before giving up. Full-book OCR is a prepared job. */
  ocrPageBudget = 400,
  // Index from the bookmark tree WITHOUT reading the book's text.
  //
  // Ids and page ranges come from the outline, which needs no text at all, so
  // when the text costs something — an OCR pass is 372 page renders where the
  // text layer was 9ms — nothing should be read until a decision depends on it.
  // Quality is judged from a sample instead, and entry text is filled in later
  // by a text source. See src/text-source.js.
  lazy = false,
  samplePages = 12,
} = {}) {
  let lines = lazy && doc.outline?.available && preferOutline
    ? await sampleText(doc, samplePages, from, to)
    : await doc.extractText({ from, to });
  // How many pages were actually read. The quality gate cannot judge coverage
  // without a denominator, and coverage is the signal that separates a scan with
  // a few stray text objects from a real text layer — the 2025 exercise book
  // reads as USABLE on its character ratios alone. See src/text-quality.js.
  const pagesRead = lazy && doc.outline?.available && preferOutline
    ? new Set(lines.map(l => l.page)).size
    : (doc.numPages ?? new Set(lines.map(l => l.page)).size);
  let assessment = assessTextQuality(lines, { expectScript, pagesRead });
  // Quality is measured on the text layer AS EXTRACTED — a cleaned copy would
  // hide the corruption the gate exists to find — so boilerplate is identified
  // only after the verdict, and it is applied to the text that gets COMPARED,
  // never to the line stream that decides where one entry ends and the next
  // begins.
  // Derived from the text actually being indexed. After a successful
  // recognition that is the OCR output, whose running heads and question
  // openers are its own, not the discarded layer's — so these are recomputed
  // below if recognition replaces the text.
  let isBoilerplate = boilerplateFilter(lines);
  let opensQuestion = bodyQuestionFilter(lines).opensQuestion;
  // Kept so two indexes can be checked for identical corruption later without
  // re-reading either book. Cheap: a few hundred characters.
  const alphabet = alphabetOfLines(lines);

  if (lazy && doc.outline?.available && preferOutline) {
    const built = buildOutlineIndex(doc.outline, [], {
      numPages: doc.numPages,
      quality: assessment.quality,
    });
    if (built.entries.length > 0) {
      return {
        quality: assessment.quality,
        reason: assessment.reason,
        metrics: assessment,
        scanned: assessment.quality === TEXT_QUALITY.SCANNED,
        alphabet,
        ...built,
        textAttached: false,
        lazy: true,
      };
    }
  }
  // A document whose text layer does not cover it cannot be matched by reading
  // text. Without a recognizer this is the end of the road, and it is reported
  // as such rather than by handing back whatever the few readable pages parsed
  // into — on the 2025 exercise book that was 18 contents rows, which then
  // matched real answers.
  // ── recognition, when the text layer cannot carry the document ──
  //
  // The gate is not "was a recognizer supplied" but "did recognition actually
  // produce text this engine can index". A recognizer that returns nothing,
  // throws, or yields a layer still too sparse to use leaves OCR_REQUIRED set.
  const needsRecognizer = requiresRecognizer(assessment.quality);
  let ocr = null;
  if (needsRecognizer && recognizer) {
    ocr = await recogniseDocument(doc, recognizer, {
      expectScript, budget: ocrPageBudget,
    });
  }

  // Recognition succeeded only if what came back is usable in its own right.
  const recognised = ocr && ocr.usable;
  const ocrRequired = needsRecognizer && !recognised;

  if (recognised) {
    // Everything downstream now works from recognised text, and says so. The
    // structure filters are rebuilt against it: OCR output has its own running
    // heads and its own question openers, and judging it by the layer it
    // replaced would apply a vocabulary drawn from 609 characters to a book.
    lines = ocr.lines;
    assessment = ocr.assessment;
    isBoilerplate = boilerplateFilter(lines);
    opensQuestion = bodyQuestionFilter(lines).opensQuestion;
  }

  const base = {
    ocrRequired,
    recognizerAvailable: !!recognizer,
    textOrigin: recognised ? 'OCR' : 'TEXT_LAYER',
    ocr: ocr ? {
      attempted: true,
      pagesRecognised: ocr.pagesRecognised,
      pagesFailed: ocr.pagesFailed,
      truncated: ocr.truncated,
      usable: ocr.usable,
      reason: ocr.reason,
    } : { attempted: false },
    alphabet,
    quality: assessment.quality,
    reason: assessment.reason,
    metrics: assessment,
    scanned: assessment.quality === TEXT_QUALITY.SCANNED,
  };

  const outlineUsable = preferOutline && doc.outline?.available;
  if (outlineUsable) {
    const built = buildOutlineIndex(doc.outline, lines, {
      isBoilerplate,
      numPages: doc.numPages,
      quality: assessment.quality,
    });
    if (built.entries.length > 0) {
      return { ...base, ...built, textAttached: textMayBeComparable(assessment.quality) };
    }
  }

  // No outline, or an outline with no question ids in it. Body text is the only
  // remaining route, and it is only worth walking when the text can be trusted.
  //
  // A sparse layer fails this test by construction: it is not that the text is
  // wrong, it is that there is almost none of it, and parsing the little there
  // is produces entries that look ordinary and match confidently.
  if (ocrRequired || !textMayBeComparable(assessment.quality)) {
    return {
      ...base,
      entries: [],
      duplicates: [],
      byLabel: new Map(),
      source: INDEX_SOURCE.NONE,
      textAttached: false,
    };
  }

  const built = buildAnswerIndex(lines, { isBoilerplate, opensQuestion });

  // A book with no bookmark tree still prints its own index. Where the printed
  // contents and the body parse independently agree on a label's page, that
  // location is as well established as a bookmark's — measured on the 2023 key,
  // 492 of 508 labels corroborate and every one of them is correct.
  const contents = buildContentsLocations(lines, built.entries, {
    numPages: doc.numPages,
  });
  const corroborated = applyContentsLocations(built.entries, contents.locations);

  return {
    ...base,
    ...built,
    entries: corroborated.entries,
    ...labelStatistics(corroborated.entries),
    source: contents.corroborated > 0 ? INDEX_SOURCE.CONTENTS : built.source,
    contents: {
      offset: contents.offset,
      agreement: contents.agreement,
      listed: contents.listed,
      corroborated: contents.corroborated,
      conflicted: contents.conflicted,
      unseen: contents.unseen,
    },
    textAttached: true,
  };
}

/**
 * The questions appearing on one page of an exercise book.
 *
 * An entry spans a page RANGE — a question can run over a page break, and
 * several questions can share one page — so containment is the test, not
 * equality. Testing equality dropped every question whose bookmark page
 * differed from the page being viewed.
 */
export function questionsOnPage(index, pageNumber) {
  if (!index?.entries) return [];
  return index.entries.filter(e =>
    pageNumber >= e.page && pageNumber <= (e.endPage ?? e.page));
}

/**
 * Do two indexed books garble their text the same way?
 *
 * OPAQUE text is only evidence when both books share a font subset, and this is
 * how a caller establishes that before passing `crossBookComparable` to
 * matchPage. Uses the alphabets captured at index time, so it costs nothing and
 * works even when the books were only sampled.
 */
export function indexesComparable(indexA, indexB, options) {
  return compareAlphabets(indexA?.alphabet, indexB?.alphabet, options);
}
