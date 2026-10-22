const CACHE_NAME = '0node-v5';
const STATIC_ASSETS = [
  '/',
  '/logo.svg',
  '/logo-hero.svg',
  '/logo.png',
  '/logo.ico',
  '/manifest.json',
];

// Install — precache the app shell, take over immediately.
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(STATIC_ASSETS))
  );
  self.skipWaiting();
});

// Activate — drop every cache that isn't the current version, then claim
// open clients. Combined with sw.js being served `Cache-Control: no-cache`
// (see netlify.toml), this is the kill-switch: a fresh sw.js always wins,
// so a fixed deploy can flush a bad cache for every returning visitor.
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);

  // Only handle our own GET requests. Never touch RPC / cross-origin
  // (wallet, Stakewiz, Solana nodes) — those must always hit the network
  // and must never be cached.
  if (request.method !== 'GET') return;
  if (url.origin !== self.location.origin) return;

  // HTML navigations: network-first. Online visitors always get the live
  // shell pointing at the current content-hashed bundle; the cached '/'
  // is only a last-resort offline fallback.
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((resp) => {
          // Refresh the cached shell opportunistically.
          if (resp && resp.ok) {
            const clone = resp.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put('/', clone));
          }
          return resp;
        })
        .catch(() => caches.match('/'))
    );
    return;
  }

  // Same-origin assets: stale-while-revalidate. Serve the cached copy
  // instantly (fast paint), and in parallel fetch a fresh copy to update
  // the cache for next time. Because our JS/CSS are content-hash-named,
  // "fresh" only matters for non-hashed files (logos, manifest); hashed
  // files are immutable so the revalidation is a cheap no-op.
  event.respondWith(
    caches.open(CACHE_NAME).then((cache) =>
      cache.match(request).then((cached) => {
        const network = fetch(request)
          .then((resp) => {
            if (resp && resp.ok) cache.put(request, resp.clone());
            return resp;
          })
          .catch(() => cached); // offline → fall back to whatever we had
        // Return cached immediately if present, else wait for network.
        return cached || network;
      })
    )
  );
});
