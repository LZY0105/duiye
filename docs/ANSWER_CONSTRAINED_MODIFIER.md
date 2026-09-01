# Answer-constrained question modifier

## Fixed data boundary

```text
image / PDF / handwriting / answer image
                    |
                    v
          Android local OCR models
                    |
             recognized text
                    |
          +---------+---------+
          |                   |
      no answer          answer present
          |                   |
 local model or         local model only
 external text API      external API blocked
```

The external API is never an OCR endpoint. It receives only normalized question text and an optional instruction, and only when no answer is present. The answer path is fail-closed.

## One interface, two local adapters

`QuestionModifierEngine` is the backend-neutral boundary used by `NativeOcrBridge`:

1. `LlamaCppQuestionModifierAdapter` is the preferred automatic backend and loads one GGUF file through the pinned llama.cpp Android runtime.
2. `OnnxGenAiQuestionModifierAdapter` preserves compatibility with ONNX Runtime GenAI packages.

An explicitly selected valid variant wins. Without a valid active selection, automatic discovery checks llama.cpp packages first and ONNX Runtime GenAI packages second. This fallback is selection-only: a runtime failure is returned to the caller and never triggers an unreported model switch or a network request.

Status includes `backend`, `format`, `variant`, `preferredBackend`, `fallbackBackend`, and `fallbackPolicy` so the UI and exported logs retain inference provenance.

## Local model packages

The Android bridge searches:

```text
models/question-modifier/{variantId}/
```

There is exactly **one** package format. Every package — regardless of backend —
must ship a strict `question-modifier.json` descriptor next to its weights.
Nothing is ever inferred from file names, so a bare weights directory is rejected
by both adapters.

Accepted layouts:

- llama.cpp/GGUF: exactly one `.gguf` file **and a `question-modifier.json` descriptor**;
- ONNX Runtime GenAI: `config.json`, at least one `.onnx` or `.bin` file, the tokenizer assets required by that model, **and a `question-modifier.json` descriptor**.

### Package descriptor (required for every backend)

GGUF:

```json
{
  "backend": "llama.cpp",
  "format": "gguf",
  "modelFamily": "qwen",
  "promptTemplate": "chatml",
  "contextLength": 4096,
  "maxOutputTokens": 512
}
```

ONNX Runtime GenAI:

```json
{
  "backend": "onnxruntime-genai",
  "format": "onnx",
  "modelFamily": "qwen",
  "promptTemplate": "chatml",
  "contextLength": 4096,
  "maxOutputTokens": 512
}
```

Missing, unknown or conflicting fields fail closed with `QUESTION_MODEL_INVALID`; nothing is inferred from file names. The generation budget is computed from the real prompt token count: `maxLength = min(contextLength, promptTokens + maxOutputTokens)`. When the prompt leaves less than the reserved minimum output room inside the context window, generation is rejected with `QUESTION_PROMPT_TOO_LONG` — input is never silently truncated and empty output is never returned as success.

**Model-family support (honest scope): only Qwen/ChatML models are currently accepted.** The prompt-template registry contains exactly `chatml`; any other `promptTemplate` value fails with `QUESTION_PROMPT_TEMPLATE_UNSUPPORTED`. Claiming support for other families requires adding a template to the registry AND updating this document, the manifest and the UI.

The example manifest contains both variants. It is a schema example, not a redistributable model download. Model weights remain separate from the application and must carry their own license, source and attribution.

The generated response must be a JSON object:

```json
{"question":"...","reason":"..."}
```

The native result also records `backend` and `modelVariant`. JavaScript rejects malformed JSON, empty or unchanged questions, and output that copies the supplied answer verbatim.

### Answer-constraint verification: what is and is not implemented

`AnswerConstraintVerifier` is implemented and wired into the publishing gate.
`NativeOcrBridge.verifyGeneratedQuestion` runs it on every generated question and
attaches the verdict, so the native side — never the model, never JavaScript —
decides publishability. The bridge returns:

```json
{"question":"...","reason":"...",
 "verifier":{"status":"...","version":"answer-verifier-v1","questionType":"...",
             "method":"...","detail":"...","normalizedAnswer":"..."},
 "publishable":true}
```

There is no `valid` field; JavaScript derives validity from this structure.

**Implemented (narrow, exact scope).** All arithmetic runs on exact `BigInteger`
rationals — floating point is never used for equality:

- integers, signs, finite decimals, `a/b` and `\frac{a}{b}`;
- `+ - * /` with parentheses and omitted multiplication signs (`2x`, `\frac{1}{2}x^2`);
- single-variable linear equations;
- single-variable quadratic equations whose discriminant is a perfect square
  (rational roots only), including double roots.

**Explicitly unsupported — returns `UNSUPPORTED` and blocks publication.** These
are refusals, not failures, and are never presented as verified:

- irrational or complex roots (`x^2 - 2 = 0`, negative discriminant);
- degree ≥ 3, inequalities, radicals, trigonometric and other functions;
- multiple unknowns, or a stem whose natural-language text cannot be safely
  separated from the mathematics;
- a multi-root equation answered with a single value when the question does not
  state whether one root or all roots are wanted.

**Not implemented.** General symbolic mathematical equivalence. A question
outside the scope above is reported as `UNSUPPORTED` and blocked — the system
never silently downgrades an unverifiable question into a verified one.

## Acceptance checklist

1. OCR an image or answer and confirm logs contain no external image URL or base64 payload.
2. Without an answer, invoke the external modifier and confirm only question text is sent.
3. With an answer, try the external modifier and confirm the request is rejected before network access.
4. Install a GGUF package (one `.gguf` **plus** `question-modifier.json`) built by following the example manifest, and confirm status reports `backend=llama.cpp`, `format=gguf` on arm64-v8a/x86_64.
4b. Install the same GGUF package with `question-modifier.json` removed and confirm it is rejected with `QUESTION_MODEL_INVALID` rather than silently accepted.
5. Explicitly select an ONNX Runtime GenAI package and confirm status reports `backend=onnxruntime-genai`.
6. Remove all local question models and confirm `QUESTION_MODEL_MISSING` with no network fallback.
7. Put a GGUF package on an unsupported ABI without an ONNX package and confirm `QUESTION_BACKEND_UNAVAILABLE`.
8. Force local generation to fail and confirm no other backend or external API is called silently.

## Build dependencies

- `android/third_party/llama.cpp` is a pinned Git submodule used to build the Android JNI runtime for arm64-v8a and x86_64.
- `android/app/libs/onnxruntime-genai-android-0.6.0.aar` is the retained ONNX Runtime GenAI fallback runtime.
- Android builds require NDK `29.0.13113456` and CMake `3.31.6`.
- The hybrid build has a minimum Android API level of 30 because the upstream llama.cpp Android logging/JNI integration calls an API introduced in Android 11.

Upstream versions and licenses are recorded in `THIRD_PARTY_NOTICES.md`.
