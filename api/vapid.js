/* ===========================================================================
   GET /api/vapid — hands the browser our VAPID public key.
   The browser needs this to subscribe to push (applicationServerKey).
   No secrets here: the public key is meant to be public.
   =========================================================================== */
'use strict';
const { VAPID_PUBLIC, json, corsPreflight } = require('./_webpush');

module.exports = (req, res) => {
  if (corsPreflight(req, res)) return;
  if (!VAPID_PUBLIC) return json(res, 500, { error: 'VAPID_PUBLIC not configured' });
  json(res, 200, { publicKey: VAPID_PUBLIC });
};
