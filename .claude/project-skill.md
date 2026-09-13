# 对页 — 项目维护指南

这份文件给接手这个仓库的人（或 agent）看。它只描述**现在的代码**；早先那一版讲的
是已经被移除的 OCR 应用——识别引擎、ONNX 模型清单、Pandoc 导出、公式编辑器——那些
东西一样都不在了，整份重写。想追那段历史去
[strangelion/LaTeXSnipper_mobile](https://github.com/strangelion/LaTeXSnipper_mobile)。

## 这个软件是什么

一个平板上的**教材批注应用**。两栏并排开 PDF，用笔在上面写字，并在练习册和答案册
之间自动对题。全部离线，数据不出设备。

## 代码规范

- JS 用 ES Module（`import` / `export`），没有打包期以外的构建魔法
- **状态先写成纯函数**（`*-state.js`、`scratch-camera.js`、`scratch-style.js`），
  再由编排层接 DOM。这是这个仓库里绝大多数验收保证能在 Node 里被证明的原因——
  测试跑的是真逻辑，不是 DOM 替身
- 所有用户可见文本走 `data-i18n` 属性或 `t()`，**不写死**。三种语言都要加
- 内联事件用 `pointerdown` 而不是 `click`（WebView 兼容，而且笔比手指先到）
- 改 `public/` 下的文件之后要重新 `npm run build`
- 注释说**为什么**，不说做了什么。特别是：这一行在修哪个具体的故障
- 提交署名带 `Co-Authored-By` 行，跟随仓库既有历史

## 目录

```
duiye/
├── index.html              单页两个 Tab：练习 / 设定
├── public/vendor/          pdf.js、cmaps、standard_fonts、KaTeX 字体
├── src/
│   ├── main.js             入口：bootstrap → createApp → start
│   ├── core/               bootstrap、app、crash-guard、logger、i18n、lang/
│   ├── pdf/                工作区、文档库、对题（46 个模块）
│   │   ├── deck-state.js          纯：一栏一个有序队列 + 当前项
│   │   ├── workspace-state.js     纯：两栏布局、比例、互换、专注、收起
│   │   ├── pdf-view-state.js      纯：单栏的页码 / 缩放 / 平移
│   │   ├── document-session.js    会话持久化；view 按 entry 记而不是按栏
│   │   ├── pdf-workspace.js       编排：交接事务、切换、移动、对题、Agent
│   │   ├── pdf-workspace-ui.js    导入、文档库、书架、顶栏收起手势
│   │   ├── pdf-pane.js            单栏 PDF：手势、翻页、位图缓存、笔迹装卸
│   │   ├── book-shelf.js          书架；book-open.js 是翻书那一下的动画
│   │   ├── user-guide.js          使用说明，图是画的不是截的
│   │   ├── agent-panel.js         Agent 面板（@WangJiyi）
│   │   └── …                      21 个匹配引擎模块
│   ├── ink/                矢量笔迹层，PDF 和草稿纸共用
│   │   └── ink-shared.js          同一页开在两栏时共用同一层（A09）
│   ├── scratch/            无限草稿纸：世界坐标相机、八种底纹
│   ├── agent/              agent-client.js → 127.0.0.1:8787（见下）
│   ├── native/             native-proxy.js → NativeProxy 插件（见下）
│   ├── ui/、settings/、export/
│   └── styles/             base / pdf / scratch / deck / ink-toolbar / mobile /
│                           material
├── native/agent-proxy/     独立的 C++ HTTP 服务，**不随 APK 走**（见下）
├── android/                Capacitor；app/src/main/cpp 是进程内的原生代理层
└── test/                   37 个文件，入口只有 `npm test`
```

### 原生层现在是两套，互不相通

接 OCR 或改 Agent 之前先看这一节，否则会往错的那一套上加东西。

**① 进程内的 JNI 桥**——`src/native/native-proxy.js` ↔ `NativeProxyPlugin.java`
↔ `jni_bridge.cpp` ↔ `duiye_proxy.cpp`，编成 `libduiye_proxy.so` 随 APK 走。
它有 `agent` 和 `ocr` 两个位置，都还空着（`ready: false`）。

**除了开机那次探测（`app.js` 的 `probeNativeProxy`），应用里零调用。**

**② 本机 HTTP 代理**——`src/agent/agent-client.js` 用 `fetch` 打
`http://127.0.0.1:8787/v1/agent/answer`，另一头是 `native/agent-proxy/` 那个
独立的 C++ 程序（cpp-httplib）。`pdf-workspace.js` 在用它。

**但那个程序不在 APK 里**：`android/app/src/main/cpp/CMakeLists.txt` 只编
`duiye_proxy.cpp` 和 `jni_bridge.cpp`，`native/agent-proxy/` 是另一个 CMake 工程，
没有任何构建步骤打包它、也没有任何代码启动它。所以**平板上 8787 没人在听**，
Agent 面板按下去总是「无法连接本地 Agent 代理」。它是开发期的原型
（在电脑上跑起来，再 `adb reverse tcp:8787 tcp:8787` 转过去）。

要接 OCR，走 ①：它随 APK 走、不需要另一个进程、位置已经留好了。

### 新增功能落在哪里

- **一种队列操作** → `deck-state.js` 加纯函数 → `workspace-state.js` 包一层 →
  `pdf-workspace.js` 接线。前两层是纯的，只有第三层碰 DOM
- **一种草稿纸底纹** → `scratch-style.js` 的 `PATTERNS` 加一项 →
  `scratch-background.js` 的 switch 加一个分支 → 语言包加 `pattern.PXX`
- **一处用户可见文案** → 三个语言包都加。漏了会显示裸键（i18n 故意这么设计）

## 多语言

```
setLang(code) → 换词表 → translateDOM() 批量重写 → onLangChange 回调
```

- 静态 HTML：`data-i18n` / `data-i18n-html` / `data-i18n-title`
- 动态 JS：`import { t } from './core/i18n.js'`
- 现有三种：`zh-CN`、`zh-TW`、`en`。日文和韩文撤掉了，i18n 那一层没动——
  把词表放回 `src/core/lang/`、在 `LANGUAGES` 里加一行就回来
- 词表里查不到的键会落回简体中文；简体也没有才显示裸键

## 测试

`npm test` 跑全部 37 个文件。没有 watch，没有分组——一条命令，全绿或者不绿。

大部分测试不需要 DOM：状态模块是纯的，所以「换文件之后页码不串」「同一页两栏共用
一层笔迹」这类保证是在 Node 里被证明的，不是靠点击模拟。需要 DOM 的用 jsdom。

还有一类是**接线测试**：读源码检查某个调用确实存在（例如「装笔迹层必须过登记
处」）。它们看起来笨，但挡住的正是重构时最容易断的那种连接。

## 构建

```bash
npm run build            # 只出 dist/
npm run build:android    # dist/ + cap sync
```

Windows 上从 Gradle 命令行构建要绕开非 ASCII 路径——四条路径都得是 ASCII，
见 `docs/BUILD_WINDOWS_NON_ASCII_PATH.md`。Android Studio 没有这个问题。

## 真机验证

改动里凡是只有真机能回答的（手感、时序、原生层），记在
`docs/待实机验证.md`，插上平板照着走。单元测试和构建产物能回答的不往那里记。
