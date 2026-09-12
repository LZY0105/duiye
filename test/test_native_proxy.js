#!/usr/bin/env node
// 原生代理层——那座桥，和桥两头还空着的两个位置。
//
// 这一层现在没有任何实现：问它 OCR，它回 UNIMPLEMENTED。所以这里能测的不是
// 「算得对不对」，而是「接口长得对不对」——而那恰好是预留一个接口时唯一要紧
// 的事：
//
//   1. 没有桥的时候（浏览器里跑、构建没带原生层）它失败得和「接上了但失败了」
//      是同一个形状，于是调用方只写一处错误处理。
//   2. 回音按 requestId 派信，不是谁先到算谁的。同时两件活在跑是常态。
//   3. 取消之后不再收这条的回音——迟到的 done 不该再把一条已经撤掉的请求点亮。
//   4. C++ 那几个文件真的在、真的接进了构建、插件真的登记了。一份从来没编译
//      过的接口和一份不存在的接口是一回事。

import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const $read = (f) => readFileSync(join(ROOT, f), 'utf-8');
const $has = (f) => existsSync(join(ROOT, f));

let passed = 0;
let failed = 0;
const group = (n) => console.log(`\n─── [${n}] ───`);
async function test(name, fn) {
  try { await fn(); passed++; console.log(`  ✅ ${name}`); }
  catch (err) { failed++; console.log(`  ❌ ${name}\n     ${err.message}`); }
}

/**
 * 一座假桥。submit 记下来，回音由测试自己按 requestId 发。
 *
 * `listenDelay` 是留给那条竞态的：真的 addListener 是异步的，而原生那一侧可以
 * 同步回话。把挂监听推迟一拍，就能把「先提交后挂监听」这个顺序错误照出来。
 * `answerSynchronously` 则让 submit 当场把结果发回来，正是库没加载、服务名不
 * 存在这两条路的样子。
 */
function fakeBridge({ listenDelay = 0, answerSynchronously = null } = {}) {
  const submitted = [];
  const cancelled = [];
  let emit = () => {};
  const send = (requestId, kind, data) => emit({ requestId, kind, data: JSON.stringify(data) });
  globalThis.Capacitor = {
    Plugins: {
      NativeProxy: {
        addListener(name, handler) {
          return new Promise((resolve) => {
            const install = () => {
              if (name === 'proxyEvent') emit = handler;
              resolve({ remove() { emit = () => {}; } });
            };
            if (listenDelay > 0) setTimeout(install, listenDelay);
            else install();
          });
        },
        submit(call) {
          submitted.push(call);
          if (answerSynchronously) send(call.requestId, ...answerSynchronously);
          return Promise.resolve({ requestId: call.requestId });
        },
        cancel(call) { cancelled.push(call); return Promise.resolve(); },
        describe() {
          return Promise.resolve({
            loaded: true,
            services: JSON.stringify({
              services: [
                { name: 'agent', ready: false, reason: 'no implementation registered' },
                { name: 'ocr', ready: true },
              ],
            }),
          });
        },
      },
    },
  };
  return { submitted, cancelled, send };
}

// 每个用例自己决定有没有桥，所以模块要在设过之后才引进来——它在模块顶层不碰
// Capacitor，每次调用才去看，这一条本身也值得被钉住。
const proxy = await import('../src/native/native-proxy.js');

/**
 * 等这一轮的事都办完。
 *
 * 提交不再是同步发出去的：监听要先挂上，而挂监听是异步的。所以「交出去了没有」
 * 要等到下一个宏任务才看得准——await 一个 Promise.resolve() 只翻过一个微任务，
 * 正好卡在半路上。
 */
const flush = () => new Promise((r) => setTimeout(r, 0));

/**
 * 等一件活落地，等不到就算它输。
 *
 * 这一层出错的样子正是「永远不落地」——回音落在空处，promise 既不 resolve 也不
 * reject。直接 await 的话，测试不是变红而是挂住，整个套件跟着停在那儿。给它一个
 * 期限，超了就是一条正常的失败。
 */
function within(promise, ms = 1500) {
  let timer;
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`等了 ${ms}ms 还没落地`)), ms);
    }),
  ]);
}

// ═══════════════════════════════════════════════════════════════
group('1. 没有桥的时候');

await test('没有原生层时，失败得和别的失败一个样', async () => {
  delete globalThis.Capacitor;
  const err = await proxy.recognize({ image: 'x' }).then(() => null, (e) => e);
  assert.ok(err, '不该悄悄成功');
  assert.equal(err.code, proxy.PROXY_ERRORS.NO_BRIDGE);
});

