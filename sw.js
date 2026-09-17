/* ===========================================================================
   Switchr service worker — offline-first app shell
   ----------------------------------------------------------------------------
   Strategy:
   - Precache the app shell (HTML, manifest, icons) on install.
   - Navigation requests: network-first with cached-shell fallback — deploys
     show up on the very next load instead of one load late; offline falls
     back to the cached shell.
   - Other same-origin GETs (e.g. icons): cache-first.
   - Google Fonts: served cache-first from a runtime cache (opaque responses
     are fine to store). Offline → falls back to the system font stack.
   =========================================================================== */

const VERSION   = 'remindly-v12'; // v12: network-first navigations + auto-update on deploy
const SHELL     = `${VERSION}-shell`;
const RUNTIME   = `${VERSION}-runtime`;

/* Everything the UI needs to paint with zero network. */
const PRECACHE_URLS = [
  './',
  './index.html',
  './manifest.json',
  './festivals.json',   // offline Indian festival/holiday data
  './assets/alarm.mp3', // bundled alarm ring (precached so it plays offline too)
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

  // --- App navigations: network-first, cached shell when offline. ---
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req)
        .then((res) => {
          // Keep the shell cache fresh for offline fallback.
          if (res && res.ok) {
            const copy = res.clone();
            caches.open(SHELL).then((c) => c.put('./index.html', copy));
          }
          return res;
        })
        .catch(() => caches.match('./index.html')) // offline → cached shell
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

/* ===========================================================================
   PUSH — true background notifications (work with the app fully closed).
   The payload arrives encrypted (aes128gcm, decrypted by the browser before
   this handler runs) and carries the ready-to-show Notification options.
   =========================================================================== */
self.addEventListener('push', (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch (e) { /* show generic */ }

  event.waitUntil(
    self.registration.showNotification(data.title || '⏰ Switchr reminder', {
      body: data.body || '',
      tag: data.tag || 'switchr',            // dedupes re-fires of the same reminder
      renotify: data.renotify || false,      // re-alert even if tag already shown
      requireInteraction: data.requireInteraction || false,
      icon: data.icon || '/icons/icon-192.png',
      badge: data.badge || '/icons/icon-192.png',
      data: { url: data.data && data.data.url || '/' },
    })
  );
});

/* Clicking the notification opens/focuses the app. */
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || '/';
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      // Focus an existing window if one is open, else open a new one.
      for (const client of clientList) {
        if ('focus' in client) return client.focus();
      }
      return self.clients.openWindow(url);
    })
  );
});
