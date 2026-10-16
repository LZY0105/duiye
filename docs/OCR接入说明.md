# OCR 接入说明：套索「识别」

2026-10-12 起接上了第一个引擎：**自建公式模型**（题目答案匹配引擎 `ocr/` 的第十轮，在原生代理层的 `ocr` 那一位上，见 3.1 末尾
「现在的实现」）。它一次认一个印刷公式，认不了中文和成段的文字。

这一份讲的是那个口子：接上引擎之后，套索多出一个「识别」——圈一块书上印的字或公式，认出来、挑几条、复制或者写成笔迹放在
画布上。没有引擎的构建里套索上没有这颗按钮，一切和原来一样。

接一个引擎进来，网页这一侧的套索、界面、动画、复制、转成笔迹都不用改，只做下面「三条接法」里的一条。

---

## 1. 人看到的是什么

**两个入口**

- **圈一块没有笔迹的地方**（就是圈书上印的字）：那一圈留下来，叫「识别区域」。它不是选区——没有把手、搬不动。套索那条小条
  上只有一颗「识别」。
- **圈住了笔迹**：选区照旧，小条上在「删除」前面多一颗「识别」（危险的那一颗永远在最后）。

草稿纸、笔记本上没有「文件里的字」可截，不出现「识别」。

**认的时候**（`src/ink/ink-recognize.js`、`src/styles/ink-recognize.css`）

- 只照亮圈里那一块（圈外一点不碰），一道光从上往下扫，圈线变成流动的虚线；
- 圈下面一个小条：跳动的三个点、「正在识别…」，引擎报进度就带一个百分比，右边「取消」；认了 4 秒还没完，补一句「内容多会久一点」；
- 套索那条小条这时让位，两样东西不挤在圈旁边；
- 扫的时候整块界面挂着 `data-lens-moving`，液态玻璃换成便宜的那一版（第 53 条量过：静止那一版每帧几十毫秒）。

**认出来了**

- 扫光淡出，认出来的那几处在图上**一个接一个**框出来（「是这几处」），框完结果单子才从下面浮上来；
- 单子上一条一行：公式按排好的样子显示（KaTeX），文字照原样；**默认全选**，点一行选上 / 取消；没把握的（把握 < 0.6）一行后面
  一个虚线圈的「?」；认错的点 ✎ 改（公式改 LaTeX），回车算数、Esc 不改；
- 底下两颗：「复制」——挑中的几条一行一条，公式写成 `$LaTeX$`，粘到别处还是公式；按钮上说一声「已复制 n 条」；
  「转为笔迹」——见第 5 节，和书上那一条一样大，写在圈的下面（下面出了屏幕就写在上面），一步撤销；写完是选中的（套索线圈着），
  选区条上「大小」那一排直接打开（缩小 / 百分比 / 放大，点百分比回到原来），接着就能拖、调大小、换色。

**没认成**

| 情况 | 小条上说 | 给不给「再试一次」 |
|---|---|---|
| 没认出东西 | 这一块没认出文字或公式（按钮「知道了」） | 不给 |
| 引擎出错 | 识别没成功 | 给 |
| 30 秒还没回来 | 等太久了，没认完 | 给 |
| 写不成笔迹 | 没能写成笔迹 | 不给 |

**都算取消**：点「取消」、按 Esc、笔又落到纸上、又圈了一块、翻页、换工具、引擎走了。取消以后才回来的结果一律不要。
取消不丢识别区域：人可以再点一次「识别」。

**减少动态效果**（系统设置）：不扫、不流动、不弹，只留静态的提示。

---

## 2. 引擎的形状

登记处在 `src/ocr/ocr-service.js`。

```js
import { registerOcrProvider } from './ocr/ocr-service.js';

const undo = registerOcrProvider({
  id: 'formula-int8',      // 唯一的名字；同一个 id 再登记一次就是换掉旧的
  label: '公式识别',        // 给人看的名字（可选）
  mock: false,             // 是模拟的就写 true，结果单子上会标「模拟」
  async recognize(request, { signal, onProgress }) {
    // 认的过程中可以 onProgress(0..1)；signal 被取消时尽早停下（抛什么都行，这边当作取消）
    return { items: [/* 见下面 */] };
  },
});
```