await test('没有桥也答得出「有没有」，形状一样', async () => {
  delete globalThis.Capacitor;
  const described = await proxy.describeProxy();
  assert.deepEqual(described, { loaded: false, services: [] });
});

await test('没有桥时 cancel 不炸', async () => {
  delete globalThis.Capacitor;
  const call = proxy.askAgent({ prompt: 'x' });
  call.catch(() => {});
  call.cancel();
});

// ═══════════════════════════════════════════════════════════════
group('2. 有桥的时候');

// 整组共用一座桥。模块只挂一次监听——真机上插件对象在整个进程里也只有一个，
// 每次请求都挂一个的话，一次会话下来会有几百个监听器为同一条事件做同样的分发。
// 所以测试也照这个来：换一座新桥等于把监听器丢在旧桥上。
const bridge = fakeBridge();
const freshBridge = () => { bridge.submitted.length = 0; bridge.cancelled.length = 0; return bridge; };

await test('交一件活下去，带着服务名和动作', async () => {
  const bridge = freshBridge();
  const call = proxy.recognize({ image: 'abc' });
  await flush();
  assert.equal(bridge.submitted.length, 1);
  assert.equal(bridge.submitted[0].service, 'ocr');
  assert.equal(bridge.submitted[0].op, 'recognize');
  assert.deepEqual(bridge.submitted[0].payload, { image: 'abc' });
  bridge.send(call.requestId, 'done', { text: 'x' });
  assert.deepEqual(await call, { text: 'x' });
});

await test('回音按 requestId 派信，不是谁先到算谁的', async () => {
  const bridge = freshBridge();
  const one = proxy.askAgent({ q: 1 });
  const two = proxy.askAgent({ q: 2 });
  await flush();
  // 故意倒过来回
  bridge.send(two.requestId, 'done', { answer: 2 });
  bridge.send(one.requestId, 'done', { answer: 1 });
  assert.deepEqual(await one, { answer: 1 });
  assert.deepEqual(await two, { answer: 2 });
});

await test('中间结果一段一段回来，最后才收尾', async () => {
  const bridge = freshBridge();
  const seen = [];
  const call = proxy.askAgent({ q: 'x' }, { onChunk: (c) => seen.push(c.text) });
  await flush();
  bridge.send(call.requestId, 'chunk', { text: '洛' });
  bridge.send(call.requestId, 'chunk', { text: '必达' });
  bridge.send(call.requestId, 'done', { text: '洛必达' });
  assert.deepEqual(await call, { text: '洛必达' });
  assert.deepEqual(seen, ['洛', '必达'], '分段是能分段用的，不分段的服务不用管它');
});

await test('失败带着原生层给的错误码上来', async () => {
  const bridge = freshBridge();
  const call = proxy.recognize({ image: 'x' });
  await flush();
  bridge.send(call.requestId, 'error',
    { code: 'UNIMPLEMENTED', message: 'ocr has no implementation registered yet' });
  const err = await call.then(() => null, (e) => e);
  assert.equal(err.code, 'UNIMPLEMENTED');
});

await test('撤回之后，迟到的那条回音不再点亮它', async () => {
  const bridge = freshBridge();
  const call = proxy.askAgent({ q: 'x' });
  await flush();
  call.cancel();
  const err = await call.then(() => null, (e) => e);
  assert.equal(err.code, proxy.PROXY_ERRORS.CANCELLED);
  assert.equal(bridge.cancelled.length, 1, '也要告诉原生层别算了');
  // 迟到的 done：不该抛，也不该把已经拒绝掉的那条再 resolve 一遍。
  bridge.send(call.requestId, 'done', { answer: 'too late' });
});

await test('哪一位接上了、哪一位还空着，分得清', async () => {
  freshBridge();
  assert.equal(await proxy.serviceReady(proxy.PROXY_SERVICES.OCR), true);
  assert.equal(await proxy.serviceReady(proxy.PROXY_SERVICES.AGENT), false,
    'ready:false 是「位置留着但还空着」，不是「有这个东西」');
});

// ═══════════════════════════════════════════════════════════════
group('3. 监听先挂上，再把活交下去');

