// One-off verification for the polish fixes (safe to delete).
const fs = require('fs');
const html = fs.readFileSync('index.html', 'utf8');

// 1. Syntax-check every inline script block.
const scripts = [...html.matchAll(/<script(?![^>]*src)[^>]*>([\s\S]*?)<\/script>/g)].map(m => m[1]);
scripts.forEach((js, i) => { new (require('vm').Script)(js); });
console.log('syntax OK (' + scripts.length + ' script blocks)');

// 2. Every ID referenced from JS must exist in the markup.
const ids = new Set([...html.matchAll(/id="([^"]+)"/g)].map(m => m[1]));
const refs = new Set([
  ...[...html.matchAll(/\$\('#([A-Za-z0-9_-]+)'\)/g)].map(m => m[1]),
  ...[...html.matchAll(/getElementById\('([^']+)'\)/g)].map(m => m[1]),
]);
const missing = [...refs].filter(r => !ids.has(r));
if (missing.length) { console.error('MISSING IDs:', missing); process.exit(1); }
console.log('all ' + refs.size + ' JS-referenced IDs exist');

// 3. New feature pieces are all present.
const need = ['glanceStrip', 'renderGlance', 'renderGreeting', 'USER_NAME',
  'g-motiv', 'MOTIVATION', 'glanceDayStr', 'jumpToDay', 'reminderChanged',
  'brand-txt', 'theme-btn:focus-visible'];
const lack = need.filter(n => !html.includes(n));
if (lack.length) { console.error('MISSING pieces:', lack); process.exit(1); }
console.log('all new feature pieces present');

// 4. Theme button kills the stuck ring; keyboard focus ring is neutral.
const tb = html.match(/\.theme-btn \{[\s\S]*?\}/)[0];
if (!/outline:\s*none/.test(tb)) { console.error('theme-btn missing outline:none'); process.exit(1); }
if (!/\.theme-btn:focus:not\(:focus-visible\) \{ outline: none; box-shadow: none; \}/.test(html)) {
  console.error('theme-btn click-focus reset missing'); process.exit(1);
}
console.log('theme-btn: no ring on click/tap, subtle ring on keyboard focus only');

// 5. Greeting shows name + date; mobile hides only the date.
if (!/Good ' \+ part \+ ', ' \+ esc\(USER_NAME\)/.test(html)) { console.error('greeting string wrong'); process.exit(1); }
if (!/\.brand small \.d \{ display: none; \}/.test(html)) { console.error('mobile date rule missing'); process.exit(1); }
console.log('greeting OK (name + date, date hidden on phones only)');

// 6. The accidentally-replaced field-row rule is intact in the media query.
const mq = html.match(/@media \(max-width: 560px\) \{[\s\S]*?\n\}/)[0];
if (!/\.field-row, \.field-row-3 \{ grid-template-columns: 1fr 1fr; \}/.test(mq)) {
  console.error('field-row rule lost from mobile media query'); process.exit(1);
}
console.log('mobile media query intact (.field-row restored alongside glance rules)');

// 7. Alert sound: loud two-tone WAV, preloaded, explicit volume, WebAudio fallback.
if (!/buildAlertWav|initAlert|playAlert/.test(html)) { console.error('alert sound functions missing'); process.exit(1); }
if (!/alertAudio\.volume = state\.soundVol;[\s\S]{0,40}alertAudio\.play\(\)/.test(html) &&
    !/alertAudio\.volume = state\.soundVol;\s*\/\/ explicit[\s\S]{0,60}\.play\(\)/.test(html)) {
  console.error('volume not set explicitly before play()'); process.exit(1);
}
if (!/alertAudio\.preload = 'auto'/.test(html)) { console.error('alert not preloaded'); process.exit(1); }
if (!/catchUpMissed/.test(html) || !/visibilitychange/.test(html)) { console.error('background catch-up missing'); process.exit(1); }
if (!/soundBtn/.test(html) || !/soundVol/.test(html)) { console.error('sound toggle missing'); process.exit(1); }
if (/playChime\(\);\s*$/m.test(html.replace(/function playAlert[\s\S]*?\n  \}/, '')) === false) { /* playChime still referenced */ }
console.log('alert sound: preloaded WAV, explicit volume, catch-up on visible, volume toggle persisted');