- 最后登记的那个在用；`useOcrProvider(id)` 指定用哪一个；`undo()` 或 `unregisterOcrProvider(id)` 撤掉。
- 套索上那颗「识别」按 `ocrAvailable()` 显隐；引擎来了、走了，画布会自己重画（`onOcrAvailabilityChange`）。
- 每一次认最多等 30 秒（`OCR_TIMEOUT_MS`），超了界面说「等太久了」，`signal` 也会被掐掉。

### 交给引擎的 `request`

| 字段 | 是什么 |
|---|---|
| `image` | 圈里那一块页面的图（`HTMLCanvasElement`）。按圈的大小**重新画**这一页（长边约 1600 像素，2～4 倍，整页像素有上限），裁出圈的外框，**圈外涂白**。只有书上印的东西，不含笔迹。 |
| `scale` | 图上几个像素是一个文档单位（页面 1 倍视口下的 CSS 像素）。 |
| `box` | 这张图在页面上的范围，文档坐标 `{minX, minY, maxX, maxY}`。 |
| `polygon` | 人圈的那一圈，文档坐标。 |
| `strokes` | 圈里的笔迹（矢量、文档坐标，`serializeStroke` 的格式）。认手写的引擎用得上，认印刷体的不看它。 |
| `pageNumber` | 第几页。 |
| `mode` | 现在总是 `'auto'`（字和公式都认）。 |
| `lang` | 界面语言（`zh-CN` / `zh-TW` / `en`）。 |

截图在 `src/pdf/pdf-pane.js` 的 `_captureRegion`。

### 引擎回的 `items`

```js
{ items: [
  { kind: 'text', text: '设函数 f(x) 在闭区间 [a, b] 上连续', confidence: 0.97, box: { x, y, width, height } },
  { kind: 'math', latex: '\\int_a^b f(x)\\,dx = F(b) - F(a)', confidence: 0.91, box: { x, y, width, height } },
] }
```

- `kind`：`'text'` 一段文字，`'math'` 一个公式。不写的话，有 `latex` 就当公式。
- `text`：给人看、给复制的文字；公式另带 `latex`。
- `confidence`：0..1，可选。低于 0.6 的一行打「?」。不必是校准过的概率，只用来提醒人看一眼。
- `box`：这一条在 `request.image` 上的位置（像素），可选。有就在图上把它框出来，转成笔迹时字高也照它；没有就不框。

收拾的规矩（`normalizeOcrItems`）：空的去掉，同样的去重，信心夹到 0..1，框里有一项不是数整个框不要，按次序编号。
引擎直接回一个数组也收。

---

## 3. 三条接法

### 3.1 原生（推荐）：接在已有的原生代理层上

仓库里本来就有一座桥（`src/native/native-proxy.js` ↔ `NativeProxyPlugin.java` ↔ `android/app/src/main/cpp/duiye_proxy.*`），
`ocr` 这一位现在挂着空实现（`NullService`，一律回 `UNIMPLEMENTED`）。**网页这一侧已经接好了**（`src/ocr/ocr-native.js`）：
开机那次探测（`app.js` 的 `probeNativeProxy`）看到 `describe` 里 `ocr` 报 `ready: true`，就把它登记成识别引擎，套索上的「识别」
随之出现。原生那边要做的：

1. 实现一个 `ocr` 服务，`describe()` 里报 `ready: true`；
2. `handle()` 收到的请求：`service: "ocr"`、`op: "recognize"`，`payload` 是 JSON：

   ```json
   { "image": "<PNG 的 base64，不带 data: 前缀>", "format": "png-base64",
     "width": 812, "height": 236, "scale": 2.6, "pageNumber": 55, "mode": "auto", "lang": "zh-CN" }
   ```

