// Caches the app so it opens without a connection. Speech recognition and
// summaries still need the network; recordings live in IndexedDB, not here.
const CACHE = 'verbatim-v1';
const SHELL = [
  './',
  'index.html',
  'styles.css',
  'app.js',
  'engine.js',
  'store.js',
  'export.js',
  'summary.js',
  'markdown.js',
  'util.js',
  'vendor/anthropic-sdk.mjs',
  'manifest.webmanifest',
  'icons/icon.svg',
  'icons/icon-180.png',
  'icons/icon-192.png',
  'icons/icon-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

// Serve from cache right away and refresh it in the background, so a new
// version shows up on the next launch.
self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET' || new URL(request.url).origin !== self.location.origin) return;
  event.respondWith(
    caches.open(CACHE).then(async (cache) => {
      const cached = await cache.match(request, { ignoreSearch: true });
      const network = fetch(request)
        .then((res) => {
          if (res.ok) cache.put(request, res.clone());
          return res;
        })
        .catch(() => null);
      if (cached) {
        event.waitUntil(network);
        return cached;
      }
      const res = await network;
      return res || (request.mode === 'navigate' ? cache.match('index.html') : Response.error());
    }),
  );
});
