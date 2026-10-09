#!/usr/bin/env node
/**
 * build-public.example.mjs —— 「门户 + 多个项目」组装模板
 *
 * 为什么需要：Cloudflare Workers 的 [assets] 只能指向**一个**目录，
 * 所以要在同一个域名下挂多个站，就得先把它们合成一棵树：
 *
 *   .deploy/public/
 *   ├── index.html      ← 门户首页（来自 PORTAL_SRC）
 *   ├── site-a/**       ← 项目 A（来自本仓库根目录，排除后端/开发文件）
 *   └── site-b/**       ← 项目 B（来自另一个目录）
 *
 * 用法：
 *   1) 复制成本项目里的 worker/build-public.mjs
 *   2) 按下面注释改 PORTAL_SRC 和 SOURCES（name 就是 URL 里的子路径）
 *   3) node build-public.mjs          # 组装
 *      node build-public.mjs --list   # 只统计不写盘
 *
 * 可用环境变量覆盖：BUILD_OUT / PORTAL_SRC / SITE_B_DIR（按需自己加）
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const WORKER_DIR = path.dirname(fileURLToPath(import.meta.url));       // …/worker
const REPO_ROOT = path.resolve(WORKER_DIR, '..');                      // 项目根
const OUT = process.env.BUILD_OUT || path.join(REPO_ROOT, '.deploy', 'public');
const PORTAL_SRC = process.env.PORTAL_SRC || path.join(REPO_ROOT, 'portal');
const LIST_ONLY = process.argv.includes('--list');

// ── 站点清单：name = URL 子路径；from = 源目录 ────────────────────────────────
// 想加站点就往数组里加一条；不需要的删掉即可。
const SOURCES = [
  {
    name: 'site-a',
    from: REPO_ROOT,
    // 后端源码、版本库、本地状态、开发产物，绝不能进静态站点
    excludeDirs: ['.git', '.deploy', '.wrangler', 'worker', 'node_modules', 'portal', '_verify', '.tmp'],
    excludeFileRe: /^(\.|_)|^(build-.*\.js|test-.*\.js|.*\.log|.*\.bat)$/,
    note: '主站（后端源码 worker/ 已排除）',
  },
  {
    name: 'site-b',
    // 把这里换成另一个项目的绝对路径，或用环境变量传入
    from: process.env.SITE_B_DIR || path.join(REPO_ROOT, '..', 'site-b'),
    excludeDirs: ['.git', '_tools', 'node_modules'],   // 常见的大块可排除目录
    excludeFileRe: /^\./,
    note: '第二个站点（可选）',
  },
];

function human(bytes) { return (bytes / 1024 / 1024).toFixed(2) + ' MB'; }

const stats = [];
function walk(from, to, s) {
  fs.mkdirSync(to, { recursive: true });
  const exDirs = s.excludeDirs || [];
  const exRe = s.excludeFileRe || /^(?!)$/;   // 默认不排除任何文件
  for (const ent of fs.readdirSync(from, { withFileTypes: true })) {
    const src = path.join(from, ent.name);
    const dst = path.join(to, ent.name);
    if (ent.isDirectory()) {
      if (exDirs.includes(ent.name)) continue;
      walk(src, dst, s);
    } else if (ent.isFile()) {
      if (exRe.test(ent.name)) continue;
      if (!LIST_ONLY) fs.copyFileSync(src, dst);
      const size = fs.statSync(src).size;
      s.files++; s.bytes += size;
      if (size > 4 * 1024 * 1024) s.big.push(`${ent.name} (${human(size)})`);
    }
  }
}

console.log(LIST_ONLY ? '（--list：只统计，不写盘）' : `组装到 ${OUT}`);
if (!LIST_ONLY) { fs.rmSync(OUT, { recursive: true, force: true }); fs.mkdirSync(OUT, { recursive: true }); }

// 1) 门户：放根目录
if (fs.existsSync(PORTAL_SRC)) {
  const s = { name: '(门户)', files: 0, bytes: 0, big: [], from: PORTAL_SRC };
  walk(PORTAL_SRC, OUT, s);
  stats.push(s);
} else {
  console.warn('⚠️ 门户源目录不存在，跳过：' + PORTAL_SRC);
}

// 2) 各项目：挂到子路径
for (const src of SOURCES) {
  if (!fs.existsSync(src.from)) {
    console.warn(`⚠️ 源目录不存在，跳过 /${src.name}/：${src.from}`);   // 可选站点缺失不算失败
    continue;
  }
  // ⚠️ 必须展开 src（含 excludeDirs/excludeFileRe），否则过滤规则会丢、甚至会自己套自己
  const s = { ...src, files: 0, bytes: 0, big: [] };
  walk(src.from, path.join(OUT, src.name), s);
  stats.push(s);
}

console.log('');
let totalFiles = 0, totalBytes = 0;
for (const s of stats) {
  totalFiles += s.files; totalBytes += s.bytes;
  console.log(`  /${s.name === '(门户)' ? '' : s.name + '/'}  ${String(s.files).padStart(4)} 个文件  ${human(s.bytes).padStart(9)}  ${s.note || ''}`);
  if (s.big.length) console.log(`        大文件：${s.big.join('、')}`);
}
console.log(`\n  合计 ${totalFiles} 个文件 / ${human(totalBytes)}  →  ${OUT}`);
console.log('  （Workers 静态资源限制：单文件 ≤25MB、免费版文件数 ≤20000）');
