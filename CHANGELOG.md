# Changelog

## 0.9.5 — 2026-09-15（CF-Server-Monitor 移植版）

0.9.4 的定向复审（LENS job `8842B181`）判仍阻塞：两条严重项都还没闭合，且**根因是 0.9.3 引入的内存副本**。
本轮按「读路径不得有内存遮蔽」重做，并修恢复等待预算。

- **凭证存储改为 backing 忠实语义（撤回内存副本对读路径的参与）**：复审给出的三个反例（写失败后读回旧
  backing 值、外部写入后删除时旧兜底复活、读抛错时送出已删除的兜底值）共同根因是——**单次快照无法区分
  「外部没动过」与「外部写入后又被删除」**，任何内存兜底都会在某个时序上掩藏 backing 的真实状态。
  现在：`get` 只返回 backing 的真实内容（读失败保守返回空）；`set` 只在 backing 存在时写 backing，
  失败就**如实失败**，不写内存副本；只有在**根本没有 backing**（无 localStorage / 访问被拒）时才用内存。
  **已知取舍**：可读不可写（配额 / 只读沙箱）环境下凭证无法持久化，该页面会被反复要求验证——比谎报
  一个没落盘的值安全，但正确修法是让链层感知「持久化失败」并限制自动恢复次数，列为后续项。
- **恢复等待预算改为最坏上界** `TURNSTILE_MAX_ATTEMPTS × (script + user + exchange)`（默认 250 秒）：
  0.9.4 的 `user + exchange`（110 秒）仍不覆盖「两轮自动尝试 + 最多两次脚本加载」，复审给出确定性反例
  （两轮各 70 秒用户交互、每轮都未超时，但早期加入者在 110 秒被判 `recovery-timeout`，恢复随后成功）。
  **已知取舍**：上界较长，等待者会久等——比把合法恢复误判成终局失败（历史请求被写成空数组并缓存
  5 分钟、置上抽屉/详情错误且不会自动清除）安全；更合适的做法是把等待超时当「仍在恢复、可重试」的
  独立状态在消费端处理，属后续项。
- **CI 覆盖**：`npm test` 纳入 `test-turnstile.mjs`——此前 CI 的 Test 步骤**不跑 Turnstile 套件**，
  26 项断言从未进入 CI（复审建议 1）。
- **测试**：12a 保持（外部更新/清除必须可见）；12b 改为「写失败如实失败、外部写入优先、外部删除不得
  复活、恢复可写后新值必须真的落盘」；12c 显式摘除全局 `localStorage` 以保证测到降级路径（复审建议 3）。

## 0.9.4 — 2026-09-15（CF-Server-Monitor 移植版）

定向复审（LENS job `2C4E8BA9`）判 0.9.3 **阻塞**：两条严重问题都是该轮加固自己引入的，本轮修正。

- **凭证存储改为「正常以 backing 为准，只有写失败的 key 才用内存副本兜底」**：0.9.3 的内存优先读取
  会遮蔽**外部上下文**（站点内置前端、其它标签页）对同一 key 的更新与**删除**——旧值继续被发送
  （多余 403、反复挑战），甚至可能反过来删掉别人刚写的有效凭证。现在 backing 有值就用 backing，
  backing 为空且本实例从未写失败过即视为「已被清除」，不再回落到陈旧内存值。
- **门控等待预算改为覆盖完整恢复过程（用户挑战 + 交换）**：0.9.3 取 exchange 量级（20 秒），不覆盖
  合法的 90 秒用户挑战 —— 超时会被当作终局失败消费，把历史请求的空数组缓存 5 分钟、置上
  `drawerHistoryError` / `detailError` 并弹提示，挑战成功后这些状态不会自动清除。现在只有恢复真的
  不结算（异常卡死）才会超时。**范围说明**：这只约束「加入在途恢复的等待者」；发起恢复的那个请求
  仍直接 `await recover()`，不受此限，因此本项并不改善 `refreshStatuses` 在挑战期间的 in-flight 状态。
- **测试 23 → 26 项**：新增 `createTurnstileStorage`（生产实现）的语义回归——12a 外部更新/清除必须
  可见、12b 可读不可写时内存兜底且外部写入优先、12c 无 localStorage 时纯内存降级；11a/11b 补精确
  断言（错误消息、`turnstile`/`reason`、凭证值不得被改动）。此前只测了 harness 自己注入的另一套存储，
  生产存储语义零覆盖，这两条阻断正是从该缺口溜过去的。

