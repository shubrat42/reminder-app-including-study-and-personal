#!/usr/bin/env node
/* Dependency-free PNG icon generator for Switchr.
 * Draws the Switchr mark — a horizontal switch pill: blue rounded-left half,
 * orange rounded-right half with a dark knob circle knocked out — centered on
 * a near-black rounded-square tile, plus the brand dot above the "i" (blue in
 * the default variant). Renders at 1024px with 4×4 supersampling, then
 * box-downsamples to 512 and 192 for crisp antialiased edges.
 * Node built-ins only (zlib for the PNG IDAT). */
'use strict';
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const SIZE = 1024;        // master canvas
const SS = 4;             // supersampling factor per axis
const OUT_DIR = path.join(__dirname, '..', 'icons');

/* ---------------- tiny vector helpers ---------------- */
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
/** Signed distance to a rounded rectangle (corner radius r). */
function sdRoundRect(px, py, cx, cy, hx, hy, r) {
  const dx = Math.abs(px - cx) - (hx - r);
  const dy = Math.abs(py - cy) - (hy - r);
  const ax = Math.max(dx, 0), ay = Math.max(dy, 0);
  return Math.hypot(ax, ay) + Math.min(Math.max(dx, dy), 0) - r;
}
/** Distance from point p to segment a-b (unused now, kept for glyphs). */
function distSeg(px, py, ax, ay, bx, by) {
  const abx = bx - ax, aby = by - ay;
  const t = clamp(((px - ax) * abx + (py - ay) * aby) / (abx * abx + aby * aby), 0, 1);
  return Math.hypot(px - (ax + abx * t), py - (ay + aby * t));
}
/** Unsigned distance to a circle edge. */
const dCircle = (px, py, cx, cy, r) => Math.hypot(px - cx, py - cy) - r;

/* ---------------- scene: coverages + region id ----------------
 * Returns per-sample coverage for tile, blue region, orange region, and the
 * knob hole. The knob is a true knockout: where hole coverage is high, the
 * pixel shows the dark tile instead of orange. */
function scene(px, py) {
  const feather = 2;
  const cov = d => clamp((feather - d) / (2 * feather), 0, 1);

  // 1) Dark rounded-square tile
  const tile = cov(sdRoundRect(px, py, SIZE / 2, SIZE / 2, SIZE / 2, SIZE / 2, 224));

  // 2) Switch pill, centered
  const pillCx = SIZE / 2, pillCy = SIZE * 0.46;
  const pillHx = SIZE * 0.27, pillHy = SIZE * 0.135, pillR = pillHy;

  // Left (blue) half: rounded on the left only — full-height rounded rect
  // shifted left, then clipped to x ≤ center.
  const blueFull = cov(sdRoundRect(px, py, pillCx - pillHx + pillR, pillCy, pillHx, pillHy, pillR));
  const blue = Math.min(blueFull, clamp((pillCx - px) / (2 * feather) + 0.5, 0, 1));

  // Right (orange) half: mirrored, clipped to x ≥ center.
  const orangeFull = cov(sdRoundRect(px, py, pillCx + pillHx - pillR, pillCy, pillHx, pillHy, pillR));
  const orange = Math.min(orangeFull, clamp((px - pillCx) / (2 * feather) + 0.5, 0, 1));

  // Knob hole: dark circle inside the orange half.
  const holeR = pillHy * 0.72;
  const hole = cov(dCircle(px, py, pillCx + pillHx - pillR, pillCy, holeR));

  // Brand dot above the "i" (blue) — positioned like the wordmark lockup.
  const dot = cov(dCircle(px, py, pillCx + SIZE * 0.055, pillCy - SIZE * 0.20, SIZE * 0.032));

  return { tile, blue, orange, hole, dot };
}

/* ---------------- render master canvas ----------------
 * field values: 1+t = tile alpha; 11+b = blue over tile; 21+o = orange;
 * 31+d = dot. Knob hole is resolved while compositing (region under hole
 * becomes tile-dark). Glyph-over-base packing keeps downsampling correct. */
const field = new Float32Array(SIZE * SIZE);
for (let y = 0; y < SIZE; y++) {
  for (let x = 0; x < SIZE; x++) {
    let tileA = 0, blueA = 0, orangeA = 0, holeA = 0, dotA = 0;
    for (let sy = 0; sy < SS; sy++) {
      for (let sx = 0; sx < SS; sx++) {
        const px = x + (sx + 0.5) / SS;
        const py = y + (sy + 0.5) / SS;
        const s = scene(px, py);
        tileA += s.tile; blueA += s.blue; orangeA += s.orange; holeA += s.hole; dotA += s.dot;
      }
    }
    const n = SS * SS;
    tileA /= n; blueA /= n; orangeA /= n; holeA /= n; dotA /= n;

    // Composite orange over blue over tile; hole punches orange back to tile.
    let v;
    if (dotA > 0.5)                 v = 31 + dotA;                       // blue dot (topmost)
    else if (orangeA > 0.5)         v = holeA > 0.5 ? 1 + tileA : 21 + Math.max(orangeA, blueA);
    else if (blueA > 0.5)           v = 11 + blueA;
    else                            v = 1 + tileA;
    field[y * SIZE + x] = v;
  }
}

/* ---------------- PNG encoding (unchanged plumbing) ---------------- */
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
      let r = 0, g = 0, b = 0, a = 0;
      const x0 = Math.floor(x * scale), y0 = Math.floor(y * scale);
      const x1 = Math.min(SIZE, Math.ceil((x + 1) * scale));
      const y1 = Math.min(SIZE, Math.ceil((y + 1) * scale));
      for (let sy = y0; sy < y1; sy++) {
        for (let sx = x0; sx < x1; sx++) {
          const v = field[sy * SIZE + sx];
          let rgb, covA;
          if (v >= 31)      { rgb = [30, 143, 255]; covA = v - 31; }   // brand blue dot
          else if (v >= 21) { rgb = [255, 160, 19];  covA = v - 21; }  // orange
          else if (v >= 11) { rgb = [30, 143, 255];  covA = v - 11; }  // blue
          else              { rgb = [17, 18, 20];    covA = v - 1; }   // dark tile
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
