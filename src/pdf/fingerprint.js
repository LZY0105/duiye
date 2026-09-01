// What makes this document THIS document.
//
// A manual binding is a user saying "these two books go together" when the
// engine could not establish it. That is a legitimate and necessary escape
// hatch — but it was accepting any truthy object, so a binding carrying
// deliberately wrong fingerprints promoted an unverified pair to VERIFIED, and
// a binding made against one file stayed valid after the file was replaced.
//
// A binding therefore has to name what it was made against, and the engine has
// to check that the documents in front of it are still those documents.
//
// ── what goes into the fingerprint ──
//
// Structure the extractor cannot silently change, plus a content sample:
//
//   pages          a different edition is a different length
//   outlineShape   node count per depth — the bookmark tree's silhouette
//   labelRange     first and last question identifier, and how many there are
//   contentDigest  a hash over sampled lines, so a re-typeset edition with the
//                  same shape still fails
//
// No cryptographic claim is made. This detects a document being swapped or
// re-issued, which is what invalidation is for; it is not a defence against
// someone deliberately forging a collision.

import { classifyOutline } from './outline-classify.js';

/** FNV-1a, 32-bit. Small, dependency-free, and adequate for change detection. */
function hash32(text) {
  let h = 0x811c9dc5;
  const s = String(text ?? '');
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

/**
 * A stable identity for one document.
 *
 * @param {{numPages:number, outline:object, lines:Array}} doc as read once
 * @returns {{pages, outlineShape, labels, labelRange, contentDigest, id}}
 */
export function fingerprintDocument(doc, { sampleLines = 400 } = {}) {
  const pages = doc?.numPages ?? 0;

  const classified = classifyOutline(doc?.outline, { numPages: pages });
  const byDepth = new Map();
  for (const node of classified.nodes ?? []) {
    byDepth.set(node.depth, (byDepth.get(node.depth) ?? 0) + 1);
  }
  const outlineShape = [...byDepth.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([depth, n]) => `${depth}:${n}`)
    .join(',');

  const labels = classified.questions.map(q => q.questionId).filter(Boolean);
  const labelRange = labels.length ? `${labels[0]}..${labels[labels.length - 1]}` : '';

  // A spread sample rather than the first N lines: front matter is the part most
  // likely to be identical between two different volumes of one series.
  const lines = doc?.lines ?? [];
  const stride = Math.max(1, Math.floor(lines.length / sampleLines));
  const sampled = [];
  for (let i = 0; i < lines.length && sampled.length < sampleLines; i += stride) {
    sampled.push(String(lines[i]?.text ?? '').replace(/\s+/g, ''));
  }
  const contentDigest = hash32(sampled.join(''));

  const parts = {
    pages,
    outlineShape,
    labels: labels.length,
    labelRange,
    contentDigest,
  };
  return { ...parts, id: hash32(JSON.stringify(parts)) };
}

/**
 * Whether a stored binding still describes the documents in hand.
 *
 * Returns the reason on failure rather than a bare false: "the answer book
 * changed" and "this binding was made for a different exercise book" need
 * different messages, and a binding that silently stops applying is worse than
 * one that says why.
 *
 * @param {{exercise:object, answer:object}} binding as stored
 * @returns {{valid: boolean, reason: string|null, changed: string[]}}
 */
export function bindingMatches(binding, exerciseFingerprint, answerFingerprint) {
  if (!binding || typeof binding !== 'object') {
    return { valid: false, reason: 'BINDING_ABSENT', changed: [] };
  }
  if (!binding.exercise || !binding.answer) {
    // The defect this exists to close: any truthy object used to be accepted.
    return { valid: false, reason: 'BINDING_MALFORMED', changed: [] };
  }

  const changed = [];
  const compare = (side, stored, current) => {
    for (const key of ['pages', 'outlineShape', 'labels', 'labelRange', 'contentDigest']) {
      if (stored?.[key] !== undefined && stored[key] !== current[key]) {
        changed.push(`${side}.${key}`);
      }
    }
  };
  compare('exercise', binding.exercise, exerciseFingerprint);
  compare('answer', binding.answer, answerFingerprint);

  if (changed.length > 0) {
    return { valid: false, reason: 'BINDING_STALE', changed };
  }
  return { valid: true, reason: null, changed: [] };
}

/** A binding a host can store after the user confirms a pair. */
export function createBinding(exerciseFingerprint, answerFingerprint) {
  return {
    exercise: { ...exerciseFingerprint },
    answer: { ...answerFingerprint },
    createdAt: new Date().toISOString(),
  };
}