- **修正记录（0.9.5 追加）**：本节关于「预算覆盖完整恢复过程」「只有恢复真的不结算才超时」「两条阻断
  都源于生产存储零覆盖」的表述不准确——110 秒不覆盖两轮自动尝试与脚本加载阶段（反例见 0.9.5），
  且 B2 属**恢复时序**覆盖缺口，与存储无关。

## 0.9.3 — 2026-09-15（CF-Server-Monitor 移植版）

批次 6 交付后按审查建议做的加固（均为非阻断项，逐条对应 LENS 审查结论）：

- **错误结构化**：`CfsmApiError` 保留 `turnstile` / `reason` 字段——业务层可直接区分「Turnstile 失败」与
  普通 403，不必再靠 status + 链快照反推（此前构造器把它们丢弃）。
- **门控等待有界**：加入在途恢复的等待有上限，超时返回 `recovery-timeout`。
  （上限取值与收益表述在 0.9.4 修正：发起恢复的那个请求直接 `await recover()`，不受该上限约束，
  因此不能据此认为 `refreshStatuses` 的 in-flight 问题已解决。）
- **存储降级自洽**：凭证读写改为**内存优先**，backing 写失败（隐私模式 / 只读沙箱 / 配额）也能立刻读到。
  此前「可读不可写」的 localStorage 会让每个业务请求都被当成无凭证 → 反复触发恢复直到锁定。
- **界面接管复位**：加载页与错误页渲染时复位门控标志，避免之后一次状态回调把挑战页整壳盖回去
  （会连已挂载的组件容器一起销毁）。
- **测试**：`test-turnstile` 21 → **23 项**，新增「响应非合法 JSON」「网络层抛错」两条此前零覆盖的分支
  （真实 `fetch` / `parseFailed` 路径），并为并发 403 用例补「三个请求各重放一次并各自成功」断言。

## 0.9.2 — 2026-09-15（CF-Server-Monitor 移植版）

本轮为批次 6：Turnstile 凭证链（站点开启全局人机验证时主题仍可用）。

- **启动门控**：应用挂载前先取 `/api/config`（裸请求，仅两个校验头都不带时豁免），据此判定站点开关；
  全局开启且未验证时先完成挑战拿到凭证再进应用。旧版「整站不可用 + 面板只读」的闸门已删除。
- **凭证链**：`X-Turnstile-Token` 换一次性凭证，之后由统一请求层给 `/api/*` 注入 `X-Turnstile-Verified`；
  `/api/ws` 与 `/admin/api` 保持豁免；只开登录验证的站点不挑战。
- **自动恢复**：只对「403 + `Turnstile verification failed`」恢复；每个业务请求最多重放 1 次、一次恢复过程内
  自动尝试最多 2 次，且只有拿到数据性成功响应才复位计数；带新凭证仍被拒则终止并锁定，界面转为可重试
  挑战页（**不自动整页刷新**）。
- **不碰 JWT**：403 一律不清 JWT，与既有 401 语义分离。
- 资源版本号升到 0.9.2：CFSM 对主题资源用 `immutable` 长缓存，不升版本则老访客继续吃旧 `app.js`、本批不生效。
- 注：0.8.0 / 0.9.0 / 0.9.1（批次 5 系列）当时未记条目。

## 0.7.3 — 2026-09-14（CF-Server-Monitor 移植版）

本轮为审查后的补齐（4b）：实时链路协议层。

- **报告级字段「过期转未知」已接线**：磁盘/磁盘容量、三网延迟与丢包、进程/连接数只在周期性报告样本里
  出现；超过 `max(3 × report_interval, 5 分钟)` 未再出现即按不可用展示（卡片磁盘与延迟胶囊、抽屉统计、
  线路延迟面板、系统信息块均显示 `—`，且不再基于旧值产生告警与平均磁盘）。CPU/内存/网速来自高频样本，
  不受影响。快照数据没有报告时间戳 → 视为新鲜，不会误标。
- **刷新函数返回结构化结果**：`refreshStatuses()` → `{ ok, error, stale, reason }`；降级轮询与手动刷新
  不再依赖共享的 `state.connected` 判断成败（该字段仍用于界面提示）。
- **generation 覆盖 REST 结果**：在途的整表/单机请求返回时若代已切换（可见性变化、深链↔列表、目标切换），
  结果按代丢弃，不再覆盖新状态。
