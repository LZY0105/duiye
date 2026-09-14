<img src="public/icon.svg" width="88" height="88" alt="Duiye">

# Duiye (对页)

[简体中文](README.md) | [English](README.en.md)

**Handwritten textbook annotation and question-answer matching** - an Android tablet app for working through exercises by hand. Open an exercise book and its answer key side by side, write directly on either PDF with a stylus, and automatically locate the answer that corresponds to the current question.

All processing happens on the device. No documents are uploaded.

## About the name and icon

The Chinese name combines two meanings of 对: **checking an answer** and **two facing pages**. That is exactly what the product does. Questions appear on the left, answers on the right, and the engine determines which answer belongs to each question.

The icon expresses the same idea geometrically. Two pages sit side by side; a notch in the left page fits the matching tab on the right, and the two shapes meet along the center line. The notch and tab use the same radius and share a center at x=256, so the idea of two matching pages remains legible even at 24 px. The center line also represents the divider that users drag in the application.

---

## Provenance

This repository combines two independent upstream projects. Both sources are listed below for verification and traceability.

### 1. Application base

The application is based on **LaTeXSnipper Mobile**:

> **https://github.com/strangelion/LaTeXSnipper_mobile**

The upstream project is a local OCR and formula-editing application. It provided the Capacitor/Android shell, PDF rendering, settings, internationalization, and other basic capabilities. This repository is a **derivative work** of that project.

This repository began as a fork of that project, which is licensed under the **GNU AGPL-3.0**. Its core has since been rewritten in full — none of the upstream code remains — and the licence changed to **MIT** along with it. The cut-over point and the reasoning are in [docs/许可证变更.md](docs/许可证变更.md).

### 2. Answer matching engine

The engine used for side-by-side question and answer matching comes from a separate repository:

> **https://github.com/LZY0105/Math-answer-to-question-matching-model**

**This application uses that engine.** The 21 modules under `src/pdf/` come directly from its `main` branch, and the engine's regression tests have also been incorporated into `test/`.

The engine solves this problem: when two PDFs share no identifier other than their printed content, determine which entry in the answer key belongs to each exercise, or refuse to answer. It evaluates the least expensive signals first: hierarchical question numbers from bookmarks, table-of-contents alignment, math-weighted similarity, and bounded sequence alignment. It will not return an automatic answer until the two books have been verified as a matching pair.

The engine is released under the **MIT License** (© 2026 LZY0105), the same as this repository.

---

## What this version keeps and removes

The upstream project is an OCR application. This version narrows it to a **handwriting-first study tool**. Recognition, the formula editor, model management, AI providers, and recognition history have been removed. Only the textbook workflow and the settings it requires remain.

The removed features and their code are preserved in local branches and can be restored later if needed:

| Branch | Contents |
|---|---|
| `feature/with-ocr-preserved` | Complete version before simplification, including OCR, the editor, models, and AI providers |
| `feature/ocr-and-editor-preserved` | Earlier complete version |

Supporting files for the recognition stack were removed as well: the model packaging script `scripts/package-models.js` and its `package-models.yml` workflow, the ONNX quantization script `scripts/quantize.py`, seven Python model tests and their shared `test_utils.py`, and the `test/run_tests.sh` runner. All came from upstream, but after recognition was removed, none of their targets remained. The packaging script expected a `public/models/` directory that does not exist, the quantization script contained an absolute path from another machine, and `run_tests.sh` named 22 test files, eight of which were already absent before this cleanup. The sole test entry point is now `npm test`.

The upstream code is being replaced piece by piece as well. Of roughly 37,000 hand-written lines, about 16% is still upstream's: `src/core/logger.js`, `i18n.js`, `update-checker.js`, the dropdown control and the background animation have been rewritten, while `status.js`, `splash.js` and `constants.js` were deleted outright because nothing imported them. The point is not to escape the licence — derivative status follows from origin, not from how many lines survive — but that reading them line by line turned up genuine faults: `exportAsZip` called a JSZip that was never loaded, "check for updates" queried the *upstream* repository's releases, and the dropdown copied its option labels once at startup, so the list froze in the old language after a switch.

**Removing OCR does not affect question matching.** The matching engine reads question numbers from PDF bookmark trees and falls back to text similarity only when those identifiers do not line up. Across four real graduate mathematics textbooks, it parsed **508/508 questions with zero errors and 100% precision at HIGH confidence**, without using a recognizer at any stage.