await test('原生同步回话时，第一件活也接得住', async () => {
  // 这条是真会发生的：库没加载、服务名不存在，原生那一侧都在 submit 还没返回
  // 的时候就把结果发出来了。而 addListener 是异步的——先提交后挂监听的话，那
  // 条回音落在空处，promise 永远不落地。偏偏这正是这层还没接上时人碰到的第一
  // 种情况。
  //
  // 这一组自己起一座桥。模块记的是「监听挂在哪个对象上」，换了对象会自己重挂，
  // 所以这里不需要任何后门。
  delete globalThis.Capacitor;
  fakeBridge({
    listenDelay: 30,
    answerSynchronously: ['error', { code: 'NOT_LOADED', message: 'native proxy library is not present' }],
  });

  const err = await within(proxy.recognize({ image: 'x' })).then(() => null, (e) => e);
  assert.ok(err, '不该就这么悬着');
  assert.equal(err.code, 'NOT_LOADED');
});

await test('监听挂不上也不耽误把活递下去', async () => {
  delete globalThis.Capacitor;
  const bridge = fakeBridge();
  globalThis.Capacitor.Plugins.NativeProxy.addListener = () => Promise.reject(new Error('nope'));

  const call = proxy.askAgent({ q: 1 });
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(bridge.submitted.length, 1,
    '原生未必同步回话，晚一点挂上监听也还来得及——不能因此连递都不递');
  call.cancel();
  await call.catch(() => {});
});

await test('还没递下去就撤了，就别递了', async () => {
  delete globalThis.Capacitor;
  const bridge = fakeBridge({ listenDelay: 30 });
  const call = proxy.askAgent({ q: 1 });
  call.cancel();
  const err = await call.then(() => null, (e) => e);
  assert.equal(err.code, proxy.PROXY_ERRORS.CANCELLED);
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(bridge.submitted.length, 0, '撤掉的活不该再交下去');
});

// ═══════════════════════════════════════════════════════════════
group('4. 原生那一侧真的在');

await test('C++ 的四个文件都在', async () => {
  for (const f of ['CMakeLists.txt', 'duiye_proxy.h', 'duiye_proxy.cpp', 'jni_bridge.cpp']) {
    assert.ok($has('android/app/src/main/cpp/' + f), f + ' 不见了');
  }
});

await test('接口里两个位置都留着，而且空实现是诚实的', async () => {
  const header = $read('android/app/src/main/cpp/duiye_proxy.h');
  assert.ok(/kServiceAgent/.test(header) && /kServiceOcr/.test(header),
    'agent 和 ocr 两个位置都要留着');
  assert.ok(/class Sink/.test(header) && /virtual void chunk/.test(header),
    '结果要能一段一段回来——只在算完才开口的模型，在人这一侧和卡死没区别');
  assert.ok(/virtual void cancel/.test(header), '长任务必须撤得回来');

  const impl = $read('android/app/src/main/cpp/duiye_proxy.cpp');
  assert.ok(/kErrUnimplemented/.test(impl),
    '还没接上就说还没接上，不假装成功也不假装还在算');
  assert.ok(/"ready\\":false/.test(impl.replace(/\\\\/g, '\\')) || /ready.*false/.test(impl),
    'describe 要说清自己没装');
});

await test('构建真的会编它，而且三个架构都带上', async () => {
  const gradle = $read('android/app/build.gradle');
  assert.ok(/externalNativeBuild/.test(gradle), 'cpp 要接进 gradle');
  assert.ok(/src\/main\/cpp\/CMakeLists\.txt/.test(gradle));
  assert.ok(/arm64-v8a/.test(gradle) && /armeabi-v7a/.test(gradle));
});

await test('插件在建桥之前登记，否则网页那边找不到它', async () => {
  const main = $read('android/app/src/main/java/com/latexsnipper/app/MainActivity.java');
  const at = main.indexOf('registerPlugin(NativeProxyPlugin.class)');
  // 带括号的那个才是调用；不带的那个是注释里在讲这件事。
  const superAt = main.indexOf('super.onCreate(');
  assert.ok(at > 0, '插件没登记');
  assert.ok(at < superAt, 'Capacitor 是在 onCreate 里建桥的，晚一步就注入不进去了');
});

await test('JNI 两头对得上名字', async () => {
  const java = $read('android/app/src/main/java/com/latexsnipper/app/proxy/NativeProxy.java');
  const cpp = $read('android/app/src/main/cpp/jni_bridge.cpp');
  assert.ok(/public static void onNativeEvent\(String requestId, String kind, String json\)/.test(java));
  assert.ok(/"onNativeEvent"/.test(cpp) && /Ljava\/lang\/String;Ljava\/lang\/String;Ljava\/lang\/String;\)V/.test(cpp),
    'C++ 是按字符串找这个方法的，改名必须两边一起改');
  assert.ok(/com\/latexsnipper\/app\/proxy\/NativeProxy/.test(cpp), '类名也是按字符串找的');
});