- **WS 失败原因探测**：握手失败在浏览器里读不到 HTTP 状态码，改为触发一次单机 REST 探测分类——
  403 给出「被站点拒绝」提示，401 交由 api 层处理（清令牌 + 提示登录），探测成功则静默降级。
  每代一次 + 30 秒最短间隔，避免可见性事件连续换代时的探测风暴。
- **按需 ping 保活**：进入 live 后若 60 秒内没有收到任何服务端消息才发一次 `{type:"ping"}`；收到任何消息
  （含 `pong`）都会重置计时。服务端按约 5 秒窗口推送，正常路径不会触发。
- 测试：`test-modules` 19 项（新增过期判定接入点、结构化刷新、generation 覆盖、探测去重断言）、
  `test-realtime` 25 项（新增按需心跳两条）。

## 0.7.2 — 2026-09-14（CF-Server-Monitor 移植版）

本轮为审查后的补齐（4a）：小修与文档，不含实时链路协议重构。

- **WebSocket 凭据不再进 URL**：改为只在 socket 的 `host` 与页面不同时才附 `token`（恢复既定方案，
  与官方 `API.md` 示例一致）。依据上游源码：公开站点（`is_public === 'true'`）的 `/api/ws` 完全不校验身份；
  私有站点同源握手由浏览器自动携带 `cfsm_auth` Cookie（`HttpOnly` 只阻止脚本读取，不阻止浏览器发送）。
  已知边界：私有站点 Cookie 缺失/过期而 localStorage JWT 仍有效时，WS 未授权 → 降级轮询，功能不中断。
  据此同步修正了测试中"同源也带 token"的断言。
- **实时通道状态文案**：页头不再显示静态描述，改为随通道状态切换——`实时推送 · 约 5 秒合并窗口` /
  `正在建立实时连接…` / `已降级为按间隔刷新`（三语）。`fatal` 与重连分支补上重渲染，文案即时跟随。
- **抽屉历史加载失败有独立提示**：此前 `GET /api/history/all` 失败会静默回落到空数组，现在在抽屉内
  给出提示并说明图表使用本地采样（不再只是 404/401/403 有提示）。
- 「空窗口节点跳过」的安全余量由固定 1 小时改为 `max(1 小时, 2 × report_interval)`，与 v4 §A2 判据一致
  （该优化仍默认关闭）。
- Turnstile 口径修正：站点开启**全局** Turnstile 时是**整套主题不可用**（CFSM 要求所有 `/api/*` 携带
  `X-Turnstile-Token`），原文案"面板保持只读"会误导；设置面板提示与 README 同步改正。
- README：补「非目标」声明（多 `apiBase`、跨域静态托管），补「空窗口跳过」的开关状态与完整启用判据，
  并修正流量视图仍写"逐台 24 小时"的过期描述。

## 0.7.1 — 2026-09-14（CF-Server-Monitor 移植版）

- **深链直达单机不再加载整表**：打开 `#/server/<id>` 时只请求 `/api/config` + `/api/server?id=`，
  并建立 `subscribe=<serverId>` 单机 WebSocket 订阅；**全程不调用 `/api/servers`**（那一次约 230 KB）。
- 关闭抽屉（或回首页）才停单机连接、取一次整表快照并重算 ids、切回 `subscribe=all` 连接。
  整表快照失败时**保持单机作用域**并提示，绝不用单台数据渲染首页。
- 新增集中渲染闸门 `dataScope`（`none` / `list` / `detail`）：`detail` 作用域下 `aggregateMetrics`、
  `buildAlerts`、`buildTrafficSeries`、节点过滤与视图渲染**调用次数为 0**（列表未加载，
  任何"总数/平均"都会是假数据）。`?debug=1` 时可用 `window.__cfsmRenderCounters` 验收。
- 单机路径的降级通道同样是单机的：WS 不可用时轮询 `GET /api/server?id=`（约 1 KB），
  不会退化成整表快照；手动刷新、可见性恢复、断线补数据都按作用域分发。
- 详情态字段来源明确：三网窗口（`ping`/`loss` 数组）只有 `/api/servers` 返回，`/api/server` 不返回，
  因此该路径只显示单值 ping/loss，拿到列表数据后才恢复迷你柱状窗口。
- 404（不存在/不可见）、401（登录失效）、403（Turnstile 或来源限制）与网络失败各有独立提示；
  路由中的 id 先做与订阅同源的字符集/长度校验，非法则提示且**不发请求**。
