# LaTeXSnipper Mobile — 项目维护指南

## 代码规范
- JS 使用 ES Module (`import`/`export`)
- CSS 使用 `src/styles/` 分模块管理（base / ocr / pdf / scratch / deck / ink-toolbar / mobile / material）
- HTML 标签内联事件用 `pointerdown` 而不是 `click`（WebView 兼容）
- 所有用户可见文本使用 `data-i18n` 属性 + `t()` 函数，禁止硬编码中文
- 语言包在 `src/core/lang/` 统一管理，新增文本要五种语言都加；缺的键回落到简体中文
- 新增功能归到所属模块，不要跨模块散落
- 修改 `public/` 下文件后需重新 `npm run build`
- 状态先写成纯函数（`*-state.js`、`scratch-camera.js`、`scratch-style.js`），再由
  编排层接 DOM。这是这个仓库里绝大多数验收保证能在 Node 里被证明的原因
- 提交署名跟随仓库既有历史：带 `Co-Authored-By` 行。（本文件早先写的是「不添加」，
  与实际提交记录不符，以记录为准）

---

## 一、项目架构

> 本节以下的旧章节（识别引擎、ONNX 模型清单、导出系统等）描述的是**已经移除**的
> OCR 应用，只作历史留存，不描述当前代码。当前结构以 README.md 和各文件头部注释
> 为准。

```
LaTeXSnipper_mobile/
├── index.html                 # 单页面 SPA：练习 / 设置 两个 Tab
├── public/vendor/             # pdf.js、cmaps、standard_fonts、KaTeX、MathLive
├── src/
│   ├── main.js                # 入口：bootstrap → createApp → start
│   ├── core/                  # bootstrap、app、crash-guard、logger、i18n、lang/
│   ├── pdf/                   # 工作区与对题
│   │   ├── deck-state.js          # 纯：一栏一个有序队列 + 当前项，含原子 moveEntry
│   │   ├── workspace-state.js     # 纯：两栏布局、分栏比例、互换、专注、收起
│   │   ├── pdf-view-state.js      # 纯：单栏的页码 / 缩放 / 平移
│   │   ├── document-session.js    # 会话 v2 持久化 + v1 迁移；view 按 entry 记
│   │   ├── pdf-workspace.js       # 编排：交接事务、切换、移动、收起、专注、对题
│   │   ├── pdf-workspace-ui.js    # 导入、文档库、顶栏收起手势
│   │   ├── pdf-pane.js            # 单栏 PDF 视图：手势、翻页动画、位图缓存
│   │   ├── deck-strip.js          # 52dp 切换行 + 内容列表 + 滑动手势
│   │   ├── deck-dialogs.js        # 新建 / 选栏 / 移动 / 危险确认
│   │   ├── deck-organizer.js      # 整理内容：两栏并排，拖手柄或点按
│   │   ├── answer-association.js  # 习题册 ↔ 答案册的配套关联
│   │   └── (21 个匹配引擎模块，来自 Math-answer-to-question-matching-model)
│   ├── scratch/               # 无限草稿纸
│   │   ├── scratch-camera.js      # 纯：世界中心 + 缩放，四方向无界
│   │   ├── scratch-background.js  # 八种底纹，按可见世界区域直接绘制
│   │   ├── scratch-style.js       # 纯：底纹 / 纸色 / 间距 / 浓淡
│   │   ├── scratch-store.js       # 草稿纸资源（IndexedDB），笔迹走 ink-store
│   │   ├── scratch-pane.js        # 单栏草稿纸视图：手势、相机、保存状态机
│   │   └── scratch-style-panel.js # 样式选择面板
│   ├── ink/                   # 矢量笔迹层（PDF 与草稿纸共用，一行未改）
│   ├── settings/              # 设置页
│   ├── ui/                    # liquid-glass、particles、custom-select、double-tap
│   └── styles/                # base / ocr / pdf / scratch / deck / ink-toolbar /
│                              #   mobile / material
├── android/                   # Capacitor Android（除 Capacitor 外无原生业务代码）
└── test/                      # 23 套，809 项，入口只有 `npm test`
```

### 新增功能要落在哪里

- 新增一种队列操作 → `deck-state.js` 加纯函数 → `workspace-state.js` 包一层 →
  `pdf-workspace.js` 接线。三层都是纯的，只有最后一层碰 DOM。
- 新增一种草稿纸底纹 → `scratch-style.js` 的 `PATTERNS` 加一项，
  `scratch-background.js` 的 switch 加一个分支，语言包加 `pattern.PXX` 两条。
- 新增用户可见文案 → 五个语言包都加；缺的键会回落到简体中文，不会显示裸键。

## 二、Tab 页面结构

