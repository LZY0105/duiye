// Scratch Module — drawing the paper's guides (F11).
//
// The background is drawn for the VISIBLE world region only, straight onto a
// viewport-sized canvas, on the same camera transform the ink uses. Two
// consequences the specification asks for follow from that and are worth
// stating plainly:
//
//   - guides never slide beneath the strokes drawn on them, because there is
//     one transform and both read it;
//   - there is no infinite bitmap, no node per line and no full-ink scan; the
//     cost is the number of lines actually on screen and nothing else.
//
// Deliberately NOT a canvas pattern fill. A repeating tile has to be an whole
// number of device pixels or its edges do not meet, and the zoom here is
// continuous — so a tiled grid shows seams at most zooms, which is exactly the
// artefact the acceptance list calls out. Lines are drawn where they are.
//
// Guides are not ink. They are painted on a different canvas from the ink
// surface, they are never in the layer, and erasing, lasso and clear cannot
// reach them.

import {
  PATTERNS,
  axisColor,
  effectivePattern,
  guideColor,
  guideSpacing,
  paperColor,
} from './scratch-style.js';
import { visibleWorld } from './scratch-camera.js';

/**
 * How close together a family of guides may be drawn, in screen pixels.
 *
 * Below this they stop reading as guides and start reading as a tint over the
 * paper, and they cost a line each to say it. Rather than dropping them at a
 * threshold — which pops as the zoom crosses it — the finer family is faded
 * out over the range between these two, so a zoom out thins the grid instead of
 * losing half of it in one frame.
 */
const FADE_FROM = 5;
const FADE_TO = 11;

/** Dots need more room than lines before they turn into a texture. */
const DOT_FADE_FROM = 7;
const DOT_FADE_TO = 15;

const SQRT3_2 = Math.sqrt(3) / 2;
const INV_SQRT2 = 1 / Math.sqrt(2);

const clamp01 = (v) => Math.min(1, Math.max(0, v));

/**
 * Which spacings to draw at this zoom, and how strongly.
 *
 * `coarse` is the first multiple of the chosen spacing that is far enough apart
 * to be worth drawing, always a power-of-two multiple so every line it keeps is
 * a line the base grid had — the grid thins, it never shifts. `fine` is the
 * family one step below it, drawn at `fineStrength` as it fades in, which is
 * what makes zooming continuous rather than stepped.
 */
function levelOfDetail(spacing, zoom, from = FADE_FROM, to = FADE_TO) {
  let coarse = spacing;
  let steps = 0;
  while (coarse * zoom < to && steps < 16) { coarse *= 2; steps += 1; }
  const fine = steps > 0 ? coarse / 2 : 0;
  const fineStrength = fine ? clamp01((fine * zoom - from) / (to - from)) : 0;
  return { coarse, fine, fineStrength };
}

/**
 * The visible span of one line of a parallel family, clipped to the world rect.
 *
 * The family is described by a unit normal and a signed distance, so every
 * pattern below — horizontal, vertical, 60°, 45° — is the same code with
 * different numbers, and the spacing between neighbours is a true perpendicular
 * distance rather than an intercept that stretches with the angle.
 *
 * @returns {{x0:number,y0:number,x1:number,y1:number}|null}
 */
function clipLine(nx, ny, d, rect) {
  // A point on the line, and the direction along it.
  const px = d * nx;
  const py = d * ny;
  const dx = -ny;
  const dy = nx;

  let t0 = -Infinity;
  let t1 = Infinity;
  // Liang-Barsky against the two slabs of the rectangle.
  const slab = (p, q) => {
    if (Math.abs(p) < 1e-12) return q >= 0;          // parallel: in or out entirely
    const t = q / p;
    if (p < 0) { if (t > t1) return false; if (t > t0) t0 = t; }
    else { if (t < t0) return false; if (t < t1) t1 = t; }
    return true;
  };
  if (!slab(-dx, px - rect.minX)) return null;
  if (!slab(dx, rect.maxX - px)) return null;
  if (!slab(-dy, py - rect.minY)) return null;
  if (!slab(dy, rect.maxY - py)) return null;
  if (!(t1 > t0)) return null;

  return { x0: px + dx * t0, y0: py + dy * t0, x1: px + dx * t1, y1: py + dy * t1 };
}

/** Every multiple of `spacing`, offset by `phase`, that falls in [min, max]. */
function multiplesIn(min, max, spacing, phase = 0) {
  const out = [];
  if (!(spacing > 0)) return out;
  const first = Math.ceil((min - phase) / spacing) * spacing + phase;
  // A guard rather than a limit: the level-of-detail step above already bounds
  // this to a few hundred, and a runaway zoom must not lock the main thread.
  for (let v = first, n = 0; v <= max && n < 4000; v += spacing, n += 1) out.push(v);
  return out;
}

