// Scratch Module — paper style (F11).
//
// A style is four independent choices: a guide pattern, a paper tone, how far
// apart the guides sit, and how strongly they are drawn. They combine freely,
// and two patterns are never overlaid.
//
// Pure and DOM-free. The style is data owned by a scratchpad RESOURCE, so it
// travels with the pad through every deck change, move, focus and restart —
// it is not a property of a pane, an entry or the app theme.
//
// Nothing here touches ink. Guides are drawn under the strokes from the same
// camera and are not part of the layer: erasing, lasso selection and clear all
// ignore them, and changing a style never scales, reflows or rewrites a stroke.

/** The eight patterns of the first release. */
export const PATTERNS = Object.freeze({
  PLAIN: 'P01',
  DOTS: 'P02',
  SQUARE: 'P03',
  RULED: 'P04',
  CARTESIAN: 'P05',
  ISOMETRIC: 'P06',
  TIANZI: 'P07',
  MIZI: 'P08',
});

const PATTERN_IDS = Object.freeze(Object.values(PATTERNS));

/**
 * Which patterns are drawn from repeating cells rather than plain lines.
 *
 * They are the two handwriting grids, and they differ from the rest in more
 * than looks: their spacing control is labelled Cell size and it steps through
 * much larger world units, because a 24-unit 田字格 is not a writing cell, it
 * is graph paper with a cross in it.
 */
export const CELL_PATTERNS = Object.freeze([PATTERNS.TIANZI, PATTERNS.MIZI]);

/** Patterns with nothing to space or contrast; the two controls are hidden. */
export const UNGUIDED_PATTERNS = Object.freeze([PATTERNS.PLAIN]);

/**
 * Paper tones.
 *
 * Visual preference, not an eye-health claim. There is deliberately no dark
 * chalkboard: this app's ink defaults to near-black and a dark paper would
 * swallow every stroke already written on it. For the same reason a system
 * dark mode must not invert these — see the note on `paperColor`.
 */
export const TONES = Object.freeze({
  WHITE: 'white',
  IVORY: 'ivory',
  GREY: 'grey',
  SAGE: 'sage',
});

const TONE_COLORS = Object.freeze({
  [TONES.WHITE]: '#ffffff',
  [TONES.IVORY]: '#fbf6e9',
  [TONES.GREY]: '#f1f2f4',
  [TONES.SAGE]: '#eef2ec',
});

export const SPACINGS = Object.freeze({
  COMPACT: 'compact',
  STANDARD: 'standard',
  SPACIOUS: 'spacious',
});

export const CONTRASTS = Object.freeze({
  LIGHT: 'light',
  STANDARD: 'standard',
  CLEAR: 'clear',
});

/**
 * Guide spacing in WORLD units — the same units strokes are stored in.
 *
 * Nominally the same logical pixel as a dp at 100% zoom, and deliberately not
 * millimetres: this paper has no physical size, so a guide cannot have one
 * either. Because the numbers are in world space, zooming changes how big the
 * squares LOOK and never how big they ARE, which is what keeps guides from
 * sliding underneath the ink drawn on them.
 */
const LINE_SPACING = Object.freeze({
  [SPACINGS.COMPACT]: 16,
  [SPACINGS.STANDARD]: 24,
  [SPACINGS.SPACIOUS]: 32,
});

/** Handwriting cells are outer-box sized, and much larger. */
const CELL_SPACING = Object.freeze({
  [SPACINGS.COMPACT]: 48,
  [SPACINGS.STANDARD]: 64,
  [SPACINGS.SPACIOUS]: 80,
});

/** Guide alpha at each contrast step, against the paper behind it. */
const CONTRAST_ALPHA = Object.freeze({
  [CONTRASTS.LIGHT]: 0.14,
  [CONTRASTS.STANDARD]: 0.24,
  [CONTRASTS.CLEAR]: 0.38,
});

/** The ink guides are drawn in, before contrast is applied. */
const GUIDE_INK = '15, 23, 42';

/** Bumped only when a stored style needs converting, never for a new pattern. */
export const STYLE_SCHEMA_VERSION = 1;

const freeze = (o) => Object.freeze(o);
const oneOf = (value, allowed, fallback) => (allowed.includes(value) ? value : fallback);

/**
 * Builds a style, filling in what is missing and keeping what it does not know.
 *
 * An unrecognised `patternId` is PRESERVED rather than replaced. A pad styled
 * by a later version of the app and opened here must come back unharmed when
 * it is opened there again, so the unknown id is carried through every read and
 * write; only the renderer substitutes plain paper, and the UI says why. The
 * alternative — clamping to a default on load — destroys the user's choice on
 * a device that merely could not draw it.
 *
 * A pad with no style at all is plain white, and stays plain white: a new-pad
 * default set later applies to pads created after it, never retroactively.
 */
