/* ===========================================================================
   POST /api/sync — register a push subscription + (re)schedule reminders.
   Called by the browser right after the user enables push, and every time
   a reminder is added/edited/deleted (so QStash always fires the right
   thing at the right time).

   Body: {
     sub:  { endpoint, keys: { p256dh, auth } },   // browser push subscription
     reminders: [ { id, title, notes, date, time, repeat } ],  // full desired state
     completedIds: [id, ...]                       // done ones — never notified
   }

   Flow:
   1. Verify the HMAC signature (only our frontend may write here).
   2. Store the subscription in memory (see "storage" note below).
   3. Compute every future occurrence of every not-done reminder.
   4. Diff against QStash's current schedule for this device:
        - schedules that no longer match → cancel
        - missing/changed → (re)schedule at the exact occurrence time
   5. Reply with how many schedules exist (shown in the UI).

   Storage note (kept intentionally simple): subscriptions + the message-ID
   map live in a module-level Map — the standard Vercel Node runtime keeps
   the lambda warm between requests, so this works day-to-day. The tradeoff:
   after a long cold start the schedule is rebuilt on the next sync (the
   client re-syncs on load/visibility, so self-heals automatically). Swap in
   Upstash Redis here later if you want schedules to survive restarts.
   =========================================================================== */
'use strict';
const { verifySigned, json, corsPreflight } = require('./_webpush');
const { Client } = require('@upstash/qstash');

// Regional deployments get a dedicated URL (e.g. https://qstash-eu-central-1.upstash.io);
// fall back to the global endpoint when QSTASH_URL is not set.
const QSTASH_BASE = (process.env.QSTASH_URL || 'https://qstash.upstash.io').replace(/\/$/, '');
const qstash = process.env.QSTASH_TOKEN
  ? new Client({ token: process.env.QSTASH_TOKEN, url: QSTASH_BASE })
  : null;

/* deviceId → { sub, schedule: Map<messageId → occurrenceId> } */
const devices = new Map();

/* ------------------------- occurrence expansion -------------------------
   A reminder may repeat daily/weekly; QStash needs ONE message per future
   fire time. We expand the next 5 occurrences (or fewer if the repeat
   window is short) so notifications keep coming without client check-ins.
   ------------------------------------------------------------------------ */

/** Turn a stored reminder into the absolute epoch-ms times it should fire. */
function occurrences(r, now) {
  const out = [];
  const t = new Date(r.date + 'T' + (r.time || '09:00') + ':00');
  const step = r.repeat === 'daily' ? 86400000 : r.repeat === 'weekly' ? 7 * 86400000 : 0;
  for (let i = 0; i < 5; i++) {
    const at = t.getTime() + step * i;
    if (!step && i > 0) break;           // non-repeating → single occurrence
    if (at > now) out.push(at);          // future only
    if (step && out.length >= 5) break;  // cap expansion
  }
  return out;
}

/** Stable schedule id for one device + occurrence. */
function schedId(deviceId, reminderId, atMs) {
  return deviceId + ':' + reminderId + ':' + atMs;
}

module.exports = async (req, res) => {
  if (corsPreflight(req, res)) return;

  // --- read the raw body (needed for signature verification) ---
  let body = '';
  await new Promise((resolve) => {
    req.on('data', (c) => { body += c; });
    req.on('end', resolve);
  });

  const bad = verifySigned(req, body);
  if (bad) return json(res, 401, { error: bad });

  let parsed;
  try { parsed = JSON.parse(body); }
  catch (e) { return json(res, 400, { error: 'invalid JSON' }); }

  const { sub, reminders = [], completedIds = [] } = parsed || {};
  if (!sub || !sub.endpoint || !sub.keys || !sub.keys.p256dh || !sub.keys.auth) {
    return json(res, 400, { error: 'missing push subscription' });
  }
  if (!qstash) return json(res, 503, { error: 'QSTASH_TOKEN not configured on server' });

  // --- 1. persist the subscription (in-memory; see header note) ---
  const deviceId = Buffer.from(sub.endpoint).toString('base64url').slice(-24);
  const dev = devices.get(deviceId) || { sub, schedule: new Map() };
  dev.sub = sub;
  devices.set(deviceId, dev);

  // --- 1b. "disable push": cancel every queued schedule for this device ---
  if (parsed.delete === true) {
    for (const [msgId] of dev.schedule) {
      fetch(QSTASH_BASE + '/v2/messages/' + msgId, {
        method: 'DELETE',
        headers: { Authorization: 'Bearer ' + process.env.QSTASH_TOKEN },
      }).catch(() => {});
    }
    const n = dev.schedule.size;
    dev.schedule.clear();
    return json(res, 200, { ok: true, cancelled: n });
  }

  // --- 2. expand the desired schedule ---
  const now = Date.now();
  const doneSet = new Set(completedIds);
  const wanted = new Map(); // schedId → { reminder, atMs }
  for (const r of reminders) {
    if (doneSet.has(r.id)) continue;
    for (const atMs of occurrences(r, now)) wanted.set(schedId(deviceId, r.id, atMs), { r, atMs });
  }

  // --- 3. cancel schedules that are no longer wanted ---
  // (QStash cancel endpoint: DELETE /v2/messages/{messageId} — works for
  //  pending scheduled messages. Failures are non-fatal: worst case the
  //  send endpoint's fresh-state check drops it.)
  for (const [msgId, sid] of dev.schedule) {
    if (wanted.has(sid)) continue;
    dev.schedule.delete(msgId);
    fetch(QSTASH_BASE + '/v2/messages/' + msgId, {
      method: 'DELETE',
      headers: { Authorization: 'Bearer ' + process.env.QSTASH_TOKEN },
    }).catch(() => {});
  }

  // --- 4. schedule what's missing ---
  let scheduled = 0, failed = 0;
  const target = process.env.PUSH_TARGET_URL ||
    ('https://' + (req.headers['x-forwarded-host'] || req.headers.host) + '/api/send');

  for (const [sid, { r, atMs }] of wanted) {
    if (dev.schedule.has(sid)) continue;  // already queued correctly
    try {
      const { messageId } = await qstash.publishJSON({
        url: target,
        // QStash delay semantics: seconds from now ( fractional allowed ).
        delay: Math.max(1, Math.round((atMs - now) / 1000)),
        body: {
          sub, reminder: {
            id: r.id, title: r.title, notes: r.notes || '',
            at: atMs, category: r.category || '',
          },
        },
        headers: {
          'content-type': 'application/json',
          // Proves to /api/send that THIS request came from our own scheduler.
          'x-switchr-secret': process.env.APP_SECRET || '',
        },
      });
      dev.schedule.set(messageId, sid);
      scheduled++;
    } catch (e) {
      failed++;
    }
  }

  json(res, 200, {
    ok: true, deviceId, scheduled, failed,
    pending: dev.schedule.size,
  });
};
