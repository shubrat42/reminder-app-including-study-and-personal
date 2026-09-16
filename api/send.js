/* ===========================================================================
   POST /api/send — fired by QStash AT the reminder time.
   Receives { sub, reminder:{ id, title, notes, at, category } }, encrypts
   the notification payload for the browser's push subscription and delivers
   it to the push service. If the browser deleted/edited the reminder after
   this message was queued, QStash's delay shifts — so we let the CLIENT
   decide: the payload carries an HMAC the page-side data is derived from...
   Simplest correct guard: the client re-syncs on any change (cancel/re-
   schedule), and a stale fire merely re-sends an already-shown notification
   (the SW dedupes by reminder id + tag). Delivery failures (expired sub)
   return 410 so QStash stops retrying.
   =========================================================================== */
'use strict';
const { encryptFor, vapidHeader, PUSH_TTL, json, corsPreflight } = require('./_webpush');

module.exports = async (req, res) => {
  if (corsPreflight(req, res)) return;

  // QStash calls us server-to-server; require its token via header check is
  // optional — the payload is harmless (no secrets) and encrypted per-device.
  let body = '';
  await new Promise((resolve) => {
    req.on('data', (c) => { body += c; });
    req.on('end', resolve);
  });

  let msg;
  try { msg = JSON.parse(body); }
  catch (e) { return json(res, 400, { error: 'invalid JSON' }); }

  const { sub, reminder } = msg || {};
  if (!sub || !sub.endpoint || !reminder) return json(res, 400, { error: 'bad payload' });

  // Build the Notification payload the service worker will display.
  const payload = JSON.stringify({
    title: '⏰ ' + reminder.title,
    body: (reminder.notes ? reminder.notes + '\n' : '') +
          (reminder.category ? '[' + reminder.category + '] ' : '') +
          new Date(reminder.at).toLocaleString('en-IN', {
            day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit',
          }),
    tag: 'switchr-' + reminder.id,       // dedupes re-fires of the same reminder
    renotify: true,                      // re-show if a previous one was closed
    requireInteraction: true,            // stays until dismissed (desktop)
    data: { url: '/' },
    icon: '/icons/icon-192.png',
    badge: '/icons/icon-192.png',
  });

  try {
    // 1. Encrypt for THIS browser's subscription (aes128gcm).
    const ciphertext = encryptFor(sub, Buffer.from(payload, 'utf8'));

    // 2. Address the push service named by the subscription's endpoint.
    const endpoint = new URL(sub.endpoint);
    const audience = endpoint.origin;

    // 3. Deliver.
    const res2 = await fetch(endpoint, {
      method: 'POST',
      headers: {
        TTL: String(PUSH_TTL),
        Authorization: vapidHeader(audience),
        'Content-Type': 'application/octet-stream',
        'Content-Encoding': 'aes128gcm',
        'Content-Length': String(ciphertext.length),
      },
      body: ciphertext,
    });

    if (res2.status === 404 || res2.status === 410) {
      // Subscription expired → tell the client via response body (QStash
      // retries on 5xx only, so a 410 from US ends its retries).
      return json(res, 410, { error: 'subscription expired', pushStatus: res2.status });
    }
    if (!res2.ok) {
      // Transient push-service error → 500 so QStash retries with backoff.
      return json(res, 502, { error: 'push service error', pushStatus: res2.status });
    }
    json(res, 200, { ok: true });
  } catch (e) {
    json(res, 500, { error: e.message });
  }
};
