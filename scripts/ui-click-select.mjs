// 用 CDP 操作 Cloudflare 等 Base UI(Radix 系) 面板里的下拉。
// 为什么不能只用 .click()：这些下拉是**虚拟化列表**，弹层只渲染 1 行（--available-height
// 被算得很小），DOM 里没有其它 option；键盘 Enter 也**不会提交**选中。
// 实测有效的姿势：点击触发器打开 → 直接点那个 option 元素（pointer 事件 + click）→ 回读触发器文字确认。
//
// 用法：
//   1) 先起一个带远程调试的 Chrome，让它停在目标页面
//   2) CDP_PORT=9225 node ui-click-select.mjs "base-ui-:r4g:=10 seconds" "base-ui-:r4m:=Block"
//      参数格式： <触发器元素id>=<选项文本>，可传多个；选项文本支持"包含匹配"。
const PORT = process.env.CDP_PORT || 9222;
const pairs = process.argv.slice(2).map((s) => {
  const i = s.indexOf('=');
  return { triggerId: s.slice(0, i), want: s.slice(i + 1) };
});
if (!pairs.length || pairs.some((p) => !p.triggerId || !p.want)) {
  console.error('用法: node ui-click-select.mjs "<触发器id>=<选项文本>" ["<id>=<文本>" ...]');
  process.exit(1);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const page = list.filter((t) => t.type === 'page')[0];
if (!page) { console.error('没有可用的页面标签'); process.exit(2); }
const ws = new WebSocket(page.webSocketDebuggerUrl);
let msgId = 0; const pending = new Map();
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result); }
};
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
function send(method, params = {}) {
  const id = ++msgId;
  return new Promise((res, rej) => {
    pending.set(id, { res, rej });
    ws.send(JSON.stringify({ id, method, params }));
    setTimeout(() => { if (pending.has(id)) { pending.delete(id); rej(new Error('timeout ' + method)); } }, 30000);
  });
}
async function ev(expr) {
  const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true, userGesture: true });
  if (r.exceptionDetails) throw new Error('JS: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
  return r.result.value;
}
const clickExpr = (target) => `(() => { const el = ${target}; if (!el) return false;
  el.scrollIntoView({block:'center'});
  for (const t of ['pointerdown','mousedown','mouseup']) el.dispatchEvent(new PointerEvent(t,{bubbles:true,cancelable:true,button:0,isPrimary:true}));
  el.click(); return true; })()`;
const triggerText = (id) => ev(`(() => { const e = document.getElementById(${JSON.stringify(id)}); return e ? (e.innerText || e.value || '').trim() : '(找不到触发器)'; })()`);

let failed = 0;
for (const { triggerId, want } of pairs) {
  const before = await triggerText(triggerId);
  if (before.includes(want)) { console.log(`✓ 已是「${before}」，跳过（${triggerId}）`); continue; }
  await ev(clickExpr(`document.getElementById(${JSON.stringify(triggerId)})`));
  let outcome = null;
  for (let i = 0; i < 25 && !outcome; i++) {
    await sleep(200);
    const r = await ev(`(() => {
      const pops = [...document.querySelectorAll('[data-open],[role="dialog"]')].filter(p => p.querySelector('[role="listbox"]'));
      if (!pops.length) return null;
      const pop = pops[pops.length - 1];
      const opts = [...pop.querySelectorAll('[role="option"]')];
      const hit = opts.find(o => o.innerText.trim() === ${JSON.stringify(want)})
               || opts.find(o => o.innerText.trim().toLowerCase().includes(${JSON.stringify(want.toLowerCase())}));
      if (!hit) return JSON.stringify({ miss: opts.map(o => o.innerText.trim()) });
      hit.scrollIntoView({ block: 'center' });
      for (const t of ['pointerdown','mousedown','mouseup']) hit.dispatchEvent(new PointerEvent(t,{bubbles:true,cancelable:true,button:0,isPrimary:true}));
      hit.click();
      return 'clicked';
    })()`);
    if (r === 'clicked') outcome = { ok: true };
    else if (r && r.startsWith('{')) outcome = { ok: false, why: '弹层里没有「' + want + '」，实际可选：' + JSON.parse(r).miss.join(' | ') };
  }
  if (!outcome) outcome = { ok: false, why: '弹层未打开' };
  if (!outcome.ok) { failed++; console.log(`✗ ${triggerId}：${outcome.why}`); continue; }
  await sleep(600);
  const after = await triggerText(triggerId);
  if (after.includes(want)) console.log(`✅ ${triggerId} → 「${after}」`);
  else { failed++; console.log(`❌ ${triggerId} 点了但没生效（现在显示「${after}」）`); }
}
ws.close();
process.exit(failed ? 1 : 0);