3. 可以分段回进度：`sink->chunk(R"({"progress":0.4})")`，小条上的百分比就是它；
4. 最后 `sink->done(json)`，两种回法都认：
   - 和网页引擎一样的 `{"items":[...]}`；
   - **自建公式模型原样的回法**（`ScratchFormulaRecognizer` 的结果）：`{"latex":"...","endedWithEos":true,"meanLogProbability":-0.05,"reasonCodes":[...]}`。
     整块当一个公式、不画框；`endedWithEos` 为 false 或 `reasonCodes` 里有 `NO_EOS` 的标「可能认得不准」；有 `EMPTY` 的当没认出；
     `meanLogProbability` 只拿来决定打不打「?」（取每个词平均的概率 `exp(mean)`），不当作准确率。
5. 人取消、等太久时会调 `cancel(requestId)`；拦得住就停，拦不住也没关系（迟到的结果网页这边不要）。

**接自建公式模型**（题目答案匹配引擎的 `ocr/`；现在用的是第十轮带缓存的 INT8：`encoder.onnx` + `decoder.onnx` + `tokenizer.json`，约 4.2 MB）：

- 运行器现在是 Java 写的（`ocr/android` 的 `ScratchFormulaRecognizer`，ONNX Runtime Android）。桥的服务接口是 C++ 的，所以二选一：
  在 `NativeProxyPlugin.java` 里把 `service` 为 `ocr` 的请求截下来交给 Java 运行器（`describe` 也由 Java 那边报 ocr 就绪），
  或者用 ONNX Runtime 的 C/C++ API 在 `duiye_proxy` 里写一个 `OcrService`。网页这一侧两种都一样。
- **预处理要照模型包里的 `metadata.json` 来**（运行器只收已经处理好的张量）：透明的地方合成到白底 → 灰度 → 裁出像素值小于 245
  的外框 → 保持比例、四周留 4 像素，用和 Pillow 一致的 LANCZOS 缩进 256 × 768 → 白底居中 → `像素 / 127.5 - 1`。
  送下去的 PNG 圈外已经是白的，正好合这一步的「裁外框」。
- 这个模型一次认**一个印刷公式**。圈里有好几行、有中文的话它认不了；要认整块，得在它前面加一个找行 / 分字和公式的检测，
  或者再接一个认文字的模型，结果拼成 `items` 回来就行（每一条带上 `box`，界面会框出来）。
- 模型说明里写着结果「总是要人核对」（`reviewRequired` 恒为 true）——结果单子就是那一步：默认全选、能改、能不要。

**现在的实现**（2026-10-12，走的是上面第一种：在 Java 里截下来）：

| 文件 | 管什么 |
|---|---|
| `android/app/src/main/java/io/github/lzy0105/duiye/proxy/FormulaOcrService.java` | `ocr` 那一位：拷模型、后台预热、一次跑一件、取消、回结果 |
| `android/app/src/main/java/io/github/lzy0105/duiye/proxy/NativeProxyPlugin.java` | `service` 为 `ocr` 的 submit / cancel 交给上面那个；describe 里用它顶替 C++ 的同名空位 |
| `android/app/src/main/java/com/answermatcher/ocr/ScratchFormulaRecognizer.java` | 运行器，从题目答案匹配引擎原样拷来 |
| `android/app/src/main/java/com/answermatcher/ocr/FormulaImagePreprocessor.java` | 与 Pillow 逐位一致的预处理，同上 |
| `android/app/src/main/assets/ocr/formula/` | 模型包：第十轮带缓存的 INT8（`scratch-formula-ocr-v1-kv`），ORT 格式（`encoder.ort`、`decoder.ort`，共约 4.9 MB），文件名记在 `model.properties` 的 `encoder_file` / `decoder_file` |
| `android/app/libs/onnxruntime-android-minimal-1.23.2.aar` | 精简版 ONNX Runtime 1.23.2：只含这个模型用到的 20 个算子，三个架构的原生库合计约 6 MB（官方包 56 MB）；怎么重编见 `android/ort-minimal/README.md` |
| `android/app/build.gradle` | 引用上面那个 AAR；原生库在 APK 里压缩存放。debug 包 22.0 MB（接 OCR 前 17.0 MB） |

