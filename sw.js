// Lets Bee Ready open and work without internet (e.g. on the train).
// App files: try the network first so updates show up, fall back to the saved copy.
// Libraries from CDNs: use the saved copy if we have one.

const CACHE = 'bee-ready-v1';
const APP_FILES = [
  './', 'index.html', 'manifest.webmanifest', 'icons/icon.svg', 'css/style.css',
  'js/app.js', 'js/db.js', 'js/importer.js', 'js/lookup.js', 'js/practice.js',
  'js/progress.js', 'js/speech.js', 'js/stats.js', 'js/tips.js', 'js/ui.js', 'js/util.js',
];
const CDN_HOSTS = ['cdn.jsdelivr.net', 'cdn.sheetjs.com'];

self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE).then(c => c.addAll(APP_FILES)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  if (url.origin === self.location.origin) {
    event.respondWith(
      fetch(req)
        .then(res => {
          if (res.ok) { const copy = res.clone(); caches.open(CACHE).then(c => c.put(req, copy)); }
          return res;
        })
        .catch(() => caches.match(req, { ignoreSearch: true }).then(r => r || caches.match('index.html'))),
    );
    return;
  }

  if (CDN_HOSTS.includes(url.hostname)) {
    event.respondWith(
      caches.match(req).then(hit => hit || fetch(req).then(res => {
        if (res.ok || res.type === 'opaque') { const copy = res.clone(); caches.open(CACHE).then(c => c.put(req, copy)); }
        return res;
      })),
    );
  }
  // Dictionary lookups go straight to the network (the app keeps its own copy of results).
});
