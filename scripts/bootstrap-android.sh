#!/usr/bin/env bash
# Reports what a fresh checkout still needs before the Android build will run.
#
# The acceptance run against 6986c20 found that a clean checkout does not build
# as delivered: two dependencies are referenced by the Gradle project and are
# not in the repository. Neither can simply be committed — one is a large
# binary redistributed under its own terms, the other is a submodule — so this
# script does what can be automated and says plainly what cannot.
#
# Usage:  bash scripts/bootstrap-android.sh
set -u

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
AAR="$ROOT/android/app/libs/onnxruntime-genai-android-0.6.0.aar"
SUBMODULE="$ROOT/android/third_party/llama.cpp"
missing=0

echo "── Android build prerequisites ─────────────────────────────────────────"

# 1. The submodule can be initialised here, so it is.
if [ -f "$SUBMODULE/CMakeLists.txt" ]; then
  echo "  ok       llama.cpp submodule is initialised"
else
  echo "  fixing   initialising the llama.cpp submodule…"
  if git -C "$ROOT" submodule update --init --recursive android/third_party/llama.cpp; then
    echo "  ok       llama.cpp submodule initialised"
  else
    echo "  MISSING  llama.cpp — run: git submodule update --init --recursive"
    missing=1
  fi
fi

# 2. The AAR cannot be fetched from here without asserting a licence to
#    redistribute it, so it is reported rather than downloaded.
if [ -f "$AAR" ]; then
  echo "  ok       onnxruntime-genai AAR is present"
  if command -v sha256sum >/dev/null 2>&1; then
    echo "           sha256 $(sha256sum "$AAR" | cut -d' ' -f1)"
  fi
else
  echo "  MISSING  android/app/libs/onnxruntime-genai-android-0.6.0.aar"
  echo "           Obtain onnxruntime-genai 0.6.0 for Android from Microsoft's"
  echo "           release page and place it at the path above."
  echo "           The build verified in the 20260903 acceptance run used"
  echo "           sha256 A3FA9FE62310EA100B7D7D8FC09B8E3E239C6B5A13E1A812FDC9B20C5B34F6CC"
  missing=1
fi

echo "────────────────────────────────────────────────────────────────────────"
if [ "$missing" -eq 0 ]; then
  echo "Ready. Next:  npm run build:android"
  exit 0
fi
echo "Supply what is marked MISSING above, then re-run this script."
echo
echo "Both dependencies belong to the recognition stack, which this release no"
echo "longer uses — the web app has no OCR. Removing them from the Gradle"
echo "project would delete both prerequisites and shrink the APK considerably."
echo "That change is not made here because it cannot be verified without an"
echo "Android build."
exit 1