- **模型：** 第一次用时从 APK 拷到私有目录（`noBackupFilesDir/ocr/formula-<编码器哈希前 12 位>`），换了模型就换一个目录、删掉旧的。运行器加载时逐个核哈希。开机就在后台线程上预热，不卡开机。
- **预处理：** 用 Java 照 Pillow 的整数算法重写（透明合成到白底、转灰度、裁外框、LANCZOS 缩放）。在桌面上和 Python 的预处理比过：1,900 张裁图（RGBA PNG，其中五分之一带半透明和全透明像素）输出的张量逐字节相同，脚本是匹配引擎的 `ocr/android/verify_preprocess.py`。
- **桌面一致性：** 同一个包在桌面上已和 Python 逐记号一致（`verify_parity.py`）。
- **圈里是白的：** 回 `reasonCodes: ["EMPTY"]`，网页说「这一块没认出文字或公式」。
- **取消：** 每生成一个记号前看一次取消标记，撤了就停，不回话。
- **还没验过：** 平板上的耗时、内存、和桌面结果是否一致，见 `docs/待实机验证.md` 第 55 条。

### 3.2 网页里（WebAssembly / onnxruntime-web 之类）

在开机时（比如 `app.js` 的 `start()` 里）登记一个引擎，模型放在 Web Worker 里跑，`recognize` 把 `request.image`
（`getImageData` 或 `convertToBlob`）交过去、把结果照第 2 节的格式回来。注意包的大小：模型和运行时都要进 APK。

### 3.3 模拟（开发用）

设置 → 开发者选项 → 打开「开发者模式」→「预览识别（模拟结果）」。只有两样都开着时才登记（`src/ocr/ocr-mock.js`）。它看不懂图：
按圈的形状给几条像样的示例（一段文字、一两个公式，带框），一秒半左右报完进度；圈得太小就说没认出。结果单子上标「模拟」。
用它看动画、走「挑 → 复制 → 转成笔迹」这条路。

---

## 4. 复制

挑中的几条按单子上的次序，一行一条：文字照原样，公式是 `$LaTeX$`。走系统剪贴板（`navigator.clipboard.writeText`，用不了就退回
隐藏文本框 + `execCommand('copy')`）。

---

## 5. 转成笔迹

`src/ocr/ink-typeset.js`。人在平板上试了真的识别以后说：转成笔迹显示的不该是 LaTeX，要是正常的公式；有些符号认对了、写出来
却不对；写出来的要大小合适，也要能放大缩小。下面每一步都是照这几句改的。

1. **公式交给 KaTeX 排**（`katex-ink.js`）——和结果单子上的预览是同一个排法，单子上看着什么样，写出来就是什么样。原来用自己的小排版
   （`latex-layout.js`），只认一百来个命令，认不得的照名字写出来，`\begin{cases}` 就写成了「begin cases」。
   - 自建公式模型的词表里有 443 个命令（`test/fixtures/formula-ocr-commands.json`），KaTeX 认得 414 个；剩下的换成意思一样的写法
     （`OCR_KATEX_MACROS`：`\upepsilon` → `\epsilon`、`\mbox` → `\text`、`\prescript`、`\sideset`……；`\buildrel … \over …` 改成
     `\stackrel`、`\raise` / `\lower` 去掉尺寸）。测试逐个确认每一个都排得出来。
   - 模型没写完的（到了长度上限、括号没配上）先补齐（`repairLatex`）：没关上的 `{`、`\left`、`\begin{…}` 按次序关上，多出来的右括号、
     `\end`、`\right` 不要。KaTeX 还报错，就按它报的位置把那一处删掉再排，末尾缺参数的补一个空组（`fitLatexForKatex`）——宁可少
     一个记号，也别整条变成红字。
   - 画成黑白图：在页面里排一份（看不见），等它用到的那几套 KaTeX 字体加载好，照排好的样子一个字一个字画到画布上（画布用的就是页面
     里已经加载的字体）；分数线、上划线、`\boxed` 的框是边框，照边框画；根号、长箭头、大括号是 SVG，照路径画。没有页面、拿不到
     KaTeX 时退回小排版。文字照原样一行，用系统字体画。