- 修正单机订阅的协议形态：连接建立后发送**不带 `scope`** 的 `subscribe` 消息
  （服务端在消息缺 `scope` 时沿用 URL 的 `subscribe`）。显式发 `scope:"all"` 且 ids 为空时，
  服务端 `_shouldDeliver` 会把该连接判定为不推送任何服务器。
- 测试：`test-realtime.mjs` 增至 23 项（新增单机订阅形态断言）、`test-modules.mjs` 增至 15 项
  （新增 `/api/server` 单机映射、渲染闸门与 `getServers` 调用点断言）。

## 0.7.0 — 2026-09-14（CF-Server-Monitor 移植版）

- **实时链路改为 WebSocket 推送**：新增 `assets/cfsm-realtime.js`（URL 构造、消息解析、ids 校验、
  增量合并、连接状态机）。首页不再依赖 30 秒轮询 `/api/servers`：先取一次快照，再经 `/api/ws`
  以 `{type:"subscribe",scope:"all",ids}` 订阅，服务端按约 5 秒合并窗口推送增量。
- 编排层单一 owner：WS 进入 live 即停轮询；异常关闭按 1s→30s 退避重连，期间以轮询兜底；
  关闭码 1008（非法 scope/ids）为终止态，之后长期以轮询运行、不再重连。
- 增量合并只更新样本确实提供的字段：报告级字段（三网延迟/丢包、磁盘、启动时间）在样本缺失时
  **保留旧值**，不会因为某个样本没有这些字段就被清除。
- 可见性由编排层统一处理（隐藏时关闭 WS 与轮询，恢复可见先补一次快照再重建连接），并移除轮询模块
  自带的 `visibilitychange` 监听以避免双通道；顺带修掉「恢复可见后仍要等 30 秒」的问题。
- 支持 `frontend_ws_timeout_minutes`（0–1440，只累计可见时间）：到期询问是否重连，拒绝后不再自动重连。
- 认证语义修正：401 清除本地令牌并提示重新登录；**403 不再清除令牌**（令牌被拒 ≠ 令牌失效）。
- 三语文案更新（实时推送说明 + 超时提示）。
- 测试：新增 `scripts/test-realtime.mjs`（20 项）；`npm run check` 现覆盖两个测试套件。

## 0.6.3 — 2026-09-14（CF-Server-Monitor 移植版）

- 修正节点排序方向：CFSM 的 `sort_order` 语义是「越小越靠前」（`/api/servers` 按 `sort_order ASC` 返回），
  而移植版沿用了上游 Komari 的 `weight` 降序，方向相反。现在默认排序为升序。
- 流量视图：默认档位由 24 小时改为 **6 小时**，并提供 6h / 24h 显式切换；历史缓存与加载态按档位隔离。
  依据：服务端返回点数固定（`long_history_points`），客户端体积与档位无关，随档位增长的是服务端 D1 的扫描范围。
- 修正 `cfsm-api.js` 中关于 Turnstile 的注释：**全局** Turnstile 覆盖**所有 `/api/*`**
  （bypass 仅 `/api/config` 不带该 Header 时、`/api/ws`、`/admin/api`），不只是写接口。
  本移植版不实现 Turnstile 凭证链，启用全局 Turnstile 的站点上主题不可用。
- 新增 `npm test`（`scripts/test-modules.mjs`）并接入 CI 与 `npm run check`：
  覆盖设置默认值/归一化、字段映射、以及排序方向与流量默认档位的源码级断言。

## 上游版本（Komari-Butterfly）

## 1.5.0 — 2026-09-03

- Reduced mobile scrolling cost by removing large blurred background layers, disabling nonessential off-screen animation, and deferring status-driven DOM refreshes until scrolling becomes idle.
- Lazy-loaded the 2,398-point world land dataset only when the interactive globe is opened, keeping it out of the initial dashboard request and computation path.
- Reworked globe rendering with cached projection trigonometry, grid and route geometry, a lower mobile pixel ratio, and automatic idle-frame suspension after camera motion settles.
- Paused polling and live-clock work while the page is hidden, resumed with an immediate refresh, and prevented overlapping status requests on slow connections.
- Restored the complete bottom navigation on short landscape phones and removed the text caption from the raised globe action.
- Improved mobile contrast and replaced nested interactive node cards with a dedicated accessible card action; Lighthouse accessibility and agent navigation audits now pass at 100.

