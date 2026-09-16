/* ===========================================================================
   GET /api/ping — tiny health check.
   Returns whether the backend is fully configured (no secrets leaked).
   The Settings panel calls this to show a green/amber push status line.
   =========================================================================== */
'use strict';
const { VAPID_PUBLIC, APP_SECRET, json, corsPreflight } = require('./_webpush');

module.exports = (req, res) => {
  if (corsPreflight(req, res)) return;
  json(res, 200, {
    ok: true,
    vapid: !!VAPID_PUBLIC,
    secret: !!APP_SECRET,
    qstash: !!process.env.QSTASH_TOKEN,
  });
};
