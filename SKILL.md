---
name: free-domain-worker-deploy
description: 把「免费域名 + Cloudflare Workers 全栈站点」从零部署上线并加固的完整流程——PSL 校验选后缀、DigitalPlat 免费域名注册（含 GitHub KYC）、Cloudflare zone 与 NS 委派、Workers 静态资源 + KV/R2 + D1、自定义域名、Turnstile 人机验证、速率限制/反爬加固，以及不依赖本机 DNS 的端到端验收。Use this skill whenever 用户说要申请免费域名、把网站接到自己的域名、部署到 Cloudflare、给站点加防爬/限流/人机验证，or when a Cloudflare Worker site (+KV/R2/D1) needs to be deployed, hardened, or acceptance-tested; also use it to troubleshoot DigitalPlat KYC 失败、域名列表为空、Cloudflare 报 10042/10085/81062/110200、zone 长期 pending、或国内浏览器打不开刚接入的新域名。
---

# 免费域名 + Cloudflare Workers 站点：部署与加固

## 这个 skill 解决什么问题

把一个静态站点/小型应用，用**零成本**的方式上线到**自己的域名**上，并配好抗刷的防护：

- 域名：DigitalPlat FreeDomain（`.dpdns.org` / `.qzz.io` 等），NS 委派给 Cloudflare
- 托管：Cloudflare Workers（免费版）+ 静态资源绑定
- 存储：图片/文件用 **Workers KV**（不要卡）或 **R2**（更好但要绑卡）；元数据用 **D1**
- 防护：Turnstile 人机验证 + 速率限制 + Worker 内缓存/限流/热链保护
- 验收：不依赖本机 DNS 的端到端脚本（国内线路对新域名有很长的负缓存）

本 skill 的脚本是**跑通过的**：2026-10 用它在 `example.dpdns.org` 上部署了「门户 + 站点 A + 站点 B」（Worker + KV + D1 + Turnstile + 速率限制），端到端 24 项断言全绿。

---

## 0. 三条铁律（踩过坑才写的）

