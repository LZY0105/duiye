/**
 * Regression test for large-PDF first paint.
 *
 * Opening a document must expose the page interface before the optional table
 * of contents has finished loading. Real exam books can have hundreds of
 * bookmarks; making first paint wait for every destination makes the UI feel
 * frozen even though page 1 is already available.
 */

import assert from 'node:assert/strict';

let outlineCalls = 0;
let pageRenderCalls = 0;
let releaseOutline;
const outlineResult = [{ title: 'Chapter 1', dest: [0], items: [] }];
const outlinePending = new Promise((resolve) => { releaseOutline = resolve; });

const fakePdf = {
  numPages: 372,
  getOutline() {
    outlineCalls += 1;
    return outlinePending;
  },
  async getPageIndex() { return 0; },
  async getPage() {
    return {
      getViewport({ scale }) { return { width: 600 * scale, height: 800 * scale }; },
      render() {
        pageRenderCalls += 1;
        return { promise: Promise.resolve() };
      },
      cleanup() {},
    };
  },
  destroy() {},
};

globalThis.window = {
  pdfjsLib: {
    getDocument() {
      return { promise: Promise.resolve(fakePdf) };
    },
  },
};
globalThis.document = {
  createElement(tagName) {
    assert.equal(tagName, 'canvas');
    return {
      width: 0,
      height: 0,
      style: {},
      getContext() { return {}; },
    };
  },
};

const { openPdfDocument } = await import('../src/pdf/pdf-document.js');

const openPromise = openPdfDocument(new Uint8Array([0x25, 0x50, 0x44, 0x46]));
const firstPaintGate = await Promise.race([
  openPromise.then((doc) => ({ state: 'opened', doc })),
  new Promise((resolve) => setTimeout(() => resolve({ state: 'blocked' }), 25)),
]);

assert.equal(
  firstPaintGate.state,
  'opened',
  'large PDF open must not wait for table-of-contents extraction',
);
assert.equal(outlineCalls, 0, 'outline work must be lazy');
assert.equal(firstPaintGate.doc.outline, null,
  'outline remains explicitly unresolved before it is requested');
const renderedPage = await firstPaintGate.doc.renderPage(1, 1);
assert.equal(renderedPage.width, 600);
assert.equal(renderedPage.height, 800);
assert.equal(pageRenderCalls, 1,
  'page 1 renders successfully while outline extraction is still pending');
assert.equal(outlineCalls, 0,
  'rendering page 1 must not implicitly request the outline');

const outlinePromise = firstPaintGate.doc.getOutline();
assert.equal(outlineCalls, 1, 'the first outline request starts one extraction');
assert.strictEqual(
  firstPaintGate.doc.getOutline(),
  outlinePromise,
  'concurrent outline callers share the same in-flight work',
);

releaseOutline(outlineResult);
const outline = await outlinePromise;
assert.equal(outline.available, true);
assert.equal(outline.items.length, 1);
assert.equal(outline.items[0].pageNumber, 1);
assert.strictEqual(firstPaintGate.doc.outline, outline,
  'the compatibility outline property exposes the resolved memoized value');

firstPaintGate.doc.destroy();
delete globalThis.window;

const { PdfPane } = await import('../src/pdf/pdf-pane.js');

let releasePageSize;
const pageSizePending = new Promise((resolve) => { releasePageSize = resolve; });
let renderStarted = 0;
let loadIsCurrent = true;
const cancellablePane = Object.create(PdfPane.prototype);
Object.assign(cancellablePane, {
  answerIndex: null,
  questionIndex: null,
  outlineAlignment: null,
  answerComparability: undefined,
  doc: null,
  meta: null,
  state: null,
  pageSize: null,
  _viewport: () => ({ width: 800, height: 600 }),
  _render: async () => {
    renderStarted += 1;
    return new Promise(() => {});
  },
  elEmpty: { hidden: false },
  elBody: { hidden: true },
  ink: { setEnabled() {}, loadLayer() {} },
  handlers: {},
});
const pendingLoad = cancellablePane.loadDocument({
  numPages: 372,
  pageSize: () => pageSizePending,
}, { id: 'superseded-document' }, null, () => loadIsCurrent);

