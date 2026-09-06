// 平台层模块的行为测试：日志、多语言、下拉选择器、文件保存。
//
// 这四个模块从上游继承而来、被整体重写过，而在此之前它们一行测试也没有——上一版
// 里每写一条日志就会记两遍、下拉列表在语言切换后停在旧文字上，都是没人发现的。
// 这里用 JSDOM 跑真实的 DOM 交互，不看源码形状，只看行为。
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/', pretendToBeVisual: true });
for (const k of ['window', 'document', 'navigator', 'Node', 'Event', 'CustomEvent',
                 'HTMLElement', 'localStorage', 'matchMedia', 'requestAnimationFrame',
                 'cancelAnimationFrame', 'getComputedStyle', 'Blob', 'URL']) {
  if (dom.window[k] === undefined) continue;
  try { globalThis[k] = dom.window[k]; }
  catch (_) { Object.defineProperty(globalThis, k, { value: dom.window[k], configurable: true }); }
}
globalThis.window = dom.window;
globalThis.document = dom.window.document;

let PASS = 0, FAIL = 0;
const check = async (label, fn) => {
  try { await fn(); PASS++; console.log('  OK   ' + label); }
  catch (e) { FAIL++; console.log('  FAIL ' + label + ': ' + e.message); }
};

// ── logger ──────────────────────────────────────────────────────────────────
const { default: Logger } = await import('../src/core/logger.js');

await check('logger records one line per call, not two', () => {
  Logger.clear();
  Logger.info('T', 'hello');
  const lines = Logger.getLastLines(10);
  assert.equal(lines.length, 1, `got ${lines.length}: ${JSON.stringify(lines)}`);
  assert.match(lines[0], /\[INFO\]\[T\] hello/);
});

await check('a third-party console call is still captured', () => {
  Logger.clear();
  console.warn('[PDFJS] something');
  const lines = Logger.getLastLines(10);
  assert.equal(lines.length, 1);
  assert.match(lines[0], /\[WARN\]\[PDFJS\]/);
});

await check('error attaches the exception and its stack', () => {
  Logger.clear();
  Logger.error('T', 'broke', new Error('boom'));
  const line = Logger.getLastLines(1)[0];
  assert.match(line, /broke \| boom/);
});

await check('the buffer survives via localStorage', () => {
  Logger.clear();
  Logger.info('T', 'persisted');
  assert.ok(Logger.getLastLines(1)[0].includes('persisted'));
});

await check('logSystemInfo writes a block and clear empties it', () => {
  Logger.clear();
  Logger.logSystemInfo();
  assert.ok(Logger.getLastLines(50).length > 5);
  Logger.clear();
  assert.equal(Logger.getLastLines(50).length, 0);
});

// ── i18n ────────────────────────────────────────────────────────────────────
const i18n = await import('../src/core/i18n.js');

await check('initI18n loads a dictionary and t() resolves', async () => {
  const lang = await i18n.initI18n();
  assert.ok(lang, 'a language was chosen');
  assert.notEqual(i18n.t('pdf.library'), 'pdf.library', 't() found a real string');
});

await check('a missing key comes back as the key itself', () => {
  assert.equal(i18n.t('no.such.key.at.all'), 'no.such.key.at.all');
});

await check('placeholders are substituted', () => {
  const s = i18n.t('update.available', { version: '9.9.9' });
  assert.ok(s.includes('9.9.9'), s);
});

await check('translateDOM fills text, placeholder, title and aria-label', () => {
  document.body.innerHTML = `
    <button data-i18n="pdf.library"><svg></svg> old</button>
    <input data-i18n-placeholder="pdf.library">
    <span data-i18n-title="pdf.library"></span>`;
  i18n.translateDOM();
  const btn = document.querySelector('button');
  assert.ok(btn.querySelector('svg'), 'the icon survived');
  assert.notEqual(btn.textContent.trim(), 'old');
  assert.ok(document.querySelector('input').placeholder.length > 0);
  const span = document.querySelector('span');
  assert.ok(span.title.length > 0 && span.getAttribute('aria-label') === span.title);
});