## 1.4.0 — 2026-09-02

- Rebuilt the traffic view around a responsive dual-axis chart inspired by Komari's traffic dashboard.
- Added recent aggregate upload and download rate lines with cumulative traffic overlays, adaptive axes, and localized time labels.
- Added a traffic-usage Top 5 ranking with per-node upload/download totals, peak rates, timestamps, and proportional usage bars.
- Traffic history now loads on demand with bounded concurrency and falls back to live samples while records are loading or unavailable.
- Added direct preview links through `?view=traffic` and refined the traffic layout for desktop and mobile screens.

## 1.3.0 — 2026-09-02

- Added direction-aware bottom navigation: it moves out of the content area while scrolling down, returns on upward motion or at page boundaries, and stays hidden behind search, sidebar, globe, node-detail overlays, and the on-screen keyboard.
- Shortened mobile search and sort labels so 320–390 px screens no longer clip essential controls.
- Reduced phone node-card height while preserving CPU, memory, disk, latency, traffic, uptime, and favorite controls.
- Added a drag-to-dismiss node sheet with velocity and distance thresholds, backdrop feedback, and tap-to-close compatibility.
- Reworked the phone node sheet into a four-column metric strip, two-column hardware grid, and shorter charts for faster scanning.
- Added a dedicated short-portrait layout that removes the secondary latency panel, compresses KPI and hero surfaces, reduces bottom-navigation height, and exposes globe fleet data sooner.
- Ultra-short portrait screens now omit only the large network hero, keep the KPI ribbon, and place filters plus the first node above the floating navigation.
- Added momentum-based globe rotation after touch or pointer dragging while preserving reduced-motion behavior and precise region focus.
- Removed a duplicated country-centroid table from the globe bundle; region coordinates now have one exact source in `region-data.js`.

## 1.2.0 — 2026-09-02

- Rebuilt the phone command bar with compact page context, an expandable search field, safe-area spacing, and larger touch targets.
- Mobile search now opens the node workspace immediately, keeps keyboard focus during live filtering, removes the duplicate toolbar field while expanded, and dismisses the keyboard through the Search key.
- Live refreshes preserve search focus and selection, KPI/filter scroll positions, and the current node-sheet reading position instead of jumping the mobile interface back to its start.
- Reworked the mobile overview into a horizontally snapping KPI row, a shorter network hero, compact latency summary tiles, and a first node card visible without a long initial scroll.
- Added sticky node filters, a focused node/favorites layout without unrelated alert cards, four-card overview truncation, and a direct “view all nodes” action.
- Added a five-destination bottom navigation with a raised globe action; it respects device safe areas and hides while the node sheet is open.
- Refined the node detail bottom sheet with a tappable handle, sticky header, touch scrolling, compact charts, and safe-area body padding.
- Reworked the globe for phones with a full-screen layout, horizontal snap region cards, automatic selected-region centering, and larger node rows.
- Reduced globe rendering cost on phones and short landscape screens by capping frame rate and pixel ratio, thinning the bundled land point cloud, and limiting animated arcs.
- Added a dedicated short-landscape layout for KPI cards, hero/latency panels, node grids, and the two-pane globe.
- Added mobile viewport metadata for display cutouts, standalone mode, keyboard resizing, and disabled telephone-number detection.

## 1.1.0 — 2026-09-02

- Reworked dark mode with tonal navy surfaces, muted off-white text, darker hero land tones, quieter highlights, and consistently dark controls and node cards.
- Removed the Top Performance panel and the redundant performance summary card from the overview.
- Added an interactive geographic globe opened from the Global Network hero.
- Expanded the desktop node workspace to four columns and moved alerts into a compact row below it.
- Added exact ISO alpha-2 and leading flag-emoji region parsing, country-level node aggregation, illuminated online/mixed/offline markers, region focus, drag rotation, node selection, and reduced-motion support.
- Added bundled country centroids and a local land point cloud; the globe loads no external scripts, styles, maps, or location services.
- The globe now opens already focused on the best-connected online region, while every mapped region remains illuminated and selectable.

## 1.0.0 — 2026-09-01

- Initial Komari Butterfly release.
- Added WinUI 3 and Mica-inspired light and dark appearances.
- Added responsive overview, node, region, traffic, favorites, and about views.
- Added node detail history drawer and exact Komari JSON-RPC 2.0 integration.
- Added managed theme configuration, multilingual copy, local demo preview, validation, packaging, and release workflows.