loadIsCurrent = false;
releasePageSize({ width: 600, height: 800 });
await new Promise((resolve) => setImmediate(resolve));
assert.equal(renderStarted, 0,
  'a superseded pane load must stop before starting page rendering');
assert.equal(await pendingLoad, false,
  'a superseded pane load reports that it did not commit');

const { PdfWorkspace } = await import('../src/pdf/pdf-workspace.js');
const { createWorkspaceState, SLOTS } = await import('../src/pdf/workspace-state.js');

let releaseStoredDocument;
let storedDocumentRequested = false;
const storedDocumentPending = new Promise((resolve) => {
  releaseStoredDocument = resolve;
});
let workspaceLoadCalls = 0;
let destroyedDocuments = 0;
const outlinePanel = {
  hidden: false,
  innerHTML: 'old outline',
  replaceChildren() { this.innerHTML = ''; },
};
const outlineButton = { disabled: false };
const slotElement = {
  querySelector(selector) {
    if (selector.includes('outline-panel')) return outlinePanel;
    if (selector.includes('outline')) return outlineButton;
    return null;
  },
};
const workspacePane = {
  doc: null,
  isLoaded: () => false,
  unload() { this.doc = null; },
  async loadDocument(doc) {
    workspaceLoadCalls += 1;
    this.doc = doc;
    return true;
  },
};
const workspace = Object.create(PdfWorkspace.prototype);
Object.assign(workspace, {
  state: createWorkspaceState(),
  _openTokens: { [SLOTS.PRIMARY]: 0, [SLOTS.SECONDARY]: 0 },
  _outlines: { [SLOTS.PRIMARY]: { available: true, items: [] }, [SLOTS.SECONDARY]: null },
  _pdfLibrary: {
    async getDocumentMeta() { return { id: 'replacement', pageCount: 372 }; },
    openStoredDocument() {
      storedDocumentRequested = true;
      return storedDocumentPending;
    },
  },
  panes: { [SLOTS.PRIMARY]: workspacePane },
  elSlots: { [SLOTS.PRIMARY]: slotElement },
  _invalidatePairCaches() {},
  _setState(next) { this.state = next; },
  _layout() {},
  _persist() {},
});

const workspaceOpen = workspace.openDocument(SLOTS.PRIMARY, 'replacement');
while (!storedDocumentRequested) await new Promise((resolve) => setImmediate(resolve));
assert.equal(workspace._outlines[SLOTS.PRIMARY], null,
  'replacement open clears the previous document outline immediately');
assert.equal(outlinePanel.hidden, true,
  'replacement open closes the previous document outline panel');
// Disabled here because there is no DOCUMENT — the old one has been unloaded
// and the replacement has not arrived. That is the only reason it is ever
// disabled now.
//
// It used to be disabled whenever the OUTLINE was missing or still parsing,
// and that was wrong once the same control started opening the thumbnails and
// the bookmarks too: it switched off the one way into a book that has no table
// of contents, which is most scanned ones.
assert.equal(outlineButton.disabled, true,
  'nothing to find pages in while no document is open');
assert.equal(outlinePanel.innerHTML, '',
  'old bookmark controls are removed before replacement parsing finishes');
workspace.closeSlot(SLOTS.PRIMARY);
releaseStoredDocument({
  outline: { available: false, items: [] },
  getOutline: async () => ({ available: false, items: [] }),
  destroy() { destroyedDocuments += 1; },
});
const closedOpenResult = await workspaceOpen;
assert.equal(closedOpenResult, null,
  'closing a slot cancels its pending document open');
assert.equal(workspaceLoadCalls, 0,
  'a document resolved after close must never load into the pane');
assert.equal(destroyedDocuments, 1,
  'a document resolved after close is released');