await check('switching language changes what t() returns', async () => {
  const from = i18n.currentLang();
  const before = i18n.t('update.later');
  const to = from === 'zh-CN' ? 'en' : 'zh-CN';
  await i18n.setLang(to);
  assert.equal(i18n.currentLang(), to);
  assert.notEqual(i18n.t('update.later'), before, from + ' -> ' + to + ' changed the text');
});

// ── custom-select ───────────────────────────────────────────────────────────
const sel = await import('../src/ui/custom-select.js');

await check('a hidden <select> gains a button and a listbox', () => {
  document.body.innerHTML = `
    <div class="set-select-wrap">
      <select class="set-select"><option value="a">A</option><option value="b">B</option></select>
    </div>`;
  sel.initCustomSelects();
  const btn = document.querySelector('.set-select-btn');
  assert.ok(btn, 'button built');
  assert.equal(btn.getAttribute('aria-haspopup'), 'listbox');
  assert.equal(document.querySelectorAll('.set-option').length, 2);
  assert.equal(btn.textContent, 'A');
});

await check('opening actually shows the list, by the class the stylesheet reads', () => {
  // 样式表里 .set-select-dropdown 本身是 display:none，只有 .show 才显示；
  // 另有一条 .set-group:has(.set-select-dropdown.show) 负责把它抬到上层。
  // 改写时用了 hidden 属性代替这个类，于是按钮拿到了焦点、菜单却一次也没出现。
  // 这条断言盯的就是那份契约。
  const btn = document.querySelector('.set-select-btn');
  const list = document.querySelector('.set-select-dropdown');
  assert.ok(!list.classList.contains('show'), 'closed to begin with');
  btn.dispatchEvent(new dom.window.Event('pointerdown', { bubbles: true, cancelable: true }));
  assert.ok(list.classList.contains('show'), 'opening adds the class the CSS needs');
  assert.equal(list.hidden, false);
  btn.dispatchEvent(new dom.window.Event('pointerdown', { bubbles: true, cancelable: true }));
  assert.ok(!list.classList.contains('show'), 'and closing takes it away again');
});

await check('initialising twice does not build a second control', () => {
  sel.initCustomSelects();
  assert.equal(document.querySelectorAll('.set-select-btn').length, 1);
});

await check('choosing an option writes through to the real select', () => {
  const select = document.querySelector('.set-select');
  let changes = 0;
  select.addEventListener('change', () => changes++);
  const btn = document.querySelector('.set-select-btn');
  btn.dispatchEvent(new dom.window.Event('pointerdown', { bubbles: true, cancelable: true }));
  const second = document.querySelectorAll('.set-option')[1];
  second.dispatchEvent(new dom.window.Event('pointerdown', { bubbles: true, cancelable: true }));
  assert.equal(select.value, 'b');
  assert.equal(changes, 1, 'exactly one change event');
  assert.equal(document.querySelector('.set-select-btn').textContent, 'B');
});

await check('relabelled options are picked up, not cached from init', () => {
  const select = document.querySelector('.set-select');
  select.options[1].textContent = 'B — 改过了';
  sel.syncCustomSelects();
  assert.equal(document.querySelector('.set-select-btn').textContent, 'B — 改过了');
});

// ── save-file ───────────────────────────────────────────────────────────────
const save = await import('../src/export/save-file.js');

await check('showSaveToast puts one status node on the page', () => {
  document.body.innerHTML = '';
  save.showSaveToast('已保存');
  const el = document.querySelector('.save-toast');
  assert.ok(el && el.textContent === '已保存');
  assert.equal(el.getAttribute('role'), 'status');
  save.showSaveToast('再一次');
  assert.equal(document.querySelectorAll('.save-toast').length, 1, 'never two at once');
});

console.log(`\n  ${PASS} passed, ${FAIL} failed`);
process.exit(FAIL ? 1 : 0);
