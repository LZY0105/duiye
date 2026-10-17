# 精简版 ONNX Runtime（公式识别用）

`android/app/libs/onnxruntime-android-minimal-1.23.2.aar` 是照公式识别模型用到的算子，从 ONNX Runtime 1.23.2 源码
编的精简版。官方包每个架构的 `libonnxruntime.so` 有十几到二十多兆，这个只有 1.4–2.4 MB：

| 架构 | 精简版 `libonnxruntime.so` | 官方包 |
|---|---|---|
| arm64-v8a | 2.40 MB | 19.3 MB |
| armeabi-v7a | 1.35 MB | 14.0 MB |
| x86_64 | 2.32 MB | 23.2 MB |

debug 安装包由 81.9 MB 降到 22.0 MB：原生库换成精简版，再加上 `build.gradle` 里让原生库压缩存放。接 OCR 之前是 17.0 MB。

AAR 里的 Java 部分（`classes.jar`、清单、头文件）原样取自官方 `onnxruntime-android` 1.23.2 包，只有 `jni/<abi>/` 下的两个
原生库换成了精简版。`FormulaOcrService` 和运行器的代码一行没变。

## 什么时候要重编

- **模型用到了新的算子：** 改了模型结构，或者导出、转换方式变了。`required_operators_and_types.config` 会跟着变，要重编。
- **升级 ONNX Runtime 版本。**

只是重新训练、结构不变的话，算子清单不变，不用重编，换 `assets/ocr/formula/` 里的模型文件就行。不确定的时候，
转完模型和这里的清单比一比，一样就不用重编。

精简版只认 ORT 格式的模型（`.ort`），不认 `.onnx`。

## 步骤

以下在 Windows 的 Git Bash 里做，工作目录用 `C:/ortb`（路径里不能有中文）。

1. **把模型转成 ORT 格式，同时生成算子清单。**
   用题目答案匹配引擎仓库的 `ocr/android/to_ort_bundle.py`：

   ```bash
   python ocr/android/to_ort_bundle.py --bundle tmp/formula-scratch-kv-int8-texteller-r10 --output C:/ortb/bundle-ort --manifest <验证清单.jsonl>
   ```

   - 转换设置与官方 `convert_onnx_models_to_ort` 的 Fixed 风格、`--target_platform arm` 相同。
   - 转完会用验证图核对：编码器输出逐位相同、识别结果逐记号相同，才算数。
   - 把 `C:/ortb/bundle-ort/` 下的模型文件拷进 `android/app/src/main/assets/ocr/formula/`：
     `encoder.ort`、`decoder.ort`、`tokenizer.json`、`model.properties`、`metadata.json`。
   - 把 `required_operators_and_types.config` 拷到本目录。

2. **准备编译环境**（第一次做时）：
   - `git clone --depth 1 --branch v1.23.2 https://github.com/microsoft/onnxruntime.git C:/ortb/onnxruntime`
   - `python -m venv C:/ortb/venv && C:/ortb/venv/Scripts/python -m pip install flatbuffers`
   - 把 Android SDK 自带的 CMake 3.31.6 整个目录拷到 `C:/ortb/cmake`。
   - 需要 NDK 27.0.12077973 和 JDK 21（脚本里写的是 `C:/Users/Public/jdk21`，可用 `JAVA_HOME` 换）。
   - 不需要 Visual Studio：在 Windows 上交叉编译时，ORT 会自己下载官方现成的 protoc。

3. **每个架构编一次**，16 核大约 5 分钟一个：

   ```bash
   bash android/ort-minimal/build-ort-android.sh arm64-v8a
   ```

   `armeabi-v7a`、`x86_64` 同样各跑一次。脚本以两个 `.so` 是否编出来为准。ORT 自带的 Gradle 打包那一步在 JDK 21 下会报错，不影响结果。

4. **合成 AAR：**

   ```bash
   python android/ort-minimal/assemble_aar.py <官方 onnxruntime-android-1.23.2.aar> android/app/libs/onnxruntime-android-minimal-1.23.2.aar C:/ortb/b arm64-v8a armeabi-v7a x86_64
   ```

   官方 AAR 在 Gradle 缓存里：`.gradle-hybrid-j21/caches/modules-2/files-2.1/com.microsoft.onnxruntime/onnxruntime-android/1.23.2/`。
   缓存里没有的话，从 Maven Central 下载同一版本。

5. **编 APK，上机核对：** 把电脑上的识别结果和平板上的逐记号对比（`docs/待实机验证.md` 第 55 条的做法）。

## 已知的小坑

- **中文路径：**
  - Android SDK 装在带中文的用户目录下，脚本用 `subst` 临时把它映射成 `N:`，结束时取消。
  - CMake 必须用纯英文路径下的那份：它会把自己的路径写进构建后的批处理，路径带中文时 cmd 找不到。
- **ORT 自带的 Gradle 打包步骤**会往 Android SDK 里自动装 Build-Tools 30.0.3 和 Platform 34。这两样都是新增的，不影响现有的东西。
