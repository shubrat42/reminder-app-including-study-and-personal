/* ===========================================================================
   Remindly service worker — offline-first app shell
   ----------------------------------------------------------------------------
   Strategy:
   - Precache the app shell (HTML, manifest, icons) on install.
   - Navigation requests: serve the cached shell instantly, then refresh the
     cache in the background (stale-while-revalidate) so updates land on the
     *next* load — the app never blocks on the network.
   - Other same-origin GETs (e.g. icons): cache-first.
   - Google Fonts: served cache-first from a runtime cache (opaque responses
     are fine to store). Offline → falls back to the system font stack.
   =========================================================================== */

const VERSION   = 'remindly-v5'; // v5: interactive month calendar + Indian festivals
const SHELL     = `${VERSION}-shell`;
const RUNTIME   = `${VERSION}-runtime`;

/* Everything the UI needs to paint with zero network. */
const PRECACHE_URLS = [
  './',
  './index.html',
  './manifest.json',
  './festivals.json',   // offline Indian festival/holiday data
  './icons/icon-192.png',
  './icons/icon-512.png',
];

/* ------------------------------ install ------------------------------ */
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(SHELL)
      .then((cache) => cache.addAll(PRECACHE_URLS))
      .then(() => self.skipWaiting()) // activate immediately, no waiting tab
  );
});

/* ------------------------------ activate ----------------------------- */
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        // Delete every cache not belonging to the current version.
        keys.filter((k) => k !== SHELL && k !== RUNTIME)
            .map((k) => caches.delete(k))
      ))
      .then(() => self.clients.claim()) // take control of open tabs at once
  );
});

/* ------------------------------ fetch -------------------------------- */
self.addEventListener('fetch', (event) => {
  const req = event.request;

  // Only handle GETs; let everything else (POST etc.) hit the network.
  if (req.method !== 'GET') return;

  // --- App navigations: instant shell, then refresh in background. ---
  if (req.mode === 'navigate') {
    event.respondWith(
      caches.match('./index.html').then((cached) => {
        const network = fetch(req)
          .then((res) => {
            // Keep the shell cache fresh for next launch.
            if (res && res.ok) {
              const copy = res.clone();
              caches.open(SHELL).then((c) => c.put('./index.html', copy));
            }
            return res;
          })
          .catch(() => cached); // fully offline → cached shell
        return cached || network;
      })
    );
    return;
  }

  // --- Google Fonts: cache-first runtime cache (works offline after 1st load).
  if (req.url.startsWith('https://fonts.googleapis.com') ||
      req.url.startsWith('https://fonts.gstatic.com')) {
    event.respondWith(
      caches.match(req).then((cached) => cached || fetch(req).then((res) => {
        const copy = res.clone();
        caches.open(RUNTIME).then((c) => c.put(req, copy));
        return res;
      }))
    );
    return;
  }

  // --- Everything else (same-origin assets): cache-first, then network. ---
  event.respondWith(
    caches.match(req).then((cached) => cached || fetch(req))
  );
});

/* ------------------------- messages / updates ------------------------ */
// Lets the page trigger an immediate update: navigator.serviceWorker
// controller gets postMessage({ type: 'SKIP_WAITING' }) after an updatecheck.
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') self.skipWaiting();
});
