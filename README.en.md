<img src="public/icon.svg" width="88" height="88" alt="Duiye">

# Duiye (对页)

[简体中文](README.md) | [English](README.en.md)

**Handwritten textbook annotation and question-answer matching** - an Android tablet app for working through exercises by hand. Open an exercise book and its answer key side by side, write directly on either PDF with a stylus, and automatically locate the answer that corresponds to the current question.

All processing happens on the device. No documents are uploaded.

## About the name and icon

The Chinese name combines two meanings of 对: **checking an answer** and **two facing pages**. That is exactly what the product does. Questions appear on the left, answers on the right, and the engine determines which answer belongs to each question.

The icon expresses the same idea geometrically. Two pages sit side by side; a notch in the left page fits the matching tab on the right, and the two shapes meet along the center line. The notch and tab use the same radius and share a center at x=256, so the idea of two matching pages remains legible even at 24 px. The center line also represents the divider that users drag in the application. There is no pencil, formula or mortarboard in the icon — those describe a subject, not a tool.

---

## Provenance

This repository combines two independent upstream projects. Both sources are listed below for verification and traceability.

### 1. Application base

The application is based on **LaTeXSnipper Mobile**:

> **https://github.com/strangelion/LaTeXSnipper_mobile**

The upstream project is a local OCR and formula-editing application. It provided the Capacitor/Android shell, PDF rendering, settings, internationalization, and other basic capabilities. This repository started as a fork of it.

Its core has since been rewritten in full — the upstream code is no longer in it — and the licence changed from AGPL-3.0 to **MIT** along with it. The cut-over point, the criteria, and the attribution that is still kept are recorded in [docs/许可证变更.md](docs/许可证变更.md).

### 2. Answer matching engine

The engine used for side-by-side question and answer matching comes from a separate repository:

> **https://github.com/LZY0105/Math-answer-to-question-matching-model**

**This application uses that engine.** The 21 modules under `src/pdf/` come directly from that repository and track its `main` branch, and the engine's regression tests have also been incorporated into `test/`.

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

The code left over from upstream is being replaced too. Of roughly 55,000 hand-written lines in the project, about **700 lines, 1.3%**, are still upstream's text verbatim — not counting `LICENSE`, nor what comes out the same whoever generates it: the Gradle wrapper, the Capacitor template, `package-lock.json`. The figure is not maintained by hand; `npm run check:upstream` computes it. `src/core/logger.js`, `i18n.js`, `update-checker.js`, the dropdown control and the background animation have been rewritten; `status.js`, `splash.js` and `constants.js` were deleted outright because nothing called them; and the iOS build setup (two scripts and two `ExportOptions.plist` files) was removed wholesale because it never actually ran in this project.

