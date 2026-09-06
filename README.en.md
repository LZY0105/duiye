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

The upstream project is licensed under the **GNU AGPL-3.0**. This repository therefore uses the same license and retains the original license and copyright notices.

### 2. Answer matching engine

The engine used for side-by-side question and answer matching comes from a separate repository:

> **https://github.com/LZY0105/Math-answer-to-question-matching-model**

**This application uses that engine.** The 21 modules under `src/pdf/` come directly from its `main` branch, and the engine's regression tests have also been incorporated into `test/`.

The engine solves this problem: when two PDFs share no identifier other than their printed content, determine which entry in the answer key belongs to each exercise, or refuse to answer. It evaluates the least expensive signals first: hierarchical question numbers from bookmarks, table-of-contents alignment, math-weighted similarity, and bounded sequence alignment. It will not return an automatic answer until the two books have been verified as a matching pair.

The engine is released under the **MIT License** (© 2026 LZY0105), which is compatible with this repository's AGPL-3.0 license.

---

## What this version keeps and removes

The upstream project is an OCR application. This version narrows it to a **handwriting-first study tool**. Recognition, the formula editor, model management, AI providers, and recognition history have been removed. Only the textbook workflow and the settings it requires remain.

The removed features and their code are preserved in local branches and can be restored later if needed:

| Branch | Contents |
|---|---|
| `feature/with-ocr-preserved` | Complete version before simplification, including OCR, the editor, models, and AI providers |
| `feature/ocr-and-editor-preserved` | Earlier complete version |

Supporting files for the recognition stack were removed as well: the model packaging script `scripts/package-models.js` and its `package-models.yml` workflow, the ONNX quantization script `scripts/quantize.py`, seven Python model tests and their shared `test_utils.py`, and the `test/run_tests.sh` runner. All came from upstream, but after recognition was removed, none of their targets remained. The packaging script expected a `public/models/` directory that does not exist, the quantization script contained an absolute path from another machine, and `run_tests.sh` named 22 test files, eight of which were already absent before this cleanup. The sole test entry point is now `npm test`.

**Removing OCR does not affect question matching.** The matching engine reads question numbers from PDF bookmark trees and falls back to text similarity only when those identifiers do not line up. Across four real graduate mathematics textbooks, it parsed **508/508 questions with zero errors and 100% precision at HIGH confidence**, without using a recognizer at any stage.

The only affected case is a pure scanned document with neither bookmarks nor a readable text layer. Such a document explicitly reports that OCR is required before matching instead of making a guess.

---

## Core features

- **Dual-document workspace**: open an exercise book and answer key side by side. Swap the left and right documents with one action while preserving each document's width and annotations.
- **Split view**: drag the central capsule handle, marked with φ, to resize the panels. The rest of the divider does not capture the gesture because the line continues through the workspace and the bottom bar uses a downward swipe along the same path to collapse. The split follows the pointer continuously and has no snapping at either end. Push it to the edge to close one side. Both pages render at their final scale throughout the drag, so releasing the divider does not cause a jump. Double-clicking returns the workspace to a 50:50 split with the same frame-by-frame behavior.
- **Handwritten annotations**: pen, pencil, marker, highlighter, and eraser tools with adjustable pressure, color, width, and opacity. Annotations are stored per page in a separate layer and never modify the original PDF.
- **Lasso editing**: select annotations and move, scale, or rotate them as a group. Rotation and scaling share the selection center and can happen in one gesture. The entire gesture occupies a single undo step.
- **Four-corner toolbar docking**: drag the floating toolbar to any edge. Near a corner, its collapsed circular token grows as a docking cue; release to snap into that corner and expand. Each corner is an independent target instead of a rounded result from the nearest edge.
- **Automatic question matching**: list question numbers and their corresponding answer locations for the current page, with a reliability label. If the books have not been verified as a pair, the application says "please verify" and never presents a tentative match as certain.
- **Annotation saving**: annotations save automatically after 400 ms. The toolbar also provides an explicit Save button, enabled only while changes remain unwritten. A disabled button therefore means the current work is already saved.
- **Handwriting-first input**: the stylus writes; fingers and the mouse pan or change pages. A one-finger gesture is interpreted by the page itself. When zoom makes the page larger than its panel, the gesture pans; when the page already fits, it turns the page. Direction is chosen once at the start of the gesture and never changes midway. Reaching an edge does not turn the page until the next swipe.
- **Collapsible toolbars**: swipe the top import bar upward or the bottom capsule downward to hide it. Swipe inward from the corresponding screen edge to bring it back. The two bars operate independently. A redundant corner arrow that performed the same action has been removed because it was the only control unrelated to reading and occupied the page space it was meant to free.
- **Liquid Glass material**: glass is limited to navigation surfaces so content remains clear. Two skins are available: **Duiye · Liquid Glass** and **Minimal Fiber White**. The tool settings card is an exception. It floats over the document, but `backdrop-filter` evaluates to `none` in the tested WebView even though `CSS.supports` reports support. A translucent card would therefore pass formulas and ruling lines through unchanged. Since a reading surface cannot depend on an unsupported blur, this card is opaque.
- **Tablet tuning**: the application page itself cannot zoom, so pinch gestures belong only to the PDF panels and two zoom levels never compete. Resting a palm on the screen does not select text or open a long-press menu. Dragging past a boundary does not move the entire application.
- **Press feedback**: capsule controls compress on press and settle after release using a sampled physical spring (`response` 0.34 s, damping ratio 0.52, expressed as CSS `linear()`).
- **No interruptions**: automatic update checks are **off by default**. The old behavior ran after every launch and could cover anything on screen with a full-page changelog, including the "What is this file?" prompt shown immediately after import. Users can still enable automatic checks in Settings or select Check for updates to run one manually.
- **Accessibility**: supports reduced transparency, increased contrast, and reduced motion. All motion described above becomes displacement-free when Reduced Motion is enabled.

## Technology stack

| Layer | Technology |
|---|---|
| Web UI | Vite 8, Rollup 4, Capacitor 8 |
| PDF | pdfjs-dist, vendored locally |
| Annotations | Custom vector ink layer (`src/ink/`) with IndexedDB persistence |
| Matching | The engine described above; pure JavaScript with no dependencies |
| Local storage | IndexedDB |
| Offline support | Service Worker (`public/sw.js`) |

The precache includes only the nine files requested by name from `index.html` at startup, plus the worker that pdf.js starts as soon as a document opens. Two categories are intentionally excluded. First, Vite application bundles contain content hashes and change with every build, so they cannot be listed statically. Their requests use a network-first strategy and update the cache, which is appropriate because a stale application bundle is worse than a slow one. Second, the 168 character maps, standard PDF fonts, and 245 KaTeX/MathLive glyph files are loaded only when a document needs them. Precaching those files would spend the first launch downloading resources that most users never open.

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

This project follows the upstream **GNU AGPL-3.0** license. See [LICENSE](LICENSE).

This repository is a derivative work of https://github.com/strangelion/LaTeXSnipper_mobile. It retains the original license and copyright notices and publishes the complete source code as required by the AGPL.

The answer matching engine comes from https://github.com/LZY0105/Math-answer-to-question-matching-model and is released under the MIT License. Its copyright and license notices remain in the corresponding source files.