1. **先验 PSL，再谈注册。** Cloudflare 只接受「可注册域名」。免费后缀必须先在 [Public Suffix List](https://publicsuffix.org/) 里（这样 `example.dpdns.org` 才算根域名而不是子域）。
   - ❌ 不要用老的 npm `psl` 包判断（数据可能是两年前的）。
   - ✅ 用 `tldts`（更新勤）+ 交叉验证 `_psl.<后缀>` 的 TXT 记录：
     ```powershell
     # PSL 私有段条目会发布 _psl.<suffix> TXT，指向它的 PSL PR
     curl.exe -s "https://cloudflare-dns.com/dns-query?name=_psl.dpdns.org&type=TXT" -H "accept: application/dns-json"
     # 期望形如： {"Answer":[{"data":"\"https://github.com/publicsuffix/list/pull/2414\""}], "Status":0}
     ```
     实测（2026-10）：`dpdns.org` ✅ 在 PSL、`qzz.io` ✅ 在 PSL、`us.kg` ✅ 在 PSL。
   - 若 `tldts.parse(name, {allowPrivateDomains:true}).domain === name`，说明它就是根域名，Cloudflare 能接。

2. **密钥只放 `.secrets`，永远不进 git。** 默认目录 `<secrets-dir>\`（该目录不在任何仓库里）。里面会有：
   | 文件 | 内容 |
   |---|---|
   | `cf-token.txt` | Cloudflare API Token |
   | `cf-state.json` | **含 accountId / zoneId / d1Id / kvNamespaceId / adminToken / ipSalt**（敏感，值都在里面） |
   | `admin-token.txt` | 站点管理员密钥（明文，方便交给用户） |
   | `turnstile-secret.txt` | Turnstile Secret Key |
   | `_secret-body.json` | 临时文件，写完即删 |

3. **验收必须绕开本机 DNS。** 国内递归解析器对新委派的域名可能有很长的负缓存（表现为 `curl`/Chrome 打不开，但站点其实正常）。验收脚本用「公共 DNS 查 A 记录 + 自定义 lookup 连接」的方式（`scripts/cf-deploy.mjs` 已内置 `resolveA` / `httpsReq`），结论才反映线上真实状态。

---

## 1. 关键路径总览

| 阶段 | 做什么 | 谁做 | 产出 |
|---|---|---|---|
| A | 可行性预检：PSL、后缀政策、凭据 | 你 | 结论：用哪个后缀 |
| B | Cloudflare 建 zone → 拿 2 个 NS | 你（API） | `aragorn/beth.ns.cloudflare.com` 之类 |
| C | DigitalPlat 注册域名 + 填 NS（**GitHub KYC**） | 用户（浏览器，可代操作） | 域名出现在 Domain List |
| D | 建存储（KV 或 R2）+ D1 + 灌 schema | 你（API） | 绑定可用的存储 |
| E | 写 Worker（静态资源 + API）+ 部署 | 你 | Worker 上线 |
| F | 绑自定义域名（apex + www） | 你 | `https://<域名>` 可访问 |
| G | 安全加固：限流规则、TLS、Turnstile、Worker 内防护 | 你 + 用户点 1~2 下 | 防护生效 |
| H | 端到端验收 + 浏览器实测 | 你 | 验收报告 |

---

## 2. 阶段 A：可行性预检（别跳过）

```powershell
# 1) 后缀是否在 PSL（决定 Cloudflare 能不能接）
curl.exe -s "https://cloudflare-dns.com/dns-query?name=_psl.dpdns.org&type=TXT" -H "accept: application/dns-json"

# 2) 该后缀当前是否还免费 / 是否暂停注册 —— 必须看面板「公告板」
#    2026-10 实测：.us.kg/.xx.kg 全球暂停；.qzz.io 新注册要「付费槽位」；.dpdns.org 仍免费
#    所以：默认选 .dpdns.org

# 3) Cloudflare API Token 权限（用户去 https://dash.cloudflare.com/profile/api-tokens 建 Custom token）
```

**Cloudflare Token 权限清单**（按需勾，Account 组 + Zone 组）：

| 组 | 权限 | 级别 | 用途 |
|---|---|---|---|
| Account | Workers Scripts | Edit | 部署 Worker |
| Account | Workers KV Storage | Edit | 建 KV（推荐存储方案） |
| Account | Workers R2 Storage | Edit | 建 R2（要绑卡才能启用） |
| Account | D1 | Edit | 建库/执行 SQL |
| Account | Account Settings | Read | 校验账号 |
| Zone | Zone | Edit | 建 zone |
| Zone | DNS | Edit | 补 A 记录等 |
| Zone | Workers Routes | Edit | 绑自定义域名 |

> **Zone Resources 必须选 `Include → All zones`**：域名还不存在，指定具体 zone 会失败。
> 想要脚本直接建限流/WAF 规则，再补 `Zone → WAF → Edit`；想要 Bot Fight Mode，再补 `Zone → Bot Management → Edit`（否则只能在面板点）。

---

## 3. 阶段 B：建 zone 拿 NS

```powershell
$env:ZONE_NAME="example.dpdns.org"          # 换成新域名
node scripts\cf-deploy.mjs status         # 校验 token + 拿 accountId
node scripts\cf-deploy.mjs zone           # 建 zone，打印两个 NS
```

- 期望输出两个 NS（形如 `aragorn.ns.cloudflare.com` / `beth.ns.cloudflare.com`）。
- 建完后 zone 状态是 `pending`，**这是正常的**——它在等 DNS 委派。
- 此时可直接验证 Cloudflare 权威 NS 已在应答本 zone（说明配置无误）：
  ```powershell
  nslookup -type=SOA <域名> <NS1>
  ```

---

## 4. 阶段 C：DigitalPlat 注册（KYC 是唯一难点）

**顺序很重要：先拿 NS，再注册**（DigitalPlat 官方文档也是这个顺序）。

用户在 https://dashboard.digitalplat.org/registration?guide_task=domain 操作：
1. 先看**公告板**（后缀可用性/额度政策随时变）
2. label 填前缀 + 选后缀 → `Check availability`
3. **委派模式选「外部名称服务器」**（不是 DigitalPlat DNS），把两个 NS 都填上
4. 勾政策 → 提交 → **Domain List 确认**

### ⚠️ 免费域名名额需要「账户验证（GitHub KYC）」

- 面板黄条提示「只有使用免费域名插槽时才需要账户验证」，路径是 `Account → /user/kyc` → 选 GitHub OAuth → `Verify with GitHub`。
- **常见故障**：GitHub 那边显示已授权、DigitalPlat 却报「验证失败」，域名列表为空。
  **根因几乎都是浏览器扩展/隐私设置掐断了 OAuth 回调**（不是 GitHub 账号资格问题——用 API 查过：账号 867 天、24 仓库、邮箱已验证，仍然失败）。
- **解法（100% 复现有效）**：开一个**干净 Chrome 窗口**（禁用扩展），让用户在里面登录一次，然后你接管：
  ```powershell
  # 1) 干净窗口（禁用扩展 + 独立配置目录）+ 远程调试
  Start-Process "<chrome.exe 的完整路径>" -ArgumentList @(
    '--remote-debugging-port=9225','--user-data-dir=<profile-dir>','--disable-extensions','--new-window',
    'https://dashboard.digitalplat.org/registration?guide_task=domain'
  ) -RedirectStandardOutput "$env:TEMP\c.out" -RedirectStandardError "$env:TEMP\c.err"
  # 2) 用户登录后，你就能用 cdp.js 全程代操作（见「脚本速查」）
  $env:CDP_PORT=9225; node scripts\cdp.js targets
  ```
  **注意**：用户主 Chrome 运行时会独占锁住 Cookie 文件（无管理员权限无法复制），所以「复制配置」这条路走不通；干净窗口 + 用户登录一次是最省事的。
- 验证成功后 URL 会跳到 `.../settings?oauth_notice=github_kyc_verified`。

注册完立刻验证委派是否发布（国内 DNS 服务器上直接查）：
```powershell
nslookup -type=NS <域名> 223.5.5.5     # 应返回你填的两个 Cloudflare NS
```

---

## 5. 阶段 D：存储与数据库

**存储选型（关键决策）**：

| 方案 | 免费额度 | 要不要卡 | 结论 |
|---|---|---|---|
| **Workers KV** | 1GB / 10万读/天 / **1000 写/天（全账号共享）** | ❌ 不要 | **默认选它** |
| R2 | 10GB + 出流量永久免费 | ✅ **要绑信用卡/PayPal**（银联储蓄卡不行，错误码 10042 `Please enable R2 through the Cloudflare Dashboard`） | 有卡再用 |

> R2 还有一条隐藏依赖：**未启用 R2 的账号无法部署带 R2 绑定的 Worker**（wrangler 报 `10085 R2 bucket not found`）。所以没卡就直接走 KV，别硬扛。

```powershell
node scripts\cf-deploy.mjs kv          # 建 KV namespace（会回填 wrangler.toml 的 id 占位符）
node scripts\cf-deploy.mjs resources   # 建 D1 + 执行 schema.sql（R2 未启用时只告警不阻断）
```

Worker 代码里**存储层要做适配**：同一个绑定名（如 `BUCKET`），靠能力探测自动识别 KV/R2 —— `typeof env.BUCKET.getWithMetadata === 'function'` → KV，否则 R2。这样以后换回 R2 只需改 `wrangler.toml`，代码零改动。

---

## 6. 阶段 E：Worker 站点（静态资源 + API）

`wrangler.toml` 的三个要点：

```toml
name = "<worker 名>"
main = "src/worker.js"
compatibility_date = "2026-10-06"      # 必须 ≤ 今天，否则 wrangler 拒绝

[assets]
directory = ".."                        # 站点文件在 worker 目录的上一级
binding = "ASSETS"
run_worker_first = ["/api/*", "/img/*"] # 让 Worker 优先处理接口，避免被静态文件遮住
not_found_handling = "none"

[[kv_namespaces]]
binding = "BUCKET"
id = "<真实 id，别提交占位符>"

[[routes]]                              # 声明式自定义域名：这样部署不依赖 workers.dev 子域
pattern = "<域名>"
custom_domain = true
```

- **必须有 `.assetsignore`**（放在 assets 目录根部）：排除 `worker/`（后端源码不能公开）、`.git/`、`_*/`（本地验证产物，常含几十 MB 的浏览器配置！）、`node_modules/`。
  用 wrangler 内部同款 `ignore` 库自测一遍再部署，确认敏感路径都被排除：
  ```js
  const ig = require('ignore')().add(fs.readFileSync('.assetsignore','utf8').split(/\r?\n/).filter(l=>l&&!l.startsWith('#')));
  ig.ignores('gallery/_verify/chrome-profile/Default/Network/Cookies')  // 期望 true
  ```
- 部署前先 dry-run：`npx wrangler@4 deploy --dry-run`（会打印绑定与资源数）。

```powershell
node scripts\cf-deploy.mjs deploy      # wrangler deploy + 写入 secrets
```

**Secrets**（用 API 写，避免交互）：
```powershell
# 例：ADMIN_TOKEN / IP_SALT / TURNSTILE_SECRET 三个
# PUT /accounts/{acct}/workers/scripts/{name}/secrets   body {"name":..,"text":..,"type":"secret_text"}
```

---

## 7. 阶段 F：自定义域名

- `[[routes]] custom_domain = true` 会在部署时自动创建域名绑定 + DNS 记录 + 证书。
- 刚创建时**只有 AAAA（100::）**，A 记录要等 Cloudflare 配置完成才出现（实测几分钟）。这期间纯 IPv4 客户端解析不到 → 表现为「站点打不开」，耐心等或重新查询。
- zone 从 `pending` 变 `active` 才会正式对外服务（Cloudflare 自己会检测委派，实测几分钟）。
- 证书签发期间 HTTPS 可能短暂 `ERR_CONNECTION_CLOSED`／握手失败，**不要急着排查配置**，等 5~10 分钟再试。

---

## 8. 阶段 G：安全加固（免费版能做到的）

**Cloudflare 层面**

| 项 | 怎么做 |
|---|---|
| 强制 HTTPS / 最低 TLS 1.2 | API 直接改：`PATCH /zones/{id}/settings/always_use_https {"value":"on"}`、`.../min_tls_version {"value":"1.2"}`（用文件传 JSON，PowerShell 直接 `-d '{...}'` 会报 6007 Malformed JSON） |
| Bot Fight Mode | 只能面板开（`Security → Bots`）；开了之后要用脚本验收一次，确认没误伤自动化调用 |
| 速率限制规则 | 新版面板**不叫 WAF 了，叫 `Security → Security rules`**；免费版可用字段只有 **Path**、计数只有 **IP**、只能建 **1 条**，且下拉可选值很有限（实测只有 `10 seconds` / `Block` / `10 seconds`） |
| Turnstile | 面板建 widget（Managed 模式）→ 拿到 Site Key（公开）+ Secret Key（私密，写成 Worker secret）；**Hostname 白名单必须包含线上域名**，否则报 `110200` |

**Worker 层面**（都要有开关，默认值写进 `[vars]`）

| 措施 | 作用 |
|---|---|
| `/img/*` Cache API 边缘缓存 | 同一 PoP 上同一张图被刷一万次=只读一次存储（KV 读额度是稀缺资源） |
| 列表接口匿名短缓存（30s，带管理员头永久不缓存） | 扛脚本扫列表，保护 D1 行读额度 |
| 热链保护（`Sec-Fetch-Site` + 来源白名单） | 别人盗挂你的图 → 403 `hotlink_blocked` |
| 上传挑战令牌（HMAC + 10 分钟 + 绑 IP） | 挡「直接 POST 刷上传」的脚本（低成本的第二道闸） |
| **全局每日上传上限**（写 D1 计数表） | ⚠️ 保护 KV 那 **1000 写/天（全账号共享）**——被刷爆会导致**自己也不能上传** |
| 管理员接口防爆破（10 次/小时/IP） | 密钥不会被暴力枚举 |
| `robots.txt` + `/api/*` 带 `X-Robots-Tag: noindex` | 规矩的爬虫别碰接口 |

### 封 IP / 封扫描路径（免费版可用，Custom rules 共 5 条名额）

入口：`Security → Security rules → Custom rules → Create rule`

| 目的 | 表达式 | 动作 |
|---|---|---|
| 封单个恶意 IP | `ip.src eq 1.2.3.4` | Block |
| **封整段**（推荐：攻击者常在同一个 /24 里换 IP） | `ip.src in {1.2.3.0/24}` | Block |
| 封机房 / ASN | `ip.geoip.asnum eq 12345` | Block |
| 拦常见敏感文件探测 | 见下方表达式 | Block |

```
(lower(http.request.uri.path) contains "/.env") or (lower(http.request.uri.path) contains "/.git")
or (lower(http.request.uri.path) contains "/.aws") or (lower(http.request.uri.path) contains "/.docker")
or (lower(http.request.uri.path) contains "/.ssh") or (lower(http.request.uri.path) contains ".php")
or (lower(http.request.uri.path) contains "wp-admin") or (lower(http.request.uri.path) contains "wp-login")
or (lower(http.request.uri.path) contains "phpmyadmin") or (lower(http.request.uri.path) contains "/xmlrpc")
or (lower(http.request.uri.path) contains "/config.json") or (lower(http.request.uri.path) contains "/vendor/")
```

**为什么一定要拦扫描路径**：本项目 `not_found_handling = "none"`，**不存在的路径会交给 Worker**——
扫描器狂刷 `/.env`、`/.git/config` 这类路径能把 10 万/天的 Worker 请求额度直接刷掉。
拦在 Cloudflare 边缘（403）就完全不消耗 Worker 额度。

**判断恶意 IP 归属**（决定封单 IP 还是整段）：
```bash
curl -s https://rdap.db.ripe.net/ip/203.0.113.45   # 看网段 / 运营商；VPS 机房基本都是整段被租来扫的
```

**验证方法**（改完立刻实测）：
```bash
curl -o /dev/null -w "%{http_code}\n" https://<域名>/.env        # 期望 403
curl -o /dev/null -w "%{http_code}\n" https://<域名>/            # 期望 200
```

**用 CDP 代操作面板时的两个坑**（都在 `scripts/ui-click-select.mjs` / 本节里踩过）：
1. Base UI 的虚拟化下拉弹层只渲染 1 行 —— 只能"点触发器打开 + 点那个 option"，键盘 Enter 不提交；
2. 改操作符（`eq → is in`）后**值控件会换成 react-select**，必须用真实键盘事件（`Input.insertText` 再按 Enter），用原生 setter 直接赋值无效。

**Turnstile 的验收姿势**（很重要，否则自动化验收做不下去）：
- 真实 Secret 下，任何没有真人 token 的 `POST /api/upload` 都会 403 —— 这是**正确行为**，也是最好的负面测试。
- 要跑**完整上传链路**时，把 secret 临时换成 Cloudflare 官方 **always-pass 测试密钥** `1x0000000000000000000000000000000AA`，请求里带假 token `XXXX.DUMMY.TOKEN.XXXX`，跑完再换回真实密钥。
  ```powershell
  node scripts\cf-deploy.mjs tstest pass   # 换测试密钥
  node scripts\cf-deploy.mjs e2e           # 完整链路（含图片缓存/盗链/配额断言）
  node scripts\cf-deploy.mjs tstest real   # 换回真实密钥
  node scripts\cf-deploy.mjs e2e           # 复查：无 token 上传应被 403 拦下
  ```

---

## 9. 阶段 H：验收

```powershell
node scripts\cf-deploy.mjs report   # zone 状态 / DNS 记录 / Worker 域名
node scripts\cf-deploy.mjs e2e      # 端到端断言（自带 DNS 绕行）
```

`e2e` 覆盖：health 与绑定 → robots.txt/X-Robots-Tag/challenge 接口 → 首页与画廊页（跟 307）→ 上传（待审）→ 未过审不泄露 → 错误管理员令牌 401 → 审核通过 → 公开列表出现 → 出图 Content-Type/immutable/字节一致 → **缓存 MISS→HIT** → **盗链 403** → `/api/piece` 可读 → 清理。当前基线 **24/24**。

**最终还要用真实浏览器过一遍**（脚本过不了 JS/渲染）：
```powershell
# 本机 DNS 打不开新域名时，用带 DoH 的浏览器：
Start-Process "<chrome.exe 的完整路径>" -ArgumentList @(
  '--remote-debugging-port=9226','--user-data-dir=<profile-dir>','--disable-extensions',
  '--no-proxy-server','--dns-over-https-mode=secure','--dns-over-https-templates=https://cloudflare-dns.com/dns-query',
  'https://<域名>/')
$env:CDP_PORT=9226; node scripts\cdp.js eval - scripts\probe\probe-url.js
node scripts\cdp.js shot - <工作区>\_shots\live.png
```
实测结论：**headless Chrome 会被 Turnstile 判为可疑（给交互式验证，且不自动通过）；可见窗口的真实浏览器会无感自动通过**（token 自动拿到、提交按钮可用）。所以「真人可用性」必须在可见窗口里测。

---

## 10. 换新站点时要改什么

1. `ZONE_NAME`（或环境变量）→ 新域名
2. `CF_WORKER_DIR` → 新项目的 `worker/` 目录（里面的 `wrangler.toml` + `src/`）
3. `.secrets/cf-state.json` 里旧的 id 会被新值覆盖；**换项目时建议先把 state 文件备份/改名**，避免 zone/d1 串台
4. 静态资源目录（`[assets] directory`）与 `.assetsignore`
5. 新站点记得重新走一遍：PSL 校验 → zone → NS → 注册 → 存储 → 部署 → 域名 → 加固 → 验收

---

## 11. 脚本速查

全部在 `scripts\`，零依赖（Node 20+，用内置 fetch/WebSocket）。

| 命令 | 作用 |
|---|---|
| `node scripts\cf-deploy.mjs status` | 校验 token、列账号 |
| `... zone` | 建/复用 zone，打印 NS |
| `... resources` | 建 R2(可失败告警) + D1 + 执行 schema.sql + 回填 wrangler.toml |
| `... kv` | 建 KV namespace 并回填 id |
| `... deploy` | wrangler deploy + 写入 secrets |
| `... domain` | 用 API 绑 Worker 自定义域名（apex + www） |
| `... subdomain` | 注册 workers.dev 子域（海外备用入口；国内不可达） |
| `... ipv4` | 补代理 A 记录（自定义域名只有 AAAA 时用） |
| `... tstest pass\|real` | 切换 TURNSTILE_SECRET（自动化验收用） |
| `... e2e` | 端到端验收（DNS 无关） |
| `... report` | 汇总 zone/DNS/域名状态 |
| `node scripts\cdp.js <cmd>` | 浏览器自动化：`targets / newtab / nav / eval <file> / text / shot / shotfull / viewport / clickxy` |
| `node scripts\ui-click-select.mjs` | 点开 Base UI 虚拟化下拉并选中选项（面板自动化用） |
| `node scripts\verify-serve.mjs [port]` | 本地 mock 服务器：静态托管 + mock 画廊 API（本地联调用） |

---

## 12. 在同一个域名下挂多个站（多站组装）

**原理限制**：Workers 的 `[assets]` 只能指向**一个**目录。所以「一个域名、多个项目」必须先把它们组装成一棵树，
或者每个项目各用一个 Worker + 子域名。2026-10 实测选了前者（`example.dpdns.org`）：

```
.deploy/public/                 ← 组装产物（[assets] 指向它）
├── index.html                  ← 门户首页（源：..\portal\）
├── style.css
├── draw/**                     ← 项目 1（源：仓库根目录）
└── world/**                    ← 项目 2（源：<另一个项目目录>）
```

访问效果：`/`（门户）、`/draw/`、`/draw/gallery/gallery.html`、`/world/` —— 一个域名、一个 Worker、同源无 CORS。

**组装脚本要点**（`worker/build-public.mjs`，由 `cf-deploy deploy` 自动调用）：

| 要点 | 说明 |
|---|---|
| 每个源目录一份排除清单 | 必须排除：`.git/`、后端源码目录（如 `worker/`）、`.deploy/`（**否则自我递归！**）、`node_modules/`、开发产物（`_tools/`、`_verify/`）、`_*.js`、`*.log` |
| 把源条目**展开**进统计对象 | `const s = { ...src, files: 0, bytes: 0, big: [] }` —— 少写展开就会丢掉过滤规则（我们踩过，见 pitfalls） |
| 输出体积报表 | 打印每个子站的"文件数 / 体积 / 大文件"，部署前一眼看出有没有把 46MB 的开发目录传上去 |
| 门户放根目录 | 根 `index.html` = 门户；各项目在子路径 |
| 旧链接兼容 | 门户里加一段 JS：`if(/^#(g|p)=/.test(location.hash)) location.replace('/draw/index.html'+location.hash)`，把搬走前的深链转过去 |
| 源仓库不受影响 | 组装只是复制，`<项目目录>` 的目录结构、本地双击打开、git 仓库都不变；`.deploy/` 加进 `.gitignore` |

> ⚠️ **站点里有音频/视频的话，一定要看 `references/pitfalls.md` 的 H 节。**
> Workers 静态资源**不支持 Range 请求**，媒体会变成"拖不动进度条、一拖就回到开头"。
> 修法：把媒体目录加进 `run_worker_first`，并在 Worker 里自己实现 Range（记得剥掉 Range 头再问资产服务，
> 且**不要相信返回的 content-length**——实测资产服务常常不给这个头）。

**子路径 vs 子域名怎么选**

| | 子路径（本篇） | 子域名 |
|---|---|---|
| 前提 | 各站都用**相对路径**引用资源（用绝对 `/xxx` 的站要改） | 无所谓 |
| 好处 | 一个 Worker、一次部署、同源无 CORS、额度只算一份 | 项目完全隔离、可独立 Worker/独立部署 |
| 代价 | 需要组装脚本；项目 URL 变化（`/` → `/draw/`） | 每个站一个 Worker；跨子域调 API 要配 CORS（`ALLOWED_ORIGIN` 加来源） |
| 证书 | 自动（apex） | Universal SSL 覆盖 `*.域名` 一级子域，自动 |

**大站部署注意**：首次上传 35MB 时实测出现过一次 `fetch failed`（网络抖动）——**直接重跑 `wrangler deploy` 即可**，
静态资源是内容寻址的，只会补传缺失部分（第二次成功，耗时 168 秒）。总限制：单文件 ≤25MB、免费版文件数 ≤20000。

---

## 13. 参考

- `references/pitfalls.md` —— **所有踩过的坑**（症状 → 根因 → 处理），排查问题先看它
- 存储层适配、缓存、防刷的具体实现思路见 `references/pitfalls.md` 的「实现笔记」一节
