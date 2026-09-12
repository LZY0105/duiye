// Scratch Module — the style chooser (F11).
//
// One panel, one pad. It is bound to the RESOURCE it was opened for, not to the
// pane it was opened from: the pane can change what it is showing while the
// panel is up, and a write that followed the pane would land on the wrong pad.
//
// Selecting a sample changes a preview and nothing else. Nothing is stored, no
// ink is touched, and the panel says so in words — "Preview – not applied" —
// because a chooser whose selections take effect silently is a chooser you
// cannot explore.
//
// The tiles are drawn by the SAME renderer that draws the paper, at a fixed
// camera. A preview painted by a second implementation is a preview that can
// disagree with the thing it is previewing.

import { t } from '../core/i18n.js';
import {
  CONTRASTS,
  PATTERNS,
  SPACINGS,
  TONES,
  createScratchStyle,
  guideSpacing,
  isCellPattern,
  isKnownPattern,
  hasGuides,
  paperColor,
  sameStyle,
} from './scratch-style.js';
import { drawScratchBackground } from './scratch-background.js';
import { createCamera } from './scratch-camera.js';
import { setScratchpadStyle, writeNewPadStyle } from './scratch-store.js';

/**
 * How much paper one sample shows, counted in rows of its own ruling.
 *
 * A fixed zoom of 1 was the bug in the picture. Spacings differ per pattern —
 * 24 world units between squares, 64 between ruled lines — so at zoom 1 a 96px
 * tile showed four squares, and the ruled tile showed a single line with
 * nothing to compare it to. Neither looked like the paper it stands for.
 *
 * Sizing the camera to the pattern's OWN spacing instead makes every sample
 * show the same amount of paper, whatever it is ruled with and whatever size
 * the tile happens to be — which is the only way eight of them side by side
 * can be compared at all.
 */
const TILE_ROWS = 3.5;

/** Kept clear of zooms where the renderer starts thinning the grid on us. */
const tileCamera = (style, height) => createCamera({
  x: 0, y: 0,
  zoom: Math.min(2, Math.max(0.2, height / (TILE_ROWS * guideSpacing(style)))),
});
const TILE_W = 150;
const TILE_H = 74;

/** Shared with the create dialog, so both choosers offer the same eight. */
export const PATTERN_ORDER = [
  PATTERNS.PLAIN, PATTERNS.DOTS, PATTERNS.SQUARE, PATTERNS.RULED,
  PATTERNS.CARTESIAN, PATTERNS.ISOMETRIC, PATTERNS.TIANZI, PATTERNS.MIZI,
];

export const TONE_ORDER = [TONES.WHITE, TONES.IVORY, TONES.GREY, TONES.SAGE];
const SPACING_ORDER = [SPACINGS.COMPACT, SPACINGS.STANDARD, SPACINGS.SPACIOUS];
const CONTRAST_ORDER = [CONTRASTS.LIGHT, CONTRASTS.STANDARD, CONTRASTS.CLEAR];

const escapeHtml = (s) => String(s ?? '').replace(/[&<>"']/g, c => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
));

/**
 * Paints one pattern sample.
 *
 * Marks in three ink colours are laid over it so the reader can judge whether
 * their own writing will still read against the guides. It cannot promise that
 * for every colour ever used — an old highlighter on Clear guides is the
 * reader's call — but it shows the common ones honestly.
 */
export function paintTile(canvas, style, { width = TILE_W, height = TILE_H } = {}) {
  const dpr = Math.min(2, Math.max(1, (typeof window !== 'undefined' && window.devicePixelRatio) || 1));
  canvas.width = Math.round(width * dpr);
  canvas.height = Math.round(height * dpr);
  // The asked-for size, but never wider than whatever is holding it.
  //
  // A fixed inline width beats the stylesheet's `width: 100%`, so in a grid
  // column narrower than the sample the canvas simply overhung the tile and
  // the ink marks crossed its rounded border. Capping the width and taking the
  // height from the canvas's own aspect keeps the drawing square-on while it
  // shrinks, instead of squashing it.
  canvas.style.width = `${width}px`;
  canvas.style.maxWidth = '100%';
  canvas.style.height = 'auto';
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  drawScratchBackground(ctx, {
    style,
    camera: tileCamera(style, height),
    viewport: { width, height },
    dpr,
  });
  ctx.save();
  ctx.lineCap = 'round';
  ctx.lineWidth = 2;
  // Spread across whatever width the sample has, so a small tile shows the same
  // three marks rather than one and a half.
  const marks = [['#111827', 0.12], ['#2563eb', 0.4], ['#dc2626', 0.68]];
  for (const [colour, at] of marks) {
    const x = width * at;
    ctx.strokeStyle = colour;
    ctx.beginPath();
    ctx.moveTo(x, height * 0.62);
    ctx.quadraticCurveTo(x + width * 0.09, height * 0.34, x + width * 0.2, height * 0.58);
    ctx.stroke();
  }
  ctx.restore();
}