| Tab | ID | 功能 |
|-----|-----|------|
| 识别 | `#page-ocr` | 图片/PDF/拍照/手写识别，模式选择（公式/文本/混合） |
| 编辑器 | `#page-editor` | MathLive 所见即所得编辑，KaTeX 预览，虚拟键盘，符号工具栏，导出 |
| 历史 | `#page-history` | IndexedDB 列表，收藏筛选，滑动删除/分享/复制，点击填入编辑器 |
| 设置 | `#page-settings` | 识别引擎选择、加速模式、外部 API 配置、预设、皮肤、语言、AI 整理配置、开发者模式、更新检查 |

---

## 三、识别引擎架构

> **历史章节。** 本节描述的识别（OCR）栈已从仓库移除：`android/app/src/main/java/
> com/latexsnipper/app/ocr/`、`:llama-runtime` 模块、`llama.cpp` 子模块与
> `onnxruntime-genai` AAR 均已删除，Web 端也不再调用。保留在此仅供追溯当时的
> 设计，不描述当前代码。当前 Android 端除 Capacitor 外没有原生业务代码。

Android 端使用纯 Java ONNX Runtime 管线，桌面端 Python `mathcraft-ocr` 实现对标。

### 公式识别 (formula mode)
```
图片 → FormulaDetPreProcess (768×768 letterbox)
  → 公式检测 (YOLOv8) → 结果区域 → 每个区域:
    → FormulaRecPreProcess (短边384+中心裁剪) → TrOCR 编码器(DeiT) → 束搜索解码(beam=3)
    → LaTeX 修复 → 输出
```

### 文字识别 (text mode)
```
图片 → TextDetPreProcess (最长边960, stride32对齐)
  → DBNet 推理 → Moore-Neighbor 轮廓追踪 → unclip → box_thresh=0.5
  → 每个文本框 → TextRecPreProcess (BGR 48×320) → CRNN 推理 → CTC 解码
  → 输出文本
```

### 混合模式 (mixed mode)
```
图片 → 公式检测 (YOLOv8) + 文字检测 (DBNet)
  → splitTextBoxAroundFormulas (按公式 x 范围 + y 重叠分割)
    → 公式段 → crop 使用 formulaDet 框坐标 → 公式行分割/单行识别
    → 文字段 → crop 使用 textDet 框坐标 → 直接 CRNN 识别
  → 独立显示公式加入 → overlap check 去重（使用正确坐标避免重复）
  → 行分组（union box y-overlap≥0.45）
  → 版面输出（inline 用 $…$，display 用 $$\n…\n$$）
```

### 桥接通信

```
JS → window.NativeOcr.recognizeFormula(base64) → NativeOcrBridge (后台线程)
  → OcrEngine → ONNX Runtime Android
  → 结果 JSON → JS 轮询 getResult(key) 获取
```

- 识别异步：Java 后台线程执行，JS 每 200ms 轮询
- 结果 JSON 含 `text`/`latex`/`confidence`/`timeMs`/`regions`（混合模式）

---

## 四、ONNX 模型清单（按需下载，doc-ori 内置）

模型通过 ZIP 包下载导入，doc-ori 方向检测模型内置 APK（6.5 MB）。
ZIP 包格式对齐 HuggingFace ONNX + PaddleOCR 规范，每个包含 `config.json`。

| 类别 | 默认 variant ID | 模型文件 | 分发方式 |
|------|----------------|----------|----------|
| `formula-det` | `yolov8-mfd` | `mathcraft-mfd.onnx` | 下载 ZIP |
| `formula-rec` | `trocr-deit` | `encoder_model.onnx` + `decoder_model.onnx` + `tokenizer.json` | 下载 ZIP |
| `text-det` | `ppocrv5-mobile` | `ppocrv5_mobile_det.onnx` | 下载 ZIP |
| `text-rec` | `ppocrv5-mobile` | `ppocrv5_mobile_rec.onnx` + `ppocrv5_keys.txt` | 下载 ZIP |
| `doc-ori` | `pplcnet-doc-ori` | `pplcnet_doc_ori.onnx` | **内置 APK** |

### ZIP 包结构

```
{category}/{variantId}/
  model.onnx (或 encoder_model.onnx + decoder_model.onnx)  — ONNX 模型权重
  config.json                                               — 模型自描述（类型/输入/输出/预处理/后处理）
  tokenizer.json / ppocrv5_keys.txt                         — 解码器字典文件
```

### ModelConfig.java — config.json 解析

```java
ModelConfig.load(modelDir)       // 从模型目录读取 config.json
ModelConfig.findModelFile(dir)   // 发现 ONNX 文件（model.onnx → *.onnx）
ModelConfig.findEncoderFile(dir) // 发现编码器 ONNX（encoder.onnx → encoder_model.onnx）
ModelConfig.findDecoderFile(dir) // 发现解码器 ONNX
ModelConfig.findTokenizerFile(dir) // 发现字典文件（tokenizer.json → ppocr_keys.txt）
```

