#!/usr/bin/env node
// Scratchpad save tests (F06).
//
// The rule these exist to hold: never release the only unsaved copy, and never
// say Saved when nothing was written. A save indicator that lies is worse than
// no indicator, because it is the thing someone checks before closing the app.
//
// The pane is built from the prototype with only the fields the save path uses,
// so none of this needs a canvas or a database — the store calls are injected.

import assert from 'node:assert/strict';

import { SAVE_STATES, ScratchPane } from '../src/scratch/scratch-pane.js';

let PASS = 0, FAIL = 0;
function pass(l) { PASS++; console.log(`  ✅ ${l}`); }
function fail(l, d) { FAIL++; console.log(`  ❌ ${l}${d ? ': ' + d : ''}`); }
function group(n) { console.log(`\n─── [${n}] ───`); }
async function check(label, fn) {
  try { await fn(); pass(label); } catch (e) { fail(label, e.message); }
}

const tick = () => new Promise((r) => setTimeout(r, 0));

/**
 * A pane with a real save path and a stub everything else.
 *
 * `saveLayer` is the seam: a test decides whether the write lands, throws, or
 * hangs until it is released.
 */
function makePane({ save } = {}) {
  const written = [];
  const states = [];
  const layer = { strokes: [], isEmpty: () => false };
  const pane = Object.create(ScratchPane.prototype);
  Object.assign(pane, {
    root: null,
    pad: { id: 'pad-1', name: 'Scratchpad 01' },
    camera: { x: 0, y: 0, zoom: 1 },
    saveState: SAVE_STATES.SAVED,
    handlers: { onSaveStateChange: (s) => states.push(s), onStateChange: () => {} },
    ink: {
      getLayer: () => layer,
      setEnabled: () => {},
      loadLayer: () => {},
      resize: () => {},
      setTransform: () => {},
    },
    // Enough of a surface for the repaint that follows a load. The drawing
    // itself is covered by the background tests; what matters here is that the
    // save happened before the new pad arrived.
    elViewport: { getBoundingClientRect: () => ({ width: 800, height: 600 }) },
    elPaper: { width: 0, height: 0, style: {} },
    paperCtx: {
      setTransform() {}, scale() {}, save() {}, restore() {}, beginPath() {},
      moveTo() {}, lineTo() {}, rect() {}, fillRect() {}, clearRect() {},
      stroke() {}, fill() {}, setLineDash() {},
    },
    _inkSaveTimer: null,
    _cameraTimer: null,
    _loadToken: 0,
    _writes: Promise.resolve(),
    _inkRevision: 0,
    _savingRevision: -1,
    _store: {
      loadLayer: async () => layer,
      setScratchpadCamera: async () => null,
      saveLayer: save || (async (id, page, l) => { written.push({ id, page, l }); }),
    },
  });
  return { pane, written, states, layer };
}

console.log('═══════════════════════════════════════════════════════════════');
console.log('  Scratchpad Save Tests — never lose the only unsaved copy');
console.log('═══════════════════════════════════════════════════════════════');

// ═══════════════════════════════════════════════════════════════
group('1. The ordinary path');

await check('a stroke marks the pad unsaved at once, before any write', async () => {
  const { pane } = makePane();
  pane._inkChanged();
  assert.equal(pane.saveState, SAVE_STATES.UNSAVED);
  assert.equal(pane.hasUnsavedInk(), true);
  clearTimeout(pane._inkSaveTimer);
});

await check('flushing writes the layer and only then says Saved', async () => {
  const { pane, written, states } = makePane();
  pane._inkChanged();
  clearTimeout(pane._inkSaveTimer);
  pane._inkSaveTimer = null;

  const ok = await pane.flush();
  assert.equal(ok, true);
  assert.equal(written.length, 1);
  assert.equal(written[0].id, 'pad-1');
  assert.equal(pane.saveState, SAVE_STATES.SAVED);
  // Saving is a state of its own and is passed through on the way.
  assert.deepEqual(states, [SAVE_STATES.UNSAVED, SAVE_STATES.SAVING, SAVE_STATES.SAVED]);
});

await check('flushing a pad with nothing outstanding writes nothing', async () => {
  const { pane, written } = makePane();
  assert.equal(await pane.flush(), true);
  assert.equal(written.length, 0, 'an idle flush is not a write');
});

await check('the debounce collapses a burst of strokes into one write', async () => {
  const { pane, written } = makePane();
  for (let i = 0; i < 20; i++) pane._inkChanged();
  assert.equal(written.length, 0, 'nothing is written while the hand is moving');
  await pane.flush();
  assert.equal(written.length, 1);
});

// ═══════════════════════════════════════════════════════════════
group('2. A failed write is reported, and the ink is kept');