/**
 * Opens the chooser for one pad.
 *
 * @param {{pad: Object, onPreview: function, onApplied: function,
 *          onNotice: function, compact: boolean}} options
 *   `onPreview` paints a candidate on the real pad without storing it;
 *   `onApplied` receives the committed record.
 * @returns {Promise<{applied: boolean, pad?: Object}>}
 */
export function openScratchStylePanel({ pad, onPreview, onApplied, onNotice, compact = false }) {
  return new Promise((resolve) => {
    // Bound to the resource and the revision the panel opened on. If the pad
    // changed by another route in the meantime, the write is refused rather
    // than allowed to overwrite the newer state with this draft.
    const resourceId = pad.id;
    const openedRevision = pad.revision;
    const applied = createScratchStyle(pad.style);
    let draft = applied;
    let alsoNewPads = false;
    let busy = false;

    const overlay = document.createElement('div');
    overlay.className = `deck-overlay style-overlay${compact ? ' is-sheet' : ''}`;
    const panel = document.createElement('div');
    panel.className = 'style-panel';
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-modal', 'true');
    overlay.appendChild(panel);

    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      document.removeEventListener('keydown', onKey, true);
      overlay.remove();
      resolve(value);
    };

    /**
     * Leaving with an unapplied preview.
     *
     * Asked in the panel's own footer rather than by stacking a second modal on
     * top of the first — and Discard puts the applied background back, so the
     * pad is never left wearing something the user did not choose.
     */
    const tryClose = () => {
      if (busy) return;
      if (sameStyle(draft, applied)) { onPreview?.(applied); finish({ applied: false }); return; }
      panel.classList.add('is-confirming');
      render();
    };

    const onKey = (e) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopPropagation();
      tryClose();
    };
    document.addEventListener('keydown', onKey, true);
    overlay.addEventListener('pointerdown', (e) => { if (e.target === overlay) tryClose(); });
    // The panel's own scrolling, taps and dismissal must not reach the canvas,
    // the divider or the strip underneath it.
    panel.addEventListener('pointerdown', (e) => e.stopPropagation());

    const preview = (next) => {
      draft = createScratchStyle(next);
      onPreview?.(draft);
      render();
    };

    async function apply() {
      if (busy) return;
      busy = true;
      render();
      try {
        const saved = await setScratchpadStyle(resourceId, draft, {
          expectedRevision: openedRevision === pad.revision ? undefined : openedRevision,
        });
        // The preference is a separate write, and a separate outcome. If only it
        // fails the pad is still saved, and saying otherwise — or rolling the
        // pad back — would be a lie in one direction or a loss in the other.
        if (alsoNewPads && !writeNewPadStyle(draft)) {
          onNotice?.(t('scratch.defaultFailed'));
        }
        onApplied?.(saved);
        finish({ applied: true, pad: saved });
      } catch (_) {
        busy = false;
        // The panel stays, with the pending selection and every unsaved stroke
        // intact. Nothing claims to have been saved.
        panel.classList.add('is-failed');
        render();
      }
    }

    function render() {
      const pattern = draft.patternId;
      const showGuideControls = hasGuides(pattern);
      const spacingLabel = isCellPattern(pattern) ? t('scratch.cellSize') : t('scratch.spacing');
      const confirming = panel.classList.contains('is-confirming');
      const failed = panel.classList.contains('is-failed');

      panel.innerHTML = `
        <div class="style-head">
          <div class="style-title">${escapeHtml(t('scratch.style'))}</div>
          <div class="style-subject">
            <span></span>
            <span class="style-preview-flag">${escapeHtml(t('scratch.previewNotApplied'))}</span>
          </div>
        </div>
        <div class="style-body">
          <div class="style-grid" role="radiogroup"
               aria-label="${escapeHtml(t('scratch.pattern'))}"></div>
          ${!isKnownPattern(pattern)
    ? `<p class="style-note is-warning">${escapeHtml(t('scratch.unsupportedPattern'))}</p>` : ''}
          <div class="style-row">
            <span class="style-row-label">${escapeHtml(t('scratch.tone'))}</span>
            <span class="style-swatches" role="radiogroup"
                  aria-label="${escapeHtml(t('scratch.tone'))}"></span>
          </div>
          <div class="style-row" data-role="spacing-row" ${showGuideControls ? '' : 'hidden'}>
            <span class="style-row-label">${escapeHtml(spacingLabel)}</span>
            <span class="style-segments" data-role="spacing" role="radiogroup"
                  aria-label="${escapeHtml(spacingLabel)}"></span>
          </div>
          <div class="style-row" data-role="contrast-row" ${showGuideControls ? '' : 'hidden'}>
            <span class="style-row-label">${escapeHtml(t('scratch.contrast'))}</span>
            <span class="style-segments" data-role="contrast" role="radiogroup"
                  aria-label="${escapeHtml(t('scratch.contrast'))}"></span>
          </div>
          <label class="deck-check">
            <input type="checkbox" data-role="also-new">
            <span>${escapeHtml(t('scratch.alsoNewPads'))}</span>
          </label>
          ${failed ? `<p class="style-note is-error">${escapeHtml(t('scratch.styleFailed'))}</p>` : ''}
        </div>
        <div class="style-actions">
          ${confirming
    ? `<button type="button" class="deck-dialog-btn" data-role="discard">${escapeHtml(t('scratch.discardPreview'))}</button>
             <button type="button" class="deck-dialog-btn is-primary" data-role="keep">${escapeHtml(t('scratch.keepChoosing'))}</button>`
    : `<button type="button" class="deck-dialog-btn" data-role="cancel">${escapeHtml(t('deck.cancel'))}</button>
             <button type="button" class="deck-dialog-btn is-primary" data-role="apply"${busy ? ' disabled' : ''}>${escapeHtml(failed ? t('deck.retry') : t('scratch.apply'))}</button>`}
        </div>`;

      panel.querySelector('.style-subject span').textContent = pad.name;
      panel.querySelector('.style-preview-flag').hidden = sameStyle(draft, applied);

      const grid = panel.querySelector('.style-grid');
      for (const id of PATTERN_ORDER) {
        const selected = id === pattern;
        const tile = document.createElement('button');
        tile.type = 'button';
        tile.className = `style-tile${selected ? ' is-selected' : ''}`;
        tile.setAttribute('role', 'radio');
        tile.setAttribute('aria-checked', String(selected));
        tile.innerHTML = `
          <canvas class="style-tile-canvas" aria-hidden="true"></canvas>
          <span class="style-tile-name">${escapeHtml(t(`pattern.${id}`))}</span>
          <span class="style-tile-note">${escapeHtml(t(`pattern.${id}.note`))}</span>`;
        // Each tile carries the CURRENT tone and settings, so the grid shows
        // what choosing it would actually give rather than a stock swatch.
        paintTile(tile.querySelector('canvas'), createScratchStyle({ ...draft, patternId: id }));
        tile.addEventListener('click', () => preview({ ...draft, patternId: id }));
        grid.appendChild(tile);
      }

      const swatches = panel.querySelector('.style-swatches');
      for (const tone of TONE_ORDER) {
        const selected = tone === draft.paperTone;
        const button = document.createElement('button');
        button.type = 'button';
        button.className = `style-swatch${selected ? ' is-selected' : ''}`;
        button.setAttribute('role', 'radio');
        button.setAttribute('aria-checked', String(selected));
        button.setAttribute('aria-label', t(`tone.${tone}`));
        button.title = t(`tone.${tone}`);
        button.style.background = paperColor({ paperTone: tone });
        button.addEventListener('click', () => preview({ ...draft, paperTone: tone }));
        swatches.appendChild(button);
      }

      const segments = (host, values, current, key, prefix) => {
        for (const value of values) {
          const selected = value === current;
          const button = document.createElement('button');
          button.type = 'button';
          button.className = `style-segment${selected ? ' is-selected' : ''}`;
          button.setAttribute('role', 'radio');
          button.setAttribute('aria-checked', String(selected));
          button.textContent = t(`${prefix}.${value}`);
          button.addEventListener('click', () => preview({ ...draft, [key]: value }));
          host.appendChild(button);
        }
      };
      segments(panel.querySelector('[data-role="spacing"]'), SPACING_ORDER,
        draft.spacingPreset, 'spacingPreset', 'spacing');
      segments(panel.querySelector('[data-role="contrast"]'), CONTRAST_ORDER,
        draft.guideContrast, 'guideContrast', 'contrast');

      const alsoNew = panel.querySelector('[data-role="also-new"]');
      alsoNew.checked = alsoNewPads;
      alsoNew.addEventListener('change', (e) => { alsoNewPads = e.target.checked; });

      panel.querySelector('[data-role="apply"]')?.addEventListener('click', apply);
      panel.querySelector('[data-role="cancel"]')?.addEventListener('click', tryClose);
      panel.querySelector('[data-role="keep"]')?.addEventListener('click', () => {
        panel.classList.remove('is-confirming');
        render();
      });
      panel.querySelector('[data-role="discard"]')?.addEventListener('click', () => {
        // The applied background goes back on, and the ink is untouched — it
        // never was touched.
        onPreview?.(applied);
        finish({ applied: false });
      });
    }

    render();
    document.body.appendChild(overlay);
    panel.querySelector('button')?.focus();
  });
}
