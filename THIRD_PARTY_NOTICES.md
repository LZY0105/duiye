# Third-party notices

The on-device recognition stack — the `llama.cpp` Android runtime and ONNX
Runtime GenAI — was removed from this project, along with the Java `ocr`
package that used them. Their notices are gone with them; nothing in this build
links against either any more. The history is on `feature/with-ocr-preserved`.

## ONNX Runtime

Formula recognition (`FormulaOcrService`) runs on ONNX Runtime 1.23.2,
© Microsoft Corporation, released under the MIT licence
(https://github.com/microsoft/onnxruntime). The native libraries in
`android/app/libs/onnxruntime-android-minimal-1.23.2.aar` are a reduced build
compiled from that release's source with only the operators the formula model
uses (`android/ort-minimal/`); the Java API classes, headers and manifest in the
same AAR are taken unchanged from the official `onnxruntime-android` 1.23.2
package. ONNX Runtime's own third-party notices (`ThirdPartyNotices.txt` in its
repository) apply to the components compiled into those libraries.

The formula model itself was trained from scratch for this project; its training
labels were produced by TexTeller-3.0. Its provenance is recorded in the
model card of https://github.com/LZY0105/Math-answer-to-question-matching-model
(`ocr/MODEL_CARD.md`).

## LaTeXSnipper Mobile base

This repository began as a fork of `strangelion/LaTeXSnipper_mobile`, which is
licensed under the GNU AGPL-3.0. Its core has since been rewritten in full and
the project is now released under the MIT licence; see `docs/许可证变更.md` for
the cut-over point and the reasoning, and `LICENSE.AGPL-3.0` for the text that
still governs every revision before it.

Crediting where this started is a matter of fact, not of licence obligation, and
it stays here either way.
