// Service worker: app shell + Quran text/translation/timings cached for offline use.
// Recitation audio is saved separately (on request) by the app in the "qm-audio" cache.
const VERSION = '2026.11.26-1';
const SHELL_CACHE = `qm-shell-${VERSION}`;
const DATA_CACHE = 'qm-data-v1';
const KEEP = new Set([SHELL_CACHE, DATA_CACHE, 'qm-audio', 'qm-recite']);

const SHELL = [
  './',
  './index.html',
  './css/styles.css',
  './js/app.js',
  './js/api.js',
  './js/player.js',
  './js/marker.js',
  './js/storage.js',
  './js/ui.js',
  './js/revision.js',
  './js/context.js',
  './js/search.js',
  './js/pages.js',
  './data/pages.json',
  './js/recite/engine.js',
  './js/recite/mel.js',
  './js/recite/mic.js',
  './js/recite/client.js',
  './js/recite/session.js',
  './js/recite/worker.js',
  './manifest.webmanifest',
  './icons/icon.svg',
  './fonts/kfgqpc-uthmanic-hafs.otf',
  './icons/icon-192.png',
  './icons/icon-512.png',
];

const DATA_HOSTS = new Set([
  'api.quran.com',
  'mp3quran.net',
  'www.mp3quran.net',
  'fonts.googleapis.com',
  'fonts.gstatic.com',
]);

self.addEventListener('install', (event) => {
  // cache: 'reload' bypasses the browser's HTTP cache, so an update never re-stores old files.
  event.waitUntil(
    caches.open(SHELL_CACHE)
      .then((c) => c.addAll(SHELL.map((u) => new Request(u, { cache: 'reload' }))))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('message', (event) => {
  if (event.data === 'version') event.source.postMessage({ version: VERSION });
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => !KEEP.has(k)).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

// App files: always try the network first (fresh code after every update), cache when offline.
async function networkFirst(request, fallbackUrl) {
  const cache = await caches.open(SHELL_CACHE);
  try {
    const res = await fetch(request, { cache: 'no-cache' });
    if (res.ok) cache.put(request, res.clone());
    return res;
  } catch {
    return (await cache.match(request)) || (fallbackUrl && (await cache.match(fallbackUrl))) || Response.error();
  }
}

// Quran data: serve from cache straight away, refresh it in the background.
async function staleWhileRevalidate(cacheName, request, fallbackUrl) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request, { ignoreSearch: false });
  const network = fetch(request)
    .then((res) => {
      if (res.ok || res.type === 'opaque') cache.put(request, res.clone());
      return res;
    })
    .catch(() => null);
  if (cached) return cached;
  const res = await network;
  if (res) return res;
  if (fallbackUrl) {
    const fb = await cache.match(fallbackUrl);
    if (fb) return fb;
  }
  return Response.error();
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET' || req.headers.has('range')) return;
  const url = new URL(req.url);

  // The recitation checker's large files (model, WebAssembly): from the one-time download, never re-fetched.
  if (url.origin === self.location.origin && /\/(models|vendor)\//.test(url.pathname)) {
    event.respondWith(caches.open('qm-recite').then((c) => c.match(req)).then((hit) => hit || fetch(req)));
    return;
  }
  if (url.origin === self.location.origin) {
    const fallback = req.mode === 'navigate' ? './index.html' : null;
    event.respondWith(networkFirst(req, fallback));
  } else if (DATA_HOSTS.has(url.hostname)) {
    event.respondWith(staleWhileRevalidate(DATA_CACHE, req));
  }
  // Everything else (including streamed audio) goes straight to the network.
});
