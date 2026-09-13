// Service Worker —— 让这个应用在没有网络时也打得开。
//
// 说明一句它在这个工程里的位置：装成 APK 时，页面是 Capacitor 从包里用本地
// HTTP 服务器发出来的，本来就不依赖网络，这一层几乎不起作用。真正需要它的是
// 浏览器那条路 —— 加到主屏幕之后当 PWA 用。两条路共用一份代码，所以下面的策略
// 要在「本地服务器，永远秒回」和「真的断网」两种情况下都说得通。

// 缓存名就是上一代缓存的死刑判决书：activate 里会删掉所有名字不是它的缓存。
//
// 它曾经叫 latexsnipper-v1。那个缓存在跑过旧版本的人机器上可能压着几百兆的
// ONNX 权重 —— 那套识别栈这个应用已经没有了。改名就是把那块空间还回去的办法。
const CACHE_NAME = 'duiye-v1';

/**
 * 启动前必须就位的文件。
 *
 * 只有两类：index.html 每次加载都点名要的，加上 pdf.js 的 worker —— 打开任何
 * 一份文档的那一瞬间就要用它。别的都不进这张表：
 *
 *  - 应用代码由 Vite 按内容哈希命名，每次构建都换名字，根本没法写死在这里。
 *    下面的 fetch 处理器对它走「网络优先、顺手缓存」，这对它本来也是对的策略：
 *    一份过期的代码比一次慢启动糟得多。
 *  - 字符映射表（168 个）、PDF 标准字体、KaTeX 字形，是某份文档真的需要时才去
 *    取的。全部预缓存要拿第一次启动的漫长等待去换大多数人根本不会碰的文件；
 *    fetch 处理器会把每一个被要过的留下来。
 *
 * 这张表曾经有 17 项，其中 13 项指向不存在的文件 —— ONNX 运行时、公式识别模型
 * 和一个图标，都随识别栈一起没了。每一次失败都被单独 catch 并警告，所以没有
 * 出错，只是每次安装打印十三条警告然后缓存了四个文件。
 *
 * test_ui_interactions.js 盯着这张表：每一项都必须在源码树里真的存在。
 */
const PRE_CACHE = [
  '/',
  '/manifest.json',
  '/icon.svg',
  '/vendor/pdf.min.js',
  '/vendor/pdf.worker.min.js',
  '/vendor/katex.min.css',
];

/** 这条响应值不值得留下来。
 *
 * 原来这里什么都往缓存里塞，包括 404 和 500。塞进去之后，网络优先那条路的
 * `.catch(() => caches.match(...))` 会在下次断网时把那个 404 当成答案端出来 ——
 * 一次偶然的失败就这样变成了永久的失败。
 *
 * 206 单独挡掉：Cache API 拒绝存部分响应，`cache.put` 会抛 TypeError，而那是
 * 一个没人接的 promise 拒绝。
 */
function worthCaching(response) {
  return response && response.ok && response.status === 200 && response.type !== 'opaque';
}

/** 存一份，但存不进去不算错。
 *
 * 缓存写失败（配额满、隐私模式、存储被清）不该影响这次请求本身 —— 请求已经
 * 拿到响应了。所以这里吞掉异常，而不是让它冒泡成未处理的拒绝。
 */
function remember(request, response) {
  if (!worthCaching(response)) return;
  const copy = response.clone();
  caches.open(CACHE_NAME)
    .then((cache) => cache.put(request, copy))
    .catch(() => {});
}

/** 缓存优先：有就直接给，没有才去取。 */
async function cacheFirst(request) {
  const hit = await caches.match(request);
  if (hit) return hit;
  const response = await fetch(request);
  remember(request, response);
  return response;
}

/** 网络优先：取得到就用新的，取不到才回缓存。 */
async function networkFirst(request) {
  try {
    const response = await fetch(request);
    remember(request, response);
    return response;
  } catch (err) {
    const hit = await caches.match(request);
    if (hit) return hit;
    throw err;
  }
}

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    // 一个一个加，而不是 cache.addAll。addAll 是全有或全无：少一个文件，整次
    // 安装就失败，应用最后一个缓存都没有。宁可缺一个也要把其余的留下。
    const results = await Promise.all(PRE_CACHE.map(
      (url) => cache.add(url).then(() => null, (err) => `${url}: ${err.message}`),
    ));
    const failed = results.filter(Boolean);
    if (failed.length) console.warn('SW: 这些文件没能预缓存 —', failed.join('; '));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names.filter((n) => n !== CACHE_NAME).map((n) => caches.delete(n)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const { request } = event;

  // 只管 GET。POST 之类有副作用，缓存它们没有意义，重放它们是危险的。
  if (request.method !== 'GET') return;

  // 跨源的一概不管，交还给浏览器。这个应用唯一的外部请求是启动时问一次
  // GitHub 的 Releases API —— 那是一条「此刻有没有新版」的问题，缓存它只会
  // 让答案永远停在第一次问到的那个。
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // vendor/ 下面是钉死在仓库里的第三方构建产物：pdf.js、字符映射表、字体。
  // 它们不随应用版本变化，缓存里那份永远是对的，为它们走一趟网络是纯粹的延迟。
  //
  // 这条规则原来点名的是 /models/ 和 /ort/ —— 两个都不存在了 —— 而它判断的
  // 扩展名（.wasm、.otf）在这棵树里一个都匹配不上。于是一本中文教材要用的
  // 168 张字符映射表，每次启动都按下面的网络优先规则重新取一遍，一种字体一次。
  event.respondWith(
    url.pathname.startsWith('/vendor/') ? cacheFirst(request) : networkFirst(request),
  );
});
