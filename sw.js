// sw.js
// Manual service worker — no Workbox dependency.
//
// Caching strategy:
//   App shell (HTML/JS/manifest/icons): cache-first — these are versioned by CACHE_NAME
//   CelesTrak TLE data:                 network-first, fall back to SW cache
//                                       (primary rate-limit enforcement is in localStorage;
//                                        SW cache is the offline/failure fallback only)
//   satellite.js CDN (jsDelivr):        cache-first — URL is pinned to a specific version

const CACHE_NAME = 'satellite-overhead-v16';

const APP_SHELL = [
  './',
  './index.html',
  './style.css',
  './app.js',
  './satellites.js',
  './passes.js',
  './manifest.json',
  './icons/icon-192.png',
  './icons/icon-512.png',
];

// ── Install: pre-cache app shell ──────────────────────────────────────────────
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(APP_SHELL))
      .then(() => self.skipWaiting()) // activate immediately on first install
  );
});

// ── Activate: purge old caches ────────────────────────────────────────────────
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k))
      ))
      .then(() => self.clients.claim()) // take control of open pages immediately
  );
});

// ── Fetch: route by origin ────────────────────────────────────────────────────
self.addEventListener('fetch', event => {
  // Only handle GET requests over http/https — ignore chrome-extension:// etc.
  if (event.request.method !== 'GET') return;
  if (!event.request.url.startsWith('http')) return;

  const url = new URL(event.request.url);

  // CelesTrak: network-first with SW cache fallback
  // Note: localStorage-based TTL in satellites.js is the primary guard against
  // over-fetching. The SW cache here is purely for offline resilience.
  if (url.hostname === 'celestrak.org') {
    event.respondWith(networkFirstWithCache(event.request));
    return;
  }

  // jsDelivr CDN (satellite.js): cache-first — version-pinned URL never changes
  if (url.hostname === 'cdn.jsdelivr.net') {
    event.respondWith(cacheFirstWithNetwork(event.request));
    return;
  }

  // App shell and everything else: cache-first
  event.respondWith(cacheFirstWithNetwork(event.request));
});

// ── Strategy helpers ──────────────────────────────────────────────────────────

async function networkFirstWithCache(request) {
  try {
    const response = await fetch(request);
    if (response.ok) {
      const cache = await caches.open(CACHE_NAME);
      cache.put(request, response.clone()); // update cache in background
    }
    return response;
  } catch (_) {
    // Network failed — serve stale cache if available
    const cached = await caches.match(request);
    if (cached) return cached;
    // Nothing cached — surface an explicit failure so the app can show an error state
    return new Response(JSON.stringify([]), {
      status: 503,
      statusText: 'Offline',
      headers: { 'Content-Type': 'application/json' },
    });
  }
}

async function cacheFirstWithNetwork(request) {
  const cached = await caches.match(request);
  if (cached) return cached;

  try {
    const response = await fetch(request);
    if (response.ok) {
      const cache = await caches.open(CACHE_NAME);
      cache.put(request, response.clone());
    }
    return response;
  } catch (_) {
    // Nothing in cache and network failed — return a minimal 503
    return new Response('Offline', { status: 503 });
  }
}
