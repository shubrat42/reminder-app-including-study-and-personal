// One-off functional test for the synthesized alert WAV (safe to delete).
const fs = require('fs');
const html = fs.readFileSync('index.html', 'utf8');

// Extract buildAlertWav via brace matching — a naive regex breaks on the
// nested braces inside the WAV-header helper.
const start = html.indexOf('function buildAlertWav()');
if (start < 0) { console.error('buildAlertWav not found'); process.exit(1); }
const bodyStart = html.indexOf('{', start);
let depth = 0, end = -1;
for (let i = bodyStart; i < html.length; i++) {
  if (html[i] === '{') depth++;
  else if (html[i] === '}') { depth--; if (depth === 0) { end = i; break; } }
}
if (end < 0) { console.error('unbalanced braces in buildAlertWav'); process.exit(1); }
const buildAlertWav = new Function(html.slice(start, end + 1) + '; return buildAlertWav;')();
const buf = Buffer.from(buildAlertWav());

// --- WAV structure ---
if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') {
  console.error('bad WAV header'); process.exit(1);
}
const sr = buf.readUInt32LE(24);
const dataLen = buf.readUInt32LE(40);
const n = dataLen / 2;
console.log('WAV ok: ' + (buf.length / 1024).toFixed(1) + ' KB, ' + sr + ' Hz mono 16-bit, ' +
  (n / sr).toFixed(2) + 's');

// --- loudness: peak amplitude across the whole file ---
let peak = 0;
for (let i = 0; i < n; i++) {
  const s = Math.abs(buf.readInt16LE(44 + i * 2));
  if (s > peak) peak = s;
}
const peakFs = peak / 32767;
console.log('peak amplitude: ' + (peakFs * 100).toFixed(1) + '% full-scale');
if (peakFs < 0.7) { console.error('FAIL: too quiet (old chime peaked ~12%)'); process.exit(1); }

// RMS over the first tone's sustained region (0.05s..0.4s) — perceived loudness proxy
let sum = 0, cnt = 0;
for (let i = (0.05 * sr) | 0; i < (0.4 * sr) | 0; i++) {
  const s = buf.readInt16LE(44 + i * 2) / 32767;
  sum += s * s; cnt++;
}
const rms = Math.sqrt(sum / cnt);
console.log('sustain RMS: ' + (rms * 100).toFixed(1) + '%');
if (rms < 0.4) { console.error('FAIL: sustain RMS too low'); process.exit(1); }

// --- two tones present, with a real gap between them ---
function bandEnergy(t0, t1) {
  let e = 0;
  for (let i = (t0 * sr) | 0; i < (t1 * sr) | 0; i++) {
    const s = buf.readInt16LE(44 + i * 2) / 32767;
    e += s * s;
  }
  return Math.sqrt(e / ((t1 - t0) * sr));
}
const dingE = bandEnergy(0.05, 0.40), dongE = bandEnergy(0.60, 1.10), gapE = bandEnergy(0.46, 0.54);
console.log('tone1 ' + (dingE * 100).toFixed(0) + '% / tone2 ' + (dongE * 100).toFixed(0) + '% / gap ' + (gapE * 100).toFixed(0) + '%');
if (dingE < 0.3 || dongE < 0.3) { console.error('FAIL: missing a tone'); process.exit(1); }
if (gapE > dingE * 0.15) { console.error('FAIL: no gap between tones (not two-tone)'); process.exit(1); }

// --- duration inside the 1–1.5s window the user asked for ---
if (n / sr < 1.0 || n / sr > 1.5) { console.error('FAIL: duration outside 1–1.5s'); process.exit(1); }

console.log('PASS: sharp loud two-tone alert, ~1.2s, peaks near full scale');
