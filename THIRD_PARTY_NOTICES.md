# Third-party notices

## llama.cpp Android runtime

- Submodule: `android/third_party/llama.cpp`
- Upstream: https://github.com/ggml-org/llama.cpp
- Pinned commit: `d775b8967a46d8beb110d444aa3b8938179e0dd8`
- License: MIT
- Integration source: upstream `examples/llama.android/lib`

The application builds the upstream Android JNI runtime for `arm64-v8a` and `x86_64`. GGUF model weights are separate model-package content and must retain the license and attribution supplied by their model author.

## ONNX Runtime GenAI Android

- Artifact: `android/app/libs/onnxruntime-genai-android-0.6.0.aar`
- Upstream: https://github.com/microsoft/onnxruntime-genai
- Release asset: https://github.com/microsoft/onnxruntime-genai/releases/tag/v0.6.0
- License: MIT (Microsoft Corporation)
- Local AAR SHA-256: `A3FA9FE62310EA100B7D7D8FC09B8E3E239C6B5A13E1A812FDC9B20C5B34F6CC`

The AAR is retained as the on-device fallback text-generation runtime. The question model weights are separate model-package content and must retain the license and attribution supplied by their model author.

## LaTeXSnipper Mobile base

This repository is based on `strangelion/LaTeXSnipper_mobile` and remains under GNU AGPL-3.0. The original license and copyright notices are retained in `LICENSE`.