let releaseWorkspaceOutline;
const workspaceOutlinePending = new Promise((resolve) => {
  releaseWorkspaceOutline = resolve;
});
const openOrder = [];
const liveDocument = {
  outline: null,
  getOutline() {
    openOrder.push('outline-start');
    return workspaceOutlinePending;
  },
  destroy() {},
};
const livePanel = {
  hidden: true,
  innerHTML: '',
  replaceChildren() { this.innerHTML = ''; },
};
const liveOutlineButton = { disabled: false };
const liveSlotElement = {
  querySelector(selector) {
    if (selector.includes('outline-panel')) return livePanel;
    if (selector.includes('outline')) return liveOutlineButton;
    return null;
  },
};
const livePane = {
  doc: null,
  isLoaded: () => false,
  unload() { this.doc = null; },
  async loadDocument(doc, meta, restoredView, isCurrent) {
    assert.equal(typeof isCurrent, 'function',
      'workspace passes its cancellation guard into pane loading');
    assert.equal(isCurrent(), true);
    openOrder.push('first-page');
    this.doc = doc;
    return true;
  },
};
const liveWorkspace = Object.create(PdfWorkspace.prototype);
Object.assign(liveWorkspace, {
  state: createWorkspaceState(),
  _openTokens: { [SLOTS.PRIMARY]: 0, [SLOTS.SECONDARY]: 0 },
  _outlines: { [SLOTS.PRIMARY]: null, [SLOTS.SECONDARY]: null },
  _pdfLibrary: {
    async getDocumentMeta() { return { id: 'large-book', pageCount: 372 }; },
    async openStoredDocument() { return liveDocument; },
  },
  panes: { [SLOTS.PRIMARY]: livePane },
  elSlots: { [SLOTS.PRIMARY]: liveSlotElement },
  _invalidatePairCaches() {},
  _setState(next) { this.state = next; },
  _layout() {},
  _persist() {},
});

const liveOpenResult = await liveWorkspace.openDocument(SLOTS.PRIMARY, 'large-book');
assert.equal(liveOpenResult.id, 'large-book');
assert.deepEqual(openOrder, ['first-page', 'outline-start'],
  'first-page commit happens before optional outline extraction starts');
assert.equal(liveWorkspace._outlines[SLOTS.PRIMARY], null,
  'workspace open resolves while the outline is still pending');

releaseWorkspaceOutline({
  available: true,
  items: [{ title: 'Chapter 1', pageNumber: 1, depth: 0, children: [] }],
});
await new Promise((resolve) => setImmediate(resolve));
assert.equal(liveWorkspace._outlines[SLOTS.PRIMARY].available, true);
assert.equal(liveOutlineButton.disabled, false,
  'outline control becomes available after background extraction');
assert.equal(livePanel.hidden, true,
  'background extraction does not force the outline panel open');

/*
 * Turning a page, and what it costs.
 *
 * Every page change used to rasterise from scratch — a second of work on the
 * tablet for a dense maths page — with nothing on screen changing until it
 * landed. Paging through a chapter meant paying that over and over, and the
 * page counter ran ahead of the picture the whole way. The pane now keeps the
 * pages it has drawn and draws the neighbours ahead of time, so the common
 * case costs nothing at all.
 */
function cachePane({ pageNumber = 1, zoom = 1, fitMode = 'page', pageCount = 10 } = {}) {
  const rasterised = [];
  const pane = Object.create(PdfPane.prototype);
  Object.assign(pane, {
    rasterised,
    doc: {
      async pageSize() { return { width: 600, height: 800 }; },
      async renderPage(page, scale) {
        rasterised.push({ page, scale });
        return {
          canvas: { width: 600 * scale, height: 800 * scale, style: {}, className: '' },
        };
      },
    },
    state: { pageNumber, pageCount, zoom, fitMode, scrollX: 0, scrollY: 0 },
    pageSize: { width: 600, height: 800 },
    _renderToken: 0,
    _pageCache: new Map(),
    _prefetchTimer: null,
    _renderBusy: false,
    _previewScale: 1,
    elHolder: { style: {}, replaceChildren() {} },
    _viewport: () => ({ width: 600, height: 800 }),
    _position() {},
  });
  return pane;
}

