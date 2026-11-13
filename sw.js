// Metyu service worker: makes the pages installable on the iPhone / iPad home screen and openable
// offline. Only the app shell is cached. Live data (/api/..., Polymarket) always goes to the network
// and is never cached, so prices are never stale.
const CACHE = 'metyu-shell-v3';
const SHELL = [
  './', 'board.html', 'polymarket.html', 'index.html', 'metyu-agent.js', 'metyu-vault.js', 'metyu-wallet.js', 'manifest.webmanifest',
  'icons/icon.svg', 'icons/icon-180.png', 'icons/icon-192.png', 'icons/icon-512.png'
];

self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', event => {
  event.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(key => key !== CACHE).map(key => caches.delete(key))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  // Live data and other sites: straight to the network, never from or into the cache.
  if (event.request.method !== 'GET' || url.origin !== self.location.origin || url.pathname.includes('/api/')) return;
  // App shell: network first (so updates arrive), the cached copy when offline.
  event.respondWith(fetch(event.request)
    .then(response => {
      if (response.ok) {
        const copy = response.clone();
        caches.open(CACHE).then(cache => cache.put(event.request, copy));
      }
      return response;
    })
    .catch(() => caches.match(event.request, { ignoreSearch: true })));
});
