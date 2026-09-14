# Changelog

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
