// Çevrimdışı çalışma için basit önbellek. three.js CDN'den geldiği için
// 3B önizleme çevrimdışı devre dışı kalır; tasarım ve G-code üretimi çalışır.

const CACHE = 'cnc-oyma-v2';
const ASSETS = [
  './',
  './index.html',
  './app.css',
  './manifest.webmanifest',
  './assets/icon.svg',
  './js/main.js',
  './js/pattern.js',
  './js/stl.js',
  './js/tool.js',
  './js/toolpath.js',
  './js/gcode.js',
  './js/export.js',
  './js/preview.js',
  './js/view3d.js',
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE)
      .then((c) => c.addAll(ASSETS))
      .then(() => self.skipWaiting())
      .catch(() => {})
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  // Ağ öncelikli, çevrimdışında önbellek: geliştirirken bayat dosya sorunu olmaz.
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(e.request, copy)).catch(() => {});
        return res;
      })
      .catch(() => caches.match(e.request).then((r) => r || caches.match('./index.html')))
  );
});
