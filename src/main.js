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

import { bootstrap } from './core/bootstrap.js';
import { createApp, start } from './core/app.js';

await bootstrap();
await createApp();
await start();
