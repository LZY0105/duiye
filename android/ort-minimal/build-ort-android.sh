#!/usr/bin/env bash
# 为一个安卓架构编精简版 ONNX Runtime 1.23.2：只含同目录 required_operators_and_types.config 里的算子（按数据类型精简）。
# 在 Windows 的 Git Bash 里跑；步骤和前提见同目录 README.md。
#
# 用法：ORT_SRC=C:/ortb/onnxruntime ORT_WORK=C:/ortb bash build-ort-android.sh <abi>
#       <abi> 是 arm64-v8a / armeabi-v7a / x86_64；输出在 $ORT_WORK/b/<abi>/MinSizeRel/ 的两个 .so。
#
# - SDK 装在带中文的用户目录下，交叉编译工具链认不了，临时用 subst 映射成 N:，结束时取消。
# - CMake 用拷到 $ORT_WORK/cmake 的那份（Android SDK 自带的 3.31.6 原样拷过去）：它会把自己的路径写进构建后的
#   批处理，路径带中文时 cmd 找不到。
# - Python 用 $ORT_WORK/venv（独立虚拟环境，pip install flatbuffers）。
# - 不编单元测试（--skip_tests 只是不跑，不加 onnxruntime_BUILD_UNIT_TESTS=OFF 照样会编）。
# - --build_java 是为了编 JNI 那一层（libonnxruntime4j_jni.so）。它随后用 ORT 自带的 Gradle 配置（AGP 7.4.2）打 AAR，
#   在 JDK 21 下会失败（jlink 处理 android-34 的已知问题）；那一步不需要——AAR 由 assemble_aar.py 拿官方 AAR
#   换掉原生库合成。所以这里以两个 .so 是否编出来为准。
set -u
ABI="$1"
HERE="$(cd "$(dirname "$0")" && pwd -W)"
ORT_SRC="${ORT_SRC:-C:/ortb/onnxruntime}"
ORT_WORK="${ORT_WORK:-C:/ortb}"
CONFIG="$HERE/required_operators_and_types.config"
OUT="$ORT_WORK/b/$ABI/MinSizeRel"
SDK_REAL="${ANDROID_SDK_REAL:-$LOCALAPPDATA\\Android\\Sdk}"
cleanup() { subst.exe N: //D >/dev/null 2>&1; }
trap cleanup EXIT
cleanup
subst.exe N: "$SDK_REAL" || exit 1

export PATH="$ORT_WORK/cmake/bin:$ORT_WORK/venv/Scripts:$PATH"
export JAVA_HOME="${JAVA_HOME:-C:\\Users\\Public\\jdk21}"
export ANDROID_HOME='N:\' ANDROID_SDK_ROOT='N:\' ANDROID_NDK_HOME='N:\ndk\27.0.12077973'
export TEMP="$ORT_WORK/tmp" TMP="$ORT_WORK/tmp"
export GRADLE_USER_HOME="$ORT_WORK/gradle-home"
mkdir -p "$ORT_WORK/tmp" "$ORT_WORK/gradle-home" "$ORT_WORK/b"

cd "$ORT_SRC" || exit 1
"$ORT_WORK/venv/Scripts/python.exe" tools/ci_build/build.py \
  --build_dir "$ORT_WORK/b/$ABI" --config MinSizeRel \
  --android --android_sdk_path 'N:\' --android_ndk_path 'N:\ndk\27.0.12077973' \
  --android_abi "$ABI" --android_api 24 --cmake_generator Ninja \
  --minimal_build --include_ops_by_config "$CONFIG" \
  --enable_reduced_operator_type_support --disable_ml_ops --enable_lto \
  --build_java --build_shared_lib --skip_tests --skip_submodule_sync --parallel \
  --cmake_path "$ORT_WORK/cmake/bin/cmake.exe" \
  --cmake_extra_defines onnxruntime_BUILD_UNIT_TESTS=OFF \
  --update --build
echo "build.py exit=$?"
if [ -s "$OUT/libonnxruntime.so" ] && [ -s "$OUT/libonnxruntime4j_jni.so" ]; then
  ls -l "$OUT/libonnxruntime.so" "$OUT/libonnxruntime4j_jni.so"
  echo "BUILD_EXIT=0"
  exit 0
fi
echo "BUILD_EXIT=1"
exit 1