/**
 * Draws one family of parallel lines.
 *
 * `phase` is what puts a family on the ODD multiples of a spacing — the lines a
 * coarser family left out — so the fine family can be faded in without drawing
 * the coarse ones a second time on top of themselves.
 */
function drawFamily(ctx, camera, viewport, world, { nx, ny, spacing, phase = 0 }) {
  // The range of signed distances the visible rectangle spans, for this normal.
  const corners = [
    world.minX * nx + world.minY * ny,
    world.maxX * nx + world.minY * ny,
    world.minX * nx + world.maxY * ny,
    world.maxX * nx + world.maxY * ny,
  ];
  const lo = Math.min(...corners);
  const hi = Math.max(...corners);

  ctx.beginPath();
  for (const d of multiplesIn(lo, hi, spacing, phase)) {
    const seg = clipLine(nx, ny, d, world);
    if (!seg) continue;
    const a = toScreen(camera, viewport, seg.x0, seg.y0);
    const b = toScreen(camera, viewport, seg.x1, seg.y1);
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
  }
  ctx.stroke();
}

/** World → CSS pixels. Inlined rather than imported per point; this is a loop. */
function toScreen(camera, viewport, x, y) {
  const scale = camera.zoom;
  const offsetX = camera.x - (viewport.width / 2) / scale;
  const offsetY = camera.y - (viewport.height / 2) / scale;
  return { x: (x - offsetX) * scale, y: (y - offsetY) * scale };
}

/** A grid of dots, as one path of tiny squares rather than thousands of arcs. */
function drawDots(ctx, camera, viewport, world, spacing, radius) {
  const xs = multiplesIn(world.minX, world.maxX, spacing);
  const ys = multiplesIn(world.minY, world.maxY, spacing);
  const size = radius * 2;
  ctx.beginPath();
  for (const wx of xs) {
    for (const wy of ys) {
      const p = toScreen(camera, viewport, wx, wy);
      ctx.rect(p.x - radius, p.y - radius, size, size);
    }
  }
  ctx.fill();
}

/**
 * Paints the paper and its guides.
 *
 * Everything inside is in CSS pixels; the device-pixel-ratio transform is set
 * here, once, exactly as the ink surface sets its own.
 */