export function createScratchStyle(initial = {}) {
  const source = initial || {};
  const patternId = typeof source.patternId === 'string' && source.patternId
    ? source.patternId
    : PATTERNS.PLAIN;
  return freeze({
    schemaVersion: Number(source.schemaVersion) || STYLE_SCHEMA_VERSION,
    patternId,
    paperTone: oneOf(source.paperTone, Object.values(TONES), TONES.WHITE),
    spacingPreset: oneOf(source.spacingPreset, Object.values(SPACINGS), SPACINGS.STANDARD),
    guideContrast: oneOf(source.guideContrast, Object.values(CONTRASTS), CONTRASTS.LIGHT),
  });
}

/** Plain on white — the first-use default, and what a style-less pad shows. */
export const DEFAULT_STYLE = createScratchStyle();

export function serializeStyle(style) {
  const s = createScratchStyle(style);
  return {
    schemaVersion: s.schemaVersion,
    patternId: s.patternId,
    paperTone: s.paperTone,
    spacingPreset: s.spacingPreset,
    guideContrast: s.guideContrast,
  };
}

/** Two styles are the same when every field is; used to skip idle writes. */
export function sameStyle(a, b) {
  const x = createScratchStyle(a);
  const y = createScratchStyle(b);
  return x.patternId === y.patternId
    && x.paperTone === y.paperTone
    && x.spacingPreset === y.spacingPreset
    && x.guideContrast === y.guideContrast;
}

export function isKnownPattern(patternId) {
  return PATTERN_IDS.includes(patternId);
}

export function isCellPattern(patternId) {
  return CELL_PATTERNS.includes(patternId);
}

/** Plain has nothing to space or contrast, so both controls are hidden for it. */
export function hasGuides(patternId) {
  return isKnownPattern(patternId) && !UNGUIDED_PATTERNS.includes(patternId);
}

/**
 * The pattern actually drawn.
 *
 * An unknown id renders as plain paper. The stored id is untouched — see
 * createScratchStyle — so this is a display substitution and not a migration.
 */
export function effectivePattern(style) {
  const id = createScratchStyle(style).patternId;
  return isKnownPattern(id) ? id : PATTERNS.PLAIN;
}

export function paperColor(style) {
  return TONE_COLORS[createScratchStyle(style).paperTone] || TONE_COLORS[TONES.WHITE];
}

/** Guide spacing in world units, by pattern family. */
export function guideSpacing(style) {
  const s = createScratchStyle(style);
  const table = isCellPattern(effectivePattern(s)) ? CELL_SPACING : LINE_SPACING;
  return table[s.spacingPreset] ?? table[SPACINGS.STANDARD];
}

/**
 * The firmest a guide may ever be drawn.
 *
 * Guides are not ink and must never read as ink. The ceiling is what keeps the
 * axis emphasis below from turning into a line someone could mistake for a
 * stroke they drew — at Clear contrast, an unbounded 2.1x would land at 0.8.
 */
const GUIDE_ALPHA_MAX = 0.55;

function guideAlpha(style, strength) {
  const base = CONTRAST_ALPHA[createScratchStyle(style).guideContrast]
    ?? CONTRAST_ALPHA[CONTRASTS.LIGHT];
  return Math.min(GUIDE_ALPHA_MAX, Math.max(0, base * Math.max(0, strength)));
}

/**
 * Guide colour at a given level of detail, 0..1.
 *
 * `strength` is the density fade: at low zoom the finest family of lines is
 * thinned out rather than dropped abruptly, which is what stops a grid
 * flickering as it crosses a density threshold. Clamped to 1, because this is
 * the fade — emphasis is `axisColor`'s job, and a caller reaching for a
 * stronger line through here would be quietly redefining what Light means.
 */
export function guideColor(style, strength = 1) {
  return `rgba(${GUIDE_INK}, ${guideAlpha(style, Math.min(1, strength)).toFixed(3)})`;
}

/**
 * The x and y axes of the Cartesian grid, drawn firmer than the squares.
 *
 * They occur once, at the world origin, and they are what makes that pattern a
 * pair of axes rather than more graph paper — so they have to be legible at
 * Light contrast, where the grid itself is nearly not there. Still bounded by
 * GUIDE_ALPHA_MAX: firmer than the grid, never as dark as ink.
 */
export function axisColor(style) {
  return `rgba(${GUIDE_INK}, ${guideAlpha(style, 2.1).toFixed(3)})`;
}
