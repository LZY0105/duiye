"""用精简版 ONNX Runtime 的原生库替换官方 AAR 里的原生库，合成一个 AAR 给对页用。

官方 onnxruntime-android-1.23.2.aar 里的 Java 部分（classes.jar、AndroidManifest、头文件）和我们编的版本出自同一份
源码，原样保留；只把 jni/<abi>/ 下的 libonnxruntime.so、libonnxruntime4j_jni.so 换成精简版（build-ort-android.sh 的
输出）。我们没编的架构（x86）整个去掉，对页本来就不装它。

用法：python assemble_aar.py <官方.aar> <输出.aar> <构建根目录> <abi> [<abi> ...]
"""
import sys
import zipfile
from pathlib import Path

official, output, root, abis = Path(sys.argv[1]), Path(sys.argv[2]), Path(sys.argv[3]), sys.argv[4:]
NAMES = ("libonnxruntime.so", "libonnxruntime4j_jni.so")

for abi in abis:
    for name in NAMES:
        if not (root / abi / "MinSizeRel" / name).is_file():
            raise SystemExit(f"{abi} 没有 {name}")

with zipfile.ZipFile(official) as source, zipfile.ZipFile(output, "w", zipfile.ZIP_DEFLATED) as target:
    for item in source.infolist():
        if item.filename.startswith("jni/"):
            continue
        target.writestr(item, source.read(item.filename))
    for abi in abis:
        for name in NAMES:
            # .so 在 AAR 里不压缩，和官方包一样，打进 APK 时再按应用的设置处理
            info = zipfile.ZipInfo(f"jni/{abi}/{name}", date_time=(2026, 10, 16, 0, 0, 0))
            info.compress_type = zipfile.ZIP_STORED
            info.external_attr = 0o644 << 16
            target.writestr(info, (root / abi / "MinSizeRel" / name).read_bytes())

with zipfile.ZipFile(output) as check:
    for item in check.infolist():
        if item.filename.endswith(".so") or item.filename == "classes.jar":
            print(f"{item.file_size:>11,d}  {item.filename}")
print(f"写出 {output}（{output.stat().st_size:,d} 字节）")
