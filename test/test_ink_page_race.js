#!/usr/bin/env node
// Ink page-switch race regression tests.
//
// The reported defect: paging quickly could save one page's strokes onto
// another, or lose them. The cause was that the installed layer and the page
// number it belonged to were tracked separately, and a save named its page as a
// caller-supplied argument — so an interleaved swap could pair the two wrongly.
//
// These tests drive the same interleaving deterministically against a model of
// the swap protocol, with the store's async boundary made controllable. They
// fail against the old protocol (page argument + unserialised swaps) and pass
// against the current one (page derived from state + serialised swaps).

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const $read = (f) => readFileSync(join(ROOT, f), 'utf-8');

let PASS = 0, FAIL = 0;
function pass(l) { PASS++; console.log(`  ✅ ${l}`); }
function fail(l, d) { FAIL++; console.log(`  ❌ ${l}${d ? ': ' + d : ''}`); }
function ok(c, l, d) { if (c) pass(l); else fail(l, d); }
function group(n) { console.log(`\n─── [${n}] ───`); }
async function checkAsync(label, fn) {
  try { await fn(); pass(label); } catch (e) { fail(label, e.message); }
}

/**
 * Drives queued loads to completion.
 *
 * A load is only queued once the preceding save has resolved, so flushing once
 * would deadlock: the queue is still empty at that moment. This alternates
 * flushing with yielding to the microtask queue until nothing is left in
 * flight, which is what lets the interleaving be reproduced deterministically.
 */
async function settle(store, rounds = 20) {
  for (let i = 0; i < rounds; i++) {
    store.flushLoads();
    await new Promise(r => setTimeout(r, 0));
  }
}

/** A store whose reads resolve only when released, so races are reproducible. */
function controllableStore() {
  const saved = new Map();       // page → layer marker
  const pendingLoads = [];
  return {
    saved,
    async save(page, layer) { saved.set(page, layer); },
    load(page) {
      return new Promise((resolve) => {
        pendingLoads.push(() => resolve(`layer-p${page}`));
      });
    },
    /** Releases queued loads in the order they were requested. */
    flushLoads() {
      while (pendingLoads.length) pendingLoads.shift()();
    },
    flushOneLoad() {
      if (pendingLoads.length) pendingLoads.shift()();
    },
    pendingCount() { return pendingLoads.length; },
  };
}

/** The CURRENT protocol: page derived from state, swaps serialised. */
function makePane(store) {
  return {
    inkPage: 1,
    layer: 'layer-p1',
    _chain: Promise.resolve(),
    async _flush() {
      // No page argument: the page comes from the pane's own state, so it
      // always matches the installed layer.
      if (!this.inkPage) return;
      const page = this.inkPage;
      const layer = this.layer;
      await store.save(page, layer);
    },
    async _perform(toPage) {
      await this._flush();
      const loaded = await store.load(toPage);
      this.layer = loaded;      // installed and recorded together
      this.inkPage = toPage;
    },
    swap(toPage) {
      this._chain = this._chain.then(() => this._perform(toPage));
      return this._chain;
    },
  };
}

/**
 * The CURRENT protocol with the atomic blank: the surface is cleared the
 * instant the page changes, so the previous page's notes are never drawn over
 * the new page while its ink is being read. The danger that buys is obvious —
 * a save arriving after the blank would write an empty layer over real work —
 * so the outgoing (page, layer) are captured as a pair first and `inkPage` is
 * set to null, which disowns the cleared surface until the new page lands.
 */
function makeAtomicPane(store) {
  return {
    inkPage: 1,
    layer: 'layer-p1',
    _chain: Promise.resolve(),
    /** The autosave timer and unload path; writes only what it still owns. */
    async _flush() {
      if (!this.inkPage) return;
      await store.save(this.inkPage, this.layer);
    },
    async _perform(toPage, fromPage, outgoing) {
      if (fromPage && outgoing) await store.save(fromPage, outgoing);
      const loaded = await store.load(toPage);
      this.layer = loaded;
      this.inkPage = toPage;
    },
    swap(toPage) {
      const fromPage = this.inkPage;
      const outgoing = fromPage ? this.layer : null;
      this.inkPage = null;              // disowned
      this.layer = 'blank';             // surface cleared, synchronously
      this._chain = this._chain.then(() => this._perform(toPage, fromPage, outgoing));
      return this._chain;
    },
  };
}

/** The OLD protocol, kept to prove these tests actually detect the defect. */
function makeLegacyPane(store) {
  return {
    inkPage: 1,
    layer: 'layer-p1',
    async _flush(page) {
      const target = page ?? this.inkPage;
      if (!target) return;
      await store.save(target, this.layer);   // caller names the page
    },
    async swap(fromPage, toPage) {
      await this._flush(fromPage);
      this.inkPage = toPage;                  // advanced BEFORE the layer lands
      const loaded = await store.load(toPage);
      if (this.inkPage !== toPage) return;
      this.layer = loaded;
    },
  };
}

console.log('═══════════════════════════════════════════════════════════════');
console.log('  Ink page-switch race');
console.log('═══════════════════════════════════════════════════════════════');

// ═══════════════════════════════════════════════════════════════
group('1. The defect is real (old protocol)');

await checkAsync('OLD protocol writes page 1 strokes onto page 2', async () => {
  const store = controllableStore();
  const pane = makeLegacyPane(store);
  pane.layer = 'strokes-from-page-1';

  const a = pane.swap(1, 2);            // not awaited, as the UI does
  await new Promise(r => setTimeout(r, 0));  // let it reach its load()
  const b = pane.swap(2, 3);            // user pages again mid-flight
  await settle(store);
  await Promise.all([a, b]);

  // Page 2 received the layer that belonged to page 1.
  assert.equal(store.saved.get(2), 'strokes-from-page-1',
    'expected the old protocol to exhibit the corruption');
});