The only affected case is a pure scanned document with neither bookmarks nor a readable text layer. Such a document explicitly reports that OCR is required before matching instead of making a guess.

---

## Core features

- **Dual-document workspace**: open an exercise book and answer key side by side. Swap the left and right documents with one action while preserving each document's width and annotations.
- **Split view**: drag the central capsule handle, marked with φ, to resize the panels. The rest of the divider does not capture the gesture because the line continues through the workspace and the bottom bar uses a downward swipe along the same path to collapse. The split follows the pointer continuously and has no snapping at either end. Push it to the edge to close one side. Both pages render at their final scale throughout the drag, so releasing the divider does not cause a jump. Double-clicking returns the workspace to a 50:50 split with the same frame-by-frame behavior.
- **Zoom does not stutter**: PDF rasterisation runs on its **own thread** (`pdf-render-worker.js` with OffscreenCanvas), and the worker keeps the last few page objects alive instead of releasing them after each draw. The first stops rasterisation from occupying the main thread; the second stops a zoom change from re-decoding the same page's image. Measured on the tablet, one page rendered at six zoom levels: previously 488–544 ms each with a worst frame gap of 97 ms; now 602 ms once and 1–3 ms after, worst frame gap 10 ms. The bitmap reaches the screen through `bitmaprenderer`, a zero-copy handover that costs 0.1 ms at 1961×2772.
  pdf.js does not officially support rendering in a worker, but it touches `document` in exactly two places — `baseURI` when deciding `useWorkerFetch`, and `fonts` for the font loader — and a worker can supply both for real (`self.fonts` is a genuine `FontFaceSet`). The stub provides those two fields and nothing else, so a future pdf.js that reaches for anything more throws instead of misbehaving, and the client falls back to the main thread: same features, slower, with one line in the log.
- **Handwritten annotations**: pen, pencil, marker, highlighter, and eraser tools with adjustable pressure, color, width, and opacity. Annotations are stored per page in a separate layer and never modify the original PDF.
- **The pencil draws graphite**: graphite is powder scraped onto the tooth of the paper — the raised parts take it, the hollows are never touched — so a pencil line is not an even band but a dense field of grain. Modulating stroke width cannot produce that; width changes the outline, and the character lives inside it. Instead a fixed-seed noise tile is used as an eraser, punching holes out of a filled stroke; the holes are the paper the graphite missed. The tile is generated once (otherwise the grain reshuffles on every repaint and the handwriting crawls as you pan) and scales with the page rather than the screen, because the grain belongs to the paper.
- **Notebooks**: blank, paginated books to write in — the same submenu that creates a scratchpad creates these, as its second mode, and both share one set of paper styles (eight rulings, four paper tones). They differ in exactly one way, and that one decides everything else: a scratchpad is a single sheet with no edges, a notebook is a **stack of bounded pages** turned one at a time like a textbook. Page count is chosen at creation; pages are appended from the toolbar (append only — inserting in the middle would shift every later page number, and ink is filed by page number).
  A notebook is not "a scratchpad that turns pages"; it is **a document**. `note-document.js` answers the same questions a PDF does — how many pages, how big is page N, what does it look like, what text is on it — so paging, zoom, fit-to-width, bitmap caching, prefetch, ink alignment, thumbnails, bookmarks, covers and session restore all work on it without a line of change. Pages are drawn on demand rather than stored: a thousand-page empty notebook is a few dozen bytes in the library.
