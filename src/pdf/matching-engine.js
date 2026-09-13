// The only entry point a product is allowed to use.
//
// The engine's defect was never its scoring. It was that the gate order lived in
// the caller: `matchQuestion` accepted `exactId`, `sectionAligned` and
// `crossBookComparable` as arguments, and `matchPage` defaulted `pairStatus` to
// VERIFIED_PAIR. Any host that forgot a check, or supplied a flag optimistically,
// got a confident answer out of an unverified pair — measured, 52 of 60
// wrong-book combinations produced accepted results at HIGH confidence.
//
// So the facts that decide safety are no longer parameters. They are derived
// here, in one place, in one order:
//
//   roles  ->  pair identity  ->  text quality / OCR  ->  indexes  ->  matching
//
// The deletion test this module has to pass: removing it should force its gate
// ordering to reappear in every caller. Nothing here is a pass-through.
//
// What may cross the interface:
//   document adapters, an optional recognizer, an optional manual binding,
//   a target page or question id, and cancellation/limits.
//
// What may not:
//   exactId, sectionAligned, crossBookComparable, pairStatus, confidence, or any
//   boolean asserting that something was verified. Those are conclusions, and
//   conclusions are the module's job.

import { indexAnswerDocument, indexQuestionDocument, questionsOnPage } from './answer-index.js';
import { PAIR_STATUS, RUNG, applyPairPermissions } from './decision.js';
import { alignOutlines, matchPage } from './question-matcher.js';
import { locateAnswerRegion } from './region-locator.js';
import { verifyPair } from './pair-verifier.js';
import { requiresRecognizer } from './text-quality.js';

/**
 * Per-document work, memoised on the adapter itself.
 *
 * Indexing a document is the expensive half of preparing a pair, and it does not
 * depend on the other document at all — so pairing one exercise book against
 * eight answer books should index it once, not eight times. Measured on the
 * 8-document corpus, the 64-combination matrix rebuilt 128 indexes to inspect 64
 * pairs.
 *
 * Keyed on the adapter object in a WeakMap rather than on a content fingerprint.
 * That is the conservative choice: it cannot go stale, because a reopened or
 * edited document is a different object, and it never has to decide whether two
 * documents that hash alike really are the same file. A fingerprint-keyed cache
 * that survives process restarts is the larger feature this stands in for.
 */
const documentCache = new WeakMap();

function cached(doc, key, build) {
  let slot = documentCache.get(doc);
  if (!slot) { slot = new Map(); documentCache.set(doc, slot); }
  if (!slot.has(key)) slot.set(key, build());
  return slot.get(key);
}

/**
 * Narrows a page's questions to the tapped area.
 *
 * An entry carries geometry only if the adapter gave its lines geometry. Where
 * it did not, this returns every question on the page AND says the region was
 * not applied — a caller that taps one of two questions and silently receives
 * both has been told something false about what it asked.
 *
 * @returns {{questions: Array, applied: boolean, reason: string|null}}
 */
function selectByRegion(questions, region, page) {
  if (!region) return { questions, applied: false, reason: null };

  const top = region.top ?? region.y;
  const bottom = region.bottom ?? (region.y != null && region.height != null
    ? region.y + region.height : undefined);
  if (!Number.isFinite(top) || !Number.isFinite(bottom)) {
    return { questions, applied: false, reason: 'REGION_MALFORMED' };
  }

  // The band each question occupies ON THIS PAGE.
  const spanOn = (q) => (q.spans ?? []).find(s => s.page === page);
  const withGeometry = questions.filter(q => spanOn(q));
  if (withGeometry.length === 0) {
    return { questions, applied: false, reason: 'REGION_UNSUPPORTED_BY_ADAPTER' };
  }

  const hit = withGeometry.filter((q) => {
    const s = spanOn(q);
    return s.bottom >= top && s.top <= bottom;
  });
  if (hit.length === 0) {
    return { questions: [], applied: true, reason: 'REGION_EMPTY' };
  }
  return { questions: hit, applied: true, reason: null };
}

