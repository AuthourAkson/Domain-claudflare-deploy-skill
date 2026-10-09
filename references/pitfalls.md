# 踩坑手册（症状 → 根因 → 处理）

按「你会看到什么」排序，全部为 2026-10 在 `example.dpdns.org` 部署时**真实遇到并解决**的问题。

---

## A. 域名与 PSL

| 症状 | 根因 | 处理 |
|---|---|---|
| Cloudflare 添加站点报 `Please ensure you are providing the root domain and not any subdomains (Code: 1099)` / `1093` / `1116`，或文档说「子域 Zone 仅 Enterprise 可用」 | 免费域名的后缀**不在 PSL** 里时，`前缀.后缀` 对 Cloudflare 而言只是子域 | **先验 PSL**：`_psl.<后缀>` TXT 存在 + `tldts` 解析 `domain === 完整域名`。`dpdns.org` / `qzz.io` / `us.kg` 都已在 PSL，可正常添加 |
| 用 npm `psl` 包判断得出「不在 PSL」，但实际能注册 | 该包数据可能停留在两年前（实测 `psl@1.15.0` 数据是 2024-12） | 换 `tldts`（v7.x，数据新），并以 `_psl` TXT 记录 + Cloudflare API 实际建 zone 的结果为准 |
| 面板说某些后缀能接 Cloudflare，但选不到 / 要钱 | 政策随时变（2026-10：`.us.kg`/`.xx.kg` 全球暂停注册；`.qzz.io` 新注册要**付费槽位**） | 每次先看 DigitalPlat 面板**公告板**；免费首选 `.dpdns.org` |
| 域名列表空的、KYC 报「GitHub 验证失败」但 GitHub 显示已授权 | **浏览器扩展/隐私设置掐断 OAuth 回调**（不是 GitHub 账号资格问题） | 用**干净 Chrome 窗口**（`--disable-extensions` + 独立 user-data-dir）让用户登录一次，再代操作。验证成功 URL 尾会带 `oauth_notice=github_kyc_verified` |
| 想复制用户 Chrome 配置来复用登录态，Cookie 复制失败 | 运行中的 Chrome **独占锁住** `Default\Network\Cookies`；无管理员权限拿不到 VSS/备份权限 | 放弃复制；改用「干净窗口 + 用户登录一次」。Chrome 136+ 也禁止用默认配置目录开 `--remote-debugging-port` |
| 域名注册后 `dig NS` 在本地查不到 | 递归解析器负缓存（新委派传播慢） | 直接问权威/公共 DNS：`nslookup -type=NS <域名> 223.5.5.5`；父区权威服务器上能查到就说明委派已发布 |
| 浏览器打不开刚上线的域名（`ERR_CONNECTION_CLOSED` / 解析不到），但站点其实是好的 | 两条独立原因：① 本机/运营商 DNS 还是负缓存；② 用户挂了本地代理（Clash 之类），新域名不在规则里就走了直连 | ① `ipconfig /flushdns` 或改用 `223.5.5.5`；② 重启代理清它的 DNS 缓存；③ 验收时用「公共 DNS 查 A + 自定义 lookup」或带 DoH 的浏览器绕开 |

---

## B. Cloudflare 平台行为

