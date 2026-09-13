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
| 实时刷新 | 轮询 | 默认 **30 秒**轮询（设置内 15–300），页面不可见自动暂停，失败按 30→60→120 秒退避。不引入 WebSocket。 |
| 设置 | `komari-theme.json` 清单 | 主题内设置面板 → `POST /api/theme_options`，键统一 `butterfly_` 前缀，写前必读-改-写 |
| 深链接 | 无 | `#/` 与 `#/server/<id>`（抽屉 + 浏览器前进后退） |
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
- 站点开启全局 Turnstile → 面板保持只读，因为本移植版不实现 `X-Turnstile-Token` / `X-Turnstile-Verified`。
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
- 流量视图逐台取 24 小时历史（12 台约 12 次请求、数百 KB），并节流为 5 分钟一次。
- 上游的 `TW → CN` 旗帜特例未复刻。

## 许可

MIT，与上游一致。上游作者 [TomorrowX6](https://github.com/TomorrowX6)，移植与维护
[LucaLin233](https://github.com/LucaLin233)。