/** Reads a document once, so identity checks and indexing share the same text. */
async function readDocument(doc) {
  return cached(doc, 'read', async () => {
    const lines = (await doc.extractText({})) ?? [];
    return { numPages: doc.numPages, outline: doc.outline, lines, adapter: doc };
  });
}

/**
 * A prepared pair. Owns the indexes, the alignment and the pair verdict, and is
 * the only thing that can produce a match.
 */
class PairSession {
  constructor({
    exercise, answer, exerciseIndex, answerIndex, alignment, pair, ocrRequired,
    formulaPolicy, matcher = null,
  }) {
    this.formulaPolicy = formulaPolicy;
    /** 可选的外部打分实现，见 score()。为空就用 JS 那份。 */
    this.matcher = matcher;
    this.exercise = exercise;
    this.answer = answer;
    this.exerciseIndex = exerciseIndex;
    this.answerIndex = answerIndex;
    this.alignment = alignment;
    this.pair = pair;
    this.ocrRequired = ocrRequired;
  }

  /** The pair status the engine derived. Never supplied by a caller. */
  get pairStatus() { return this.pair.status; }

  /**
   * Matches the questions on one exercise page.
   *
   * The pair status passed down is this session's own, so a caller cannot raise
   * it. Where OCR is required the ceiling drops to LOCATED: the engine may still
   * say which pages to turn to, because that comes from bookmark structure and
   * needs no text, but it may not claim to have read a question it could not.
   */
  /**
   * @param {object} target
   * @param {number} target.page
   * @param {string} [target.label]  an explicit question identifier
   * @param {object} [target.region] the tapped area: {top, bottom} or
   *   {y, height}, in the same coordinate space the DocumentAdapter reports for
   *   its lines. Applied only when the adapter supplies line geometry; when it
   *   does not, the result says so rather than silently returning the whole page.
   */
  async matchQuestion({
    page, label = null, region = null, limits = {}, signal = null,
  } = {}) {
    if (this.pair.status === PAIR_STATUS.REJECTED_PAIR) {
      return [{
        rung: RUNG.BLOCKED,
        matched: false,
        cappedBy: this.pair.reasonCodes[0] ?? 'PAIR_IDENTITY_MISMATCH',
        reasonCodes: this.pair.reasonCodes,
        question: null,
      }];
    }

    const onPage = questionsOnPage(this.exerciseIndex, page)
      .filter(q => (label ? q.label === label : true));

    // A tap selects one question, not the page. Selection needs geometry, and
    // geometry is the adapter's to provide: an adapter that reports only text
    // cannot support it, and the honest response is to say the region was not
    // applied rather than to return every question on the page as though it had
    // been.
    const selection = selectByRegion(onPage, region, page);
    const questions = selection.questions;

    if (questions.length === 0) {
      const located = locateAnswerRegion(this.alignment, {
        exercisePage: page, answerPageCount: this.answer.numPages,
      });

      // "This page has no questions" and "your tap selected none of the
      // questions that are here" are different answers, and the caller needs to
      // tell them apart: the first means look elsewhere, the second means tap
      // again. An earlier version returned NO_QUESTION_LEVEL_INDEX for both,
      // discarding the region outcome entirely — and did it via an inner
      // const region declaration that shadowed the parameter, which is how the evidence
      // went missing without anyone noticing.
      const emptyTap = onPage.length > 0 && selection.applied;
      const reason = emptyTap
        ? (selection.reason ?? 'REGION_EMPTY')
        : (this.ocrRequired ? 'OCR_REQUIRED' : 'NO_QUESTION_LEVEL_INDEX');

      return [{
        rung: located ? RUNG.LOCATED : RUNG.REFUSED,
        matched: false,
        asserted: false,
        region: located ?? null,
        cappedBy: reason,
        reasonCodes: [reason],
        question: null,
        ...(region ? { regionApplied: selection.applied, regionReason: selection.reason } : {}),
      }];
    }

    // A region that was asked for and could not be honoured caps the result.
    //
    // Reporting regionApplied: false was not enough. The caller pointed at ONE
    // question; without geometry the engine hands back every question on the
    // page, and any of them arriving as AUTO_MATCH is a confident answer to a
    // question nobody asked about. Withholding the automatic answer — while
    // still returning the candidates — is the difference between "here is your
    // answer" and "here is what is on this page, you pick".
    //
    // Only when a region was actually requested. Batch and whole-book flows pass
    // none and are unaffected.
    const regionUnhonoured = !!region && !selection.applied;

    const annotate = (m) => {
      if (!region) return m;
      const tagged = { ...m, regionApplied: selection.applied, regionReason: selection.reason };
      if (!regionUnhonoured || tagged.rung !== RUNG.AUTO_MATCH) return tagged;
      return {
        ...tagged,
        rung: RUNG.REVIEW,
        matched: false,
        asserted: false,
        cappedBy: selection.reason ?? 'REGION_NOT_APPLIED',
      };
    };

    const matches = await this.score(questions, {
      alignment: this.alignment,
      exercisePage: page,
      answerPageCount: this.answer.numPages,
      questionCount: this.exerciseIndex.entries.length,
      pairStatus: this.pair.status,
      ...(this.formulaPolicy ? { formulaPolicy: this.formulaPolicy } : {}),
      limits,
      signal,
    });

    if (!this.ocrRequired) return matches.map(annotate);
    return matches.map(m => annotate(m.rung === RUNG.AUTO_MATCH || m.rung === RUNG.REVIEW
      ? { ...m, rung: m.region ? RUNG.LOCATED : RUNG.REFUSED, matched: false, cappedBy: 'OCR_REQUIRED' }
      : m));
  }