| 症状 | 根因 | 处理 |
|---|---|---|
| `POST /accounts/{id}/r2/buckets` 报 `10042 Please enable R2 through the Cloudflare Dashboard` | R2 是**订阅制**，必须先在面板「Enable R2」一次（要信用卡/PayPal；银联储蓄卡不行） | 没卡就直接改用 **Workers KV**（免费 1GB，不要卡） |
| `wrangler deploy` 报 `10085 R2 bucket 'xxx' not found` | 账号未启用 R2 时，**带 R2 绑定的 Worker 根本部署不了** | 先把 `[[r2_buckets]]` 注释掉，改用 KV 段部署 |
| `wrangler deploy` 报 `You need to register a workers.dev subdomain` | 新账号没有 workers.dev 子域 | 改用声明式自定义域名（`[[routes]] custom_domain = true`）即可跳过；或 `node scripts/cf-deploy.mjs subdomain` 注册一个（**注意：`*.workers.dev` 在国内被 DNS 污染，只能当海外备用**） |
| 访问 `api.cloudflare.com/.../bot_management`、`/rulesets` 报 `10000 Authentication error` | token 缺对应权限组（Bot Management / Zone WAF） | 让用户给 token 补权限，或直接在面板操作（免费版限流规则只能建 1 条） |
| 面板里找不到 WAF | 新版面板把 WAF 归到 **`Security → Security rules`** | 限流规则在那里建；页面上的 **「Deploy with API call」** 会给出**官方请求体**，可直接照抄 |
| 免费版限流规则的 Period/Action/Duration 下拉"打不开"或只有一个值 | 免费版**只开放有限取值**：实测 Period 只有 `10 seconds`、Action 只有 `Block`、Duration 只有 `10 seconds`；可用匹配字段只有 **Path**、计数只有 **IP** | 接受限制（60 次/10 秒 Block 也很够用）；要更灵活就升级套餐 |
| 想给 Cloudflare 设置项打补丁，`curl -d '{"value":"on"}'` 报 `6007 Malformed JSON` | PowerShell 把 JSON 参数传坏了 | 把 JSON 写进临时文件，用 `curl.exe --data-binary "@file"` |
| 用 `Invoke-WebRequest` 调本机/远端服务经常卡住不返回 | PowerShell 的 IWR 在某些链路上会挂 | 一律改用 `curl.exe`（带上 `--max-time`） |
| 自定义域名绑好后只有 AAAA（`100::`），纯 IPv4 打不开 | Workers 自定义域名先建 AAAA 占位记录，A 记录稍后才补 | 等几分钟重查；实在没有可跑 `node scripts/cf-deploy.mjs ipv4` 补代理 A 记录（注意 apex 可能已被 Workers 托管，会返回 `81062 A DNS record managed by Workers already exists`，属正常） |
| zone 一直 `pending` | Cloudflare 在等它自己检测委派 | 先确认父区已发布 NS（阶段 C 末尾的检查）；然后等，实测几分钟内变 `active` |
| 证书签发期间 HTTPS 报握手失败/连接被关 | 证书还在签发 | 等 5~10 分钟，别改配置 |

---

## C. Windows / Node / PowerShell 环境

| 症状 | 根因 | 处理 |
|---|---|---|
| `spawnSync npx.cmd EINVAL` | Node 20+ 禁止 `execFileSync` 直接启动 `.cmd`/`.bat` | 用 `shell: true` + 整条命令行字符串 |
| CDP 客户端传空参数被吞（`nav "" url` 变成 `nav url`） | PowerShell 不把空字符串传给原生程序 | CLI 里用 `-` 当「任意标签页」哨兵值 |
| `https.request` 自定义 `lookup` 报 `Invalid IP address: undefined` | Node 有时以 `{ all: true }` 调用 lookup，此时必须回数组 | `if (opts.all) cb(null, [{address: ip, family: 4}]) else cb(null, ip, 4)` |
| `fs` is not defined（自写 CDP 脚本） | 漏了 `require('fs')` | — |
| Node 脚本跑完不退出（挂 60 秒） | 请求超时用的 `setTimeout` 没在成功路径 `clearTimeout` | 在 resolve/reject 前清掉 |
| PowerShell 里 JSON 中文/引号被破坏、或 `ConvertFrom-Json` 报 "Invalid array passed in" | 多行 JSONL/引号转义问题 | 用 Node 读写 JSON，别用 PowerShell 字符串拼 |
| 面板控件点不动（Radix/Base UI） | 虚拟化下拉弹层只渲染 1 行（`--available-height` 算出 33px），DOM 里只有 1 个 option；键盘 Enter 也**不提交** | 用 `scripts\ui-click-select.mjs` 的姿势：**点击触发器打开 → 直接点那个 option 元素**（`pointerdown/mousedown/mouseup + click`），然后回读触发器文字确认生效 |
| 想模拟真人点跨域 iframe 里的东西（如 Turnstile 复选框） | 跨域 iframe 无法用 JS 点击 | 用 CDP `Input.dispatchMouseEvent` 按坐标点（`cdp.js clickxy`） |

---

## D. 部署与静态资源