export function drawScratchBackground(ctx, { style, camera, viewport, dpr = 1 }) {
  if (!ctx || !viewport?.width || !viewport?.height) return;

  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  ctx.fillStyle = paperColor(style);
  ctx.fillRect(0, 0, viewport.width, viewport.height);

  const pattern = effectivePattern(style);
  if (pattern === PATTERNS.PLAIN) return;

  const world = visibleWorld(camera, viewport);
  const spacing = guideSpacing(style);
  const zoom = camera.zoom;

  ctx.save();
  ctx.lineCap = 'butt';
  ctx.lineWidth = 1;

  const strokeFamilies = (families, level, colour) => {
    ctx.strokeStyle = colour(1);
    for (const f of families) {
      drawFamily(ctx, camera, viewport, world, { ...f, spacing: level.coarse * f.unit });
    }
    if (level.fine && level.fineStrength > 0.02) {
      ctx.strokeStyle = colour(level.fineStrength);
      for (const f of families) {
        drawFamily(ctx, camera, viewport, world, {
          ...f,
          spacing: level.coarse * f.unit,
          phase: level.fine * f.unit,
        });
      }
    }
  };

  const guide = (strength) => guideColor(style, strength);

  switch (pattern) {
    case PATTERNS.DOTS: {
      const level = levelOfDetail(spacing, zoom, DOT_FADE_FROM, DOT_FADE_TO);
      // The dot grows a little with the zoom so it stays a dot rather than
      // thinning to nothing, but never becomes a blot.
      //
      // The floor used to be 0.6, which on a normal screen is barely one device
      // pixel of a pale guide colour: dot paper drew dots that could not be
      // seen, and the sample in the style chooser came out looking blank. A dot
      // has to survive being small — that is the whole point of dot paper —
      // so it never goes below a pixel you can actually find.
      const radius = Math.min(1.8, Math.max(0.95, 0.55 * Math.sqrt(zoom)));
      ctx.fillStyle = guide(1);
      drawDots(ctx, camera, viewport, world, level.coarse, radius);
      if (level.fine && level.fineStrength > 0.02) {
        // The dots the coarse grid left out: every fine intersection that is
        // not also a coarse one. Drawn as the full fine grid at the fading
        // strength, then the coarse grid again on top at full — cheaper than
        // testing each point, and the overdraw is one grid of dots.
        ctx.fillStyle = guide(level.fineStrength);
        drawDots(ctx, camera, viewport, world, level.fine, radius);
        ctx.fillStyle = guide(1);
        drawDots(ctx, camera, viewport, world, level.coarse, radius);
      }
      break;
    }

    case PATTERNS.RULED: {
      const level = levelOfDetail(spacing, zoom);
      strokeFamilies([{ nx: 0, ny: 1, unit: 1 }], level, guide);
      break;
    }

    case PATTERNS.SQUARE: {
      const level = levelOfDetail(spacing, zoom);
      strokeFamilies([{ nx: 1, ny: 0, unit: 1 }, { nx: 0, ny: 1, unit: 1 }], level, guide);
      break;
    }

    case PATTERNS.CARTESIAN: {
      const level = levelOfDetail(spacing, zoom);
      strokeFamilies([{ nx: 1, ny: 0, unit: 1 }, { nx: 0, ny: 1, unit: 1 }], level, guide);
      // One pair of axes, at the world origin, and nowhere else — they are what
      // makes this a pair of axes rather than more graph paper. They may well be
      // off screen, which is correct: the origin is a place, not a corner.
      ctx.strokeStyle = axisColor(style);
      ctx.lineWidth = 1.4;
      if (world.minX <= 0 && world.maxX >= 0) {
        const top = toScreen(camera, viewport, 0, world.minY);
        const bottom = toScreen(camera, viewport, 0, world.maxY);
        ctx.beginPath();
        ctx.moveTo(top.x, top.y);
        ctx.lineTo(bottom.x, bottom.y);
        ctx.stroke();
      }
      if (world.minY <= 0 && world.maxY >= 0) {
        const left = toScreen(camera, viewport, world.minX, 0);
        const right = toScreen(camera, viewport, world.maxX, 0);
        ctx.beginPath();
        ctx.moveTo(left.x, left.y);
        ctx.lineTo(right.x, right.y);
        ctx.stroke();
      }
      ctx.lineWidth = 1;
      break;
    }

    case PATTERNS.ISOMETRIC: {
      // Three families at 60° to each other make equilateral triangles. The
      // spacing setting is the triangle's SIDE, so the perpendicular distance
      // between neighbours in each family is its height, s·√3/2.
      const level = levelOfDetail(spacing * SQRT3_2, zoom);
      strokeFamilies([
        { nx: 0, ny: 1, unit: 1 },                        // horizontal
        { nx: -SQRT3_2, ny: 0.5, unit: 1 },               // +60°
        { nx: SQRT3_2, ny: 0.5, unit: 1 },                // -60°
      ], level, guide);
      break;
    }

    case PATTERNS.TIANZI:
    case PATTERNS.MIZI: {
      // The cell walls first, at full strength: they are the structure, and
      // they are what has to survive when the grid gets dense. The inner guides
      // are dashed and go first, rather than dropping arbitrary lines out of
      // the cells and leaving something that is no longer a 田字格.
      const level = levelOfDetail(spacing, zoom);
      strokeFamilies([{ nx: 1, ny: 0, unit: 1 }, { nx: 0, ny: 1, unit: 1 }], level, guide);

      const cellPx = level.coarse * zoom;
      const innerStrength = clamp01((cellPx - 26) / 22);
      if (innerStrength > 0.02) {
        ctx.save();
        ctx.setLineDash([4, 4]);
        ctx.strokeStyle = guide(innerStrength);
        // The centre cross: the lines halfway between the walls.
        drawFamily(ctx, camera, viewport, world,
          { nx: 1, ny: 0, spacing: level.coarse, phase: level.coarse / 2 });
        drawFamily(ctx, camera, viewport, world,
          { nx: 0, ny: 1, spacing: level.coarse, phase: level.coarse / 2 });
        if (pattern === PATTERNS.MIZI) {
          // Both diagonals of every cell. Written as two 45° families whose
          // perpendicular spacing is s/√2: the family x−y = k·s runs corner to
          // corner of one cell per line, which is what 米 means here.
          const diagonal = level.coarse * INV_SQRT2;
          drawFamily(ctx, camera, viewport, world,
            { nx: INV_SQRT2, ny: -INV_SQRT2, spacing: diagonal });
          drawFamily(ctx, camera, viewport, world,
            { nx: INV_SQRT2, ny: INV_SQRT2, spacing: diagonal });
        }
        ctx.restore();
      }
      break;
    }

    default:
      break;
  }

  ctx.restore();
}