// ═══════════════════════════════════════════════════════════════
group('2. The fix (current protocol)');

await checkAsync('rapid paging never writes a layer to the wrong page', async () => {
  const store = controllableStore();
  const pane = makePane(store);
  pane.layer = 'strokes-from-page-1';

  const swaps = [pane.swap(2), pane.swap(3), pane.swap(4)];
  await settle(store);   // serialised swaps request their loads one at a time
  await Promise.all(swaps);

  assert.equal(store.saved.get(1), 'strokes-from-page-1', 'page 1 keeps its own strokes');
  for (const [page, layer] of store.saved) {
    if (page === 1) continue;
    assert.equal(layer, `layer-p${page}`,
      `page ${page} must hold its own layer, got ${layer}`);
  }
});

await checkAsync('the layer and its page are always consistent', async () => {
  const store = controllableStore();
  const pane = makePane(store);
  const swaps = [pane.swap(5), pane.swap(9)];
  await settle(store);
  await Promise.all(swaps);
  assert.equal(pane.inkPage, 9);
  assert.equal(pane.layer, 'layer-p9', 'installed layer must match the recorded page');
});

await checkAsync('no strokes are lost when paging away immediately', async () => {
  const store = controllableStore();
  const pane = makePane(store);
  pane.layer = 'unsaved-work';
  const swap = pane.swap(2);
  await settle(store);
  await swap;
  assert.equal(store.saved.get(1), 'unsaved-work', 'leaving a page must commit it');
});

// ═══════════════════════════════════════════════════════════════
group('3. Source guarantees');

const pane = $read('src/pdf/pdf-pane.js');

ok(
  /async _flushInkSave\(\)\s*\{/.test(pane),
  '_flushInkSave takes no page argument, so a caller cannot name the wrong page',
);
ok(
  pane.includes('this._inkSwap = this._inkSwap'),
  'page swaps are serialised through a promise chain',
);
ok(
  /this\.ink\.loadLayer\(layer\);\s*\n\s*this\._inkPage = toPage;/.test(pane),
  '_inkPage advances only after the new layer is installed',
);
ok(
  !/_flushInkSave\(\s*[A-Za-z_]/.test(pane),
  'no call site passes a page to the save path',
);

// ═══════════════════════════════════════════════════════════════
group('4. Blanking the surface must not blank the page it came from');

await checkAsync('the outgoing page keeps its strokes even though the surface is cleared', async () => {
  const store = controllableStore();
  const pane = makeAtomicPane(store);
  pane.layer = 'strokes-from-page-1';

  const done = pane.swap(2);
  assert.equal(pane.layer, 'blank', 'the surface is cleared at once, not a read later');
  assert.equal(pane.inkPage, null, 'and the page is disowned in the same breath');
  await settle(store);
  await done;
  assert.equal(store.saved.get(1), 'strokes-from-page-1',
    'page 1 must hold what was drawn on page 1, not the blank that replaced it');
  assert.equal(pane.layer, 'layer-p2');
  assert.equal(pane.inkPage, 2);
});

await checkAsync('an autosave landing in the gap can never write the blank', async () => {
  // The 400ms debounce can fire between the surface being cleared and the new
  // page's ink arriving. With the page disowned there is nothing for it to
  // write to — which is the whole point, because what it would otherwise write
  // is the cleared surface, over work the reader can still see on paper.
  const store = controllableStore();
  const pane = makeAtomicPane(store);
  pane.layer = 'strokes-from-page-1';

  const done = pane.swap(2);
  assert.equal(pane.inkPage, null, 'nothing is owned while the swap is in flight');
  await pane._flush();                 // the autosave timer, mid-swap
  assert.notEqual(store.saved.get(1), 'blank',
    'the cleared surface must never be written to the page it replaced');
  assert.equal(store.saved.has(2), false,
    'nor to the page that has not arrived yet');

  await settle(store);
  await done;
  assert.equal(store.saved.get(1), 'strokes-from-page-1', 'and the real save lands');
  assert.equal(pane.inkPage, 2, 'ownership resumes only once the new layer is installed');
});

await checkAsync('a fast 1 → 2 → 3 run keeps every page with its own strokes', async () => {
  const store = controllableStore();
  const pane = makeAtomicPane(store);
  pane.layer = 'strokes-from-page-1';

  const a = pane.swap(2);
  await settle(store);
  await a;
  pane.layer = 'strokes-from-page-2';   // the reader writes on page 2
  const b = pane.swap(3);
  await settle(store);
  await b;

  assert.equal(store.saved.get(1), 'strokes-from-page-1');
  assert.equal(store.saved.get(2), 'strokes-from-page-2');
  assert.equal(pane.inkPage, 3);
});

const paneSrc = $read('src/pdf/pdf-pane.js');
ok(
  /this\._inkPage = null;[\s\S]{0,200}?this\.ink\.loadLayer\(null\);/.test(paneSrc),
  'the real swap disowns the page before clearing the surface',
);
ok(
  /_performInkSwap\(toPage, fromPage, outgoing\)/.test(paneSrc),
  'and hands the captured pair to the save, rather than re-reading state later',
);

const workspace = $read('src/pdf/pdf-workspace.js');
ok(workspace.includes('_openTokens'), 'openDocument is guarded by a per-slot token');
ok(
  /superseded\(\)/.test(workspace) && /doc\.destroy\(\)/.test(workspace),
  'a superseded open releases the document it opened instead of leaking it',
);

console.log('\n═══════════════════════════════════════════════════════════════');
console.log(`  ${PASS} passed, ${FAIL} failed`);
console.log('═══════════════════════════════════════════════════════════════');
process.exit(FAIL === 0 ? 0 : 1);