| 症状 | 根因 | 处理 |
|---|---|---|
| 部署后 `/gallery/xxx.html` 返回 **307** | Workers 静态资源默认 `html_handling = auto-trailing-slash`，会把 `.html` 重定向到无扩展名路径 | 正常，浏览器会跟随；**hash 会保留**（实测 `#g=` 深链跨 307 存活）。想彻底避免多重定向可设 `html_handling = "none"`（代价是 `/xxx` 无扩展名路径不再解析） |
| 担心把后端源码/隐私文件传到公网 | `.assetsignore` 没写或写得不对 | 在 assets 目录根部写 `.assetsignore`（gitignore 语法）：`worker/`、`.git/`、`.gitignore`、`_*/`、`node_modules/`、`.wrangler/`。**用 wrangler 同款 `ignore` 库自测**：`ig.ignores('gallery/_verify/chrome-profile/Default/Network/Cookies')` 必须为 `true` |
| 部署包体积/文件数异常大 | 本地验证产物（Chrome 用户配置常有 60~90MB、几百个文件）混进了 assets | ① `.assetsignore` 加 `_*/`；② 验证完**删掉** `chrome-profile` 目录。wrangler 打印的 "Read N files" 是**条目数**（含目录），不是纯文件数，别被数字吓到 |
| `wrangler d1 execute --remote` 卡在交互确认 | CLI 需要 TTY 确认 | 改用 D1 REST API：`POST /accounts/{acct}/d1/database/{id}/query  {"sql":"..."}`（脚本 `resources` 阶段就是这么做的） |
| `wrangler.toml` 被脚本回填 id 后，队友/自己再整体重写导致 id 丢回占位符 | 多写入方互相覆盖 | 只做**局部 edit**，改完 `grep` 校验关键 id 仍在（`tomllib` 解析验证更稳） |

---

## E. 反爬 / Turnstile / 额度

| 症状 | 根因 | 处理 |
|---|---|---|
| Turnstile 报 `Error: 110200` | widget 的 Hostname 白名单里没有当前域名（本地 `127.0.0.1`/`localhost` 报这个是**正常的**） | Turnstile → 该 widget → Edit Widget → Hostnames 加上线上域名（免费版可加 10 个） |
| headless 浏览器里 Turnstile 一直是交互式验证、拿不到 token | Cloudflare 把 headless 判为可疑（这正是它的设计） | 用**可见窗口**的真实浏览器验收；实测真实浏览器 Managed 模式**无感自动通过**（token 直接拿到、提交按钮可用） |
| 部署后上传全部 403 `turnstile_failed` / `turnstile_required` | 配了 `TURNSTILE_SECRET` 但前端还没带 `cf-turnstile-response` | 部署顺序要对：先上前端，再写 secret；或临时 `wrangler secret delete TURNSTILE_SECRET` |
| 自动化验收跑不了上传 | 真实密钥下必须真人过验证 | `node scripts/cf-deploy.mjs tstest pass` 临时换官方 always-pass 测试密钥（`1x0000000000000000000000000000000AA`）+ 假 token `XXXX.DUMMY.TOKEN.XXXX`，跑完 `tstest real` 换回来 |
| 审核通过后作品墙还是旧的 | **匿名列表有 30 秒边缘缓存**（我们自己加的，用来保护 D1） | 等 30 秒；或给 URL 加无关查询参数绕过（查询串参与缓存键）；审核台带管理员头，永远实时 |
| 上传偶发 502 `storage_error` | KV 免费额度 **1000 写/天，全账号共享**（一次上传=2 写） | 已加 `DAILY_UPLOAD_CAP`（默认 300）保护；要更高就升级或换 R2 |
| 上传后马上 `GET /img/...` 偶发 404 | KV 是**最终一致**（跨边缘节点最多约 60 秒可见；同机房立即） | 设计上让上传者看本地 Blob 预览；跨节点读取容忍几十秒 |
| 图片被别的网站盗挂/被刷 | 默认没有防盗链 | 热链保护：`Sec-Fetch-Site: cross-site` 且 Referer 不在白名单 → 403 `hotlink_blocked`；代价是**搜索引擎图片缩略图也会被挡**，要收录就往 `HOTLINK_ALLOW_REFERERS` 加白名单 |
| 单 IP 把 API 刷爆 | 没有限流 | 三层：Cloudflare 规则（Path/IP）+ Worker 每 IP 每分钟节流 + 上传 5 分钟 3 次 |
| 管理员密钥被暴力枚举 | 没有防爆破 | 失败 10 次/小时 → 该 IP 全部 429 `too_many_attempts`；成功一次即清零 |

---

## G. 多站组装（一个域名挂多个项目）

