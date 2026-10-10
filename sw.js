/* Rishi Music service worker
   Caches the app files so the app opens offline.
   Your songs are NOT stored here. They live in IndexedDB (see app.js).
   Paths are relative, so this works at https://<username>.github.io/SPIDERMAN/ */

const CACHE = 'rishi-music-v6';   // change this number whenever you update your files

const APP_SHELL = [
  './',
  'index.html',
  'style.css',
  'app.js',
  'manifest.json',
  'icons/icon-192.png',
  'icons/icon-512.png'
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE)
      .then(cache => Promise.all(APP_SHELL.map(f => cache.add(f).catch(() => {}))))   // one missing file must not break the worker
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.includes('/songs/') || req.headers.has('range')) return;   // audio is stored by the app, not cached here

  // Page loads: try network first, fall back to cached page when offline
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req)
        .then(res => {
          const copy = res.clone();
          caches.open(CACHE).then(c => c.put('index.html', copy));
          return res;
        })
        .catch(() => caches.match('index.html').then(r => r || caches.match('./')))
    );
    return;
  }

  // Other files: serve from cache instantly, refresh in the background
  event.respondWith(
    caches.match(req).then(cached => {
      const fetching = fetch(req)
        .then(res => {
          if (res && res.status === 200) {
            const copy = res.clone();
            caches.open(CACHE).then(c => c.put(req, copy));
          }
          return res;
        })
        .catch(() => cached);
      return cached || fetching;
    })
  );
});