2. **抽中心线**（`skeleton.js`）：Guo–Hall 细化成一像素宽（原来的 Zhang–Suen 会把两三像素粗的斜线整条剥光，「×」只剩「\」）→ 按交叉数
   拆成折线 → 去掉碰着岔口的短毛刺 → **在尖角处拆成几笔** → 抽稀。笔迹是沿相邻采样点中点画平滑曲线的，一笔里拐直角会被抹成一大段
   圆弧（「+」在交叉处被拆成两条 L 形的线，一抹就成了错开的两个弯）；拆成几笔，每一笔都是直的或平滑的弯，多大都画得对。只拆尖角
   不拆弧线：窗口里拐过 50° 以上、而且窗口放大一倍拐的角度涨不到 1.35 倍（拐弯集中在一点）。细化以后一个像素都没留下的小块补一个点。
3. **照书上的大小**：在截给识别的那张图里量出这一条印着的墨的外框（`printedExtent`，给了框就只看框里），把写出来的那一条缩放到正好
   放得进去（宽、高取小的那个比例），左边对齐它。量不到（模拟识别的假图）就按估的字号（有框照框高，没有就按圈的高度分）。一个字
   夹在 4 到 96 个文档单位之间。
4. **摆在看得见的地方**：竖着一条接一条，整块默认在圈的下面；下面出了屏幕而上面放得下就摆到上面，右边出了屏幕就往左挪。
5. **成为一条条普通的钢笔笔迹**：颜色是工具栏当前的颜色，粗细按字号。整批是**一步撤销**；写完是选中的，选区条上「大小」那一排直接
   打开：缩小、放大一下各是 1.25 倍、一步撤销，以选区中心为准，笔的粗细跟着变；点百分比回到原来的大小；最多放大、缩小到原来的
   5 倍、五分之一。拖套索线上那颗把手也能缩放（同时转），只想变大变小的时候按钮更准。

笔迹和人手写的是同一种东西：能擦、能套、能换色，导出 PDF 时照样是矢量笔迹。

想换别的写法：`registerInkTypesetter(fn)`，`fn(items, {em, color, width})` 回 `Promise<{strokes, width, height, groups}>`——`groups`
是每一条自己的那几笔（`{strokes, em}`），调用方按书上的大小一条条缩放、摆放；不给 `groups` 就整批当一条。没有 2D 画布的地方（jsdom）
它说 `TYPESET_NO_CANVAS`，界面上是「没能写成笔迹」。

---

## 6. 文件一览

| 文件 | 管什么 |
|---|---|
| `src/ocr/ocr-service.js` | 引擎登记处、统一入口（取消、超时、进度、收拾结果） |
| `src/ocr/ocr-native.js` | 原生代理层 `ocr` 那一位 → 引擎 |
| `src/ocr/ocr-mock.js` | 模拟引擎（开发者选项） |
| `src/ocr/katex-ink.js` | 公式用 KaTeX 排（预览和写成笔迹共用）：补齐、换掉 KaTeX 不认的命令、画成黑白图 |
| `src/ocr/latex-layout.js` | 自己的小排版：KaTeX 用不了时的退路 |
| `src/ocr/skeleton.js` | 黑白图 → 单线笔画（Guo–Hall 细化、在尖角处拆笔） |
| `src/ocr/ink-typeset.js` | 认出来的几条 → 笔迹；量书上那一条印得多大（`printedExtent`） |
| `src/ink/ink-recognize.js` | 扫描动画、进度小条、结果单子 |
| `src/ink/ink-surface.js` | 识别区域、入口、取消、复制、写成笔迹（「识别（OCR）」那一节） |
| `src/ink/ink-selection-bar.js` | 套索那条上的「识别」「大小」 |
| `src/pdf/pdf-pane.js` | 截圈里那一块（`_captureRegion`） |
| `src/styles/ink-recognize.css` | 那一段界面的样子和动画；纸、液态玻璃另在 `paper.css`、`liquid-glass-react.css` |
| `test/test_ocr_recognize.js` | `npm run test:ocr` |
| `test/fixtures/formula-ocr-commands.json` | 自建公式模型词表里的全部命令（换了模型就照 tokenizer.json 重新生成） |
