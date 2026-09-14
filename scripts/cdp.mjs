#!/usr/bin/env node
// 驱动平板上那个 WebView。
//
// 用法：node cdp.mjs "<一段 JS>"   —— 在页面里求值，把结果打出来
//      node cdp.mjs --file x.js   —— 同上，但 JS 从文件读（长脚本用这个）
//
// 走的是 Chrome DevTools Protocol。前提是外面已经做过：
//   adb forward tcp:9333 localabstract:webview_devtools_remote_<pid>
//
// 求值是 awaitPromise 的：应用里大半件事都是异步的，同步取值只会拿到 Promise。

import { readFileSync } from 'node:fs';

const PORT = process.env.CDP_PORT || 9333;

async function targetUrl() {
  const res = await fetch(`http://127.0.0.1:${PORT}/json/list`);
  const list = await res.json();
  const page = list.find(t => t.type === 'page' && t.webSocketDebuggerUrl);
  if (!page) throw new Error('没有可连的页面：' + JSON.stringify(list.map(t => t.type)));
  return page.webSocketDebuggerUrl;
}

function connect(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.addEventListener('open', () => resolve(ws), { once: true });
    ws.addEventListener('error', (e) => reject(new Error('连不上：' + (e.message || 'ws error'))), { once: true });
  });
}

async function main() {
  const args = process.argv.slice(2);
  const expression = args[0] === '--file'
    ? readFileSync(args[1], 'utf-8')
    : args.join(' ');
  if (!expression.trim()) throw new Error('没有给要求值的 JS');

  const ws = await connect(await targetUrl());
  let id = 0;
  const pending = new Map();
  ws.addEventListener('message', (event) => {
    const msg = JSON.parse(event.data);
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    }
  });
  const send = (method, params) => new Promise((resolve) => {
    const mine = ++id;
    pending.set(mine, resolve);
    ws.send(JSON.stringify({ id: mine, method, params }));
  });

  const reply = await send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
    allowUnsafeEvalBlockedByCSP: true,
  });
  ws.close();

  const result = reply.result;
  if (result?.exceptionDetails) {
    console.error('页面里抛了：', result.exceptionDetails.exception?.description
      || result.exceptionDetails.text);
    process.exit(1);
  }
  const value = result?.result?.value;
  console.log(typeof value === 'string' ? value : JSON.stringify(value, null, 1));
}

main().catch((err) => { console.error(err.message); process.exit(1); });