/** Long enough for the prefetch timer (260ms) to have run. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 340));

const paging = cachePane();
await paging._render();
assert.equal(paging.rasterised.length, 1, 'the page being read is drawn once');

await paging._render();
assert.equal(paging.rasterised.length, 1,
  'drawing the same page at the same zoom again comes out of the cache');

await settle();
assert.deepEqual(paging.rasterised.map(r => r.page).sort((a, b) => a - b), [1, 2],
  'and the page ahead is drawn before the reader gets there (there is no page 0)');

// The turn itself: state moves, _render runs, and nothing is rasterised.
paging.state = { ...paging.state, pageNumber: 2 };
await paging._render();
assert.equal(paging.rasterised.length, 2,
  'turning to a page already drawn costs no rasterise at all — this is the fix');
await settle();
assert.deepEqual(paging.rasterised.map(r => r.page).sort((a, b) => a - b), [1, 2, 3],
  'and the next one is made ready while the reader is on page 2');

// Prefetch must stay CHEAP. pdf.js has one worker and a page costs about half
// a second on the tablet; drawing several pages nobody asked for puts the page
// they did ask for behind them. Measured on the device: two-ahead prefetching
// at a short delay took a page turn from 8ms to a median of 1191ms.
const cheap = cachePane({ pageNumber: 50, pageCount: 400 });
await cheap._render();
cheap.rasterised.length = 0;
await settle();
assert.ok(cheap.rasterised.length <= 2,
  `one settle may queue at most a couple of pages, got ${cheap.rasterised.length}`);

// Direction matters: a reader going backwards is served the pages behind them.
// Reading forward and prefetching forward is the same thing; reading backward
// and prefetching forward is work for pages they are walking away from.
const back = cachePane({ pageNumber: 20, pageCount: 40 });
await back._render();
await settle();
back.rasterised.length = 0;
back.state = { ...back.state, pageNumber: 19 };
back._pageStep = -1;                       // what _apply() records on a back-turn
await back._render();
await settle();
const drawnBack = back.rasterised.map(r => r.page).sort((a, b) => a - b);
assert.ok(drawnBack.includes(18),
  `going backwards must draw the page behind: got ${JSON.stringify(drawnBack)}`);
assert.ok(!drawnBack.includes(21),
  'and not the page the other way, which the reader has already left');

// A different zoom is a different bitmap, so it is a different entry.
const zoomed = cachePane();
await zoomed._render();
zoomed.state = { ...zoomed.state, zoom: 2, fitMode: 'none' };
await zoomed._render();
assert.equal(zoomed.rasterised.length, 2, 'a new zoom needs a new bitmap');
zoomed.state = { ...zoomed.state, zoom: 1, fitMode: 'page' };
await zoomed._render();
assert.equal(zoomed.rasterised.length, 2, 'and going back to the old one does not');

// Zoomed in, the reader is studying one page rather than flipping through it.
// Rasterising its neighbours at that scale buys nothing and costs a great deal.
const studying = cachePane({ zoom: 3, fitMode: 'none' });
assert.equal(studying._zoomedPastTurning(), true);
await studying._render();
await settle();
assert.equal(studying.rasterised.length, 1, 'no neighbours are drawn at deep zoom');

// The ceiling. 600x800 at zoom 6 is 17.3M pixels, over the 8M budget, so the
// scale comes down — the canvas is still stretched to the full CSS size, so
// only sharpness is lost, and the alternative is an allocation that kills the
// WebView.
const deep = cachePane({ zoom: 6, fitMode: 'none' });
await deep._render();
const [{ scale }] = deep.rasterised;
assert.ok(scale < 6, `raster scale ${scale} must be capped below the requested 6`);
assert.ok(600 * scale * 800 * scale <= 8e6 + 1, 'and capped to the pixel budget');
assert.equal(deep._renderedZoom, 6,
  'the LOGICAL zoom is untouched, so layout and the pinch preview still agree');

// A page whose render is superseded is still worth keeping: it is exactly what
// a reader who turned one too far is about to come back to.
const superseded = cachePane();
await superseded._render();
superseded.rasterised.length = 0;
superseded.state = { ...superseded.state, pageNumber: 7 };
const inFlight = superseded._render();
superseded._renderToken += 1;                      // something newer starts
await inFlight;
assert.equal(superseded._pageCache.has('7@1.0000'), true,
  'the discarded render is banked rather than thrown away');

// Bitmaps are keyed by page and zoom, NOT by document. A cache carried across
// a load would answer for the wrong book — page 3 of the exercise book shown
// as page 3 of the answer key, silently and confidently.
const reused = cachePane();
await reused._render();
assert.ok(reused._pageCache.size > 0, 'precondition: the first book left bitmaps behind');
Object.assign(reused, {
  elBody: { hidden: true }, elEmpty: { hidden: false },
  ink: { setEnabled() {}, loadLayer() {} },
  handlers: {},
  _syncInk() {},
});
// `meta.id` is left undefined so loadLayer short-circuits instead of reaching
// for IndexedDB, which does not exist here.
await reused.loadDocument({ numPages: 9, ...reused.doc }, {}, { pageNumber: 1 });
assert.equal(reused._pageCache.size, 1,
  'opening a document starts from an empty cache — only the page it just drew');

// Both bounds are enforced: the count, and a total the device can actually
// hold. Five pages at reading zoom is one thing; five at 1.5x is twice that.
const budget = cachePane();
for (let page = 1; page <= 8; page++) {
  budget.state = { ...budget.state, pageNumber: page };
  await budget._render();
}
const total = [...budget._pageCache.values()].reduce((sum, e) => sum + e.pixels, 0);
assert.ok(budget._pageCache.size <= 5, `kept ${budget._pageCache.size} pages, cap is 5`);
assert.ok(total <= 10e6, `kept ${total} pixels, budget is 10M`);
assert.ok(budget._pageCache.has('8@1.0000'), 'and the page being read is one of them');

// A page and the notes written on it arrive together, or not at all.
//
// The two used to be raced: the bitmap landed in one frame from cache and the
// ink some tens of milliseconds later, so every turn flashed a blank page. The
// render now waits for the page's own annotations before installing anything.
{
  const waiting = cachePane();
  await waiting._render();                       // page 1, warms nothing else
  waiting.state = { ...waiting.state, pageNumber: 2 };
  let releaseInk;
  const inkReady = new Promise((r) => { releaseInk = r; });
  let shown = null;
  waiting._showCanvas = function (canvas, zoom) { shown = { at: Date.now(), zoom }; };

  const rendering = waiting._render(inkReady);
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(shown, null,
    'the page must not be installed while its annotations are still coming');
  releaseInk();
  await rendering;
  assert.ok(shown, 'and it is installed once they have');
}

{
  // But a page turn may not be held hostage by the annotation store. If the
  // ink never resolves the page still appears, after a bounded wait.
  const stuck = cachePane();
  await stuck._render();
  stuck.state = { ...stuck.state, pageNumber: 2 };
  let shown = false;
  stuck._showCanvas = function () { shown = true; };
  const t0 = Date.now();
  await stuck._render(new Promise(() => {}));    // never resolves
  const waited = Date.now() - t0;
  assert.ok(shown, 'the page turns even when the ink store never answers');
  assert.ok(waited >= 350 && waited < 1500,
    `and it waits a bounded time first, waited ${waited}ms`);
}

{
  // A rejected ink swap must not take the page down with it.
  const failed = cachePane();
  await failed._render();
  failed.state = { ...failed.state, pageNumber: 2 };
  let shown = false;
  failed._showCanvas = function () { shown = true; };
  await failed._render(Promise.reject(new Error('ink store is on fire')));
  assert.ok(shown, 'a failed ink read still lets the page through');
}

delete globalThis.document;
console.log('PASS: large PDF opening, outline deferral, cancellation and page caching are regression-tested');
