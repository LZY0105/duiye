// Service Worker — keeps the app's own files available offline.
//
// The cache name is what evicts the previous one: `activate` deletes every
// cache whose key is not this. It was `latexsnipper-v1`, and that cache could
// be holding several hundred megabytes of ONNX weights on anyone who ran an
// older build — the recognition stack this app no longer has. Renaming it is
// how they get that space back.
const CACHE_NAME = 'duiye-v1';

/**
 * What has to be present before the app can start.
 *
 * Exactly the files index.html asks for by name on every load, plus the pdf.js
 * worker, which it spawns the moment a document is opened. Nothing else:
 *
 *  - The application bundle is emitted by Vite under content-hashed names that
 *    change on every build, so it cannot be listed here at all. The fetch
 *    handler below is network-first and caches it on the way past, which is
 *    the right policy for it anyway — a stale bundle is worse than a slow one.
 *  - Character maps (168 of them), the standard PDF fonts and the KaTeX and
 *    MathLive glyph files are fetched only when a document actually needs
 *    them. Pre-caching all 245 would spend a long first start on files most
 *    readers never touch; the fetch handler keeps each one it is asked for.
 *
 * This list was 17 entries and 13 of them did not exist. They named the ONNX
 * runtime, the formula-recognition models and an icon, all removed with the
 * recognition stack. Each failure was caught and warned about individually, so
 * nothing broke — it just logged thirteen warnings on every install and cached
 * four files.
 */
const PRE_CACHE = [
  '/',
  '/manifest.json',
  '/icon.svg',
  '/vendor/pdf.min.js',
  '/vendor/pdf.worker.min.js',
  '/vendor/katex.min.js',
  '/vendor/katex.min.css',
  '/vendor/mathlive/mathlive.min.js',
  '/vendor/mathlive/mathlive-fonts.css',
];

// Install — put the starting set in the cache
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      // One at a time, so a single missing file cannot fail the whole install
      // and leave the app with no cache at all.
      return Promise.allSettled(
        PRE_CACHE.map((url) =>
          cache.add(url).catch((err) => {
            console.warn('SW: failed to cache', url, err.message);
          })
        )
      );
    }).then(() => self.skipWaiting())
  );
});

// Activate — clean old caches
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))
      )
    ).then(() => self.clients.claim())
  );
});

// Fetch — cache first, then network
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // Skip non-GET requests
  if (event.request.method !== 'GET') return;

  // Vendored libraries, character maps and fonts: cache first.
  //
  // These are third-party builds pinned into the repository — they do not
  // change between app builds, so the copy in the cache is always the right
  // answer and going to the network for them is pure latency. This used to
  // name `/models/` and `/ort/`, neither of which exists any more, and the
  // extensions it tested for (.wasm, .otf) match nothing in the tree; so the
  // 168 character maps a Chinese textbook needs were being re-fetched under
  // the network-first rule below, one per font, on every start.
  if (url.pathname.startsWith('/vendor/')) {
    event.respondWith(
      caches.match(event.request).then((cached) => {
        if (cached) return cached;
        return fetch(event.request).then((response) => {
          const clone = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
          return response;
        });
      })
    );
    return;
  }

  // For HTML, JS, CSS: network first, fallback to cache
  event.respondWith(
    fetch(event.request)
      .then((response) => {
        const clone = response.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
        return response;
      })
      .catch(() => caches.match(event.request))
  );
});
