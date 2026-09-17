// Functional test for the bundled alarm MP3 (safe to delete).
// Verifies the file itself AND that index.html wires it in correctly.
const fs = require('fs');
const path = require('path');

let fail = 0;
function check(name, ok, detail) {
  if (ok) console.log('  ✓ ' + name + (detail ? ' — ' + detail : ''));
  else { console.error('  ✗ ' + name + (detail ? ' — ' + detail : '')); fail = 1; }
}

console.log('[1] MP3 file');
const mp3 = fs.readFileSync('assets/alarm.mp3');
check('file exists & non-empty', mp3.length > 10 * 1024, (mp3.length / 1024).toFixed(0) + ' KB');

// MP3 frame sync (0xFF Ex/Ex) + duration estimate at the file's 256 kbps bitrate
// (measured via afinfo: 3.4s, 256 kbps — so duration = size·8 / 256000).
check('MP3 frame sync at byte 0', mp3[0] === 0xff && (mp3[1] & 0xe0) === 0xe0, 'header ' +
  mp3.slice(0, 4).toString('hex'));
const durationS = (mp3.length * 8) / 256000;
check('duration ≈ 1.5–7s', durationS > 1.5 && durationS < 7,
  '~' + durationS.toFixed(1) + 's at 256 kbps');
check('not silent (contains non-zero frames)', mp3.some((b) => b > 0x10), '');

console.log('[2] index.html wiring');
const html = fs.readFileSync('index.html', 'utf8');
check('ALERT_SRC points at the MP3', /var ALERT_SRC\s*=\s*'assets\/alarm\.mp3'/.test(html), '');
check('no stale synthesized-WAV generator left', !/buildAlertWav|audio\/wav/.test(html), '');
check('preloaded at page load', /alertAudio\.preload\s*=\s*'auto'/.test(html), '');
check('explicit volume right before .play()', /alertAudio\.volume\s*=\s*state\.soundVol;[^;]{0,80}alertAudio\.play\(\)/.test(html), '');
check('muted path returns early', /if \(!state\.soundVol\) return;/.test(html), '');
check('WebAudio fallback kept', /function playChime\(\)/.test(html), '');
check('fallback is NOT the old ding-dong', !/659\.25|880\.00/.test(html),
  'fallback is now three short pulses');

console.log('[3] service worker');
const sw = fs.readFileSync('sw.js', 'utf8');
check('MP3 precached for offline', /'\.\/assets\/alarm\.mp3'/.test(sw), '');
check('cache version bumped to v12', /remindly-v12/.test(sw), '');

process.exit(fail);