| 症状 | 根因 | 处理 |
|---|---|---|
| 组装脚本报 `RangeError: Maximum call stack size exceeded`，且产物里出现 `public\draw\.deploy\public\draw\.deploy\...` | 统计对象没把源条目的 `excludeDirs/excludeFileRe` 带过去（只复制了 name/files/bytes），过滤规则失效 → 把 `.deploy` 自己也复制进去，无限自我嵌套 | 用**展开**生成统计对象：`const s = { ...src, files: 0, bytes: 0, big: [] }`；源清单里必须含 `.deploy` 自身 |
| 清理被套娃的目录时报"路径太长"删不掉 | Windows 260 字符路径限制 | `robocopy <空目录> <目标> /MIR /NFL /NDL /NJH /NJS /R:0 /W:0` 先把树"镜像"成空，再 `Remove-Item -Recurse -Force` |
| 首次 `wrangler deploy` 大站点（几十 MB）报 `fetch failed / connectivity issue` | 上传中断（网络抖动） | **直接重跑**：资源是内容寻址的，只补缺失部分（实测第二次 168 秒成功）；必要时循环重试 3 次 |
| 文件名含空格/分号/括号（如 `my song (remix) ;.mp3`）请求返回 **307** | Cloudflare 会把 `;` 规范化为 `%3B` 后 307 重定向 | 正常，浏览器/播放器会自动跟随，最终 200 + 正确的 `Content-Type`；用 `curl -L` 验证即可 |
| 用 `document.querySelector('audio')` 判断音频是否加载，得到 `null` 以为坏了 | 页面可能用 **Web Audio API**（`AudioContext` + `decodeAudioData`），根本没有 `<audio>` 元素 | 看页面自己的状态文案（例如 "音频就绪 · 211.907 s"）或查 `fetch`/资源条目，别只看 `<audio>` |
| 门户页/子站样式串味、图片 404 | 子站里用了以 `/` 开头的绝对路径 | 部署前先 grep `(src|href)\s*=\s*["']/`；有绝对路径的站改用子域名，或把引用改成相对/带前缀 |
| 改完源码部署后发现线上是旧的 | 忘了跑组装（`[assets]` 指向的是 `.deploy/public`，不是源码目录） | 让部署命令**自动先组装**（`cf-deploy.mjs deploy` 里已经这么做了）；别单独跑 wrangler |

---

## H. 媒体与静态资源（Range / 拖动进度条）

| 症状 | 根因 | 处理 |
|---|---|---|
| **拖进度条就回到开头**（音频/视频"拖不动"） | **Workers 静态资源不处理 Range 请求**：`Range: bytes=0-99` 会返回 `200` + 整个文件，也没有 `Accept-Ranges`（GitHub Pages/Fastly 会正确返回 `206` + `Accept-Ranges: bytes`）。浏览器看不到 `Accept-Ranges` 就认为不可定位，一拖就把播放位置重置为 0 | 把含媒体的路径加进 `run_worker_first`，在 Worker 里自己实现 Range（见下方"实现笔记"）。**验证方法**：`curl -r 0-99 -D -` 看是否 `206` + `Content-Range` |
| Worker 里 `env.ASSETS.fetch(request)` 直接抛错（返回 500） | **把带 `Range` 的请求原样转给资产服务会抛错**（它不支持 Range） | 先把 `range`/`if-range` 头**剥掉**再调 `ASSETS.fetch`，取回完整文件后自己切片 |
| Range 逻辑写了但完全不生效、也没有任何自定义响应头 | `env.ASSETS.fetch()` 返回的响应**常常没有 `content-length`**（实测 `len=none`），若代码用 `content-length` 判断大小就会提前 `return res` | 不要信任 `content-length`：把 body 读成 `ArrayBuffer`（或 `Uint8Array`）拿**真实长度**再切片；只有声明大小超过阈值的才跳过（防 OOM） |
| 改了 `run_worker_first` 但行为没变 | 静态资源**没变化**时 wrangler 会跳过资源清单上传，路由配置可能没下发 | 让资源内容变一个字节（或删掉本地 `.wrangler` 状态）逼它重传清单；改完务必用真实请求验证（别只看配置） |
| 分号/空格/括号文件名请求先返回 307 | Cloudflare 会把 `;` 规范化成 `%3B` | 正常，浏览器会自动跟随，最终 200 + 正确 `Content-Type` |
| 视频**要下完才开始播**、进度条点了没反应 | MP4 的索引（moov atom）在文件末尾，浏览器必须先拿到它才能播/定位 | 转码时加 `-movflags +faststart`（把索引挪到开头）；已压好的也可以无损搬一下：`ffmpeg -i in.mp4 -c copy -movflags +faststart out.mp4` |
| 部署报文件过大 | Workers 静态资源**单文件上限 25 MiB**（免费版文件数上限 2 万） | 重压：1080p + CRF 26 实测 **85.5MB → 17.4MB（省 80%）**，2D/动画类画面几乎看不出差别；实在太大就分片或换视频托管 |
| 视频拖不动（和音频同一个病） | 静态资源没有 Range | 视频目录也要加进 `run_worker_first`（如 `/media/*`），只加音频目录不够 |
| 列表页一打开就吃掉几十 MB 流量 | 默认 `preload` 会把视频预取一部分 | `<video preload="metadata" poster="...">`：只拉文件头 + 一张封面图 |