注意：已知模型加载使用**硬编码文件名**（避免多 ONNX 目录误选），`findModelFile` 仅供第三方模型发现使用。

### 模型管理系统

```
JS 端:
  model-manager.js    — 清单解析、CRUD、下载、导入、变体合并
  model-analyzer.js   — ONNX protobuf 解析，自动推断类别
  model-import.js     — ZIP/单文件导入 UI
  model-settings.js   — 设置页模型管理（源/变体/下载/删除）
  package-builder.js  — 应用内模型包创建器

Java 端:
  ModelManager.java   — 文件路径、活跃变体（SharedPreferences）、安装状态
  OnnxRunner.java     — 动态加载（文件系统优先 → 资产回退 → null）
  NativeOcrBridge.java — getModelStatus() 返回各模型可用状态
```

### 存储路径

- JS: `localStorage` (sources/active/installed/manifests/download_progress) + Capacitor Filesystem (`DATA/models/{category}/{variantId}/`)
- Java: `SharedPreferences "ModelManagerPrefs"` + `ctx.getFilesDir()/models/{category}/{variantId}/`

### 下载系统（镜像 + 断点续传 + SHA256 校验）

```
manifest.mirrors[]    — 多下载源，主源失败自动切换
manifest.checksums{}  — {filename: sha256hex}，下载后校验完整性
downloadVariant()     — 镜像 fallback → Range 断点续传 → SHA256 校验 → importFromZip
localStorage          — ls_download_progress 持久化下载进度，支持应用重启恢复
```

- 镜像 URL 格式：`https://mirror/https://github.com/original-path`
- 默认镜像：`gh.zwy.one`、`gh.xxooo.cf`
- 断点续传：HTTP `Range: bytes=N-` header，服务器不支持时自动重新下载
- SHA256：Web Crypto API `crypto.subtle.digest('SHA-256')`，不匹配则拒绝导入


### 模型目录结构

```
model-sources/          ← 打包源文件（.gitignore，不在 git 中）
  mathcraft-formula-det/
  mathcraft-formula-rec/
  mathcraft-text-det/
  mathcraft-text-rec/
  mathcraft-doc-ori/

public/models/          ← 仅含内置 APK 的文件
  mathcraft-doc-ori/pplcnet_doc_ori.onnx  ← 内置方向检测（6.5 MB）
  mathcraft-formula-rec/tokenizer.json     ← 公式 tokenizer fallback
  mathcraft-text-rec/ppocrv5_keys.txt      ← 文字 CTC 字典 fallback
```

---

## 五、关键参数

| 参数 | 值 | 说明 |
|------|-----|------|
| det 置信度阈值 | 0.25 | 匹配桌面端 |
| det NMS IoU | 0.45 | 匹配桌面端 |
| rec max_tokens | 512 | 匹配桌面端 |
| det thresh | 0.3 | RapidOCR 默认 |
| box_thresh | 0.5 | RapidOCR 默认 |
| unclip_ratio | 1.6 | RapidOCR 默认 |
| min_text_score | 0.45 | 文字置信度过滤 |
| largeHeap | true | AndroidManifest.xml |

---

## 六、欢迎弹窗与首次启动

```
首次启动 → checkFirstLaunch() → 欢迎弹窗
  → "立即下载" → refreshManifests() → 逐个下载 4 个模型（弹窗内进度条）
  → "使用外部 API" → 切换引擎到外部 API
  → "稍后设置" → 跳过
```

- 欢迎弹窗自动下载所有模型，弹窗内显示每个模型的下载进度
- 下载失败可重试，不会自动关闭弹窗
- `POST_NOTIFICATIONS` 权限在 AndroidManifest.xml 声明，Java 端运行时检查

---

## 七、Pandoc WASM 按需下载

pandoc.wasm（58 MB）不内置 APK，用户在设置页手动下载。

```
设置页 → "下载 Pandoc WASM" → downloadPandocWasm()
  → IndexedDB 缓存（避免 base64 OOM）
  → 首次编译 WASM 显示加载弹窗
  → 后续导出直接使用缓存实例
```

- 下载源：GitHub Release + gh.zwy.one + gh.xxooo.cf 镜像
- 缓存：IndexedDB（原生二进制，无 base64 开销）
- 导出菜单：pandoc 不可用时仅显示 PNG/SVG/Typst
- AndroidManifest.xml 声明 `POST_NOTIFICATIONS` 权限

---

## 六、多语言系统

```
用户切换语言 → setLang(code) → 加载语言包 → translateDOM() 批量更新
                                  └→ onLangChange 回调（更新动态文本）
```

