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
check('alarm preset points at the MP3', /alarm:\s*'assets\/alarm\.mp3'/.test(html), '');
check('old ding-dong tones gone', !/880\.00|659\.25/.test(html),
  'presets are chime (G5/C6) + beep (1kHz) now');
check('preloaded at page load', /alertAudio\.preload\s*=\s*'auto'/.test(html), '');
check('explicit volume right before .play()', /alertAudio\.volume\s*=\s*state\.soundVol;[^;]{0,80}alertAudio\.play\(\)/.test(html), '');
check('muted path returns early', /if \(!state\.soundVol\) return;/.test(html), '');
check('WebAudio fallback kept', /function playChime\(\)/.test(html), '');
check('fallback is NOT the old ding-dong', !/659\.25|880\.00/.test(html),
  'fallback is now three short pulses');
check('in-app notification is silent (MP3 provides the sound)',
  /new Notification\('⏰ ' \+ rem\.title, \{[\s\S]{0,220}?silent: true/.test(html), '');

console.log('[3] service worker');
const sw = fs.readFileSync('sw.js', 'utf8');
check('MP3 precached for offline', /'\.\/assets\/alarm\.mp3'/.test(sw), '');
check('cache version bumped to v15', /remindly-v15/.test(sw), '');
check('push notification silent only while app is visible',
  /silent: appVisible/.test(sw), 'OS sound kept when app is closed');

console.log('[4] actionable notifications');
const apiSend = fs.readFileSync('api/send.js', 'utf8');
check('alarm vibration pattern', /vibrate:\s*\[200, 100, 200, 100, 400\]/.test(sw), '');
check('Done + Snooze action buttons', /action:\s*'done'/.test(sw) && /action:\s*'snooze'/.test(sw), '');
check('payload carries reminder id + category', /id: data\.data && data\.data\.id/.test(sw) &&
  /id: reminder\.id/.test(apiSend), '');
check('click handler branches on event.action', /event\.action/.test(sw), '');
check('open app gets postMessage action', /type:\s*'notification-action'/.test(sw) &&
  /notification-action/.test(html), '');
check('closed app deep-links ?action=&id=', /'\?action=' \+ encodeURIComponent/.test(sw) &&
  /applyUrlAction/.test(html), '');
check('URL params stripped after applying', /history\.replaceState\(null, '', location\.pathname\)/.test(html), '');
check('snooze resyncs QStash via saveReminders',
  /delete fired\[rem\.id\];[\s\S]{0,120}saveReminders\(\);[\s\S]{0,80}resyncs the QStash schedule|.\/\/ → resyncs the QStash schedule/.test(html), '');

process.exit(fail);
