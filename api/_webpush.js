/* ===========================================================================
   Switchr backend — shared helpers (no framework, plain Vercel Node functions)
   ----------------------------------------------------------------------------
   Everything the API routes need:
   - web-push encryption (RFC 8188 aes128gcm) + VAPID auth (ES256 JWT),
     implemented directly on Node's built-in crypto so the backend has
     exactly ONE npm dependency: the QStash SDK (fast cold starts).
   - HMAC request signing so only OUR frontend can store push subscriptions.
   - Tiny helpers for Vercel's request/response objects.
   =========================================================================== */
'use strict';

const crypto = require('crypto');

/* ----------------------------- config ---------------------------------- */

const {
  VAPID_PUBLIC = '',   // base64url public key (also served to the browser)
  VAPID_PRIVATE = '',  // base64url private key (32 bytes, d parameter)
  APP_SECRET = '',     // shared secret for signing browser → api/sync requests
} = process.env;

/** b64url (no padding) → Buffer. */
function b64uToBuf(s) { return Buffer.from(s, 'base64url'); }
/** Buffer → b64url (no padding). */
function bufToB64u(b) { return b.toString('base64url'); }
/** UTF-8 string → Buffer. */
function utf8(s) { return Buffer.from(s, 'utf8'); }

/* --------------------------- JSON responses ---------------------------- */

/** Standard JSON response with CORS for our own origin. */
function json(res, status, obj) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.end(JSON.stringify(obj));
}
/** CORS preflight for browsers that send one. */
function corsPreflight(req, res) {
  if (req.method !== 'OPTIONS') return false;
  res.statusCode = 204;
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.end();
  return true;
}

/* ------------------------- request signing ------------------------------
   The browser proves a /api/sync body is genuine by sending
   X-Timestamp + X-Sign = HMAC-SHA256(APP_SECRET, timestamp + '.' + body).
   Timestamp window (5 min) blocks replay of old requests.
   ------------------------------------------------------------------------ */

/** HMAC-SHA256 of `msg` with APP_SECRET, b64url-encoded. */
function sign(msg) {
  return crypto.createHmac('sha256', APP_SECRET).update(msg).digest('base64url');
}

/** Verify an X-Sign header. Returns null when valid, else a reject reason. */
function verifySigned(req, body) {
  if (!APP_SECRET) return 'server not configured (APP_SECRET missing)';
  const ts = req.headers['x-timestamp'] || '';
  const sig = req.headers['x-sign'] || '';
  const tsNum = parseInt(ts, 10);
  if (!tsNum || Math.abs(Date.now() - tsNum) > 5 * 60 * 1000) return 'stale or bad timestamp';
  const expected = sign(ts + '.' + body);
  if (sig.length !== expected.length ||
      !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) {
    return 'bad signature';
  }
  return null;
}

/* ======================= WEB PUSH: RFC 8188 aes128gcm ===================
   Payload encryption for the "aes128gcm" content-coding:
     - ephemeral ECDH on the P-256 curve with the browser's subscription key
     - HKDF to derive the content-encryption key + nonce
     - AES-128-GCM over the payload, padded per spec
   Output layout: [salt(16) | rs(4) | idlen(1) | keyid | ciphertext]
   ------------------------------------------------------------------------ */

const RS = 4096;   // record size (single record)
const PAD = 2;     // minimum padding bytes per spec

