// Clock page + settings-toggle verification (safe to delete).
// Static checks first, then a REAL headless-Chrome smoke test:
// toggles actually receive clicks, tabs switch, stopwatch runs, timer fires.
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

let fail = 0;
function check(name, ok, detail) {
  if (ok) console.log('  ✓ ' + name + (detail ? ' — ' + detail : ''));
  else { console.error('  ✗ ' + name + (detail ? ' — ' + detail : '')); fail = 1; }
}

const html = fs.readFileSync('index.html', 'utf8');
const sw = fs.readFileSync('sw.js', 'utf8');

console.log('[static]');
check('switch knob lets clicks through to the input',
  /\.switch \.knob \{[^}]*pointer-events:\s*none/.test(html), '');
check('preview has a dedicated play-once path',
  /function playPreview\(\)/.test(html) && /previewBtn'\)\.addEventListener[\s\S]{0,120}playPreview\(\)/.test(html), '');
check('alarms use their own localStorage key',
  /ALARMS_KEY = 'remindly\.alarms\.v1'/.test(html), 'remindly.alarms.v1');
check('alarms ride the QStash pipeline',
  /alarmsAsReminders\(\)/.test(html) && /concat\(alarmsAsReminders\(\)\)/.test(html), '');
check('stopwatch derives time from a start timestamp',
  /swElapsed\(\) \{ return sw\.acc \+ \(sw\.running \? Date\.now\(\) - sw\.startTs : 0\)/.test(html), '');
check('timer derives remaining from a target end timestamp',
  /timer\.endTs - Date\.now\(\)/.test(html), '');
check('clock page is a separate view', /body\[data-view="clock"\] \.clock-page \{ display: block/.test(html), '');
check('tick respects default-off + 1s ticker hook',
  /if \(state\.tick\) playTick\(\)/.test(html), '');

(async () => {
  console.log('[headless chrome]');
  const puppeteer = require('puppeteer');
  const http = require('http');

  // Serve the project over real http — file:// makes Chrome CORS-block the
  // web app manifest, which would pollute the error log with false positives.
  const root = path.join(__dirname, '..');
  const mimes = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json',
                  '.mp3': 'audio/mpeg', '.png': 'image/png' };
  const srv = http.createServer((req, res) => {
    if (req.url === '/favicon.ico') { res.writeHead(204); return res.end(); }  // no favicon → no console noise
    if (req.url === '/api/ping') {   // stub the backend health check (no API here)
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: true, vapid: true, secret: true, qstash: true }));
    }
    const p = path.join(root, req.url === '/' ? 'index.html' : decodeURIComponent(req.url.split('?')[0]));
    fs.readFile(p, (err, data) => {
      if (err) { res.writeHead(404); return res.end('nope'); }
      res.writeHead(200, { 'Content-Type': mimes[path.extname(p)] || 'application/octet-stream' });
      res.end(data);
    });
  }).listen(0);
  const base = 'http://127.0.0.1:' + srv.address().port;

  const exe = execSync('ls -t /Applications/Google\\ Chrome.app/Contents/MacOS/Google\\ Chrome | head -1').toString().trim();
  const browser = await puppeteer.launch({
    executablePath: exe, headless: 'new',
    args: ['--no-sandbox', `--remote-debugging-port=0`, '--autoplay-policy=no-user-gesture-required'],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 900 });
  const errors = [];
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });

  await page.goto(base + '/', { waitUntil: 'load' });
  await new Promise((r) => setTimeout(r, 700));

  // Open Clock view via the desktop header button (the mobile switcher
  // pill is hidden at 1280px by design).
  await page.click('#clockViewBtn');
  const view = await page.evaluate(() => document.body.dataset.view);
  check('Clock button switches view', view === 'clock', view);
  await page.click('#ckBackBtn');
  check('‹ Back returns to the list',
    (await page.evaluate(() => document.body.dataset.view)) === 'list', '');
  await page.click('#clockViewBtn');

  // Mobile switcher has the Clock tab (primary phone path).
  check('mobile switcher has a Clock tab', /data-view="clock">Clock<\/button>/.test(html), '');

  await page.evaluate(() => document.getElementById('settingsBtn').click());
  await page.evaluate(() => document.getElementById('tickToggle').click());
  const tickOn = await page.evaluate(() => document.getElementById('tickToggle').checked);
  check('Tick toggle is clickable and switches on', tickOn === true, '');
  await page.evaluate(() => document.getElementById('fmt24Toggle').click());
  const clock24 = await page.evaluate(() => {
    const t = document.getElementById('clock').textContent;
    return { text: t, hasAmPm: /AM|PM/.test(t) };
  });
  check('24h toggle: header clock has no AM/PM', tickOn && clock24.hasAmPm === false, clock24.text);
  await page.evaluate(() => document.getElementById('settingsCloseBtn').click());

  // Preview plays once (no crash, no loop) — headless autoplay allowed.
  await page.evaluate(() => document.getElementById('settingsBtn').click());
  await page.evaluate(() => document.getElementById('previewBtn').click());
  check('Preview click runs without error', errors.length === 0, errors[0] || '');
  await page.evaluate(() => document.getElementById('settingsCloseBtn').click());

  // Tabs switch panes.
  await page.click('.ck-tab[data-ck="stopwatch"]');
  const swPaneOn = await page.evaluate(() =>
    document.querySelector('.ck-pane[data-pane="stopwatch"]').classList.contains('on'));
  check('Stopwatch tab opens its pane', swPaneOn, '');

  // Stopwatch runs from timestamps (starts near 00:00, later >1s).
  await page.click('#swStartBtn');
  const early = await page.$eval('#swDisplay', (el) => el.textContent);
  await new Promise((r) => setTimeout(r, 1300));
  const later = await page.$eval('#swDisplay', (el) => el.textContent);
  check('Stopwatch advances', early !== later, early + ' → ' + later);
  await page.click('#swLapBtn');
  const laps = await page.$$eval('#swLaps .lap-row', (r) => r.length);
  check('Lap records a split', laps === 1, laps + ' lap');
  await page.click('#swStartBtn');  // pause
  const frozen = await page.$eval('#swDisplay', (el) => el.textContent);
  await new Promise((r) => setTimeout(r, 400));
  const still = await page.$eval('#swDisplay', (el) => el.textContent);
  check('Pause freezes the display', frozen === still, frozen);
  await page.click('#swResetBtn');
  check('Reset returns to 00:00.00',
    (await page.$eval('#swDisplay', (el) => el.textContent)) === '00:00.00', '');

  // Timer: 3-second run, completes, fires toast + resets ring.
  await page.click('.ck-tab[data-ck="timer"]');
  await page.evaluate(() => {
    document.getElementById('timerH').value = 0;
    document.getElementById('timerM').value = 0;
    document.getElementById('timerS').value = 3;
    document.getElementById('timerS').dispatchEvent(new Event('input'));
  });
  check('Timer idle shows input preview',
    (await page.$eval('#timerDisplay', (el) => el.textContent)) === '00:03', '');
  await page.click('#timerStartBtn');
  await new Promise((r) => setTimeout(r, 3600));
  const done = await page.evaluate(() => ({
    disp: document.getElementById('timerDisplay').textContent,
    toast: !!document.querySelector('.toast'),
    btn: document.getElementById('timerStartBtn').textContent,
  }));
  check('Timer completes at 00:00', done.disp === '00:00', done.disp);
  check('Timer completion shows a toast', done.toast, '');
  check('Timer Start resets to fresh state', done.btn === 'Start', done.btn);

  // Alarm: create, see row, toggle off, delete.
  await page.click('.ck-tab[data-ck="alarm"]');
  await page.evaluate(() => { document.getElementById('alarmTime').value = '23:59'; });
  await page.click('#alarmSaveBtn');
  const rows = await page.$$eval('#alarmList .alarm-row', (r) => r.length);
  check('Alarm saved appears in list', rows === 1, rows + ' row');
  await page.click('#alarmList .alarm-row .switch input');
  const off = await page.$eval('#alarmList .alarm-row', (el) => el.classList.contains('off'));
  check('Alarm toggle switches off', off, '');
  await page.click('#alarmList .alarm-row [data-act="del"]');
  check('Alarm delete empties list',
    (await page.$$eval('#alarmList .alarm-row', (r) => r.length)) === 0, '');

  check('zero page errors during the whole session', errors.length === 0,
    errors.slice(0, 3).join(' | '));

  await browser.close();
  srv.close();
  process.exit(fail);
})().catch((e) => { console.error('  ✗ harness crashed:', e.message); process.exit(1); });
