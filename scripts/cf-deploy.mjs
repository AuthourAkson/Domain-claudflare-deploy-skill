#!/usr/bin/env node
/**
 * Cloudflare 部署编排脚本（零依赖）
 *
 * 用法（token 放 <secrets-dir>/cf-token.txt，或设 CLOUDFLARE_API_TOKEN 环境变量）：
 *   node cf-deploy.mjs status      # 校验 token / 列出账号
 *   node cf-deploy.mjs zone        # 建 zone → 打印要填到域名商的 2 个 NS
 *   node cf-deploy.mjs resources   # 建存储 + D1 库 + 灌表结构 + 回填 wrangler.toml
 *   node cf-deploy.mjs kv          # 只建 KV namespace 并回填 id
 *   node cf-deploy.mjs deploy      # 组装静态目录 + wrangler deploy + 写 secrets
 *   node cf-deploy.mjs domain      # 绑 Worker 自定义域名
 *   node cf-deploy.mjs tstest pass|real   # 临时切换 Turnstile secret（自动化验收用）
 *   node cf-deploy.mjs e2e         # 线上端到端验收（自带 DNS 绕行）
 *   node cf-deploy.mjs report      # 汇总 zone / DNS / 域名状态
 *
 * 状态存 <secrets-dir>/cf-state.json（不含 token 本身）
 */
import fs from 'node:fs';
import path from 'node:path';
import https from 'node:https';
import dns from 'node:dns';
import { execFileSync } from 'node:child_process';

// ── 可配置项（全部可用环境变量覆盖，便于复用到新站点） ─────────────────────────
//   CF_SECRETS_DIR  : 放 token/state 的目录（默认 <当前目录>/.secrets）
//   CF_WORKER_DIR   : 包含 wrangler.toml 的目录（默认当前目录）
//   ZONE_NAME       : 要接入 Cloudflare 的域名（**必填**，例如 yourname.dpdns.org）
//   CF_WORKER_NAME  : Worker 脚本名（默认 my-worker）
//   CF_STORAGE_NAME : KV namespace / R2 bucket 名（默认 my-app-storage）
//   CF_D1_NAME      : D1 数据库名（默认 my-app-db）
//   NPM_BIN / NPX_BIN : npm/npx 可执行文件路径（默认走 PATH 里的 npm / npx）
const SECRETS_DIR = process.env.CF_SECRETS_DIR || path.join(process.cwd(), '.secrets');
const TOKEN_FILE = path.join(SECRETS_DIR, 'cf-token.txt');
const STATE_FILE = path.join(SECRETS_DIR, 'cf-state.json');
const ADMIN_FILE = path.join(SECRETS_DIR, 'admin-token.txt');
const WORKER_DIR = process.env.CF_WORKER_DIR || process.cwd();
const WRANGLER_TOML = path.join(WORKER_DIR, 'wrangler.toml');

const ZONE_NAME = process.env.ZONE_NAME || '';
const WORKER_NAME = process.env.CF_WORKER_NAME || 'my-worker';
const R2_BUCKET = process.env.CF_STORAGE_NAME || 'my-app-storage';
const D1_NAME = process.env.CF_D1_NAME || 'my-app-db';
const NPM = process.env.NPM_BIN || 'npm';
const NPX = process.env.NPX_BIN || 'npx';
const API = 'https://api.cloudflare.com/client/v4';

/** 需要域名的阶段先过这一关，避免用错误默认值去操作别的 zone */
function requireZoneName() {
  if (!ZONE_NAME) {
    console.error('缺少域名：请设置环境变量 ZONE_NAME，例如');
    console.error('  PowerShell:  $env:ZONE_NAME="yourname.dpdns.org"');
    console.error('  bash:        export ZONE_NAME=yourname.dpdns.org');
    process.exit(2);
  }
  return ZONE_NAME;
}

fs.mkdirSync(SECRETS_DIR, { recursive: true });