- 静态 HTML：`data-i18n` / `data-i18n-html` / `data-i18n-title`
- 动态 JS：`import { t } from './core/i18n.js'`
- 新增语言：复制 zh-CN.js → 翻译 → 在 LANG_MAP 注册 → 加 HTML 选项
- 所有用户可见文本必须通过 i18n 系统，禁止硬编码

### 现有语言

| 语言 | 文件 |
|------|------|
| 简体中文 | `src/core/lang/zh-CN.js` |
| 繁体中文 | `src/core/lang/zh-TW.js` |
| 英文 | `src/core/lang/en.js` |
| 日文 | `src/core/lang/ja.js` |
| 韩文 | `src/core/lang/ko.js` |

---

## 七、导出系统

导出下拉菜单位于 OCR 结果卡和编辑器底部，共 9 种格式：

| 格式 | 转换引擎 | 说明 |
|------|---------|------|
| PNG | KaTeX → SVG → Canvas | 高清公式图片 |
| SVG | KaTeX → SVG | 矢量公式图片 |
| LaTeX | Pandoc WASM | .tex 格式 |
| MathML | Pandoc WASM | 数学标记语言 |
| Markdown | Pandoc WASM | `markdown+tex_math_dollars` |
| HTML | Pandoc WASM | 网页 |
| **Typst** | **纯 JS 转换器** | 符号表 + 结构转换，不依赖 Pandoc |
| Word | Pandoc WASM | .docx 格式 |
| Plain Text | Pandoc WASM | 纯文本 |

Typst 转换器（`pandoc-export.js`）：
- 200+ LaTeX→Typst 符号映射（希腊字母、运算符、箭头、关系符、函数名）
- 结构转换：`\frac`、`\sqrt`、`\binom`、`\begin{cases}`、矩阵环境、`\text`、`\underline`、`\hat`/`\vec` 等
- 混合内容分段：`$...$`/`$$...$$` 解析，只转换公式段，文本段保留
- 预处理：`\textcolor`、`\cfrac`、`\sideset`、`\varnothing`、`#?` 等修复

---

## 八、构建与部署

```bash
npm install            # 安装依赖
npm run dev            # Vite 开发服务器（:5174）
npm run build          # 构建到 dist/
```

### Android
```bash
npx cap sync android   # 同步到 Android
cd android && ./gradlew assembleDebug  # 编译 debug APK
```

### iOS（需要 macOS + Xcode）
```bash
# 推荐：构建后自动打开 Xcode，选签名后点 Run
bash scripts/build-ios.sh

# 仅模拟器
bash scripts/build-ios.sh --simulator

# 真机 IPA
bash scripts/build-ios.sh --device
```

免费 Apple ID 即可签名（不需要 $99 开发者账号），限制：每 7 天重新签名，最多 3 个 app。

### 测试
```bash
# Node.js 测试（无需 conda）
node test/test_pandoc_export.js   # Pandoc + Typst 导出
node test/test_katex.js           # KaTeX 渲染
node test/test_integration.js     # 项目结构检查
node test/test_e2e.js             # 全量 E2E

# 全部测试
npm test
```

### 注意事项
1. **模型按需下载** — ONNX 模型不再内置 APK（~220MB），通过设置页下载 ZIP 包导入，或使用外部 API
2. **模型加载优雅失败** — 缺失模型不崩溃，`loadModelData` 返回 null，`createSession` 返回 null，OcrEngine 跳过并记录
3. **外部 API 独立** — 选择外部 API 模式时不加载本地模型，`initModels()` 直接跳过
4. **图片解码** — `is.available()` 在 APK 压缩资产中返回压缩后大小，必须用 `ByteArrayOutputStream` 分段读取
5. **文件分享** — Capacitor Share 传 base64 文件在某些 Android 版本失败时，直接触发下载而非弹系统分享
6. **MathLive 自定义元素** — `<mathlive-field>` 在部分 WebView 中不注册，改用 `new MathfieldElement()` 创建
7. **虚拟键盘策略** — 三态切换：`manual`(关闭) → `manual` + `toggleVirtualKeyboard`(MathLive 键盘) → `sandboxed`(系统键盘)
8. **相机按钮** — 必须用 `pointerdown` + `stopPropagation`，`click` 在 WebView 中不可靠
9. **COOP/COEP 头** — Capacitor 和 Vite 中已配置
10. **iOS 构建** — 需要 Apple Developer（$99/年），CI 只能验证模拟器编译
11. **大图拍照** — >500KB 自动压缩到最长边 1920px
12. **KaTeX 替换 MathJax** — 公式渲染使用 KaTeX HTML 渲染，轻量快速
13. **Typst 不经过 Pandoc WASM** — Typst 导出使用纯 JS 符号映射 + 结构转换器
