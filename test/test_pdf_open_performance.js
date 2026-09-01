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
assert.equal(outlineButton.disabled, true,
  'outline navigation stays disabled until the replacement outline is ready');
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

delete globalThis.document;
console.log('PASS: large PDF opening, outline deferral, and cancellation are regression-tested');
