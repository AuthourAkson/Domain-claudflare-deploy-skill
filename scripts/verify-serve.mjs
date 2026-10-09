// 本地验证服务器：静态托管某个站点目录 + mock 一组 API（本地联调/验收用，不进部署产物）
// 用法: node verify-serve.mjs [port]         （站点根目录用 SITE_ROOT 环境变量指定）
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = process.env.SITE_ROOT || process.cwd();
const PORT = Number(process.argv[2] || process.env.PORT || 8123);
if (!fs.existsSync(ROOT)) { console.error('站点根目录不存在：' + ROOT + '（用 SITE_ROOT 指定）'); process.exit(2); }
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.png': 'image/png', '.txt': 'text/plain; charset=utf-8' };

// 一件「有 5 条笔迹、72BPM、8拍、6格/拍」的假作品（格式错误时用的兜底）
const FALLBACK_PIECE = {
  ar: 0.62, bpm: 72, beats: 8, stepsPerBeat: 6, scale: 'major', key: 4, name: 'mock-piece',
  pages: [[{ color: 1, pts: [[0.1, 0.1], [0.2, 0.15], [0.3, 0.2]] }]],
};

// 优先用从真实编辑器导出的作品（tools/_piece.json），这样 #g= 走的是**真实格式**往返
let MOCK_PIECE = FALLBACK_PIECE;
const DUMP = path.join(path.dirname(fileURLToPath(import.meta.url)), '_piece.json');
try {
  if (fs.existsSync(DUMP)) {
    MOCK_PIECE = JSON.parse(fs.readFileSync(DUMP, 'utf8').replace(/^\uFEFF/, ''));
    console.log('mock 使用真实作品 dump:', DUMP, '笔迹数=', (MOCK_PIECE.pages || []).reduce((a, p) => a + p.length, 0));
  }
} catch (e) { console.log('读取 dump 失败，用兜底假作品:', e.message); }
const MOCK_RECORD = Object.assign({}, MOCK_PIECE, {
  v: 1, id: 'testpiece', status: 'approved', title: 'Mock 作品', author: 'lead-test',
  created_at: new Date().toISOString(), created_ms: Date.now(),
  image: { key: 'pieces/testpiece.png', url: '/img/pieces/testpiece.png' },
  meta: { bpm: 72, beats: 8, tonic: 4, scale: 'major' },
});

const json = (res, obj, code = 200) => { const b = JSON.stringify(obj); res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(b) }); res.end(b); };

http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;
  if (p === '/api/piece/testpiece') return json(res, { ok: true, item: { id: 'testpiece', title: 'Mock 作品', author: 'lead-test', created_at: MOCK_RECORD.created_at, url: '/img/pieces/testpiece.png' }, data: MOCK_RECORD });
  if (p.startsWith('/api/piece/')) return json(res, { ok: false, error: 'not_found', message: '作品不存在' }, 404);
  if (p === '/api/list') return json(res, { ok: true, items: [], nextCursor: null });
  if (p === '/api/upload') return json(res, { ok: true, id: 'mockupload', status: 'pending', url: '/img/pieces/mockupload.png' });
  if (p.startsWith('/api/')) return json(res, { ok: false, error: 'not_found', message: '接口不存在' }, 404);

  let file = path.join(ROOT, decodeURIComponent(p === '/' ? '/index.html' : p));
  if (!file.startsWith(ROOT)) { res.writeHead(403).end('no'); return; }
  if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, 'index.html');
  if (!fs.existsSync(file)) { res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('404 ' + p); return; }
  res.writeHead(200, { 'content-type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
}).listen(PORT, '127.0.0.1', () => console.log('verify-serve on http://127.0.0.1:' + PORT + ' root=' + ROOT));