  /**
   * 打分这一步。默认走 JS 那份实现；给了 matcher 就把计算交出去。
   *
   * 留这个口是为了以后把匹配搬到 C++（见 native-matcher.js）。分出来单独一步，
   * 是因为那天要动的不止「换个函数」：matchPage 是同步的，跨 JNI 之后是异步的，
   * 而它上下全是闸门逻辑。现在先把异步和钳制做好，那天就只剩写 C++。
   *
   * 两条不变量，由这里保证，不指望实现方自觉：
   *
   * 一、**交出去的活可以失败，功能不能失败。** 原生那一位没接上会以
   *     UNIMPLEMENTED 拒绝；答得不成形状也会抛。两种都退回 JS 那份——JS 那份不是
   *     降级方案，它就是现在的正式实现。
   *
   * 二、**结论要再钳一次。** 不管谁算的，每一条都过 applyPairPermissions。
   *     matching-engine 存在的理由就是把闸门收在一处（散出去之后实测 52/60 的
   *     错书组合拿到了 HIGH 置信度的答案）；把计算交出去不等于把判断交出去。
   *     一个写错的原生实现最多让答案变差，不能让未确认的配对给出 AUTO_MATCH。
   */
  async score(questions, options) {
    if (this.matcher) {
      try {
        const out = await this.matcher(questions, this.answerIndex, options);
        return out.map(m => clampToPair(m, this.pair.status));
      } catch (_) {
        // 故意不往上抛。调用方问的是「这道题的答案是什么」，不是「用哪个实现算的」。
      }
    }
    return matchPage(questions, this.answerIndex, options);
  }

  /** Every question in the exercise book, page by page. */
  async matchAll({ limits = {}, signal = null } = {}) {
    const out = [];
    for (let page = 1; page <= this.exercise.numPages; page++) {
      if (signal?.aborted) break;
      if (questionsOnPage(this.exerciseIndex, page).length === 0) continue;
      out.push(...await this.matchQuestion({ page, limits, signal }));
    }
    return { matches: out, pairStatus: this.pair.status, ocrRequired: this.ocrRequired };
  }
}

/**
 * Verifies a pair of documents and, if it is usable at all, opens a session.
 *
 * Returns a rejection rather than throwing, because an invalid pair is an
 * ordinary product outcome — the user opened the wrong book — and the reason
 * codes are what the host needs to say so.
 *
 * @param {object} input
 * @param {object} input.exerciseDocument DocumentAdapter
 * @param {object} input.answerDocument   DocumentAdapter
 * @param {object} [input.recognizer]     RecognizerAdapter, for scanned input
 * @param {object} [input.binding]        a manual binding the user already confirmed
 * @returns {{status, decision, session}|{status, decision, session: null}}
 */
