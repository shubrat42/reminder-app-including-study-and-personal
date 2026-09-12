#!/usr/bin/env node
/* Dependency-free PNG icon generator for Remindly.
 * Draws a rounded-square blue→orange gradient tile with a white alarm-clock
 * glyph (ring, hands, bell bumps, feet) at 1024px, then box-downsamples to
 * 512 and 192 for smooth antialiased edges. Uses only Node built-ins
 * (zlib for the PNG IDAT). */
'use strict';
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const SIZE = 1024;        // master canvas
const SS = 4;             // supersampling factor per axis
const OUT_DIR = path.join(__dirname, '..', 'icons');

/* ---------------- tiny vector helpers ---------------- */
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const rad = d => (d * Math.PI) / 180;

/** Signed distance to a rounded rectangle (corner radius r). */
function sdRoundRect(px, py, cx, cy, hx, hy, r) {
  const dx = Math.abs(px - cx) - (hx - r);
  const dy = Math.abs(py - cy) - (hy - r);
  const ax = Math.max(dx, 0), ay = Math.max(dy, 0);
  return Math.hypot(ax, ay) + Math.min(Math.max(dx, dy), 0) - r;
}
/** Distance from point p to segment a-b. */
function distSeg(px, py, ax, ay, bx, by) {
  const abx = bx - ax, aby = by - ay;
  const t = clamp(((px - ax) * abx + (py - ay) * aby) / (abx * abx + aby * aby), 0, 1);
  return Math.hypot(px - (ax + abx * t), py - (ay + aby * t));
}
/** Unsigned distance to a circle edge (0 at the rim, + outside, - inside). */
const dCircle = (px, py, cx, cy, r) => Math.hypot(px - cx, py - cy) - r;

/* ---------------- glyph coverage field ----------------
 * S(x,y) ∈ [0,1] — 1 = fully inside the white glyph. Union of primitives,
 * each anti-aliased over a 2px feather (fine at SS=4 with box filtering). */
function coverage(px, py) {
  const feather = 2;
  const inside = (d) => clamp((feather - d) / (2 * feather), 0, 1);
  let s = 0;
  const acc = (d) => { s = Math.max(s, inside(d)); };

  // Rounded-square tile (acts as the glyph's background — see shade() below)
  acc(sdRoundRect(px, py, SIZE / 2, SIZE / 2, SIZE / 2, SIZE / 2, 224));

  return s;
}

/* Full scene: returns {bg, glyph} coverages.
 * bg: rounded tile; glyph: clock artwork drawn on top. */
function scene(px, py) {
  const feather = 2;
  const cov = d => clamp((feather - d) / (2 * feather), 0, 1);

  // 1) Rounded tile
  const bg = cov(sdRoundRect(px, py, SIZE / 2, SIZE / 2, SIZE / 2, SIZE / 2, 224));

  // 2) Clock glyph (white)
  const cx = 512, cy = 515, R = 300, ringW = 64;
  let g = 0;
  const acc = d => { g = Math.max(g, cov(d)); };

  acc(Math.abs(dCircle(px, py, cx, cy, R - ringW / 2)) - ringW / 2);          // ring

  const hand = (deg, len, w) =>                                                // hands
    acc(-distSeg(px, py, cx, cy + 18, cx + len * Math.cos(rad(deg)), cy + 18 + len * Math.sin(rad(deg))) + w);
  hand(-55, 150, 26);   // hour hand → upper right
  hand(-155, 205, 26);  // minute hand → upper left

  acc(dCircle(px, py, cx, cy + 18, 34));                                       // hub

  acc(dCircle(px, py, cx - 258, cy - 292, 56));                                // left bell bump
  acc(dCircle(px, py, cx + 258, cy - 292, 56));                                // right bell bump
  acc(dCircle(px, py, cx - 168, cy + R + 6, 42));                              // left foot
  acc(dCircle(px, py, cx + 168, cy + R + 6, 42));                              // right foot

  return { bg, glyph: Math.min(g, 1) };
}

/* ---------------- gradient background ----------------
 * iOS system blue (Study) → iOS orange (Personal), diagonal like a sunrise. */
function gradient(x, y) {
  const t = clamp((x + y) / (2 * SIZE), 0, 1);
  const lerp = (a, b, u) => a + (b - a) * u;
  return [
    Math.round(lerp(0x00, 0xff, t)), // R: #007aff → #ff9500
    Math.round(lerp(0x7a, 0x95, t)), // G
    Math.round(lerp(0xff, 0x00, t)), // B
  ];
}

/* ---------------- render master canvas ---------------- */
const field = new Float32Array(SIZE * SIZE); // 0 = outside, 1..2 = bg, 3 = glyph
for (let y = 0; y < SIZE; y++) {
  for (let x = 0; x < SIZE; x++) {
    // 4×4 supersample grid per pixel, averaged
    let bgAcc = 0, glAcc = 0;
    for (let sy = 0; sy < SS; sy++) {
      for (let sx = 0; sx < SS; sx++) {
        const px = x + (sx + 0.5) / SS;
        const py = y + (sy + 0.5) / SS;
        const { bg, glyph } = scene(px, py);
        bgAcc += bg; glAcc += glyph;
      }
    }
    const bg = bgAcc / (SS * SS), gl = glAcc / (SS * SS);
    field[y * SIZE + x] = gl > 0.5 ? 3 + gl : 1 + bg; // glyph wins over tile
  }
}

/* ---------------- downsample + encode PNG ---------------- */
function crc32(buf) {
  let c, table = crc32.table;
  if (!table) {
    table = crc32.table = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c;
    }
  }
  c = -1;
  for (let i = 0; i < buf.length; i++) c = table[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}
function chunk(type, data) {
  const out = Buffer.alloc(8 + data.length + 4);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'ascii');
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}
function encodePNG(size) {
  const scale = SIZE / size;
  const raw = Buffer.alloc(size * (size * 4 + 1));
  let o = 0;
  for (let y = 0; y < size; y++) {
    raw[o++] = 0; // filter: none
    for (let x = 0; x < size; x++) {
      // Box-filter average over the source square for this pixel
      let r = 0, g = 0, b = 0, a = 0;
      const x0 = Math.floor(x * scale), y0 = Math.floor(y * scale);
      const x1 = Math.min(SIZE, Math.ceil((x + 1) * scale));
      const y1 = Math.min(SIZE, Math.ceil((y + 1) * scale));
      for (let sy = y0; sy < y1; sy++) {
        for (let sx = x0; sx < x1; sx++) {
          const v = field[sy * SIZE + sx];
          const isGlyph = v >= 3;
          const covA = isGlyph ? v - 3 : v - 1;      // coverage 0..1
          const rgb = isGlyph ? [255, 255, 255] : gradient(sx, sy);
          r += rgb[0] * covA; g += rgb[1] * covA; b += rgb[2] * covA; a += covA;
        }
      }
      const n = (x1 - x0) * (y1 - y0) || 1;
      raw[o++] = Math.round(r / n); raw[o++] = Math.round(g / n);
      raw[o++] = Math.round(b / n); raw[o++] = Math.round((a / n) * 255);
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6; // 8-bit RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

fs.mkdirSync(OUT_DIR, { recursive: true });
for (const size of [512, 192]) {
  const png = encodePNG(size);
  const file = path.join(OUT_DIR, `icon-${size}.png`);
  fs.writeFileSync(file, png);
  console.log(`wrote ${file} (${png.length} bytes)`);
}
