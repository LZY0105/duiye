// 入口。这里只做两件事：按顺序引入样式，然后把启动的三步走一遍。
//
// 样式的**顺序就是层级**——后引入的覆盖先引入的，所以这一串不能重排。每一处
// 需要解释的地方都在下面注掉了原因。
//
// 启动分三步而不是一个函数，是因为它们失败的后果不同：bootstrap 挂了整个页面
// 是空的，createApp 挂了骨架在但没有内容，start 挂了界面在但不响应。分开写，
// 崩溃守卫的堆栈就能直接告诉你停在哪一步。

import './styles/base.css';
import './styles/pdf.css';
// After pdf.css: a scratchpad shares the slot chrome and then takes away the
// page boundaries the PDF pane draws — see the note at the top of the file.
import './styles/scratch.css';
// The switching strip, the content list and the dialogs the decks need.
import './styles/deck.css';
import './styles/ink-toolbar.css';
import './styles/mobile.css';
// Last: the material tier system is the authority on which layer a surface
// belongs to (chrome = glass, content = sharp, controls = fills).
import './styles/material.css';
// 在分层之后：玻璃皮肤的外观（颜色、字、形状、阴影、图标），液态玻璃和毛玻璃都穿它。它只在
// material.css 分好的那一层里把东西做好看，不把任何东西搬到另一层去。
import './styles/liquid.css';
// 液态玻璃里那几块真的液态玻璃（照 liquid-glass-react 挂上去的层）：要压过 liquid.css 给这些
// 胶囊、按钮的底色和磨砂，所以在它后面。只认 data-glass="liquid"，和毛玻璃、纸不相干。
import './styles/liquid-glass-react.css';
// 最后：「纸」的材质。尺寸和排法和玻璃是同一套（上面那一份），这里只换颜色、边和影子。
import './styles/paper.css';

import { bootstrap } from './core/bootstrap.js';
import { createApp, start } from './core/app.js';

await bootstrap();
await createApp();
await start();