function token() {
  let t = process.env.CLOUDFLARE_API_TOKEN || '';
  if (!t && fs.existsSync(TOKEN_FILE)) t = fs.readFileSync(TOKEN_FILE, 'utf8').trim();
  if (!t) { console.error('缺少 token：写入 ' + TOKEN_FILE + ' 或设置 CLOUDFLARE_API_TOKEN'); process.exit(2); }
  return t;
}
function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch { return {}; }
}
function saveState(patch) {
  const s = { ...loadState(), ...patch };
  fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2), 'utf8');
  return s;
}
async function api(method, endpoint, body, _retry = 0) {
  let res;
  try {
    res = await fetch(API + endpoint, {
      method,
      headers: { Authorization: 'Bearer ' + token(), 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (e) {
    // 网络抖动（实测这台机器偶发 "fetch failed"）→ 退避重试两次，别让部署流程被瞬时故障打断
    if (_retry < 2) { await new Promise(r => setTimeout(r, 800 * (_retry + 1))); return api(method, endpoint, body, _retry + 1); }
    throw new Error(`CF API ${method} ${endpoint} 网络失败（重试 2 次后仍失败）：${e.message}`);
  }
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  if (!res.ok || (json && json.success === false)) {
    const errs = (json && json.errors || []).map(e => `${e.code}: ${e.message}`).join(' | ') || text.slice(0, 400);
    const err = new Error(`CF API ${method} ${endpoint} -> HTTP ${res.status}: ${errs}`);
    err.cfErrors = json && json.errors;
    err.status = res.status;
    throw err;
  }
  return json.result;
}
function isAlreadyExists(err) {
  const codes = (err.cfErrors || []).map(e => e.code);
  return codes.some(c => [10004, 10014, 7502, 7500, 1002, 11009].includes(c)) ||
    /already exists|already been taken|duplicate/i.test(err.message);
}
function sh(cmdline, opts = {}) {
  // 注意：Node 20+ 出于安全考虑禁止 execFileSync 直接启动 .cmd/.bat（EINVAL），
  // 必须走 shell。这里统一用 shell:true + 整条命令行。
  return execFileSync(cmdline, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], shell: true, ...opts });
}

/* ------------------------------------------------------------- phases */
async function phaseStatus() {
  const v = await api('GET', '/user/tokens/verify');
  console.log('token 状态:', v.status);
  const accounts = await api('GET', '/accounts?per_page=50');
  for (const a of accounts) console.log(`账号: ${a.name}  id=${a.id}`);
  const state = loadState();
  const acct = state.accountId || (accounts[0] && accounts[0].id);
  if (acct) saveState({ accountId: acct, accountName: (accounts.find(a => a.id === acct) || {}).name });
  console.log('将使用 accountId =', acct);
}

async function phaseZone() {
  requireZoneName();
  let state = loadState();
  if (!state.accountId) {
    const accounts = await api('GET', '/accounts?per_page=50');
    state = saveState({ accountId: accounts[0].id, accountName: accounts[0].name });
  }
  let zone = (await api('GET', `/zones?name=${encodeURIComponent(ZONE_NAME)}`))[0];
  if (!zone) {
    console.log('创建站点', ZONE_NAME, '...');
    try {
      zone = await api('POST', '/zones', { name: ZONE_NAME, account: { id: state.accountId }, type: 'full', jump_start: true });
    } catch (e) {
      console.error('❌ 建站点失败：' + e.message);
      console.error('   → 若提示是子域/根域名问题，说明该后缀未进 PSL 或被 Cloudflare 限制，需要换后缀（.qzz.io）或换方案。');
      throw e;
    }
  } else {
    console.log('站点已存在，复用。');
  }
  const ns = zone.name_servers || [];
  saveState({ zoneId: zone.id, zoneName: zone.name, nameservers: ns, zoneStatus: zone.status });
  console.log('\n================ 需要填到 DigitalPlat 的 NS ================');
  ns.forEach((n, i) => console.log(`  NS${i + 1}: ${n}`));
  console.log('==========================================================');
  console.log('zoneId =', zone.id, ' status =', zone.status);
}

async function phaseResources() {
  let state = loadState();
  if (!state.accountId) await phaseStatus(), state = loadState();
  const acct = state.accountId;

  // R2（需要账户先在面板里「Enable R2」一次，API 无法代劳；失败不阻断后面步骤）
  let r2Ready = true;
  try {
    await api('POST', `/accounts/${acct}/r2/buckets`, { name: R2_BUCKET });
    console.log('✅ R2 桶已创建:', R2_BUCKET);
  } catch (e) {
    if (isAlreadyExists(e)) console.log('R2 桶已存在，复用:', R2_BUCKET);
    else if ((e.cfErrors || []).some(x => x.code === 10042)) {
      r2Ready = false;
      console.log('⚠️ R2 尚未在账户里启用（错误 10042）：需要去面板点一次「Enable R2」。');
      console.log('   面板地址: https://dash.cloudflare.com/' + acct + '/r2');
      console.log('   → 启用后重新跑 `node cf-deploy.mjs resources` 即可补上。');
    } else { console.error('❌ R2 创建失败: ' + e.message); throw e; }
  }
  saveState({ r2Ready });

  // D1
  let d1Id = state.d1Id;
  if (!d1Id) {
    const list = await api('GET', `/accounts/${acct}/d1/database?per_page=100`);
    const found = list.find(d => d.name === D1_NAME);
    if (found) { d1Id = found.uuid; console.log('D1 库已存在，复用:', D1_NAME, d1Id); }
    else {
      const created = await api('POST', `/accounts/${acct}/d1/database`, { name: D1_NAME });
      d1Id = created.uuid;
      console.log('✅ D1 库已创建:', D1_NAME, d1Id);
    }
    saveState({ d1Id });
  } else console.log('D1 库沿用 state:', d1Id);

  // wrangler.toml 回填 database_id
  let toml = fs.readFileSync(WRANGLER_TOML, 'utf8');
  if (toml.includes('REPLACE-WITH-YOUR-D1-DATABASE-ID')) {
    toml = toml.replace('REPLACE-WITH-YOUR-D1-DATABASE-ID', d1Id);
    fs.writeFileSync(WRANGLER_TOML, toml, 'utf8');
    console.log('✅ wrangler.toml 已回填 database_id');
  } else if (!toml.includes(d1Id)) {
    toml = toml.replace(/database_id\s*=\s*"[^"]*"/, `database_id = "${d1Id}"`);
    fs.writeFileSync(WRANGLER_TOML, toml, 'utf8');
    console.log('✅ wrangler.toml database_id 已更新');
  } else console.log('wrangler.toml database_id 已是目标值');

  // 表结构
  const sql = fs.readFileSync(path.join(WORKER_DIR, 'schema.sql'), 'utf8');
  const statements = sql.split(';').map(s => s.split(/\r?\n/).filter(l => !l.trim().startsWith('--')).join('\n').trim()).filter(Boolean);
  console.log(`执行 schema.sql（${statements.length} 条语句）...`);
  for (const stmt of statements) {
    await api('POST', `/accounts/${acct}/d1/database/${d1Id}/query`, { sql: stmt + ';' });
  }
  const check = await api('POST', `/accounts/${acct}/d1/database/${d1Id}/query`, { sql: "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name;" });
  console.log('D1 表:', JSON.stringify((check[0] && check[0].results || []).map(r => r.name)));
}

async function phaseSecretsAndDeploy() {
  let state = loadState();
  const acct = state.accountId;
  // 生成/复用管理员令牌
  let admin = state.adminToken;
  if (!admin) {
    const bytes = new Uint8Array(24);
    crypto.getRandomValues(bytes);
    admin = Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
    saveState({ adminToken: admin });
  }
  fs.writeFileSync(ADMIN_FILE, admin, 'utf8');
  const ipSalt = state.ipSalt || (() => { const b = new Uint8Array(16); crypto.getRandomValues(b); return Array.from(b, x => x.toString(16).padStart(2, '0')).join(''); })();
  saveState({ ipSalt });

  // 先把 Worker 部署出来（secret 需要脚本已存在）
  console.log('执行 wrangler deploy ...');
  const out = sh(`"${NPX}" --yes wrangler@4 deploy`, {
    cwd: WORKER_DIR,
    env: { ...process.env, CLOUDFLARE_API_TOKEN: token(), CLOUDFLARE_ACCOUNT_ID: acct, WRANGLER_SEND_METRICS: 'false' },
  });
  console.log(out.split('\n').slice(-18).join('\n'));

  for (const [name, text] of [['ADMIN_TOKEN', admin], ['IP_SALT', ipSalt]]) {
    await api('PUT', `/accounts/${acct}/workers/scripts/${WORKER_NAME}/secrets`, { name, text, type: 'secret_text' });
    console.log('✅ secret 已写入:', name);
  }
}

async function phaseDomain() {
  requireZoneName();
  const state = loadState();
  const acct = state.accountId;
  if (!state.zoneId) throw new Error('还没有 zoneId，先跑 zone 阶段');
  const hostnames = [ZONE_NAME, 'www.' + ZONE_NAME];
  for (const hostname of hostnames) {
    try {
      await api('POST', `/accounts/${acct}/workers/domains`, {
        environment: 'production', hostname, service: WORKER_NAME, zone_id: state.zoneId,
      });
      console.log('✅ 自定义域名已绑定:', hostname);
    } catch (e) {
      if (isAlreadyExists(e) || /already/i.test(e.message)) console.log('自定义域名已存在:', hostname);
      else console.error('⚠️ 绑定 ' + hostname + ' 失败: ' + e.message);
    }
  }
}

async function phaseReport() {
  const state = loadState();
  console.log('=== 当前状态 ===');
  console.log(JSON.stringify({ ...state, adminToken: state.adminToken ? state.adminToken.slice(0, 6) + '…(见 admin-token.txt)' : undefined, ipSalt: undefined }, null, 2));
  if (state.zoneId) {
    const z = await api('GET', '/zones/' + state.zoneId);
    console.log('zone status:', z.status, ' NS:', (z.name_servers || []).join(', '));
    const dns = await api('GET', `/zones/${state.zoneId}/dns_records?per_page=50`);
    console.log('DNS 记录:', dns.map(r => `${r.type} ${r.name} -> ${r.content} (proxied=${r.proxied})`).join('\n           ') || '(无)');
  }
  if (state.accountId) {
    const doms = await api('GET', `/accounts/${state.accountId}/workers/domains`);
    console.log('Worker 自定义域名:', doms.filter(d => d.service === WORKER_NAME).map(d => d.hostname + ' (' + d.environment + ')').join(', ') || '(无)');
  }
}

async function phaseSubdomain() {
  const state = loadState();
  const acct = state.accountId;
  const want = process.argv[3] || state.workersDev || 'my-worker-dev';
  // GET 看现在有没有；没有就 PUT 注册一个（这样在自定义域名 NS 生效前就能测接口）
  let cur = null;
  try { cur = await api('GET', `/accounts/${acct}/workers/subdomain`); } catch (e) { cur = null; }
  if (cur && cur.subdomain) {
    console.log('workers.dev 子域已存在:', cur.subdomain);
    saveState({ workersDev: cur.subdomain });
  } else {
    console.log('注册 workers.dev 子域:', want);
    const r = await api('PUT', `/accounts/${acct}/workers/subdomain`, { subdomain: want });
    console.log('✅ 已注册:', r.subdomain);
    saveState({ workersDev: r.subdomain });
  }
  const s = loadState().workersDev;
  console.log('测试地址: https://' + WORKER_NAME + '.' + s + '.workers.dev/api/health');
}

async function phaseIpv4() {
  requireZoneName();
  const state = loadState();
  if (!state.zoneId) throw new Error('还没有 zoneId');
  // Workers 自定义域名只会自动生成 AAAA(100::) 记录 —— 纯 IPv4 的客户端（国内大部分网络）
  // 会解析不到地址。补一条代理的 A 记录：Cloudflare 代理模式下内容只是占位，
  // 真正的回源是 Worker 的自定义域名映射，所以用文档保留地址 192.0.2.1 即可。
  const existing = await api('GET', `/zones/${state.zoneId}/dns_records?per_page=100`);
  for (const name of [ZONE_NAME, 'www.' + ZONE_NAME]) {
    const hasA = existing.some(r => r.type === 'A' && r.name === name);
    if (hasA) { console.log('A 记录已存在:', name); continue; }
    const r = await api('POST', `/zones/${state.zoneId}/dns_records`, {
      type: 'A', name, content: '192.0.2.1', proxied: true, ttl: 1, comment: 'Workers 自定义域名的 IPv4 入口（占位地址）',
    });
    console.log('✅ 已补 A 记录:', name, '->', r.content, 'proxied=' + r.proxied);
  }
}

async function phaseKv() {
  const state = loadState();
  const acct = state.accountId;
  const list = await api('GET', `/accounts/${acct}/storage/kv/namespaces?per_page=100`);
  let ns = list.find(n => n.title === R2_BUCKET);
  if (ns) console.log('KV 命名空间已存在:', ns.title, ns.id);
  else {
    ns = await api('POST', `/accounts/${acct}/storage/kv/namespaces`, { title: R2_BUCKET });
    console.log('✅ KV 命名空间已创建:', ns.title, ns.id);
  }
  saveState({ kvNamespaceId: ns.id, kvTitle: ns.title });

  // 回填 wrangler.toml（把占位符换成真实 id；若还没有 kv 段就提示先等代码就绪）
  let toml = fs.readFileSync(WRANGLER_TOML, 'utf8');
  if (toml.includes('REPLACE-WITH-KV-NAMESPACE-ID')) {
    toml = toml.replace(/REPLACE-WITH-KV-NAMESPACE-ID/g, ns.id);
    fs.writeFileSync(WRANGLER_TOML, toml, 'utf8');
    console.log('✅ wrangler.toml 已回填 KV namespace id');
  } else if (toml.includes('kv_namespaces')) {
    console.log('wrangler.toml 里 kv_namespaces 已存在，请确认 id 是否为', ns.id);
  } else {
    console.log('⚠️ wrangler.toml 里还没有 [[kv_namespaces]] 段（等后端队友的 task-4 落地后再跑本阶段）');
  }
}

/* ------------------------------------------------ 不依赖本机 DNS 的 HTTP --
   背景：这台机器所在线路的递归解析器对新委派的域名有很长的负缓存（浏览器/curl 直接解析不到），
   但公共 DNS（阿里 223.5.5.5）能正常解析。所以验收自己查 A 记录，再用自定义 lookup 连过去，
   保证结论反映"线上真实状态"，而不是本机 DNS 的毛病（等价于 curl --resolve）。 */
async function resolveA(host) {
  for (const server of ['223.5.5.5', '119.29.29.29', '180.76.76.76', '114.114.114.114']) {
    try {
      const r = new dns.Resolver();
      r.setServers([server]);
      const addrs = await new Promise((res, rej) => r.resolve4(host, (e, a) => (e ? rej(e) : res(a))));
      if (addrs && addrs.length) return { ip: addrs[0], via: server };
    } catch (e) { /* 换下一个 DNS */ }
  }
  throw new Error(`公共 DNS 都解析不到 ${host}（先确认委派已生效）`);
}
function httpsReq(url, opts = {}) {
  return httpsReqOnce(url, opts, 0);
}
function httpsReqOnce(url, { method = 'GET', headers = {}, body = null, ip }, hops) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = https.request({
      hostname: u.hostname, port: 443, path: u.pathname + u.search, method,
      headers, servername: u.hostname,
      lookup: (hostname, o, cb) => {
        // Node 有时会以 { all: true } 调用 lookup，此时必须回数组
        if (o && o.all) return cb(null, [{ address: ip, family: 4 }]);
        return cb(null, ip, 4);
      },
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', async () => {
        // 跟随重定向（Workers 静态资源对 *.html 会 307 到无扩展名路径）
        const loc = res.headers.location;
        if (loc && [301, 302, 303, 307, 308].includes(res.statusCode) && hops < 4) {
          try {
            const next = new URL(loc, u).toString();
            const r2 = await httpsReqOnce(next, { method: res.statusCode === 303 ? 'GET' : method, headers, body, ip }, hops + 1);
            r2.hops = (r2.hops || 0) + 1;
            r2.finalUrl = next;
            return resolve(r2);
          } catch (e) { return reject(e); }
        }
        const buffer = Buffer.concat(chunks);
        resolve({ status: res.statusCode, headers: res.headers, buffer, text: buffer.toString('utf8'), finalUrl: u.toString() });
      });
    });
    req.on('error', reject);
    req.setTimeout(45000, () => req.destroy(new Error('timeout')));
    if (body) req.write(body);
    req.end();
  });
}
function multipart(fields) {
  const boundary = '----e2e' + Math.random().toString(16).slice(2);
  const parts = [];
  for (const f of fields) {
    let head = `--${boundary}\r\nContent-Disposition: form-data; name="${f.name}"`;
    if (f.filename) head += `; filename="${f.filename}"`;
    head += '\r\n';
    if (f.contentType) head += `Content-Type: ${f.contentType}\r\n`;
    head += '\r\n';
    parts.push(Buffer.from(head, 'utf8'));
    parts.push(Buffer.isBuffer(f.data) ? f.data : Buffer.from(String(f.value ?? ''), 'utf8'));
    parts.push(Buffer.from('\r\n', 'utf8'));
  }
  parts.push(Buffer.from(`--${boundary}--\r\n`, 'utf8'));
  return { body: Buffer.concat(parts), contentType: `multipart/form-data; boundary=${boundary}` };
}