- **Lasso editing**: select annotations and move, scale, or rotate them as a group. Rotation and scaling share the selection center and can happen in one gesture. The entire gesture occupies a single undo step.
- **Four-corner toolbar docking**: drag the floating toolbar to any edge. Near a corner, its collapsed circular token grows as a docking cue; release to snap into that corner and expand. Each corner is an independent target instead of a rounded result from the nearest edge.
- **Importing lists every PDF on the device**: the Import button opens a small menu (exercises /
  answers), and choosing one opens the app's own sheet rather than the system picker — **every PDF
  on the device in one list**, newest first, searchable by name. The problem with the system picker
  is not that it looks foreign; it is that it makes you walk a folder tree, while what you remember
  is "that Xie Huimin book", not which folder it is in.
  "Only PDFs are visible" holds structurally here rather than as a filter that can be bypassed: the
  source itself contains nothing else, because MediaStore is queried by MIME type rather than by
  filename extension — a PDF without a `.pdf` suffix is still a PDF. Dot-prefixed folders are
  skipped; they hold file-manager cache copies and unzip leftovers, and without that the same book
  appears twice under two names.
  **This needs all-files access.** Since Android 11 a PDF is not a media file as far as MediaStore
  is concerned, so without that permission an app sees only the files it created itself. There is no
  in-app dialog for it — the app can only open system settings — so when the permission is missing
  the sheet explains why it is needed and where to grant it instead of saying "failed". The app side
  is read-only: the plugin exposes no method that deletes or modifies a file.
- **Automatic question matching**: list question numbers and their corresponding answer locations for the current page, with a reliability label. If the books have not been verified as a pair, the application says "please verify" and never presents a tentative match as certain.
- **Annotation saving**: annotations save automatically after 400 ms. The toolbar also provides an explicit Save button, enabled only while changes remain unwritten. A disabled button therefore means the current work is already saved.
- **Handwriting-first input**: the stylus writes; fingers and the mouse pan or change pages. A one-finger gesture is interpreted by the page itself. When zoom makes the page larger than its panel, the gesture pans; when the page already fits, it turns the page. Direction is chosen once at the start of the gesture and never changes midway. Reaching an edge does not turn the page until the next swipe.
- **Collapsible toolbars**: swipe the top import bar upward or the bottom capsule downward to hide it. Swipe inward from the corresponding screen edge to bring it back. The two bars operate independently. A redundant corner arrow that performed the same action has been removed because it was the only control unrelated to reading and occupied the page space it was meant to free.
- **Two skins, two materials**: **Duiye · Liquid Glass** and **Duiye · Paper**. The second is not the first with its lights switched off; it is a different material. Glass separates layers by transmittance and refraction, paper separates them by value and edge — the ground sits one step darker than the sheet so a white page has something to lie on, the edge is low-alpha ink rather than grey (everything else on that screen is ink, and a neutral grey hairline reads as a printed rule), and shadows are given only to things that genuinely float. Both skins define exactly the same 44 tokens: any token one of them fails to define silently inherits the other's value.
- **Legibility cannot depend on a blur**: this rule was forced out by a misdiagnosis. `backdrop-filter` computed to `none` on the device while `CSS.supports` reported support, and that was recorded as a WebView defect. The real cause was the CSS minifier: every glass rule in the stylesheets hand-wrote a `-webkit-` prefix, lightningcss treats the two spellings as one property and de-duplicates them keeping the last one written, so the build shipped only the prefixed form — and this WebView honours only the unprefixed one. Removing the hand-written prefixes and letting the minifier emit both took the page from 0 to 25 working glass surfaces.
  The conclusion outlived the diagnosis, though: the full-width top and bottom bars are **deliberately** not frosted, because what sits behind them is the text being read. Surfaces that float over their own panel (the page bar, the slot toolbar, the zoom badge) keep the glass.
- **Tablet tuning**: the application page itself cannot zoom, so pinch gestures belong only to the PDF panels and two zoom levels never compete. Resting a palm on the screen does not select text or open a long-press menu. Dragging past a boundary does not move the entire application.
- **Press feedback**: capsule controls compress on press and settle after release using a sampled physical spring (`response` 0.34 s, damping ratio 0.52, expressed as CSS `linear()`).
- **No interruptions**: automatic update checks are **off by default**. The old behavior ran after every launch and could cover anything on screen with a full-page changelog, including the "What is this file?" prompt shown immediately after import. Users can still enable automatic checks in Settings or select Check for updates to run one manually.
- **Interface languages**: Simplified Chinese, Traditional Chinese and English, through a small flat dictionary (`src/core/i18n.js`). Japanese and Korean were withdrawn; the i18n layer itself is unchanged, so putting the dictionaries back under `src/core/lang/` and adding a line to `LANGUAGES` restores them. Coverage today is the settings screen and the floating ink toolbar. The rest of the reading screen has its entries written — 324 keys in each of the three files — but is not yet wired, so that text is still hard-coded Chinese for the moment. One category will never be translated: six files under `src/pdf/` hold Chinese inside regular expressions (`例题|习题|第X题`, `答案|解答|证明`, `目录|索引`). Those are the patterns the engine uses to parse Chinese textbooks, not text shown to anyone; translating them would break question detection outright.
- **Accessibility**: supports reduced transparency, increased contrast, and reduced motion. All motion described above becomes displacement-free when Reduced Motion is enabled.

