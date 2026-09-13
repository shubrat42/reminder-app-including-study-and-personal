// One-off pixel probe for the generated Switchr icons (safe to delete).
const fs = require('fs'), zlib = require('zlib');
const buf = fs.readFileSync('icons/icon-512.png');
let o = 8, w = 0, h = 0; const idat = [];
while (o < buf.length) {
  const len = buf.readUInt32BE(o), type = buf.toString('ascii', o + 4, o + 8);
  const data = buf.subarray(o + 8, o + 8 + len);
  if (type === 'IHDR') { w = data.readUInt32BE(0); h = data.readUInt32BE(4); }
  if (type === 'IDAT') idat.push(data);
  o += 12 + len;
}
const raw = zlib.inflateSync(Buffer.concat(idat));
const px = Buffer.alloc(w * h * 4);
for (let y = 0; y < h; y++) raw.copy(px, y * w * 4, y * (w * 4 + 1) + 1, (y + 1) * (w * 4 + 1));
const at = (x, y) => { const i = (y * w + x) * 4; return [px[i], px[i + 1], px[i + 2], px[i + 3]]; };
const p = (fx, fy) => at(Math.round(fx * 512), Math.round(fy * 512));

// Geometry from tools/make-icons.js: pill center y=0.46, spans x≈0.23–0.77;
// knob center x≈0.73, hole r≈0.097; brand dot at (0.555, 0.26) r≈0.032.
const checks = [
  ['orange ring (x=.752)',  p(0.752, 0.46), [255, 160, 19, 255]],
  ['orange top band (x=.70,y=.35)', p(0.70, 0.35), [255, 160, 19, 255]],
  ['blue half (x=.30)',     p(0.30, 0.46),  [30, 143, 255, 255]],
  ['knob hole is dark',     p(0.73, 0.46),  [17, 18, 20, 255]],
  ['tile below pill',       p(0.5, 0.85),   [17, 18, 20, 255]],
  ['corner transparent',    at(5, 5),       [0, 0, 0, 0]],
];
let fail = 0;
for (const [label, got, want] of checks) {
  const ok = got.every((v, i) => Math.abs(v - want[i]) <= 8);
  console.log((ok ? '✓' : '✗') + ' ' + label + ': got ' + got.join(',') + (ok ? '' : ' want ' + want.join(',')));
  if (!ok) fail = 1;
}
// Brand dot: scan a small window around (0.555, 0.26) for any blue pixel.
let dotFound = false;
for (let dy = -8; dy <= 8 && !dotFound; dy++)
  for (let dx = -8; dx <= 8 && !dotFound; dx++) {
    const [r, g, b, a] = at(Math.round(0.555 * 512) + dx, Math.round(0.26 * 512) + dy);
    if (a > 200 && b > 180 && r < 120) dotFound = true;
  }
console.log((dotFound ? '✓' : '✗') + ' blue brand dot present over i');
if (!dotFound) fail = 1;
process.exit(fail);
