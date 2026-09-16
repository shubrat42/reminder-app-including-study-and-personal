// Functional test for the Switchr push backend (safe to delete).
// 1. RFC 8188 encrypt → decrypt round-trip (simulating the browser side).
// 2. VAPID ES256 JWT signature verification against the public key.
// 3. HMAC request signing round-trip.
const crypto = require('crypto');
const path = require('path');

// Load the key material generated for this project.
const keys = {};
require('fs').readFileSync(path.join(__dirname, '..', '.keys', 'switchr-keys.txt'), 'utf8')
  .trim().split('\n').forEach(line => {
    const [k, v] = line.split('=');
    keys[k] = v;
  });
process.env.VAPID_PUBLIC = keys.VAPID_PUBLIC;
process.env.VAPID_PRIVATE = keys.VAPID_PRIVATE;
process.env.APP_SECRET = keys.APP_SECRET;

const wp = require('../api/_webpush.js');
let failed = 0;
function check(name, cond) {
  console.log((cond ? 'PASS' : 'FAIL') + ': ' + name);
  if (!cond) failed++;
}

/* ---------- 1. encryptFor round-trip ---------- */
// Simulate the browser: generate a P-256 keypair like pushManager.subscribe.
// p256dh is the RAW 65-byte uncompressed point (RFC 8291 §5), auth 16 bytes.
const client = crypto.createECDH('prime256v1');
client.generateKeys();
const rawPoint = client.getPublicKey();                   // 65 bytes: 0x04|X|Y
const p256dh = rawPoint.toString('base64url');
const auth = crypto.randomBytes(16).toString('base64url');
const sub = { p256dh, auth };

const payload = Buffer.from(JSON.stringify({ title: '⏰ Test', body: 'hello from the test' }));
const encrypted = wp.encryptFor(sub, payload);

// Parse the aes128gcm header: salt(16) | rs(4) | idlen(1) | keyid | ciphertext.
const salt = encrypted.subarray(0, 16);
const rs = encrypted.readUInt32BE(16);
const idlen = encrypted[20];
const serverEphPub = encrypted.subarray(21, 21 + idlen);
const ct = encrypted.subarray(21 + idlen);

check('record size is 4096', rs === 4096);
check('ephemeral key is a 65-byte P-256 point', idlen === 65 && serverEphPub[0] === 0x04);

// Derive the same keys the decrypting side (browser) computes.
// RFC 8291: info = "WebPush: info" || 0x00 || asPublic(raw) || uaPublic(raw)
const ecdhSecret = client.computeSecret(serverEphPub);
const rawUa = client.getPublicKey();                      // 65-byte raw point
const info = Buffer.concat([
  Buffer.from('WebPush: info\u0000'), serverEphPub, rawUa,
]);
const prk = Buffer.from(crypto.hkdfSync('sha256', ecdhSecret, salt, info, 32));
const authBuf = Buffer.from(auth, 'base64url');
const cek = Buffer.from(crypto.hkdfSync('sha256', prk, authBuf, Buffer.from('Content-Encoding: aes128gcm\u0000'), 16));
const nonce = Buffer.from(crypto.hkdfSync('sha256', prk, authBuf, Buffer.from('Content-Encoding: nonce\u0000'), 12));

// Decrypt: last 16 bytes of the record are the GCM tag.
const data = ct.subarray(0, ct.length - 16);
const tag = ct.subarray(ct.length - 16);
const decipher = crypto.createDecipheriv('aes-128-gcm', cek, nonce);
decipher.setAuthTag(tag);
let plain;
try {
  plain = Buffer.concat([decipher.update(data), decipher.final()]);
} catch (e) {
  plain = null;
}
check('aes128gcm round-trip decrypts', !!plain);
if (plain) {
  // Strip padding: payload + 0x02 delimiter + padding zeros.
  const cut = plain.lastIndexOf(0x02);
  const decoded = JSON.parse(plain.subarray(0, cut).toString('utf8'));
  check('decrypted payload matches', decoded.title === '⏰ Test' && decoded.body === 'hello from the test');
}

/* ---------- 2. VAPID JWT ---------- */
const hdr = wp.vapidHeader('https://fcm.googleapis.com');
const m = hdr.match(/^vapid t=([^,]+),k=(.+)$/);
check('vapid header shape', !!m);
if (m) {
  const [h64, c64, s64] = m[1].split('.');
  const head = JSON.parse(Buffer.from(h64, 'base64url').toString());
  const claims = JSON.parse(Buffer.from(c64, 'base64url').toString());
  check('JWT header is ES256', head.alg === 'ES256' && head.typ === 'JWT');
  check('JWT audience is the push service', claims.aud === 'https://fcm.googleapis.com');
  check('JWT has mailto sub', typeof claims.sub === 'string' && claims.sub.startsWith('mailto:'));
  // VAPID_PUBLIC is the raw 65-byte point — wrap it in a JWK to verify.
  const raw = Buffer.from(keys.VAPID_PUBLIC, 'base64url');
  const pubJwk = {
    kty: 'EC', crv: 'P-256',
    x: raw.subarray(1, 33).toString('base64url'),
    y: raw.subarray(33, 65).toString('base64url'),
  };
  const ok = crypto.verify(
    'sha256', Buffer.from(h64 + '.' + c64),
    { key: crypto.createPublicKey({ key: pubJwk, format: 'jwk' }), dsaEncoding: 'ieee-p1363' },
    Buffer.from(s64, 'base64url')
  );
  check('JWT signature verifies with the VAPID public key', ok);
  check('k= matches VAPID_PUBLIC', m[2] === keys.VAPID_PUBLIC);
}

/* ---------- 3. HMAC signing ---------- */
const body = JSON.stringify({ hello: 'switchr' });
const ts = String(Date.now());
const sig = wp.sign(ts + '.' + body);
const fakeReq = { headers: { 'x-timestamp': ts, 'x-sign': sig } };
check('signed request verifies', wp.verifySigned(fakeReq, body) === null);
const stale = { headers: { 'x-timestamp': String(Date.now() - 10 * 60 * 1000), 'x-sign': wp.sign((Date.now() - 10 * 60 * 1000) + '.' + body) } };
check('stale timestamp rejected', wp.verifySigned(stale, body) === 'stale or bad timestamp');
const tampered = { headers: { 'x-timestamp': ts, 'x-sign': sig } };
check('tampered body rejected', wp.verifySigned(tampered, body + 'x') === 'bad signature');

process.exit(failed ? 1 : 0);
