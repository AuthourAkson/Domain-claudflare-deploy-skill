// Minimal CDP client over the global WebSocket (Node 22+). No npm deps.
// Usage:
//   node cdp.js targets
//   node cdp.js eval <urlSubstring> <jsExpressionFile>
//   node cdp.js nav <urlSubstring> <url>
//   node cdp.js newtab <url>
//   node cdp.js shot <urlSubstring> <outPng>
//   node cdp.js text <urlSubstring>
const fs = require('fs');
const PORT = process.env.CDP_PORT || 9222;
const BASE = `http://127.0.0.1:${PORT}`;

async function listTargets() {
  const r = await fetch(`${BASE}/json/list`);
  return (await r.json()).filter(t => t.type === 'page');
}
function pick(targets, sub) {
  if (!sub || sub === '-') return targets[0];
  const t = targets.find(t => (t.url || '').includes(sub)) || targets.find(t => t.id === sub);
  if (!t) throw new Error(`no target matching "${sub}" in: ${targets.map(t => t.url).join(' | ')}`);
  return t;
}
class CDP {
  constructor(wsUrl) { this.wsUrl = wsUrl; this.id = 0; this.pending = new Map(); this.events = []; }
  connect() {
    return new Promise((res, rej) => {
      this.ws = new WebSocket(this.wsUrl);
      this.ws.onopen = () => res(this);
      this.ws.onerror = e => rej(new Error('ws error: ' + (e.message || 'unknown')));
      this.ws.onmessage = ev => {
        const m = JSON.parse(ev.data);
        if (m.id && this.pending.has(m.id)) {
          const { res, rej } = this.pending.get(m.id);
          this.pending.delete(m.id);
          m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result);
        } else if (m.method) this.events.push(m);
      };
    });
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((res, rej) => {
      const timer = setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); rej(new Error('timeout ' + method)); } }, 60000);
      const done = (fn) => (v) => { clearTimeout(timer); fn(v); };
      this.pending.set(id, { res: done(res), rej: done(rej) });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  async evalIn(expr) {
    const r = await this.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true, userGesture: true });
    if (r.exceptionDetails) throw new Error('JS: ' + JSON.stringify(r.exceptionDetails.exception?.description || r.exceptionDetails.text));
    return r.result.value;
  }
  close() { try { this.ws.close(); } catch {} }
}
async function withTarget(sub, fn) {
  const targets = await listTargets();
  const t = pick(targets, sub);
  const c = new CDP(t.webSocketDebuggerUrl);
  await c.connect();
  try { return await fn(c, t); } finally { c.close(); }
}
(async () => {
  const [cmd, a1, a2] = process.argv.slice(2);
  if (cmd === 'targets') {
    const ts = await listTargets();
    console.log(JSON.stringify(ts.map(t => ({ id: t.id, url: t.url, title: t.title })), null, 1));
  } else if (cmd === 'newtab') {
    const r = await fetch(`${BASE}/json/new?${encodeURIComponent(a1)}`, { method: 'PUT' });
    const t = await r.json();
    console.log('opened', t.id, t.url);
    await new Promise(r2 => setTimeout(r2, 2500));
    await withTarget(t.id, async c => { await c.send('Page.enable'); });
  } else if (cmd === 'close') {
    const ts = await listTargets();
    const t = pick(ts, a1);
    await fetch(`${BASE}/json/close/${t.id}`);
    console.log('closed', t.url);
  } else if (cmd === 'nav') {
    const out = await withTarget(a1, async (c) => {
      await c.send('Page.enable');
      await c.send('Page.navigate', { url: a2 });
      for (let i = 0; i < 40; i++) {
        await new Promise(r => setTimeout(r, 500));
        try {
          const st = await c.evalIn('document.readyState');
          if (st === 'complete') break;
        } catch {}
      }
      await new Promise(r => setTimeout(r, 1200));
      return await c.evalIn('document.readyState + " :: " + location.href + " :: " + document.title');
    });
    console.log(out);
  } else if (cmd === 'eval') {
    const expr = fs.readFileSync(a2, 'utf8');
    const out = await withTarget(a1, c => c.evalIn(expr));
    console.log(typeof out === 'string' ? out : JSON.stringify(out, null, 1));
  } else if (cmd === 'text') {
    const out = await withTarget(a1, c => c.evalIn('document.body ? document.body.innerText.slice(0, 4000) : "(no body)"'));
    console.log(out);
  } else if (cmd === 'clickxy') {
    // 真实鼠标点击（可以点到跨域 iframe 里的元素，比如 Turnstile 的复选框）
    const [x, y] = [Number(a2), Number(process.argv[4])];
    await withTarget(a1, async c => {
      for (const type of ['mousePressed', 'mouseReleased']) {
        await c.send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1, buttons: 1 });
        await new Promise(r => setTimeout(r, 80));
      }
      console.log(`clicked at ${x},${y}`);
    });
  } else if (cmd === 'shot') {
    await withTarget(a1, async c => {
      await c.send('Page.enable');
      const r = await c.send('Page.captureScreenshot', { format: 'png' });
      fs.writeFileSync(a2, Buffer.from(r.data, 'base64'));
      console.log('saved ' + a2);
    });
  } else if (cmd === 'shotfull') {
    await withTarget(a1, async c => {
      await c.send('Page.enable');
      const m = await c.send('Page.getLayoutMetrics');
      const w = Math.ceil(m.cssContentSize?.width || 1440), h = Math.ceil(m.cssContentSize?.height || 900);
      await c.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: Math.min(h, 8000), deviceScaleFactor: 1, mobile: false });
      const r = await c.send('Page.captureScreenshot', { format: 'png' });
      await c.send('Emulation.clearDeviceMetricsOverride');
      fs.writeFileSync(a2, Buffer.from(r.data, 'base64'));
      console.log('saved ' + a2 + ' (1440x' + Math.min(h, 8000) + ')');
    });
  } else if (cmd === 'viewport') {
    await withTarget(a1, async c => {
      await c.send('Emulation.setDeviceMetricsOverride', { width: Number(a2) || 1440, height: 900, deviceScaleFactor: 1, mobile: false });
      console.log('viewport set');
    });
  } else {
    console.log('usage: targets | newtab <url> | close <sub> | nav <sub> <url> | eval <sub> <jsfile> | text <sub> | shot <sub> <png>');
    process.exit(1);
  }
})().catch(e => { console.error('ERROR: ' + e.message); process.exit(1); });
