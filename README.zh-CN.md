# Butterfly for CF-Server-Monitor（移植版）

参考 WinUI 3 与 Mica 材质设计的服务器看板，从
[TomorrowX6/Komari-Butterfly](https://github.com/TomorrowX6/Komari-Butterfly)（MIT）移植到
[CF-Server-Monitor](https://github.com/huilang-me/CF-Server-Monitor) 的**自用第三方主题**。
不发布到主题商店，只维护一个实例。

简体中文 · [English](README.md)

## 与上游的差异

| 方面 | 上游（Komari） | 本移植版（CF-Server-Monitor） |
|---|---|---|
| 数据层 | Komari JSON-RPC 2.0（`/api/rpc2`），9 处调用点 | REST：`GET /api/config`、`/api/servers`、`/api/server?id=`、`/api/history/all?id=&hours=`（`src/assets/cfsm-api.js`） |
| 字段映射 | 原生 Komari 模型 | `src/assets/cfsm-map.js`（单位、流量方向、当月/全时累计、线路集合、剩余流量） |
| 实时刷新 | 轮询 | 一次 `/api/servers` 快照 + `/api/ws` WebSocket 增量推送（约 5 秒合并窗口）；WS 不可用/断开期间按 30→60→120 秒轮询兜底（设置内 15–300），页面不可见即断开连接，关闭码 1008 为终止态并长期降级轮询。 |
| 设置 | `komari-theme.json` 清单 | 主题内设置面板 → `POST /api/theme_options`，键统一 `butterfly_` 前缀，写前必读-改-写 |
| 深链接 | 无 | `#/` 与 `#/server/<id>`（抽屉 + 浏览器前进后退）。深链直达时只请求 `/api/config` + `/api/server?id=` 并建立 `subscribe=<id>` 单机订阅，**不加载整表**；关闭抽屉才切回列表与 `subscribe=all`。 |
| 旗帜 | 打包 272 个 SVG | 用 CFSM 同源 `/flags/<小写码>.svg` |
| 市场打包 | `komari-theme.json`、`preview.png`、发布 ZIP | 已删除 |
| 增补块 | 无 | IPv4/IPv6 徽标、剩余流量（含降级）、到期天数、价格与计费周期、全时出/入站累计 |

流量方向是刻意写死的，不要"顺手改成看起来更自然的样子"：主题里的 `net_in` 是**上传**、`net_out` 是**下载**，
而 CFSM 的 `net_in_speed` 是下载、`net_out_speed` 是上传。当月累计用 `net_tx_monthly`（上行）/`net_rx_monthly`（下行），
全时累计用 `net_tx`/`net_rx`。

## 部署

`theme_url` 必须指向**固定 commit** 并带上 `dist/` 子路径：

```text
https://github.com/LucaLin233/cfsm-theme-butterfly/tree/<commit-sha>/dist
```

- 不要指向分支：往分支推送会**直接改掉线上**，中间没有预览。回滚就是把 `theme_url` 换成上一个阶段 tag 的 commit。
- `theme_url` 存在 `site_options`，约 120 秒 isolate 缓存，切换最坏滞后两分钟。
- 主题 `index.html` 拉取失败时站点返回 `502 Theme index.html is unavailable`，**不会自动回落**内置主题；
  救火路径是经 `/admin` 改 `theme_url`。

### 资源版本号（关键）

CF-Server-Monitor 对主题静态资源下发 `Cache-Control: public, max-age=31536000, immutable`，
所以所有资源引用都带版本查询串——`/assets/app.js?v=<version>`，模块间的 import 也一样。
**每次改动都要递增 `package.json` 的 `version`**，否则查询串不变、浏览器继续用缓存副本；
回滚到旧 commit 时"看起来没生效"也是这个原因。

## 主题设置

顶栏齿轮打开主题自带面板（16 项，分「外观 / 面板 / 文案与页脚」，标签 zh-CN/en/ja 三语）。

- 保存会通过 `POST /api/theme_options`（`{"theme_options": {…}}`）写入 `appearance_options.theme_options`。
  该接口**整对象替换**且**始终要求 `Authorization: Bearer <jwt>`**，所以面板在写之前会立即重读 `/api/config`，
  只合并自己的 `butterfly_*` 键；属于其它主题（例如 LuminaPlus）的键会被完整保留。
- 未登录 → 面板只读，请先到 `/admin#admin` 登录。
- 站点开启全局 Turnstile → **主题会自己完成验证**：启动时先取 `/api/config`（仅当两个 Turnstile 头**都不带**时才豁免），
  用返回的 `turnstile_site_key` 渲染 Cloudflare 组件，把一次性 token 换成 `turnstile_verified` 凭证；
  之后由统一请求层给所有 `/api/*` 带上 `X-Turnstile-Verified`。`/api/ws` 与 `/admin/api` 仍豁免，
  只在登录流程启用 Turnstile 的站点**无需验证**。
  凭证过期会走**一次恢复过程**（最多自动尝试 2 次、每个请求最多重放 1 次），且只有拿到数据性成功响应才算恢复；
  仍失败则显示可重试界面——**不会白屏，也不会自动整页刷新**。
- 编辑只改本地草稿，点「保存设置」才写站。

## 开发

```bash
npm run check    # 构建到 dist/ 并做结构校验
npm run build    # src/ → dist/，注入版本号
```

- Node ≥ 20，零运行时依赖。
- `dist/` 是提交进仓库的，也是站点实际加载的内容；CI 会在 `dist/` 与 `src/` 不一致时失败。
- `scripts/validate.mjs` 断言部署契约：产物只有 `dist/index.html` + `dist/assets/*`、每个模块 import 都带
  `?v=`、无残留 `__THEME_VERSION__`、无远程脚本、无内置旗帜，另含移动端布局契约 token 与"模块真的导出了
  `app.js` 引入的名字"。

## 已知限制

- `ping_bd`（BGP）在多数机器上是 1–2 ms，对家宽到美日不是合理的 RTT。BGP 仍在线路延迟面板显示，
  但**不参与**"最佳延迟"的计算（卡片胶囊、延迟分布、区域均值、抽屉统计、按延迟排序）。
- CFSM 无数据源的字段：虚拟化类型、IPv4/IPv6 地址文本、显卡（本实例全空）、CPU 温度、Komari 的 `public_remark`。
  这些行直接隐藏，不显示成"未知"。
- 流量视图逐台默认取 **6 小时**历史（面板内可切 24 小时），按档位缓存并节流为 5 分钟一次。
- 实时链路 = 一次 `/api/servers` 快照 + `/api/ws` 增量推送。凭据只在 WebSocket 的 **host 与页面不同**时
  才进 URL；同源连接依赖浏览器自动携带的 `cfsm_auth` Cookie。私有站点若 Cookie 缺失/过期而 localStorage
  的 JWT 仍有效，WS 会因未授权失败并降级为按间隔轮询（功能不中断）。
- **非目标**：不支持多个 `apiBase`、不支持跨域静态托管（规范允许该能力，本主题按同源单实例部署，明确不实现）。
- 「空窗口节点跳过」优化默认**关闭**（`TRAFFIC_SKIP_STALE = false`）。启用需同时满足：状态时间戳为有限数、
  本地状态在 10 分钟内更新过、节点非在线、最后上报时间 + `max(1 小时, 2 × 上报间隔)` 仍早于窗口起点；
  且启用前必须对一台被判"可跳过"的节点手工请求同窗口 `/api/history/all` 确认返回空数组（随机抽 3 台全空）。
- 上游的 `TW → CN` 旗帜特例未复刻。

## 许可

MIT，与上游一致。上游作者 [TomorrowX6](https://github.com/TomorrowX6)，移植与维护
[LucaLin233](https://github.com/LucaLin233)。