/**
 * 把一条结论压回配对状态允许的高度。永远只降不升。
 *
 * 这是外部实现和 JS 之间那道闸。applyPairPermissions 自己就是「只降不升」的，
 * 所以一个返回 AUTO_MATCH 的实现在未确认配对上只会得到 REVIEW；返回一个不认得
 * 的 rung 会落到 REFUSED，而不是被当成最强的那一档。
 */
function clampToPair(match, pairStatus) {
  const { rung, cappedBy } = applyPairPermissions(match?.rung, pairStatus, {
    hasRegion: !!match?.region,
  });
  if (rung === match?.rung) return match;
  return {
    ...match,
    rung,
    matched: rung === RUNG.AUTO_MATCH,
    asserted: rung === RUNG.AUTO_MATCH,
    cappedBy: cappedBy ?? match?.cappedBy ?? null,
  };
}

export async function preparePair({
  exerciseDocument,
  answerDocument,
  recognizer = null,
  /**
   * 可选：把打分这一步交给别的实现。
   *
   * 签名和 question-matcher.js 的 matchPage 一样，但返回 Promise：
   *   matcher(questions, answerIndex, options) -> Promise<match[]>
   *
   * 现在唯一的用处是把计算交给原生层，见 native-matcher.js 的
   * createNativeMatcher()。和 recognizer 一样是「有就用，没有照常跑」。
   */
  matcher = null,
  binding = null,
  expectScript = 'auto',
  /** See FORMULA_POLICY. STRICT is the agreed product rule. */
  formulaPolicy = undefined,
  /** Pages a recognizer may be asked for before the attempt is truncated. */
  ocrPageBudget = undefined,
} = {}) {
  const exercise = await readDocument(exerciseDocument);
  const answer = await readDocument(answerDocument);

  // Indexing comes first only because role and identity are judged on indexed
  // entries; nothing here can match until the verdict below is in.
  const indexOptions = { expectScript, recognizer };
  if (ocrPageBudget !== undefined) indexOptions.ocrPageBudget = ocrPageBudget;

  const exerciseIndex = await cached(exerciseDocument, `q:${expectScript}:${ocrPageBudget ?? ''}`,
    () => indexQuestionDocument(exerciseDocument, indexOptions));
  const answerIndex = await cached(answerDocument, `a:${expectScript}:${ocrPageBudget ?? ''}`,
    () => indexAnswerDocument(answerDocument, indexOptions));

  const ocrRequired = !!(exerciseIndex.ocrRequired || answerIndex.ocrRequired);

  const pair = verifyPair({
    exerciseDoc: exercise,
    answerDoc: answer,
    exerciseIndex,
    answerIndex,
    manualBinding: binding,
  });

  if (pair.status === PAIR_STATUS.REJECTED_PAIR) {
    return {
      status: pair.status,
      decision: {
        status: RUNG.BLOCKED,
        reasonCodes: pair.reasonCodes,
        exerciseRole: pair.exerciseRole,
        answerRole: pair.answerRole,
        evidence: pair.evidence,
      },
      session: null,
    };
  }

  const alignment = alignOutlines(exercise.outline, answer.outline, {
    exercisePageCount: exercise.numPages,
    answerPageCount: answer.numPages,
  });

  return {
    status: pair.status,
    decision: {
      status: ocrRequired ? 'OCR_REQUIRED' : pair.status,
      reasonCodes: ocrRequired ? [...pair.reasonCodes, 'OCR_REQUIRED'] : pair.reasonCodes,
      exerciseRole: pair.exerciseRole,
      answerRole: pair.answerRole,
      evidence: pair.evidence,
    },
    session: new PairSession({
      exercise, answer, exerciseIndex, answerIndex, alignment, pair, ocrRequired,
      formulaPolicy, matcher,
    }),
  };
}

export const matchingEngine = { preparePair };
export { PAIR_STATUS, RUNG };