## Technology stack

| Layer | Technology |
|---|---|
| Web UI | Vite 8, Rollup 4, Capacitor 8 |
| PDF | pdfjs-dist, vendored locally; rendering and text extraction run in a worker (`src/pdf/pdf-render-worker.js`), the main thread only does the zero-copy handover |
| Annotations | Custom vector ink layer (`src/ink/`) with IndexedDB persistence |
| Notebooks | `src/note/` — a synthetic document whose pages are drawn on demand from the scratchpad paper styles (`note-document.js`), read through the PDF reader |
| Matching | The engine described above; pure JavaScript with no dependencies |
| Device files | `android/…/files/PdfFilesPlugin.java` — a MediaStore query listing every PDF on the device; the web side is `src/pdf/pdf-files.js` and `pdf-picker.js` |
| Local storage | IndexedDB (PDF bytes, ink, scratchpads, notebooks) plus localStorage (session, reading position, book pairings) |
| Offline support | Service Worker (`public/sw.js`) |

The precache holds six entries: the index page, the manifest, the icon, pdf.js and its worker, and the KaTeX stylesheet. Two categories are intentionally excluded. First, Vite application bundles contain content hashes and change with every build, so they cannot be listed statically. Their requests use a network-first strategy and update the cache, which is appropriate because a stale application bundle is worse than a slow one. Second, the 168 character maps, 16 standard PDF fonts and 20 KaTeX glyph files — 204 in all — are loaded only when a document needs them. Precaching those would spend the first launch downloading resources that most users never open.

That list caused a real failure once: it had 17 entries, 13 of which named files deleted along with the recognition stack. Each entry was cached with its own `catch`, so nothing errored — every install simply logged thirteen warnings and cached four files, and nobody reads install logs. `test_ui_interactions.js` now watches it: every entry must exist in the source tree.

Files under `/vendor/` use cache-first delivery. They are third-party builds pinned in the repository and do not change within an application release, so the cached copy is always the correct one.

## Development and testing

```bash
npm install
npm run dev
npm run build
npm test
```

The real textbook corpus under `corpus/` contains copyrighted material and is **not distributed with the repository**. Tests that need it are skipped automatically when the corpus is absent, and `npm test` still passes. To run the full regression suite, place the corpus at `corpus/data.json` or point `FIND_ENGINE_CORPUS` to it.

Android builds require JDK 21 and Android SDK 36. A fresh clone builds directly without submodules or manually installed binary dependencies:

```bash
npm run build:android
cd android && ./gradlew assembleDebug
```

The Gradle project previously referenced two dependencies that were missing from the repository: the `llama.cpp` submodule and `onnxruntime-genai-android-0.6.0.aar`. This prevented a fresh clone of the old version from building. Both belonged to the removed recognition (OCR) stack and were unused by the web application. They have now been removed together with the Java implementation under `app/ocr`.

## License

This project is released under the **MIT License**. See [LICENSE](LICENSE).

It began as a fork of https://github.com/strangelion/LaTeXSnipper_mobile and inherited that
project’s AGPL-3.0. After the core was rewritten the licence changed to MIT —
**every revision before the cut-over remains under AGPL-3.0**, whose text is kept in
[LICENSE.AGPL-3.0](LICENSE.AGPL-3.0). History was not rewritten. Where the cut-over
is, what it rests on, and what did not change with it: [docs/许可证变更.md](docs/许可证变更.md).

How far the upstream cleanup got, what is left and why it stops there:
[docs/上游代码清理.md](docs/上游代码清理.md). The figure is not copied into the docs —
`npm run check:upstream` computes it.

The answer matching engine comes from https://github.com/LZY0105/Math-answer-to-question-matching-model
and is released under the MIT License too. Its copyright and license notices remain in
the corresponding source files.

The Agent panel and its local proxy were written by [@allnothing571](https://github.com/allnothing571),
who holds the copyright to them.