async function phaseE2E() {
  requireZoneName();
  const state = loadState();
  const base = 'https://' + ZONE_NAME;
  const admin = state.adminToken || (fs.existsSync(ADMIN_FILE) ? fs.readFileSync(ADMIN_FILE, 'utf8').trim() : '');
  const { ip, via } = await resolveA(ZONE_NAME);
  console.log(`解析 ${ZONE_NAME} -> ${ip}（通过 ${via}）`);
  const j = async (u, o = {}) => {
    const r = await httpsReq(u, { ...o, ip });
    let b = null; try { b = JSON.parse(r.text); } catch {}
    return { status: r.status, body: b, text: r.text, headers: r.headers, buffer: r.buffer };
  };
  let pass = 0, fail = 0;
  const check = (ok, label, detail = '') => { ok ? pass++ : fail++; console.log(`  ${ok ? '✅' : '❌'} ${label}${detail ? '  ' + detail : ''}`); };

  console.log('--- 1) /api/health');
  const h = await j(base + '/api/health');
  console.log('   ', h.status, h.text.slice(0, 300));
  const bindings = (h.body && h.body.bindings) || {};
  check(h.status === 200 && h.body && h.body.ok === true, 'health 200 且 ok:true');
  check(bindings.db === true, 'D1 绑定存在');
  check(bindings.assets === true, '静态资源绑定存在');
  check(h.body && h.body.admin_configured === true, '管理员令牌已配置');
  if (h.body && h.body.storage) console.log('    存储后端:', h.body.storage);
  if (h.body) console.log('    turnstile_configured:', h.body.turnstile_configured, ' limits:', JSON.stringify(h.body.limits || {}), ' quota_today:', JSON.stringify(h.body.quota_today || {}));
  check(h.body && h.body.turnstile_configured === true, 'Turnstile 已配置（人机验证闸门生效）');

  console.log('--- 1b) 防护 / 爬虫措施');
  const robots = await j(base + '/robots.txt');
  check(robots.status === 200 && /Disallow:\s*\/api\//.test(robots.text), 'robots.txt 可访问且屏蔽 /api/', `bytes=${robots.buffer.length}`);
  check(!/Disallow:\s*\/img\//.test(robots.text), 'robots.txt 未屏蔽 /img/（作品仍可被搜到）');
  check(String(h.headers['x-robots-tag'] || '').includes('noindex'), '/api/* 带 X-Robots-Tag: noindex', `got=${h.headers['x-robots-tag'] || '(无)'}`);
  const chal = await j(base + '/api/challenge');
  check(chal.status === 200 && chal.body && chal.body.ok === true && chal.body.t && chal.body.s, 'GET /api/challenge 返回挑战令牌');

  console.log('--- 2) 静态站点');
  // 多站组装时：根是门户、编辑器在 /draw/、画廊在 /draw/gallery/。用环境变量可覆盖。
  const PORTAL_PATH = process.env.PORTAL_PATH || '/';
  const EDITOR_PATH = process.env.EDITOR_PATH || '/draw/';
  const GALLERY_PATH = process.env.GALLERY_PATH || '/draw/gallery/gallery.html';
  const HOME_MATCH = new RegExp(process.env.HOME_MATCH || '.', 'i');   // 指定编辑器页面应包含的文字
  const portal = await j(base + PORTAL_PATH);
  check(portal.status === 200 && /<html/i.test(portal.text), '门户首页 200 且是 HTML', `bytes=${portal.buffer.length}`);
  const home = await j(base + EDITOR_PATH);
  check(home.status === 200 && HOME_MATCH.test(home.text), '编辑器页面 200 且内容匹配', `bytes=${home.buffer.length}`);
  const gal = await j(base + GALLERY_PATH);
  check(gal.status === 200 && /作品墙/.test(gal.text), '作品墙页面可访问（跟随 307 后 200）');

  if (!bindings.bucket) {
    console.log('\n⚠️ env.BUCKET 未绑定 → 跳过上传相关的端到端检查。');
    console.log(`\n=========== 验收结果：通过 ${pass}，失败 ${fail} ===========`);
    process.exitCode = 1;
    return;
  }

  console.log('--- 3) 端到端：上传 → 待审 → 通过 → 列表 → 出图 → 清理');
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
  const mp = multipart([
    { name: 'file', filename: 'e2e.png', contentType: 'image/png', data: png },
    { name: 'meta', value: JSON.stringify({ title: 'E2E 自检作品', author: 'lead-e2e', bpm: 60, beats: 8, tonic: 3, scale: 'mixolydian', width: 1, height: 1 }) },
    // Turnstile 字段：只有在 secret 被临时切到官方 always-pass 测试密钥时才有效
    { name: 'cf-turnstile-response', value: 'XXXX.DUMMY.TOKEN.XXXX' },
  ]);
  const up = await j(base + '/api/upload', { method: 'POST', headers: { 'content-type': mp.contentType }, body: mp.body });
  console.log('    上传响应:', up.status, up.text.slice(0, 220));
  const upErr = (up.body && up.body.error) || '';
  if (up.status === 403 && /^turnstile_/.test(upErr)) {
    // 这是"真实密钥生效"时的**预期行为**：没有真人过验证的请求被挡下
    check(true, 'Turnstile 拦住了未通过人机验证的上传（真实密钥场景，符合预期）', upErr);
    console.log('    （想跑完整上传链路：先 `node cf-deploy.mjs tstest pass` 换成官方测试密钥）');
    console.log(`\n=========== 验收结果：通过 ${pass}，失败 ${fail} ===========`);
    if (fail) process.exitCode = 1;
    return;
  }
  check(up.status === 200 && up.body && up.body.ok === true && up.body.status === 'pending', '上传成功且默认 pending');
  if (!up.body || !up.body.ok) { console.log(`\n=========== 验收结果：通过 ${pass}，失败 ${fail} ===========`); process.exitCode = 1; return; }
  const id = up.body.id;

  // 匿名列表有 30 秒边缘缓存 → 加一个参与缓存键的无关参数绕过（审核台带管理员头则始终实时）
  const bust = () => '&_=' + Date.now() + Math.random().toString(16).slice(2);
  const list0 = await j(base + '/api/list?status=approved' + bust());
  check(((list0.body && list0.body.items) || []).length === 0, '未过审时公开列表 0 条（不泄露）');

  const badAdmin = await j(base + '/api/admin/action', { method: 'POST', headers: { 'content-type': 'application/json', 'x-admin-token': 'wrong-token' }, body: JSON.stringify({ id, action: 'approve' }) });
  check(badAdmin.status === 401, '错误管理员令牌被拒（401）', `got=${badAdmin.status}`);

  const ap = await j(base + '/api/admin/action', { method: 'POST', headers: { 'content-type': 'application/json', 'x-admin-token': admin }, body: JSON.stringify({ id, action: 'approve' }) });
  check(ap.status === 200 && ap.body && ap.body.ok === true, '管理员审核通过');

  const list1 = await j(base + '/api/list?status=approved' + bust());
  const items = (list1.body && list1.body.items) || [];
  check(items.length === 1, '过审后公开列表出现 1 条');
  if (items[0]) console.log('    首条:', JSON.stringify(items[0]).slice(0, 260));

  const imgUrl = base + ((items[0] && (items[0].url || items[0].abs_url)) || '/img/pieces/' + id + '.png');
  const img = await j(imgUrl);
  check(img.status === 200 && /image\/png/.test(String(img.headers['content-type'] || '')), '出图 200 且 Content-Type=image/png', `ct=${img.headers['content-type']}`);
  check(/immutable/.test(String(img.headers['cache-control'] || '')), '图片带一年不可变缓存');
  check(img.buffer.length === png.length && img.buffer.equals(png), '取回字节与上传完全一致（存储往返无损）', `${img.buffer.length}B`);

  // 边缘缓存：第一次 MISS、第二次 HIT（同一 PoP、同一 URL）
  console.log('    图片边缘缓存:', img.headers['x-gallery-cache'] || '(无该头)');
  const img2 = await j(imgUrl);
  check(String(img2.headers['x-gallery-cache'] || '').toUpperCase() === 'HIT', '再取同一张图命中边缘缓存（不再读存储）', `cache=${img2.headers['x-gallery-cache']}`);

  // 热链保护：伪装成外站引用（带 cross-site 且无白名单 Referer）应当被 403
  const hot = await j(imgUrl, { headers: { 'sec-fetch-site': 'cross-site', referer: 'https://evil-example.com/steal' } });
  check(hot.status === 403 && hot.body && hot.body.error === 'hotlink_blocked', '外站盗链被拒（403 hotlink_blocked）', `got=${hot.status}`);

  const piece = await j(base + '/api/piece/' + id);
  check(piece.status === 200 && piece.body && piece.body.ok === true, '/api/piece/<id> 过审后可读（#g= 深链依赖它）');

  const del = await j(base + '/api/admin/action', { method: 'POST', headers: { 'content-type': 'application/json', 'x-admin-token': admin }, body: JSON.stringify({ id, action: 'delete' }) });
  check(del.status === 200 && del.body && del.body.ok === true, '清理自检数据（delete）');
  const list2 = await j(base + '/api/list?status=approved' + bust());
  check(((list2.body && list2.body.items) || []).length === 0, '清理后公开列表回到 0 条');

  console.log(`\n=========== 验收结果：通过 ${pass}，失败 ${fail} ===========`);
  if (fail) process.exitCode = 1;
}

/* 在「官方 always-pass 测试密钥」与「真实密钥」之间切换 TURNSTILE_SECRET。
   用途：真实密钥下无法自动上传（Turnstile 必须真人过验证），所以要跑完整端到端时
   临时换成测试密钥并配合假 token XXXX.DUMMY.TOKEN.XXXX，跑完再换回真实密钥。
   用法： node cf-deploy.mjs tstest pass   /   node cf-deploy.mjs tstest real   */
async function phaseTstest() {
  const state = loadState();
  const acct = state.accountId;
  const mode = process.argv[3] || 'real';
  const secret = mode === 'pass'
    ? '1x0000000000000000000000000000000AA'                       // Cloudflare 官方 always-pass 测试密钥
    : fs.readFileSync(path.join(SECRETS_DIR, 'turnstile-secret.txt'), 'utf8').trim();
  const f = path.join(SECRETS_DIR, '_secret-body.json');
  fs.writeFileSync(f, JSON.stringify({ name: 'TURNSTILE_SECRET', text: secret, type: 'secret_text' }), 'utf8');
  try {
    await api('PUT', `/accounts/${acct}/workers/scripts/${WORKER_NAME}/secrets`, JSON.parse(fs.readFileSync(f, 'utf8')));
  } finally { fs.rmSync(f, { force: true }); }
  console.log(`✅ TURNSTILE_SECRET 已切换为 ${mode === 'pass' ? '官方测试通过密钥（仅用于自动化验收）' : '真实密钥'}`);
}

const phases = {
  status: phaseStatus, zone: phaseZone, resources: phaseResources,
  deploy: phaseSecretsAndDeploy, domain: phaseDomain, report: phaseReport,
  subdomain: phaseSubdomain, ipv4: phaseIpv4, kv: phaseKv, e2e: phaseE2E, tstest: phaseTstest,
};
const cmd = process.argv[2];
if (!cmd || !phases[cmd]) {
  console.log('用法: node cf-deploy.mjs <' + Object.keys(phases).join('|') + '>');
  process.exit(1);
}
phases[cmd]().catch(e => { console.error('\n❌ 失败: ' + e.message); process.exit(1); });