---

## F. 实现笔记（下次照抄的做法）

**存储层适配（一份代码同时支持 KV / R2）**

```js
// 唯一一处分支，其余代码只调 store.*
const isKV = typeof env.BUCKET?.getWithMetadata === 'function';
export function createStore(env) {
  const b = env.BUCKET;
  return isKV
    ? {
        kind: 'kv',
        putImage: (k, bytes) => b.put(k, bytes, { metadata: { contentType: 'image/png' } }),
        putJson:  (k, text)  => b.put(k, text,  { metadata: { contentType: 'application/json' } }),
        get:      async (k) => { const { value, metadata } = await b.getWithMetadata(k, 'arrayBuffer');
                                 return value ? { bytes: value, contentType: metadata?.contentType } : null; },
        delete:   (k) => b.delete(k),
      }
    : { /* R2: put(k,v,{httpMetadata:{contentType,cacheControl}}) / get(k) 返回带 .body/.httpMetadata */ };
}
```
要点：KV 没有 `httpMetadata`，Content-Type 必须存进 `metadata` 再自己拼 Response；两次上传失败要**回滚**已写入的对象，避免留下没有元数据的孤儿文件。

**边缘缓存（省下最贵的额度）**

```js
const cache = caches.default;
const key = new Request(url.toString());
const hit = await cache.match(key);
if (hit) return withCors(addCacheHeader(hit, 'HIT'), request, env);   // ⚠️ 缓存里存"未加 CORS"的干净响应
const res = await build();                                            // 只有 200 才回填
if (res.status === 200) ctx.waitUntil(cache.put(key, res.clone()));
```
两个刻意的决定：① 缓存**未加 CORS 头**的响应（否则 A 站会拿到给 B 站的 `Access-Control-Allow-Origin`）；② 列表缓存用**时间桶键**（`floor(now/TTL)`），TTL 可确定性测试、不用 sleep。

**幂等与可观测**
- `/api/health` 暴露 `bindings` / `storage`(kv|r2) / `turnstile_configured` / `limits` / `quota_today` —— 线上排查一眼看清，比翻日志快。
- 每张图/每条列表响应带 `x-gallery-cache: HIT|MISS`，肉眼即可验证缓存是否工作。

**给静态媒体补 Range（让进度条能拖）**

```js
// worker/src/media.js —— 只在含媒体的路径上前置执行（wrangler.toml 的 run_worker_first）
export async function serveStaticWithRange(request, env) {
  const rangeHeader = request.headers.get('range');
  // ① 必须剥掉 Range 再问资产服务，否则它抛错
  const h = new Headers(request.headers); h.delete('range'); h.delete('if-range');
  const res = await env.ASSETS.fetch(new Request(request.url, { method: request.method, headers: h }));
  if (res.status !== 200) return res;
  const headers = new Headers(res.headers);
  headers.set('accept-ranges', 'bytes');                 // 让浏览器知道"可以拖"
  if (!rangeHeader) return new Response(res.body, { status: 200, headers });
  // ② 不要信 content-length：资产服务经常不给（实测 len=none）
  const buf = new Uint8Array(await res.arrayBuffer());
  const { start, end } = parseRange(rangeHeader, buf.byteLength);   // 支持 a-b / a- / -N
  const chunk = buf.subarray(start, end + 1);
  headers.set('content-range', `bytes ${start}-${end}/${buf.byteLength}`);
  headers.set('content-length', String(chunk.byteLength));
  headers.delete('content-encoding');
  return new Response(chunk, { status: 206, headers });   // 越界要返回 416 + `bytes */size`
}
```

三个必须一起处理的点：**剥 Range 头**、**自己算真实长度**、**`run_worker_first` 里加上媒体路径**（否则请求根本不进 Worker）。