await test('发布版里那个回调必须被 keep 住', async () => {
  // 实测：拿掉这条规则，R8 会把 onNativeEvent 改名成 c（不是删掉——它经由
  // submit 可达），于是 GetStaticMethodID 拿到 null、JNI_OnLoad 返回 JNI_ERR、
  // System.loadLibrary 抛 UnsatisfiedLinkError，整层安静地消失。而类名反倒还在，
  // 看起来像「库装上了却不动」。debug 构建不混淆，所以只在发布版发作。
  const rules = $read('android/app/proguard-rules.pro');
  assert.ok(/-keep class com\.latexsnipper\.app\.proxy\.NativeProxy\s*\{[^}]*\*;[^}]*\}/.test(rules),
    'C++ 按字符串找 onNativeEvent，它的名字必须留住');
});

await test('错误消息是转义进去的，不是拼进去的', async () => {
  // 消息里带引号、反斜杠、换行都很正常——一个文件路径就够了。拼坏的 JSON 到了
  // JS 那一侧会退成 {raw:...}，error.code 变成 UNKNOWN，恰好在出错的时候把
  // 「为什么错」弄丢。
  const cpp = $read('android/app/src/main/cpp/jni_bridge.cpp');
  const fail = cpp.slice(cpp.indexOf('void fail('), cpp.indexOf('void fail(') + 600);
  assert.ok(/jsonQuote\(code\)/.test(fail) && /jsonQuote\(message\)/.test(fail),
    '错误码和消息都要过转义');
  const header = $read('android/app/src/main/cpp/duiye_proxy.h');
  assert.ok(/std::string jsonQuote\(/.test(header), '转义函数要公开，两个文件都用得上');
});

await test('服务是共享持有的，换实现不会把正在跑的那件活踩空', async () => {
  // 一件活可能在自己的线程上跑好几秒，而这期间别人可以 registerService 换掉
  // 同名的实现。登记处要是只用 unique_ptr，一松手正在跑的那条线程手里就是个
  // 已经析构的对象。
  const header = $read('android/app/src/main/cpp/duiye_proxy.h');
  assert.ok(/std::shared_ptr<Service> findService\(/.test(header));
  assert.ok(/void registerService\(std::shared_ptr<Service>/.test(header));
  const cpp = $read('android/app/src/main/cpp/jni_bridge.cpp');
  assert.ok(!/duiye::Service\* service/.test(cpp), 'JNI 那边也不能退回裸指针');
});

await test('没有把语言特性关掉——这层是留给别人插东西的', async () => {
  // 模型运行时、识别引擎、JSON 库大多要用异常；-fno-rtti 还会让 dynamic_cast
  // 不能用。而且 std::thread 和 make_shared 本身会抛，关掉异常的话它们失败时
  // 直接 terminate。
  // 只看那一行 cppFlags。整份文件里还有一段注释在讲「为什么不关」——上一次
  // 就是这样，定位被自己的散文骗了。
  const gradle = $read('android/app/build.gradle');
  const flags = gradle.match(/cppFlags[^\r\n]*/);
  assert.ok(flags, 'cppFlags 那一行得在');
  assert.ok(!/-fno-exceptions/.test(flags[0]));
  assert.ok(!/-fno-rtti/.test(flags[0]));
});

await test('一个编号只能有一件活在飞', async () => {
  const java = $read('android/app/src/main/java/com/latexsnipper/app/proxy/NativeProxy.java');
  assert.ok(/putIfAbsent/.test(java),
    '重号会让后来的 sink 顶掉前一个，于是前一件活的回音落到后一件手里');
  const plugin = $read('android/app/src/main/java/com/latexsnipper/app/proxy/NativeProxyPlugin.java');
  assert.ok(/already in flight/.test(plugin), '收不下就说清楚，不要默默丢掉');
});

await test('库加载不上不算错误，只是「还没接」', async () => {
  const java = $read('android/app/src/main/java/com/latexsnipper/app/proxy/NativeProxy.java');
  assert.ok(/catch \(UnsatisfiedLinkError/.test(java),
    '设备架构对不上不该让整个 app 起不来——代理层是留着以后接东西的，不是读书必需的');
});

console.log('\n═══════════════════════════════════════════════════════════════');
console.log(`  ${passed} passed, ${failed} failed`);
console.log('═══════════════════════════════════════════════════════════════\n');
process.exit(failed ? 1 : 0);
