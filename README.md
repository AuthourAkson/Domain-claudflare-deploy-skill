# 免费域名 + Cloudflare Workers 站点部署与加固（Agent Skill）

把「零成本上线自己的网站」这件事固化成一个可复用的 skill：**免费域名 → Cloudflare Workers → 静态站 + KV/D1 → Turnstile/限流加固 → 端到端验收**。

> 实测来源：2026-10 用这套流程把一个门户 + 两个静态项目部署到 `example.dpdns.org`，
> 线上端到端验收全绿，并且真的挡住过扫描器和刷流量。

## 目录结构

| 路径 | 内容 |
|---|---|
| `SKILL.md` | **主流程**：三条铁律 + A~H 八个阶段（PSL 预检 → 建 zone → 域名注册 → 存储 → 部署 → 绑域名 → 加固 → 验收）+ 多站同域名 + 封 IP/封扫描路径 |
| `references/pitfalls.md` | **踩坑手册**：40+ 条「症状 → 根因 → 处理」，另含实现笔记（存储适配 / 边缘缓存 / Range） |
| `scripts/cf-deploy.mjs` | 部署编排 CLI：`status / zone / resources / kv / deploy / domain / subdomain / ipv4 / tstest / e2e / report` |
| `scripts/cdp.js` | 浏览器自动化小工具（导航 / 取值 / 截图 / 坐标点击），用于代操作面板 |
| `scripts/ui-click-select.mjs` | 点 Base UI 虚拟化下拉并选中（Cloudflare 面板那些"点不动"的控件） |
| `scripts/verify-serve.mjs` | 本地 mock 服务器：静态托管 + mock API（本地联调/验收） |
| `scripts/build-public.example.mjs` | **多站组装模板**：把门户 + 多个项目合成一个可部署目录 |
| `scripts/probe/` | 通用页面探针（取 URL/表单控件/可点元素） |

## 怎么用

1. **给 AI 助手用**：让助手读 `SKILL.md`（或直接说「按 `free-domain-worker-deploy` 这个 skill 做」），它会按 A~H 阶段推进。
2. **脚本单独用**：需要 Node 20+（用内置 `fetch`/`WebSocket`，**零第三方依赖**）。

```powershell
# 凭据放在仓库外的 .secrets/（见下），然后：
$env:ZONE_NAME = "yourname.dpdns.org"
$env:CF_WORKER_DIR = "<你的项目>\worker"
node scripts/cf-deploy.mjs status     # 校验 token
node scripts/cf-deploy.mjs zone       # 建 zone，打印要填到域名商的 NS
node scripts/cf-deploy.mjs kv         # 建 KV namespace 并回填 wrangler.toml
node scripts/cf-deploy.mjs resources  # 建 D1 + 执行 schema.sql
node scripts/cf-deploy.mjs deploy     # 组装静态目录 + wrangler deploy + 写 secrets
node scripts/cf-deploy.mjs e2e        # 线上端到端验收（自带 DNS 绕行）
```

可用环境变量：`CF_SECRETS_DIR` / `CF_WORKER_DIR` / `ZONE_NAME` / `CF_WORKER_NAME` / `CF_STORAGE_NAME` / `CF_D1_NAME` / `NPM_BIN` / `NPX_BIN`。

## 这套流程解决过哪些真实问题

- 免费域名的后缀**必须先在 Public Suffix List 里**，否则 Cloudflare 会当成子域拒收（含验证方法）
- DigitalPlat 的 GitHub KYC 在装了扩展的浏览器里**必然失败**，干净窗口一次通过
- R2 要绑信用卡 → 改用 Workers KV；且**未启用 R2 的账号连 Worker 都部署不了**
- Workers 静态资源**不处理 Range 请求** → 媒体"拖不动进度条、一拖回到开头"的完整修法
- `not_found_handling = "none"` 时**不存在的路径会进 Worker** → 扫描器能刷爆每日请求额度，必须在边缘拦
- 国内网络对新域名的 DNS 负缓存 → 验收脚本如何绕开本机 DNS
- Cloudflare 免费版的各种边界：限流规则只能建 1 条、Custom rules 5 条、面板改名叫 Security rules、WAF 入口消失

## ⚠️ 密钥处理（重要）

本仓库**不含任何密钥**。运行时凭据放在仓库之外的目录（默认 `<secrets-dir>\`，可用 `CF_SECRETS_DIR` 覆盖）：

```
.secrets/
├── cf-token.txt          Cloudflare API Token
├── admin-token.txt       站点管理员密钥
├── turnstile-secret.txt  Turnstile Secret Key
└── cf-state.json         部署状态（含 accountId/zoneId/d1Id/kvNamespaceId）
```

`SKILL.md` 里列的 Token 权限清单是**按需最小化**的（Workers / KV / D1 / Zone / DNS / Workers Routes），
不要把 Token 写进任何会被提交的文件。

## 许可

MIT