/** Encrypt `payload` for one subscription's `p256dh`/`auth` keys → Buffer. */
function encryptFor(sub, payload) {
  // 1. The browser's p256dh is the RAW 65-byte uncompressed P-256 point
  //    (RFC 8291 §5) — Node's ECDH accepts it directly.
  const uaRaw = b64uToBuf(sub.p256dh);
  const ecdh = crypto.createECDH('prime256v1');
  ecdh.generateKeys();

  // 2. Shared secret + key derivation inputs.
  const secret = ecdh.computeSecret(uaRaw);
  const salt = crypto.randomBytes(16);
  const authSecret = b64uToBuf(sub.auth);
  const asPub = ecdh.getPublicKey();               // 65-byte uncompressed point
  const prk = crypto.hkdfSync('sha256', secret, salt, Buffer.concat([utf8('WebPush: info\u0000'), asPub, uaRaw]), 32);
  const cek = crypto.hkdfSync('sha256', Buffer.from(prk), authSecret, utf8('Content-Encoding: aes128gcm\u0000'), 16);
  const nonce = crypto.hkdfSync('sha256', Buffer.from(prk), authSecret, utf8('Content-Encoding: nonce\u0000'), 12);

  // 3. Pad the plaintext: payload + delimiter + padding zeros.
  const pt = Buffer.concat([payload, Buffer.from([0x02]), Buffer.alloc(PAD)]);

  // 4. Encrypt with AES-128-GCM.
  const cipher = crypto.createCipheriv('aes-128-gcm', Buffer.from(cek), Buffer.from(nonce));
  const ct = Buffer.concat([cipher.update(pt), cipher.final(), cipher.getAuthTag()]);

  // 5. Header: salt | record size | key id (our ephemeral public key).
  const header = Buffer.concat([
    salt,
    (() => { const b = Buffer.alloc(4); b.writeUInt32BE(RS); return b; })(),
    Buffer.from([asPub.length]),
    asPub,
  ]);
  return Buffer.concat([header, ct]);
}

/* ===================== WEB PUSH: VAPID auth header ======================
   VAPID proves to push services that OUR server owns the key pair the
   browser subscribed to: a short ES256 JWT with the standard claims.
   --------------------------------------------------------------------- */

/**
 * Build the VAPID "Authorization: vapid t=JWT,k=pubkey" header.
 * @param audience origin of the push service (e.g. https://fcm.googleapis.com)
 */
function vapidHeader(audience) {
  const header = { typ: 'JWT', alg: 'ES256' };
  const claims = {
    aud: audience,
    exp: Math.floor(Date.now() / 1000) + 12 * 3600,
    sub: 'mailto:switchr-app@users.noreply.github.com',
  };
  const unsigned = bufToB64u(utf8(JSON.stringify(header))) + '.' + bufToB64u(utf8(JSON.stringify(claims)));

  // Sign SHA-256 of the data with the VAPID private key (ECDSA P-256).
  const d = privateKeyFromD();
  const sig = crypto.sign('sha256', utf8(unsigned), { key: d, dsaEncoding: 'ieee-p1363' });
  return 'vapid t=' + unsigned + '.' + bufToB64u(sig) + ',k=' + VAPID_PUBLIC;
}

/**
 * Build the P-256 private KeyObject from the raw 32-byte scalar.
 * DER hand-assembly is error-prone, so we derive the matching public point
 * with ECDH and import everything as JWK — fully supported by Node crypto.
 */
function privateKeyFromD() {
  const d = b64uToBuf(VAPID_PRIVATE);
  const tmp = crypto.createECDH('prime256v1');
  tmp.setPrivateKey(d);                      // validates the scalar + gives us the public point
  const pub = tmp.getPublicKey();            // 65-byte uncompressed: 0x04 | X | Y
  return crypto.createPrivateKey({
    key: {
      kty: 'EC', crv: 'P-256',
      x: bufToB64u(pub.subarray(1, 33)),
      y: bufToB64u(pub.subarray(33, 65)),
      d: bufToB64u(d),
    },
    format: 'jwk',
  });
}

/** TTL header value for push messages (4 days; Chrome caps at this). */
const PUSH_TTL = 4 * 24 * 3600;

module.exports = {
  VAPID_PUBLIC, APP_SECRET,
  json, corsPreflight,
  sign, verifySigned,
  encryptFor, vapidHeader, PUSH_TTL,
  b64uToBuf, bufToB64u, utf8,
};