The rewriting was not started to get out of the licence, but because reading the files one by one showed that several of them were simply broken (by the end, upstream's expression really had gone to zero, and the licence changed to MIT along with it — see [docs/许可证变更.md](docs/许可证变更.md)): `exportAsZip` called a JSZip that was never loaded, "check for updates" queried the *upstream* repository's releases, the dropdown copied its option labels once at startup and stayed in the old language after a switch, and a CI step used `sed` to overwrite the computed `versionCode` with a value two orders of magnitude smaller, so packages built by CI would not install over one installed locally.

**Removing OCR does not affect question matching.** The matching engine reads question numbers from PDF bookmark trees and falls back to text similarity only when those identifiers do not line up. Across four real graduate mathematics textbooks, it parsed **508/508 questions with zero errors and 100% precision at HIGH confidence**, without using a recognizer at any stage.

The only affected case is a pure scanned document with neither bookmarks nor a readable text layer. Such a document explicitly reports that OCR is required before matching instead of making a guess.

---

## Core features

- **A queue in each pane**: a pane no longer holds just one file. A newly opened file or scratchpad goes in front of the current item, and the one it displaces moves one layer down — not closed, and back whenever you want it. On the switcher row, swipe up for the next item and down for the previous one; tap the title to open the pane's list and pick directly, without reordering. Each pane cycles on its own.
- **The same book in both panes**: for an exercise book with the questions at the front and the answers at the back, no more paging back and forth. Each pane keeps its own page and zoom, but the ink is one and the same — write or erase on either side and the other follows at once.
- **Infinite scratchpads**: no edge in any of the four directions, negative coordinates are ordinary coordinates, and zoom runs from 25% to 400%. A scratchpad fills its pane — no inset paper card, no drop shadow, no fixed aspect ratio — and a single scratchpad can enter focus mode to take the whole workspace. Eight rulings (blank / dots / squares / lines / coordinate grid / isometric / tián-zì grid / mǐ-zì grid), four paper tones, and adjustable spacing and guide strength. The style belongs to the scratchpad itself: it goes with it between panes and across restarts, and it never alters the ink.
- **Notebooks**: blank, paginated books to write in — the same submenu that creates a scratchpad creates these, as its second mode, and both share one set of paper styles (eight rulings, four paper tones). They differ in exactly one way, and that one decides everything else: a scratchpad is a single sheet with no edges, a notebook is a **stack of bounded pages** turned one at a time like a textbook. Page count is chosen at creation; pages are appended from the toolbar (append only — inserting in the middle would shift every later page number, and ink is filed by page number).
  A notebook is not "a scratchpad that turns pages"; it is **a document**. `note-document.js` answers the same questions a PDF does — how many pages, how big is page N, what does it look like, what text is on it — so paging, zoom, fit-to-width, bitmap caching, prefetch, ink alignment, thumbnails, bookmarks, covers and session restore all work on it without a line of change. Pages are drawn on demand rather than stored: a thousand-page empty notebook is a few dozen bytes in the library.
- **Move across panes**: any item can go anywhere in the other pane. The content organizer shows both panes side by side, and dragging a handle or choosing "Move to…" goes through one atomic commit — the two queues change together or not at all.
- **Importing lists every PDF on the device**: Import in the top bar opens a small menu (exercises /
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
  in-app dialog for it — the app can only open system settings — so **the app asks first and does
  nothing else until it has an answer**: pressing Import says which permission is needed, why, and
  that only system settings can grant it; the button really does open this app's own page, and on
  returning to the foreground the app checks again and goes straight into the sheet. The old order
  was backwards — open the sheet, then put a line of "permission needed" in the empty sheet, which
  is walking someone into an empty room before mentioning the door is locked, and an empty sheet
  reads more like "this device has no PDFs".
  "Pick one file the system way" stays on that dialog throughout. The permission sounds broad
  because it is, refusing it is a reasonable choice, and importing still works afterwards — that
  way out is what makes the rest of this defensible. The plugin exposes no method that deletes or
  modifies a file; the only thing it ever writes is an export, created as a new file under
  Documents/对页 (see Export as PDF below).
- **Bookshelf library**: books are recognised by their covers rather than looked up by filename, and opening one flies the book open into the pane it is going to. The first tile is always the user guide — there as soon as the app is installed, in the interface language.
- **Folders**: when the shelf fills up, sort it — ⋯ on a book → "Move to a folder…", and if there is no folder yet, make one right there in that sheet. An open folder shows only what is inside it, and the books outside are no longer on the shelf: the entire point of sorting is fewer things on the screen, and if everything is still there afterwards the button just looks broken. A folder is a slot, not a box — deleting one returns every book in it to the shelf, and an item is in at most one folder at a time. Importing while inside a folder puts the new file straight into it.
- **Combos (layouts)**: with questions on the left and answers on the right, tap Layouts → "Save this layout" in the top bar. A new tile appears in the library; tap it and both panes come back as they were, down to the page. To build one without laying it out first, use "Build a layout…": pick items for each side (the same book can go on both), drag them into order and tap "Save and open". That replaces what is open in the two panes, so a line right above the button says which books will be replaced, and their pages are remembered. Leaving a half-built combo asks first — it has not been saved anywhere yet.
- **Dual-document workspace**: an exercise book and its answer key side by side. The divider moves freely anywhere from 0:10 to 10:0, and dragging it all the way **collapses** that pane: its queue stays untouched and a restore button says how many items are left. Swap left and right in one action; each side keeps its width and annotations.
- **Split view**: the two panes are separated by a 10 px gap, and the margins around them and below the top bar are the same 10 px. No line is drawn in the gap — the gap itself is the separation, and the capsule handle in the middle, marked φ, says it can be dragged. Only the handle takes the drag (its hit area reaches 12 px beyond each side and 22 px above and below, along that short stretch only); the rest of the gap and the card edges still take writing. The split follows the pointer continuously and has no snapping at either end: make a side as narrow as you like, and push the divider to the edge of the workspace to close it. Both pages render at their final scale throughout the drag, so the two sides animate as one motion and releasing the divider does not cause a jump. Double-clicking returns the workspace to 50:50 with the same frame-by-frame behavior.
- **Zoom does not stutter**: PDF rasterisation runs on its **own thread** (`pdf-render-worker.js` with OffscreenCanvas), and the worker keeps the last few page objects alive instead of releasing them after each draw. The first stops rasterisation from occupying the main thread; the second stops a zoom change from re-decoding the same page's image. Measured on the tablet, one page rendered at six zoom levels: previously 488–544 ms each with a worst frame gap of 97 ms; now 602 ms once and 1–3 ms after, worst frame gap 10 ms. The bitmap reaches the screen through `bitmaprenderer`, a zero-copy handover that costs 0.1 ms at 1961×2772.
  pdf.js does not officially support rendering in a worker, but it touches `document` in exactly two places — `baseURI` when deciding `useWorkerFetch`, and `fonts` for the font loader — and a worker can supply both for real (`self.fonts` is a genuine `FontFaceSet`). The stub provides those two fields and nothing else, so a future pdf.js that reaches for anything more throws instead of misbehaving, and the client falls back to the main thread: same features, slower, with one line in the log.
- **Handwritten annotations**: pen, pencil, marker, highlighter, and eraser tools with adjustable pressure, color, width, and opacity. Annotations are stored per page in a separate layer and never modify the original PDF.
- **The pencil draws graphite**: graphite is powder scraped onto the tooth of the paper — the raised parts take it, the hollows are never touched — so a pencil line is not an even band but a dense field of grain. Modulating stroke width cannot produce that; width changes the outline, and the character lives inside it. Instead a fixed-seed noise tile is used as an eraser, punching holes out of a filled stroke; the holes are the paper the graphite missed. The tile is generated once (otherwise the grain reshuffles on every repaint and the handwriting crawls as you pan) and scales with the page rather than the screen, because the grain belongs to the paper.
- **Lasso editing**: select annotations and move, scale, or rotate them as a group. Rotation and scaling share the selection center and can happen in one gesture. The entire gesture occupies a single undo step. A small bar appears beside the outline: copy, cut, recolour, delete; what you cut can be pasted onto another page, into the other pane, or onto a scratchpad.
  A copy lands on the same sheet, and you can drag it straight into the other pane. Pointer capture keeps the events coming after the finger leaves this canvas, so the whole gesture belongs to the source side and the other pane is only asked at release. **The part that crosses the divider is drawn in the other pane as it crosses** — the test is whether the selection's bounds intersect that canvas, not where the finger is, because with a large selection its far half can be across while the finger is not, and that far half is exactly what you want to see. It lands at the size it had **on screen**: the two panes are rarely at the same zoom, and carrying document coordinates across would make it jump a size at the moment of release, undoing everything the slide across had built. Undo in the source pane means "as if it never moved": this side returns to where it was before the press, and the copy disappears from the other one — without that second half, one undo turns the content into two copies.
- **Where the toolbar rests**: hold the handle to drag the floating toolbar to the left, right or bottom edge, where it expands, or drop it into one of the two bottom corners to fold it into a small ball (near a corner the ball swells, as if pulled by a magnet). Drag it upward and the top bar catches it as it nears the top — which is why the two top corners no longer hold a ball — folding it into a ball as tall as the bar, resting exactly where you let go in one of the gaps beside the two tabs. Tap the ball and the whole toolbar lays itself into the bar, growing outward from the ball; it pushes Practice / Settings only once it touches them, and not a pixel more. The folded ball pushes too: at the end of the push, carry your finger past the middle of the tabs and the ball flips to the other side. Turn on Auto-hide in the ⋯ menu and it folds back into the ball as soon as the pen touches the page.
- **Scrub to pick**: a tap is still a tap. Hold a tool and slide along the toolbar: a drop of glass rises under your finger and magnifies the slot beneath it about 1.3×, and letting go picks whatever is under your finger; the colour row works the same way, and letting go more than 44 px outside the bar cancels. The drop lives on `body`, floating outside the toolbar — the toolbar has a `backdrop-filter` of its own, and a refracting element inside it would see only the toolbar's semi-transparent backing, so the bent icon and the original one would show up as two. In Liquid Glass the drop is a convex lens: the library's displacement map pushes the other way, which makes a concave lens that shrinks the icon under it and shoves it aside. Frosted Glass bends only a rim around the edge; Paper uses a round dab of fountain-pen ink that does not refract.
- **Automatic question matching**: list question numbers and their corresponding answer locations for the current page, with a reliability label. If the books have not been verified as a pair, the application says "please verify" and never presents a tentative match as certain. The answer key is found by **association**, not as "whichever book happens to be open on the other side": the association is bound to the exercise book, independent of left and right, and it still works with the answer key buried under a scratchpad — indexing is separate from what is on screen, and a lookup changes nothing either pane is showing.
- **Annotation saving**: annotations save automatically after 400 ms. The toolbar also provides an explicit Save button, enabled only while changes remain unwritten. A disabled button therefore means the current work is already saved.
- **Export as PDF**: "Export as PDF" in the ⋯ menu of a pane or of the shelf saves into Documents/对页, adding "(2)" when a name is taken. A book keeps every object of the original file, and pages with ink get a vector layer **drawn on top of** the original content — the text can still be selected and searched, and the ink stays sharp at any zoom. Ink positions are computed back through pdf.js's own viewport, so pages rotated by 90/180/270° or carrying a crop box line up. pdf-lib cannot modify an encrypted book, so those fall back to drawing each page as an image and assembling the images, and the export says the text is no longer selectable. A notebook exports as A4 pages together with its paper, blank pages included; a scratchpad becomes a single page sized to the extent of its ink.
  The whole job runs in a worker, so the interface does not freeze. Large files cross the bridge in chunks; the native side writes a hidden temporary file and renames it only once it is complete, so a failure halfway leaves nothing half-written behind. Writing needs "All files access" (the same permission the import sheet uses): without it the app asks first; turn it on in Settings, come back, and the export carries on; refuse it and only exporting is unavailable.
- **Handwriting-first input**: the stylus writes; fingers and the mouse pan or change pages. A one-finger gesture is interpreted by the page itself. When zoom makes the page larger than its panel, the gesture pans; when the page already fits, it turns the page. Direction is chosen once at the start of the gesture and never changes midway. Reaching an edge does not turn the page until the next swipe.
- **Page turns fold like paper**: turning forward holds the left edge still and turning back holds the right edge; the sheet folds over along a crease, with a blank back. The point being pulled always stays where the crease cannot cross the fixed edge (`constrainFold` in `page-fold.js`), so pulling a corner diagonally moves only that corner; and the sheet follows the finger only from the moment the gesture is recognised as a page turn, instead of jumping a quarter of the way over the instant it is picked up. On release it looks at the speed over the last 90 ms: a fast enough flick goes the way it was flicked (flick back and even a sheet that is mostly over returns), and otherwise it goes by how far the sheet has turned (32%). The rest is a critically damped spring that carries on from the finger's speed and still respects the fixed edge on every frame. A version that stood the page up and turned it in 3D around the spine had better frame times but felt stiff, and was removed.
- **The top bar**: on the left, things to put on the desk (Import, Library, Layouts, New paper); in the middle, the Practice / Settings tabs; on the right, Close all — which empties both panes in one go, remembering the page each item was on and leaving every file in the library. When space runs out (portrait, split screen) the labels go first and the icons stay, measured against the real width rather than guessed breakpoints. The bottom edge used to carry a capsule holding Practice / Settings; it is gone, along with the gesture that hid it and the handle that brought it back: **the whole bottom edge is paper**, and a pen writes wherever it lands.
- **Hiding the top bar**: push it upward to hide it; the two tabs go with it and the panes move up. Buttons and tabs can be pushed too: after 10 px the direction is decided — vertical means hiding (the tap that would follow is swallowed, so the page does not switch), horizontal belongs to the control. Hiding moves only transforms, and the panes lay out once, at the moment of release; measured frame by frame on the tablet, it runs at 8–9 ms a frame.
  Once hidden, nothing covers the top of the screen, and bringing the bar back is told apart by gesture: buttons in a pane header still respond to taps; a vertical pull of more than 10 px from a pane header brings the bar down with the finger (again swallowing the tap); pulling down from the empty space above the panes works as well. Swiping down on the switcher row, a page or a scratchpad does not count. The top of the screen used to be covered by an invisible strip that caught the pull — but once the panes moved up, every pane header sat underneath it and every tap landed on the strip.
- **Three themes**: Settings → Skin offers **Liquid Glass**, **Frosted Glass** and **Paper**.
  **Liquid Glass** reimplements [rdev/liquid-glass-react](https://github.com/rdev/liquid-glass-react) in plain DOM (the app has no React): the body of the glass is fully transparent, and what lies behind it is bent by a displacement map only near the edges while the middle shows through unchanged; add two rim highlights that turn with the pointer, and the library's bit of elasticity on buttons. Where it differs from the library, measurement decided: the body can have no background colour at all (once the layer carrying the filter has a colour, Chromium stops including the blurred backdrop and the whole piece turns flat grey); the shadow is a separate layer painted behind the body (otherwise the glass bends its own shadow into itself); and the chromatic version — red, green and blue each bent separately — costs 50–67 ms on every other frame on the tablet, so it is used only at rest: the moment a finger touches the screen the glass switches to the single-bend version, and it switches back half a second after the finger stops. At rest nothing is redrawn, so the chromatic version costs nothing at all.
  **Frosted Glass** is the look from before the redesign: white translucent frosted capsules, flat pale blue, ripples on press. Both glass themes share one set of dimensions — Liquid Glass only adds a `data-glass` attribute on `html` — so switching between them moves nothing by a pixel.
  **Paper** is not glass with the lights switched off; it is a different material. Glass separates layers by transmittance and refraction, paper by value and edge — the ground sits one step darker than the sheet so a white page has something to lie on, the edge is low-alpha ink rather than grey (everything else on that screen is ink, and a neutral grey hairline reads as a printed rule), and shadows are given only to things that genuinely float. Paper changes only colours, backgrounds, borders, shadows, radii and blur, all in `paper.css`, and a test forbids any declaration there that changes a size, so switching to Paper moves nothing either (measured frame by frame on the tablet: not one of forty elements on the practice screen moved).
- **Legibility cannot depend on a blur**: any surface that floats over the document and has to be read must be opaque in its own right. This rule was forced out by a misdiagnosis. `backdrop-filter` computed to `none` on the device while `CSS.supports` reported support, and that was recorded as a WebView defect. The real cause was the CSS minifier: every glass rule in the stylesheets hand-wrote a `-webkit-` prefix, lightningcss treats the two spellings as one property and de-duplicates them keeping the last one written, so the build shipped only the prefixed form — and this WebView honours only the unprefixed one. Removing the hand-written prefixes and letting the minifier emit both took the page from 0 to 25 working glass surfaces.
  The conclusion outlived the diagnosis: the full-width top and bottom bars of the time were **deliberately** not frosted, because what sat behind them was the text being read. The bottom bar is gone now, and the top bar has become a few capsules floating on the desk, separated from the panes by a gap — it no longer sits over the text at all.
- **Tablet tuning**: the application page itself cannot zoom, so pinch gestures belong only to the PDF panels and two zoom levels never compete. Resting a palm on the screen does not select text or open a long-press menu. Dragging past a boundary does not move the entire application.
- **Press feedback**: capsule controls compress on press and settle after release using a sampled physical spring (`response` 0.34 s, damping ratio 0.52, expressed as CSS `linear()`).
- **No interruptions**: automatic update checks are **off by default**. The old behavior ran after every launch and could cover anything on screen with a full-page changelog, including the "What is this file?" prompt shown immediately after import. Users can still enable automatic checks in Settings or select Check for updates to run one manually.
- **Accessibility**: supports reduced transparency, increased contrast, and reduced motion. All motion described above becomes displacement-free when Reduced Motion is enabled.

## Technology stack

| Layer | Technology |
|---|---|
| Web UI | Vite 8 (bundled with Rolldown), Capacitor 8 |
| PDF | pdfjs-dist, vendored locally; rendering and text extraction run in a worker (`src/pdf/pdf-render-worker.js`), the main thread only does the zero-copy handover |
| Annotations | Custom vector ink layer (`src/ink/`) with IndexedDB persistence |
| Export | pdf-lib, run in a worker (`src/export/`); on the native side `PdfFilesPlugin.java` writes a hidden temporary file and renames it once complete |
| Queues | `src/pdf/deck-state.js` — pure functions: one ordered queue per pane plus a current item |
| Scratchpads | `src/scratch/` — a world-coordinate camera, rulings drawn only for the visible region, and the same ink layer reused |
| Notebooks | `src/note/` — a synthetic document whose pages are drawn on demand from the scratchpad paper styles (`note-document.js`), read through the PDF reader |
| Folders and layouts | `src/pdf/folder-state.js` (pure functions) and `folder-store.js`; the "Build a layout" sheet is `combo-builder.js` |
| Matching | The engine described above; pure JavaScript with no dependencies |
| Device files | `android/…/files/PdfFilesPlugin.java` — a MediaStore query listing every PDF on the device, and the path exports take into Documents/对页; the web side is `src/pdf/pdf-files.js` and `pdf-picker.js` |
| Interface and themes | `src/styles/liquid.css` holds sizes and layout, shared by all three themes; `paper.css` changes only the material; Liquid Glass is `src/ui/liquid-glass-react.js` with `liquid-glass-react.css` (SVG displacement filters) |
| Agent answers | markdown-it, KaTeX and DOMPurify (`src/agent/answer-renderer.js`) |
| Local storage | IndexedDB (PDF bytes, ink, scratchpads, notebooks) plus localStorage (session, reading position, book pairings, folders, layouts) |
| Offline support | Service Worker (`public/sw.js`) |
| Languages | A small flat dictionary of our own (`src/core/i18n.js`): Simplified Chinese, Traditional Chinese, English |

Localization: the settings screen, the floating ink toolbar and everything added since — the top bar, folders, layouts, export, the empty desk and the user guide — go through the dictionary, now 512 keys in each of the three files. Part of the reading screen is still hard-coded Chinese because the wiring is not finished; the answer panel, the match reasons and the Agent panel are among it. Japanese and Korean were withdrawn; the i18n layer itself is unchanged, so putting the dictionaries back under `src/core/lang/` and adding a line to `LANGUAGES` restores them.

One category of Chinese will never be translated: in six files — `question-id`, `body-structure`, `outline-classify`, `pair-verifier`, `toc-filter` and `glyph-map` — the Chinese is regular expressions (`例题|习题|第X题`, `答案|解答|证明`, `目录|索引`). Those are the patterns the engine uses to parse Chinese textbooks, not text shown to anyone; translating them would break question detection and pairing on the spot.

The precache holds six entries: the index page, the manifest, the icon, pdf.js and its worker, and the KaTeX stylesheet. Two categories are intentionally excluded. First, Vite application bundles contain content hashes and change with every build, so they cannot be listed statically. Their requests use a network-first strategy and update the cache, which is appropriate because a stale application bundle is worse than a slow one. Second, the 168 character maps, 16 standard PDF fonts and 20 KaTeX glyph files — 204 in all — are loaded only when a document needs them. Precaching those would spend the first launch downloading resources that most users never open.

That list caused a real failure once: it had 17 entries, 13 of which named files deleted along with the recognition stack. Each entry was cached with its own `catch`, so nothing errored — every install simply logged thirteen warnings and cached four files, and nobody reads install logs. `test_ui_interactions.js` now watches it: every entry must exist in the source tree.

Files under `/vendor/` use cache-first delivery. They are third-party builds pinned in the repository and do not change within an application release, so the cached copy is always the correct one.

## The native layer and the Agent, as they stand

The repository has `src/agent/`, `src/native/`, `native/agent-proxy/` and `android/app/src/main/cpp/`, which look like two finished pieces of plumbing. **Neither works yet, and they are two separate mechanisms that do not talk to each other** — worth saying plainly before anyone adds code to the wrong one.

**① The in-process JNI bridge** (`libduiye_proxy.so`, shipped in the APK). It has three slots — `agent`, `ocr` and `match` — all still empty; ask it and it honestly answers `UNIMPLEMENTED`. It is probed once at startup and the result goes into the log (Settings → Developer options → View log), so whether this layer is alive can be seen on the device without a debugger.

The `match` slot differs from the other two: answer matching **is implemented today**, on the JS side. The slot is reserved for moving the computation to C++ later, and the JS side of that door is already open (`preparePair({ matcher })`, with the contract in `src/pdf/native-matcher.js`). **The gates do not go through that layer** — role detection, pair identity, the OCR ceiling and region selection all stay in `matching-engine.js`, which clamps every conclusion handed back to it once more. In other words, what is handed off is computation, not judgement.

**② The local HTTP proxy** (`agent-client.js` → `127.0.0.1:8787` → `native/agent-proxy/`). This is the path the Agent panel takes. But that C++ program **is not packaged into the APK** — Android's CMake builds only the two JNI sources, `native/agent-proxy/` is a separate CMake project, no build step packages it and no code starts it. So nothing listens on that port on the tablet, and the Agent panel always reports that it cannot reach the local Agent proxy. It is a development-time prototype: run it on a computer, then forward it with `adb reverse tcp:8787 tcp:8787`.

The panel itself gained a few things in v1.6.0: you can ask your own question about the current page; the back-and-forth on one page of one book is kept as one conversation, and another page is another conversation (in memory only, keeping the last six turns); answers are laid out as Markdown with formulas rendered by KaTeX, links and images are not allowed, and DOMPurify runs before and after rendering. On the proxy's side it talks to an OpenAI-compatible `/chat/completions`: HTTPS only, the key read only from environment variables, and neither page text nor answers are logged; there is also a mock mode that makes no network request. See [native/agent-proxy/README.md](native/agent-proxy/README.md).

To wire up OCR, use ①.

## Development and testing

```bash
npm install
npm run dev
npm run build
npm test              # 55 test files, one command: all green or not
```

On pull requests and pushes to main, CI (`.github/workflows/security-scan.yml`) runs the same `npm test` on Linux with an English locale and LF line endings, which is not the same as a Chinese Windows machine: a test that asserts Chinese copy has to call `setLang('zh-CN')` first, and a test that makes assertions against a source file has to turn `\r\n` into `\n` first. Both rules were added after CI failed on them once.

Two more checks, each left behind by a real failure:

```bash
npm run check:licenses   # dependencies that ship in the APK: are their licences compatible with MIT?
npm run check:upstream   # how many lines are still verbatim from upstream, grouped by how rewritable they are
```

`check:licenses` guards against copyleft dependencies: let one in and the whole work has to follow it, while `LICENSE` says MIT. That kind of mistake does not fail the build, does not turn a test red, and the package installs and runs fine — it only shows up if someone goes looking.

`check:upstream` needs a remote pointing at upstream. Add one if it is missing, with the push URL deliberately set to something invalid so nothing can be pushed there by accident:

```bash
git remote add upstream https://github.com/strangelion/LaTeXSnipper_mobile.git
git remote set-url --push upstream no-push-to-upstream
git fetch upstream
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

Liquid Glass reimplements the approach of https://github.com/rdev/liquid-glass-react in
plain DOM; its three displacement maps are taken from it verbatim (MIT, © 2025 Max Rovensky),
and the licence notice is kept in `src/ui/liquid-glass-maps.js`.

The Agent panel and its local proxy were written by [@allnothing571](https://github.com/allnothing571),
who holds the copyright to them.

Dependency licences are guarded by `npm run check:licenses`: copyleft code such as GPL or
AGPL cannot be merged into an MIT work, and every dependency that gets packaged into the APK
has to pass.

## Development docs

- [Android development and builds](docs/android-development.md)
- [Tablet acceptance checklist](docs/tablet-acceptance.md)
- [Awaiting on-device verification](docs/待实机验证.md) (in Chinese): what each change has been verified for on the tablet, and what is still outstanding
