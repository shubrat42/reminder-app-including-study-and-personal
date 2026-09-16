// Real-browser overflow test for long reminder titles (safe to delete).
// Spawns headless Chrome with remote debugging, loads index.html from a
// static server, seeds a 120-char unbroken reminder via localStorage, and
// asserts the page never overflows horizontally.
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT_HTTP = 8931;
const PORT_CDP = 9223;

// --- tiny static server (no dependencies) ---
const server = http.createServer((req, res) => {
  const url = req.url.split('?')[0];
  const file = path.join(ROOT, url === '/' ? 'index.html' : url);
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'Content-Type': file.endsWith('.json') ? 'application/json' : 'text/html' });
    res.end(data);
  });
});

function wait(ms) { return new Promise(r => setTimeout(r, ms)); }

async function getJSON(url) {
  return new Promise((resolve, reject) => {
    http.get(url, res => {
      let b = '';
      res.on('data', c => (b += c));
      res.on('end', () => { try { resolve(JSON.parse(b)); } catch (e) { reject(e); } });
    }).on('error', reject);
  });
}

const CDP_URL = 'http://127.0.0.1:' + PORT_CDP;

// Minimal WebSocket client for the CDP evaluate protocol (no deps).
// Frames: FIN+text, client→server frames must be MASKED per RFC 6455.
function wsConnect(url) {
  return new Promise((resolve, reject) => {
    const key = 'x3JJHMbDL1EzLkh9GBhXDw==';
    const req = http.get(url.replace(/^ws:/, 'http:'), { headers: {
      Connection: 'Upgrade', Upgrade: 'websocket',
      'Sec-WebSocket-Key': key, 'Sec-WebSocket-Version': 13
    }});
    req.on('upgrade', (res, socket) => {
      let buf = Buffer.alloc(0);
      const handlers = [];
      socket.on('data', d => {
        buf = Buffer.concat([buf, d]);
        while (true) {
          if (buf.length < 2) break;
          const len0 = buf[1] & 0x7f;
          let off = 2, len = len0;
          if (len0 === 126) { if (buf.length < 4) break; len = buf.readUInt16BE(2); off = 4; }
          else if (len0 === 127) { if (buf.length < 10) break; len = Number(buf.readBigUInt64BE(2)); off = 10; }
          if (buf.length < off + len) break;
          handlers.forEach(h => h(buf.slice(off, off + len).toString('utf8')));
          buf = buf.slice(off + len);
        }
      });
      const api = {
        onmessage(h) { handlers.push(h); },
        send(str) {
          const payload = Buffer.from(str);
          const mask = Buffer.from([1, 2, 3, 4]);
          let header;
          if (payload.length < 126) header = Buffer.from([0x81, 0x80 | payload.length]);
          else if (payload.length < 65536) {
            header = Buffer.alloc(4); header[0] = 0x81; header[1] = 0x80 | 126;
            header.writeUInt16BE(payload.length, 2);
          } else {
            header = Buffer.alloc(10); header[0] = 0x81; header[1] = 0x80 | 127;
            header.writeBigUInt64BE(BigInt(payload.length), 2);
          }
          const masked = Buffer.alloc(payload.length);
          for (let i = 0; i < payload.length; i++) masked[i] = payload[i] ^ mask[i & 3];
          socket.write(Buffer.concat([header, mask, masked]));
        },
        close() { socket.end(); }
      };
      resolve(api);
    });
    req.on('error', reject);
  });
}