await check('a write that throws leaves the pad failed, not saved', async () => {
  const { pane } = makePane({ save: async () => { throw new Error('QuotaExceededError'); } });
  pane._inkChanged();
  clearTimeout(pane._inkSaveTimer);

  const ok = await pane.flush();
  assert.equal(ok, false, 'the failure is reported to the caller, not swallowed');
  assert.equal(pane.saveState, SAVE_STATES.FAILED);
  assert.equal(pane.hasUnsavedInk(), true, 'the only copy is still resident');
});

await check('the strokes are still in the layer after a failure', async () => {
  const { pane, layer } = makePane({ save: async () => { throw new Error('nope'); } });
  layer.strokes.push({ id: 's1' });
  pane._inkChanged();
  clearTimeout(pane._inkSaveTimer);
  await pane.flush();
  assert.equal(pane.ink.getLayer().strokes.length, 1, 'nothing was released');
});

await check('retry writes again and can succeed', async () => {
  let attempts = 0;
  const { pane } = makePane({
    save: async () => { attempts += 1; if (attempts === 1) throw new Error('full'); },
  });
  pane._inkChanged();
  clearTimeout(pane._inkSaveTimer);

  assert.equal(await pane.flush(), false);
  assert.equal(pane.saveState, SAVE_STATES.FAILED);

  assert.equal(await pane.retrySave(), true);
  assert.equal(attempts, 2);
  assert.equal(pane.saveState, SAVE_STATES.SAVED);
});

await check('drawing after a failure keeps it unsaved rather than clearing the alarm', async () => {
  const { pane } = makePane({ save: async () => { throw new Error('full'); } });
  pane._inkChanged();
  clearTimeout(pane._inkSaveTimer);
  await pane.flush();
  assert.equal(pane.saveState, SAVE_STATES.FAILED);

  pane._inkChanged();
  clearTimeout(pane._inkSaveTimer);
  assert.equal(pane.hasUnsavedInk(), true);
});

// ═══════════════════════════════════════════════════════════════
group('3. An acknowledgement belongs only to the ink it captured');

await check('strokes drawn during a save are not marked saved by it', async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const { pane } = makePane({ save: async () => { await gate; } });

  pane._inkChanged();
  clearTimeout(pane._inkSaveTimer);
  const inFlight = pane.flush();
  assert.equal(pane.saveState, SAVE_STATES.SAVING);

  // Three more strokes land while the write is still out.
  pane._inkChanged();
  pane._inkChanged();
  pane._inkChanged();
  clearTimeout(pane._inkSaveTimer);

  release();
  await inFlight;
  assert.equal(pane.saveState, SAVE_STATES.UNSAVED,
    'the write committed an older revision, so the pad is not saved');
  assert.equal(pane.hasUnsavedInk(), true);
});

await check('two saves cannot commit out of order', async () => {
  const order = [];
  let releaseFirst;
  const first = new Promise((r) => { releaseFirst = r; });
  let call = 0;
  const { pane } = makePane({
    save: async () => {
      call += 1;
      const mine = call;
      if (mine === 1) await first;
      order.push(mine);
    },
  });

  pane._inkChanged();
  clearTimeout(pane._inkSaveTimer);
  const a = pane.flush();
  pane._inkChanged();
  clearTimeout(pane._inkSaveTimer);
  const b = pane.flush();

  releaseFirst();
  await Promise.all([a, b]);
  assert.deepEqual(order, [1, 2], 'writes are chained, so the newer one lands last');
});

// ═══════════════════════════════════════════════════════════════
group('4. Leaving does not lose anything');

await check('unloading commits what has not been written yet', async () => {
  const { pane, written } = makePane();
  pane._inkChanged();
  assert.equal(written.length, 0);

  pane.unload();
  await pane._writes;
  assert.equal(written.length, 1, 'the pending debounce was not simply dropped');
  assert.equal(pane.pad, null);
});

await check('switching pads commits the outgoing one first', async () => {
  const { pane, written } = makePane();
  pane._inkChanged();
  clearTimeout(pane._inkSaveTimer);

  await pane.loadPad({ id: 'pad-2', name: 'Scratchpad 02', camera: {}, style: {} });
  await tick();
  assert.equal(written.length, 1, 'the first pad was written before the second arrived');
  assert.equal(written[0].id, 'pad-1');
  assert.equal(pane.pad.id, 'pad-2');
  assert.equal(pane.saveState, SAVE_STATES.SAVED, 'a freshly loaded pad has nothing pending');
});

await check('a superseded load never touches the pane', async () => {
  const { pane } = makePane();
  let current = true;
  const slow = pane.loadPad(
    { id: 'pad-slow', name: 'Slow', camera: {}, style: {} },
    { isCurrent: () => current },
  );
  current = false;                                     // the user moved on
  assert.equal(await slow, false, 'it stops rather than installing itself');
});

console.log('\n═══════════════════════════════════════════════════════════════');
console.log(`  ${PASS} passed, ${FAIL} failed`);
console.log('═══════════════════════════════════════════════════════════════');
process.exit(FAIL === 0 ? 0 : 1);