(async () => {
  server.listen(PORT_HTTP);

  // 1. Launch headless Chrome with a fresh profile.
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'switchr-test-'));
  const chrome = spawn(CHROME, [
    '--headless=new', '--no-first-run', '--no-default-browser-check',
    '--remote-debugging-port=' + PORT_CDP, '--user-data-dir=' + userDataDir,
    '--window-size=1280,900', 'about:blank'
  ], { stdio: 'ignore' });

  try {
    // 2. Grab a page target.
    let target;
    for (let i = 0; i < 40; i++) {
      try {
        const list = await getJSON(CDP_URL + '/json/list');
        target = list.find(t => t.type === 'page');
        if (target) break;
      } catch (e) { /* chrome not up yet */ }
      await wait(250);
    }
    if (!target) throw new Error('no page target found');

    // 3. Wire a minimal CDP session: id-matched responses + Runtime.evaluate.
    const ws = await wsConnect(target.webSocketDebuggerUrl);
    let msgId = 0;
    const pending = new Map();
    ws.onmessage(raw => {
      const m = JSON.parse(raw);
      if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
    });
    function send(method, params) {
      return new Promise((resolve, reject) => {
        const id = ++msgId;
        pending.set(id, m => m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result));
        ws.send(JSON.stringify({ id, method, params: params || {} }));
      });
    }
    async function evalJS(expr) {
      const r = await send('Runtime.evaluate', {
        expression: expr, returnByValue: true, awaitPromise: true
      });
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || 'page JS error');
      return r.result.value;
    }
    await send('Page.enable');
    await send('Runtime.enable');

    const page = async () => {
      await send('Page.navigate', { url: 'http://127.0.0.1:' + PORT_HTTP + '/' });
      await wait(900); // let the app boot and render
    };

    // 4. Seed one reminder with a 120-char unbroken title, then reload.
    await page();
    const title120 = 'X'.repeat(120);
    await evalJS(
      "localStorage.setItem('remindly.reminders.v1', JSON.stringify([{id:'t1',title:'" + title120 + "',notes:'',category:'Study',priority:'High',repeat:'none',date:'2026-12-01',time:'09:00',done:false}]));" +
      "localStorage.setItem('remindly.prefs.v1', JSON.stringify({theme:'light',mode:'Study',view:'list',soundVol:1}));"
    );
    await page();

    // 5. Measure real layout at desktop width.
    const desk = await evalJS(
      "(function(){var d=document.documentElement,b=document.body;" +
      "return{scrollW:d.scrollWidth,clientW:d.clientWidth,bodyScrollW:b.scrollWidth," +
      "titleW:document.querySelector('.rem-title').getBoundingClientRect().width," +
      "listW:document.querySelector('.list-panel').getBoundingClientRect().width," +
      "titleText:document.querySelector('.rem-title').textContent.length}})()"
    );
    console.log('desktop @1280:', JSON.stringify(desk));
    if (desk.scrollW > desk.clientW + 1) { console.error('FAIL: page overflows horizontally (desktop)'); process.exit(1); }
    if (desk.titleText !== 120) { console.error('FAIL: 120-char title not rendered'); process.exit(1); }
    if (desk.titleW > desk.listW + 1) { console.error('FAIL: title wider than its card'); process.exit(1); }

    // 6. Shrink viewport to phone width — the layout must still hold.
    await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
    await wait(500);
    const mob = await evalJS(
      "(function(){var d=document.documentElement;return{scrollW:d.scrollWidth,clientW:d.clientWidth}})()"
    );
    console.log('mobile @390:', JSON.stringify(mob));
    if (mob.scrollW > mob.clientW + 1) { console.error('FAIL: page overflows horizontally (mobile)'); process.exit(1); }

    // 7. Long notes line: must wrap and stay inside the card too.
    await evalJS(
      "localStorage.setItem('remindly.reminders.v1', JSON.stringify([{id:'t1',title:'OK',notes:'N'.repeat(160),category:'Study',priority:'Low',repeat:'none',date:'2026-12-01',time:'09:00',done:false}]));"
    );
    await page();
    const notes = await evalJS(
      "(function(){var d=document.documentElement,n=document.querySelector('.rem-notes');" +
      "return{scrollW:d.scrollWidth,clientW:d.clientWidth,notesH:n?n.getBoundingClientRect().height:0," +
      "notesW:n?n.getBoundingClientRect().width:0,listW:document.querySelector('.list-panel').getBoundingClientRect().width}})()"
    );
    console.log('long-notes @1280:', JSON.stringify(notes));
    if (notes.scrollW > notes.clientW + 1) { console.error('FAIL: long notes overflow the page'); process.exit(1); }
    if (!notes.notesW || notes.notesW > notes.listW + 1) { console.error('FAIL: notes wider than card'); process.exit(1); }
    if (notes.notesH < 20) { console.error('FAIL: notes did not wrap to multiple lines'); process.exit(1); }

    console.log('PASS: no horizontal overflow with long titles/notes at 1280px and 390px');
    ws.close();
    process.exit(0);
  } finally {
    chrome.kill();
    server.close();
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
})().catch(e => { console.error(e.message); process.exit(1); });
