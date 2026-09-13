import { REGION_COORDS, REGION_NAMES } from "./region-data.js?v=__THEME_VERSION__";
import { createCfsmApi, createPoller, hasStoredToken, isTurnstileBlocking } from "./cfsm-api.js?v=__THEME_VERSION__";
import { DEFAULT_SETTINGS, POLL_INTERVAL_MAX, POLL_INTERVAL_MIN, SECTION_LABELS, THEME_SETTINGS, localizedValue, mergeThemeSettings, normalizeSettingValue, readThemeSettings, settingLabel, settingsMeta } from "./theme-config.js?v=__THEME_VERSION__";
import { mapHistoryRows, mapServers } from "./cfsm-map.js?v=__THEME_VERSION__";

const DEG_TO_RAD = Math.PI / 180;
let worldLandVectorsPromise = null;

function loadWorldLandVectors() {
  if (!worldLandVectorsPromise) {
    worldLandVectorsPromise = import("./world-data.js?v=__THEME_VERSION__")
      .then(({ WORLD_LAND_POINTS }) => Object.freeze(WORLD_LAND_POINTS.map(([longitude, latitude]) => {
        const lat = latitude * DEG_TO_RAD;
        const lng = longitude * DEG_TO_RAD;
        const cosLat = Math.cos(lat);
        return { x: cosLat * Math.sin(lng), y: Math.sin(lat), z: cosLat * Math.cos(lng) };
      })))
      .catch(error => {
        worldLandVectorsPromise = null;
        throw error;
      });
  }
  return worldLandVectorsPromise;
}

const THEME_VERSION = "__THEME_VERSION__";
// 移植版仓库；上游原主题为 TomorrowX6/Komari-Butterfly（MIT，署名见 README）。
const THEME_REPOSITORY = "https://github.com/LucaLin233/cfsm-theme-butterfly";
const MOBILE_LAYOUT_QUERY = "(max-width: 720px), (max-width: 900px) and (orientation: landscape) and (max-height: 520px)";
const MOBILE_GLOBE_QUERY = "(max-width: 680px), (max-width: 900px) and (orientation: landscape) and (max-height: 520px)";
const MOBILE_STATUS_RENDER_IDLE_MS = 180;
// 流量视图与累计曲线取 24 小时；`/api/history/all` 只接受离散档位，由 cfsm-api 收敛。
const TRAFFIC_HISTORY_HOURS = 24;
// 深链接路由：#/ 与 #/server/<id>（管理入口仍是站点自身的 /admin#admin）
const HASH_SERVER_PREFIX = "#/server/";
// 文字缩放档位（作用于 CSS 变量 --text-scale，见 styles.css 末尾）
const TEXT_SCALE_FACTORS = Object.freeze({ small: 0.92, normal: 1, large: 1.12, xlarge: 1.25, xxlarge: 1.4 });

// 默认值集中在 theme-config.js（与原 komari-theme.json 的 16 项设置逐项对应）。
// 两处按移植决策改了默认值：default_sort 由 Komari 的 weight 改为 CFSM 的 sort_order，
// poll_interval 由 5 秒改为 30 秒（范围 15–300，页面不可见时暂停轮询）。
const DEFAULT_CONFIG = Object.freeze({ ...DEFAULT_SETTINGS });

const STORAGE = Object.freeze({
  theme: "cfsm.butterfly.theme",
  favorites: "cfsm.butterfly.favorites",
  sidebar: "cfsm.butterfly.sidebar",
  cardMode: "cfsm.butterfly.cardMode",
});

const STRINGS = {
  "zh-CN": {
    overview: "首页",
    nodes: "全部节点",
    regions: "区域",
    traffic: "流量",
    favorites: "收藏",
    about: "关于",
    monitor: "监控中心",
    dashboard: "运行概览",
    dashboardSubtitle: "节点、性能与网络状态",
    searchPlaceholder: "搜索节点、区域或标签…",
    searchNodes: "搜索节点…",
    searchCompact: "搜索",
    mobileSearch: "搜索",
    closeSearch: "关闭搜索",
    globeNav: "地球",
    viewAllNodes: "查看全部 {count} 个节点",
    admin: "管理后台",
    signIn: "登录",
    liveStatus: "实时状态",
    updatedNow: "刚刚更新",
    updatedAgo: "{value} 秒前更新",
    onlineNodes: "在线节点",
    regionsMetric: "区域",
    totalTraffic: "累计流量",
    averageLatency: "平均延迟",
    networkSpeed: "网络速度",
    upload: "上传",
    download: "下载",
    operational: "系统运行正常",
    degraded: "{count} 个节点需要关注",
    viewNodes: "查看全球节点",
    globeTitle: "全球节点分布",
    globeSubtitle: "按国家或地区聚合节点状态，点亮在线位置。",
    globeHint: "拖动旋转 · 点击亮点选择区域",
    globeMappedRegions: "已定位 {count} 个区域",
    globeOnlineSummary: "{online} / {total} 在线",
    globeSelectRegion: "选择一个区域查看节点",
    globeNoRegions: "当前节点没有可用于地球定位的两位地区代码或旗帜标识。",
    globeOpenNode: "打开节点",
    globeBackToNodes: "查看全部节点",
    latencyDistribution: "延迟分布",
    threeNetLatency: "线路延迟",
    lossRate: "丢包",
    nodeNotFound: "未找到该机器",
    nodeNotFoundCopy: "该机器可能已被删除、设为隐藏，或链接有误。",
    themeSettings: "主题设置",
    settingsDraftHint: "改动先在本地预览，点「保存设置」后写入站点。",
    settingsSignInHint: "未登录，只能查看。请先到 /admin#admin 登录后再保存。",
    settingsTurnstileHint: "站点已开启 Turnstile，本移植版暂不支持保存设置，仅可查看。",
    settingsSave: "保存设置",
    settingsSaving: "保存中…",
    settingsSaved: "设置已保存",
    settingsSavedCopy: "已写入站点 theme_options，其它主题的设置保持不变。",
    settingsSaveFailed: "保存失败",
    settingsReadFailed: "读取现有设置失败，已取消写入。",
    settingsReset: "恢复默认",
    languageAuto: "跟随站点",
    textSmall: "较小",
    textNormal: "标准",
    textLarge: "较大",
    textXLarge: "更大",
    textXxLarge: "极大",
    remainingTraffic: "剩余流量",
    usedThisMonth: "当月已用",
    billing: "计费与流量",
    trafficOut: "出站累计（全时）",
    trafficIn: "入站累计（全时）",
    priceLabel: "价格",
    expiresAt: "到期",
    expiresIn: "{days} 天后到期",
    expired: "已过期",
    autoRenewal: "自动续费",
    resetDay: "重置日",
    monthReset: "每月 {day} 日重置",
    yes: "是",
    no: "否",
    excellent: "优秀",
    good: "良好",
    fair: "一般",
    poor: "较差",
    bad: "很差",
    all: "全部",
    online: "在线",
    offline: "离线",
    sortBy: "排序：",
    sortWeight: "权重",
    sortName: "名称",
    sortLatency: "延迟",
    sortTraffic: "流量",
    recentAlerts: "近期提醒",
    viewAll: "查看全部",
    noAlerts: "当前没有需要处理的提醒",
    realtimeMonitoring: "实时监控",
    realtimeMonitoringCopy: "按设定间隔自动刷新",
    globalCoverage: "全球覆盖",
    globalCoverageCopy: "{regions} 个区域 · {nodes} 个节点",
    openSource: "开放源码",
    openSourceCopy: "上游原主题：TomorrowX6/Komari-Butterfly（MIT）",
    cpu: "CPU",
    memory: "内存",
    disk: "磁盘",
    uptime: "运行时间",
    speed: "速率",
    noLatency: "—",
    noNodesTitle: "没有符合条件的节点",
    noNodesCopy: "调整筛选条件或搜索内容后重试。",
    clearFilters: "清除筛选",
    nodeDetails: "节点详情",
    systemInformation: "系统信息",
    recentPerformance: "近期性能",
    networkActivity: "网络活动",
    load: "负载",
    process: "进程",
    connections: "连接",
    os: "操作系统",
    kernel: "内核",
    architecture: "架构",
    virtualization: "虚拟化",
    cpuName: "处理器",
    cpuCores: "CPU 核心",
    gpu: "显卡",
    ipv4: "IPv4",
    ipv6: "IPv6",
    group: "分组",
    tags: "标签",
    close: "关闭",
    loadingDetails: "正在读取节点记录…",
    regionSummary: "区域概览",
    regionBack: "返回全部区域",
    regionOpen: "查看 {region} 节点",
    regionNodesTitle: "{region} 节点",
    nodesCount: "节点",
    avgCpu: "平均 CPU",
    avgMemory: "平均内存",
    avgLatencyShort: "平均延迟",
    trafficOverview: "实时网络流量",
    trafficCopy: "根据各在线节点的当前上传与下载速率汇总。",
    recent24hTraffic: "最近24小时流量",
    trafficWindow: "汇总各节点近期网络记录",
    cumulativeUpload: "累计上传",
    cumulativeDownload: "累计下载",
    trafficTop5: "流量消耗 Top 5",
    trafficRankCopy: "按节点累计上传与下载总量排序。",
    peakAt: "峰值 {rate} · {time}",
    todayAt: "今天 {time}",
    yesterdayAt: "昨天 {time}",
    trafficHistoryLoading: "正在汇总节点流量记录…",
    trafficNoHistory: "暂无流量记录",
    aboutDescription: "Butterfly 把 WinUI 3 的克制层次与 Mica 质感，结合 CF-Server-Monitor 的实时数据，强调清晰、快速与响应式体验。",
    designLanguage: "WinUI 设计语言",
    designLanguageCopy: "使用层级表面、柔和圆角、清晰状态与精确间距构建信息密集型仪表盘。",
    nativeIntegration: "原生 CF-Server-Monitor 集成",
    nativeIntegrationCopy: "通过站点 REST 接口（/api/config、/api/servers、/api/history/all）读取节点、状态、历史与站点设置。",
    responsive: "响应式布局",
    responsiveCopy: "桌面端保留高信息密度，平板与手机自动切换为单栏和底部导航。",
    themeVersion: "主题版本",
    komariVersion: "站点版本",
    sourceCode: "源代码",
    connected: "已连接",
    disconnected: "连接中断",
    demoMode: "演示数据",
    retry: "重试",
    loadFailedTitle: "无法读取站点数据",
    loadFailedCopy: "请确认站点的 /api/config 与 /api/servers 可访问。",
    favoriteAdded: "已加入收藏",
    favoriteRemoved: "已移出收藏",
    appearanceChanged: "外观已切换",
    maintenance: "节点离线",
    highCpu: "CPU 使用率较高：{value}%",
    highMemory: "内存使用率较高：{value}%",
    highDisk: "磁盘使用率较高：{value}%",
    packetLoss: "检测到丢包：{value}%",
    justNow: "刚刚",
    minutesAgo: "{value} 分钟前",
    hoursAgo: "{value} 小时前",
    unknown: "未知",
    light: "浅色",
    dark: "深色",
    system: "跟随系统",
    expandSidebar: "展开侧栏",
    collapseSidebar: "收起侧栏",
    gridView: "网格视图",
    listView: "列表视图",
    themeToggle: "切换明暗模式",
    footer: "Powered by CF-Server-Monitor {komari} · Butterfly {theme}",
    poweredBy: "CF-Server-Monitor",
    refresh: "刷新数据",
    offlineData: "数据连接暂时不可用",
  },
  en: {
    overview: "Home",
    nodes: "All Nodes",
    regions: "Regions",
    traffic: "Traffic",
    favorites: "Favorites",
    about: "About",
    monitor: "Monitor",
    dashboard: "Operations overview",
    dashboardSubtitle: "Nodes, performance, and network health",
    searchPlaceholder: "Search nodes, regions, or tags…",
    searchNodes: "Search nodes…",
    searchCompact: "Search",
    mobileSearch: "Search",
    closeSearch: "Close search",
    globeNav: "Globe",
    viewAllNodes: "View all {count} nodes",
    admin: "Admin",
    signIn: "Sign in",
    liveStatus: "Live status",
    updatedNow: "Updated just now",
    updatedAgo: "Updated {value}s ago",
    onlineNodes: "Online nodes",
    regionsMetric: "Regions",
    totalTraffic: "Total traffic",
    averageLatency: "Avg. latency",
    networkSpeed: "Network speed",
    upload: "Upload",
    download: "Download",
    operational: "All systems operational",
    degraded: "{count} nodes need attention",
    viewNodes: "View global nodes",
    globeTitle: "Global node map",
    globeSubtitle: "Nodes are grouped by country or region, with online locations illuminated.",
    globeHint: "Drag to rotate · Select a light to inspect a region",
    globeMappedRegions: "{count} mapped regions",
    globeOnlineSummary: "{online} / {total} online",
    globeSelectRegion: "Select a region to inspect its nodes",
    globeNoRegions: "No node has a mappable two-letter region code or leading flag emoji.",
    globeOpenNode: "Open node",
    globeBackToNodes: "View all nodes",
    latencyDistribution: "Latency distribution",
    threeNetLatency: "Line latency",
    lossRate: "Loss",
    nodeNotFound: "Server not found",
    nodeNotFoundCopy: "It may have been deleted, hidden, or the link is wrong.",
    themeSettings: "Theme settings",
    settingsDraftHint: "Changes preview locally; click “Save settings” to write them to the site.",
    settingsSignInHint: "Read-only: you are not signed in. Sign in at /admin#admin to save.",
    settingsTurnstileHint: "Turnstile is enabled on this site, so this port cannot save settings yet.",
    settingsSave: "Save settings",
    settingsSaving: "Saving…",
    settingsSaved: "Settings saved",
    settingsSavedCopy: "Written to the site theme_options; other themes' settings are untouched.",
    settingsSaveFailed: "Save failed",
    settingsReadFailed: "Could not read the current settings, so nothing was written.",
    settingsReset: "Reset to defaults",
    languageAuto: "Follow site",
    textSmall: "Smaller",
    textNormal: "Standard",
    textLarge: "Larger",
    textXLarge: "Largest",
    textXxLarge: "Extra large",
    remainingTraffic: "Remaining",
    usedThisMonth: "Used this month",
    billing: "Billing & traffic",
    trafficOut: "Outbound (all time)",
    trafficIn: "Inbound (all time)",
    priceLabel: "Price",
    expiresAt: "Expires",
    expiresIn: "in {days} d",
    expired: "expired",
    autoRenewal: "Auto renewal",
    resetDay: "Reset day",
    monthReset: "resets on day {day}",
    yes: "Yes",
    no: "No",
    excellent: "Excellent",
    good: "Good",
    fair: "Fair",
    poor: "Poor",
    bad: "Bad",
    all: "All",
    online: "Online",
    offline: "Offline",
    sortBy: "Sort by: ",
    sortWeight: "Weight",
    sortName: "Name",
    sortLatency: "Latency",
    sortTraffic: "Traffic",
    recentAlerts: "Recent alerts",
    viewAll: "View all",
    noAlerts: "No alerts require attention",
    realtimeMonitoring: "Real-time monitoring",
    realtimeMonitoringCopy: "Refreshes at the configured interval",
    globalCoverage: "Global coverage",
    globalCoverageCopy: "{regions} regions · {nodes} nodes",
    openSource: "Open source",
    openSourceCopy: "Upstream theme: TomorrowX6/Komari-Butterfly (MIT)",
    cpu: "CPU",
    memory: "Memory",
    disk: "Disk",
    uptime: "Uptime",
    speed: "Speed",
    noLatency: "—",
    noNodesTitle: "No nodes match your filters",
    noNodesCopy: "Adjust the filter or search query and try again.",
    clearFilters: "Clear filters",
    nodeDetails: "Node details",
    systemInformation: "System information",
    recentPerformance: "Recent performance",
    networkActivity: "Network activity",
    load: "Load",
    process: "Processes",
    connections: "Connections",
    os: "Operating system",
    kernel: "Kernel",
    architecture: "Architecture",
    virtualization: "Virtualization",
    cpuName: "Processor",
    cpuCores: "CPU cores",
    gpu: "GPU",
    ipv4: "IPv4",
    ipv6: "IPv6",
    group: "Group",
    tags: "Tags",
    close: "Close",
    loadingDetails: "Loading node records…",
    regionSummary: "Region summary",
    regionBack: "Back to all regions",
    regionOpen: "View nodes in {region}",
    regionNodesTitle: "{region} nodes",
    nodesCount: "Nodes",
    avgCpu: "Avg. CPU",
    avgMemory: "Avg. memory",
    avgLatencyShort: "Avg. latency",
    trafficOverview: "Live network traffic",
    trafficCopy: "Aggregated from the current upload and download rates of online nodes.",
    recent24hTraffic: "Traffic in the last 24 hours",
    trafficWindow: "Recent network records aggregated across nodes",
    cumulativeUpload: "Total upload",
    cumulativeDownload: "Total download",
    trafficTop5: "Traffic usage Top 5",
    trafficRankCopy: "Ranked by each node's cumulative upload and download.",
    peakAt: "Peak {rate} · {time}",
    todayAt: "Today {time}",
    yesterdayAt: "Yesterday {time}",
    trafficHistoryLoading: "Aggregating node traffic records…",
    trafficNoHistory: "No traffic records yet",
    aboutDescription: "Butterfly combines the restrained hierarchy and Mica material of WinUI 3 with CF-Server-Monitor live data for a clear, fast, responsive experience.",
    designLanguage: "WinUI design language",
    designLanguageCopy: "Layered surfaces, soft corners, clear states, and precise spacing for an information-dense dashboard.",
    nativeIntegration: "Native CF-Server-Monitor integration",
    nativeIntegrationCopy: "Reads nodes, live status, history, and site settings through the REST API (/api/config, /api/servers, /api/history/all).",
    responsive: "Responsive layout",
    responsiveCopy: "High information density on desktop, automatic single-column and bottom navigation on smaller screens.",
    themeVersion: "Theme version",
    komariVersion: "Site version",
    sourceCode: "Source code",
    connected: "Connected",
    disconnected: "Disconnected",
    demoMode: "Demo data",
    retry: "Retry",
    loadFailedTitle: "Unable to load site data",
    loadFailedCopy: "Make sure /api/config and /api/servers are reachable.",
    favoriteAdded: "Added to favorites",
    favoriteRemoved: "Removed from favorites",
    appearanceChanged: "Appearance changed",
    maintenance: "Node offline",
    highCpu: "High CPU usage: {value}%",
    highMemory: "High memory usage: {value}%",
    highDisk: "High disk usage: {value}%",
    packetLoss: "Packet loss detected: {value}%",
    justNow: "Just now",
    minutesAgo: "{value}m ago",
    hoursAgo: "{value}h ago",
    unknown: "Unknown",
    light: "Light",
    dark: "Dark",
    system: "System",
    expandSidebar: "Expand sidebar",
    collapseSidebar: "Collapse sidebar",
    gridView: "Grid view",
    listView: "List view",
    themeToggle: "Toggle color scheme",
    footer: "Powered by CF-Server-Monitor {komari} · Butterfly {theme}",
    poweredBy: "CF-Server-Monitor",
    refresh: "Refresh data",
    offlineData: "The data connection is temporarily unavailable",
  },
  ja: {
    overview: "ホーム",
    nodes: "すべてのノード",
    regions: "リージョン",
    traffic: "通信量",
    favorites: "お気に入り",
    about: "概要",
    monitor: "モニター",
    dashboard: "稼働状況",
    dashboardSubtitle: "ノード、性能、ネットワーク状態",
    searchPlaceholder: "ノード、リージョン、タグを検索…",
    searchNodes: "ノードを検索…",
    searchCompact: "検索",
    mobileSearch: "検索",
    closeSearch: "検索を閉じる",
    globeNav: "地球",
    viewAllNodes: "全 {count} ノードを表示",
    admin: "管理画面",
    signIn: "ログイン",
    liveStatus: "ライブ状態",
    updatedNow: "たった今更新",
    updatedAgo: "{value} 秒前に更新",
    onlineNodes: "オンラインノード",
    regionsMetric: "リージョン",
    totalTraffic: "累計通信量",
    averageLatency: "平均遅延",
    networkSpeed: "ネットワーク速度",
    upload: "アップロード",
    download: "ダウンロード",
    operational: "すべて正常稼働中",
    degraded: "{count} ノードに注意が必要です",
    viewNodes: "世界のノードを見る",
    globeTitle: "グローバルノードマップ",
    globeSubtitle: "国・地域ごとにノードを集約し、オンライン位置を点灯します。",
    globeHint: "ドラッグで回転 · 光点を選択",
    globeMappedRegions: "{count} 地域を表示",
    globeOnlineSummary: "{online} / {total} オンライン",
    globeSelectRegion: "地域を選択してノードを確認",
    globeNoRegions: "地球上に配置できる2文字の地域コードまたは先頭の国旗絵文字がありません。",
    globeOpenNode: "ノードを開く",
    globeBackToNodes: "すべてのノードを見る",
    latencyDistribution: "遅延分布",
    threeNetLatency: "回線レイテンシ",
    lossRate: "ロス",
    nodeNotFound: "サーバーが見つかりません",
    nodeNotFoundCopy: "削除されたか、非表示に設定されている可能性があります。",
    themeSettings: "テーマ設定",
    settingsDraftHint: "変更はこの画面でのみ反映されます。「設定を保存」でサイトに書き込みます。",
    settingsSignInHint: "未ログインのため閲覧のみです。保存するには /admin#admin でログインしてください。",
    settingsTurnstileHint: "サイトで Turnstile が有効なため、この移植版では設定を保存できません。",
    settingsSave: "設定を保存",
    settingsSaving: "保存中…",
    settingsSaved: "設定を保存しました",
    settingsSavedCopy: "サイトの theme_options に書き込みました。他のテーマの設定は変更していません。",
    settingsSaveFailed: "保存に失敗しました",
    settingsReadFailed: "現在の設定を読み取れなかったため、書き込みを中止しました。",
    settingsReset: "既定値に戻す",
    languageAuto: "サイトに従う",
    textSmall: "小さめ",
    textNormal: "標準",
    textLarge: "大きめ",
    textXLarge: "最大",
    textXxLarge: "特大",
    remainingTraffic: "残り通信量",
    usedThisMonth: "今月の使用量",
    billing: "課金と通信量",
    trafficOut: "送信累計（全期間）",
    trafficIn: "受信累計（全期間）",
    priceLabel: "価格",
    expiresAt: "期限",
    expiresIn: "{days} 日後",
    expired: "期限切れ",
    autoRenewal: "自動更新",
    resetDay: "リセット日",
    monthReset: "毎月 {day} 日にリセット",
    yes: "はい",
    no: "いいえ",
    excellent: "非常に良い",
    good: "良好",
    fair: "普通",
    poor: "低調",
    bad: "不良",
    all: "すべて",
    online: "オンライン",
    offline: "オフライン",
    sortBy: "並び順：",
    sortWeight: "重み",
    sortName: "名前",
    sortLatency: "遅延",
    sortTraffic: "通信量",
    recentAlerts: "最近の通知",
    viewAll: "すべて表示",
    noAlerts: "対応が必要な通知はありません",
    realtimeMonitoring: "リアルタイム監視",
    realtimeMonitoringCopy: "設定された間隔で自動更新",
    globalCoverage: "グローバルカバレッジ",
    globalCoverageCopy: "{regions} リージョン · {nodes} ノード",
    openSource: "オープンソース",
    openSourceCopy: "上流テーマ：TomorrowX6/Komari-Butterfly（MIT）",
    cpu: "CPU",
    memory: "メモリ",
    disk: "ディスク",
    uptime: "稼働時間",
    speed: "速度",
    noLatency: "—",
    noNodesTitle: "条件に一致するノードがありません",
    noNodesCopy: "フィルターまたは検索条件を変更してください。",
    clearFilters: "フィルターを解除",
    nodeDetails: "ノード詳細",
    systemInformation: "システム情報",
    recentPerformance: "最近の性能",
    networkActivity: "ネットワーク活動",
    load: "負荷",
    process: "プロセス",
    connections: "接続",
    os: "OS",
    kernel: "カーネル",
    architecture: "アーキテクチャ",
    virtualization: "仮想化",
    cpuName: "プロセッサ",
    cpuCores: "CPU コア",
    gpu: "GPU",
    ipv4: "IPv4",
    ipv6: "IPv6",
    group: "グループ",
    tags: "タグ",
    close: "閉じる",
    loadingDetails: "ノード履歴を読み込み中…",
    regionSummary: "リージョン概要",
    regionBack: "すべてのリージョンに戻る",
    regionOpen: "{region} のノードを表示",
    regionNodesTitle: "{region} のノード",
    nodesCount: "ノード",
    avgCpu: "平均 CPU",
    avgMemory: "平均メモリ",
    avgLatencyShort: "平均遅延",
    trafficOverview: "リアルタイム通信量",
    trafficCopy: "オンラインノードの現在の送受信速度を集計します。",
    recent24hTraffic: "直近24時間の通信量",
    trafficWindow: "各ノードの最近の通信記録を集計",
    cumulativeUpload: "累計アップロード",
    cumulativeDownload: "累計ダウンロード",
    trafficTop5: "通信量 Top 5",
    trafficRankCopy: "各ノードの累計アップロード・ダウンロード量で並べ替えます。",
    peakAt: "ピーク {rate} · {time}",
    todayAt: "今日 {time}",
    yesterdayAt: "昨日 {time}",
    trafficHistoryLoading: "ノード通信記録を集計中…",
    trafficNoHistory: "通信記録はまだありません",
    aboutDescription: "Butterfly は WinUI 3 の抑制された階層と Mica 素材を CF-Server-Monitor のライブデータと組み合わせ、明快で高速なレスポンシブ体験を提供します。",
    designLanguage: "WinUI デザイン言語",
    designLanguageCopy: "階層化された面、柔らかな角丸、明確な状態、正確な間隔で高密度なダッシュボードを構成します。",
    nativeIntegration: "CF-Server-Monitor ネイティブ統合",
    nativeIntegrationCopy: "サイトの REST API（/api/config、/api/servers、/api/history/all）からノード、状態、履歴、サイト設定を取得します。",
    responsive: "レスポンシブレイアウト",
    responsiveCopy: "デスクトップでは高密度、狭い画面では自動的に 1 列と下部ナビゲーションへ切り替わります。",
    themeVersion: "テーマ版",
    komariVersion: "サイト版",
    sourceCode: "ソースコード",
    connected: "接続済み",
    disconnected: "未接続",
    demoMode: "デモデータ",
    retry: "再試行",
    loadFailedTitle: "サイトデータを読み込めません",
    loadFailedCopy: "/api/config と /api/servers にアクセスできるか確認してください。",
    favoriteAdded: "お気に入りに追加しました",
    favoriteRemoved: "お気に入りから削除しました",
    appearanceChanged: "外観を変更しました",
    maintenance: "ノードがオフラインです",
    highCpu: "CPU 使用率が高いです：{value}%",
    highMemory: "メモリ使用率が高いです：{value}%",
    highDisk: "ディスク使用率が高いです：{value}%",
    packetLoss: "パケットロス：{value}%",
    justNow: "たった今",
    minutesAgo: "{value} 分前",
    hoursAgo: "{value} 時間前",
    unknown: "不明",
    light: "ライト",
    dark: "ダーク",
    system: "システム",
    expandSidebar: "サイドバーを展開",
    collapseSidebar: "サイドバーを折りたたむ",
    gridView: "グリッド表示",
    listView: "リスト表示",
    themeToggle: "配色を切り替え",
    footer: "Powered by CF-Server-Monitor {komari} · Butterfly {theme}",
    poweredBy: "CF-Server-Monitor",
    refresh: "データを更新",
    offlineData: "データ接続を利用できません",
  },
};

const ICON_PATHS = {
  overview: '<path d="M3 11.5 12 4l9 7.5"/><path d="M5.5 10.5V20h13v-9.5"/><path d="M9 20v-6h6v6"/>',
  nodes: '<rect x="3" y="4" width="18" height="6" rx="2"/><rect x="3" y="14" width="18" height="6" rx="2"/><path d="M7 7h.01M7 17h.01M11 7h7M11 17h7"/>',
  regions: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a15 15 0 0 1 0 18M12 3a15 15 0 0 0 0 18"/>',
  traffic: '<path d="M4 18 9 13l4 3 7-9"/><path d="M15 7h5v5"/>',
  favorites: '<path d="m12 3 2.78 5.63 6.22.9-4.5 4.39 1.06 6.2L12 17.2l-5.56 2.92 1.06-6.2L3 9.53l6.22-.9L12 3Z"/>',
  about: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/>',
  menu: '<path d="M4 7h16M4 12h16M4 17h16"/>',
  panelLeft: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M9 4v16"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-4-4"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.42 1.42M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.42-1.42M17.66 6.34l1.41-1.41"/>',
  moon: '<path d="M20 15.4A8.5 8.5 0 0 1 8.6 4 8.5 8.5 0 1 0 20 15.4Z"/>',
  bell: '<path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 8h18c0-1-3-1-3-8"/><path d="M10 20h4"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>',
  arrowLeft: '<path d="M19 12H5M11 18l-6-6 6-6"/>',
  arrowRight: '<path d="M5 12h14M13 6l6 6-6 6"/>',
  grid: '<rect x="4" y="4" width="6" height="6" rx="1"/><rect x="14" y="4" width="6" height="6" rx="1"/><rect x="4" y="14" width="6" height="6" rx="1"/><rect x="14" y="14" width="6" height="6" rx="1"/>',
  list: '<path d="M8 6h12M8 12h12M8 18h12"/><path d="M4 6h.01M4 12h.01M4 18h.01"/>',
  refresh: '<path d="M20 6v5h-5"/><path d="M4 18v-5h5"/><path d="M18 9a7 7 0 0 0-12-3L4 11M6 15a7 7 0 0 0 12 3l2-5"/>',
  external: '<path d="M14 4h6v6M20 4l-9 9"/><path d="M18 13v6a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h6"/>',
  chevronRight: '<path d="m9 18 6-6-6-6"/>',
  chevronDown: '<path d="m6 9 6 6 6-6"/>',
  close: '<path d="M6 6l12 12M18 6 6 18"/>',
  globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a15 15 0 0 1 0 18M12 3a15 15 0 0 0 0 18"/>',
  activity: '<path d="M3 12h4l2-7 4 14 2-7h6"/>',
  rocket: '<path d="M14 5c3-3 6-2 6-2s1 3-2 6l-4 4-4-4 4-4Z"/><path d="m10 9-4 1-3 3 6 1M14 13l-1 4-3 3-1-6M6 18l-2 2"/>',
  github: '<path d="M15 22v-4a4.8 4.8 0 0 0-1-3.5c3.3-.4 6.8-1.6 6.8-7A5.4 5.4 0 0 0 19.4 4 5 5 0 0 0 19.3.5S18.2.1 15.5 1.9a13.4 13.4 0 0 0-7 0C5.8.1 4.7.5 4.7.5A5 5 0 0 0 4.6 4a5.4 5.4 0 0 0-1.4 3.7c0 5.4 3.5 6.6 6.8 7A4.8 4.8 0 0 0 9 18v4"/><path d="M9 19c-3 .9-3-1.5-4-2"/>',
  warning: '<path d="M10.3 3.5 2.4 18a2 2 0 0 0 1.8 3h15.6a2 2 0 0 0 1.8-3L13.7 3.5a2 2 0 0 0-3.4 0Z"/><path d="M12 9v4M12 17h.01"/>',
  check: '<path d="m5 12 4 4L19 6"/>',
  server: '<rect x="3" y="4" width="18" height="7" rx="2"/><rect x="3" y="13" width="18" height="7" rx="2"/><path d="M7 7.5h.01M7 16.5h.01"/>',
  gauge: '<path d="M20 15a8 8 0 1 0-16 0"/><path d="m12 15 4-4"/><path d="M7 19h10"/>',
  shield: '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10Z"/><path d="m9 12 2 2 4-4"/>',
  filter: '<path d="M4 5h16l-6 7v5l-4 2v-7L4 5Z"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  network: '<circle cx="5" cy="12" r="2"/><circle cx="19" cy="5" r="2"/><circle cx="19" cy="19" r="2"/><path d="m7 11 10-5M7 13l10 5"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-2.9 1.2 2 2 0 1 1-4 0 1.7 1.7 0 0 0-2.9-1.2l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1A1.7 1.7 0 0 0 3 15a2 2 0 1 1 0-4 1.7 1.7 0 0 0 1.2-2.9l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1A1.7 1.7 0 0 0 10 4.6a2 2 0 1 1 4 0 1.7 1.7 0 0 0 2.9 1.2l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1A1.7 1.7 0 0 0 21 11a2 2 0 1 1 0 4z"/>',
};

function icon(name, size = 20, extra = "") {
  const paths = ICON_PATHS[name] || ICON_PATHS.info;
  return `<svg ${extra} width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;
}

function butterflyLogo(extra = "") {
  return `<svg ${extra} viewBox="0 0 64 64" aria-hidden="true">
    <defs>
      <linearGradient id="bf-a" x1="8" y1="10" x2="54" y2="54" gradientUnits="userSpaceOnUse">
        <stop stop-color="#7B8BFF"/><stop offset=".52" stop-color="#5064F4"/><stop offset="1" stop-color="#2EC4C7"/>
      </linearGradient>
      <linearGradient id="bf-b" x1="48" y1="12" x2="18" y2="55" gradientUnits="userSpaceOnUse">
        <stop stop-color="#B9C3FF"/><stop offset="1" stop-color="#6E7EFF"/>
      </linearGradient>
    </defs>
    <path d="M31.6 31.7C23.3 15.5 11.7 9.3 7.8 16.6 4 23.8 14 32 27.8 34.1c-11.7 1.5-20.5 8.5-16.5 15.4 4 6.9 14.2.4 20.6-12.2" fill="url(#bf-a)" opacity=".92"/>
    <path d="M32.4 31.7C40.7 15.5 52.3 9.3 56.2 16.6 60 23.8 50 32 36.2 34.1c11.7 1.5 20.5 8.5 16.5 15.4-4 6.9-14.2.4-20.6-12.2" fill="url(#bf-b)" opacity=".93"/>
    <path d="M32 25.4c2.6 0 4.7 3.5 4.7 7.7s-2.1 9.1-4.7 9.1-4.7-4.9-4.7-9.1 2.1-7.7 4.7-7.7Z" fill="#243583"/>
    <circle cx="32" cy="22.4" r="3.4" fill="#3B4CD1"/>
    <path d="M30.4 20c-3.5-5.2-6.7-4.8-8.3-3.3M33.6 20c3.5-5.2 6.7-4.8 8.3-3.3" fill="none" stroke="#5364F4" stroke-width="2" stroke-linecap="round"/>
  </svg>`;
}

function networkArt() {
  return `<svg class="network-art" viewBox="0 0 760 360" aria-hidden="true">
    <defs>
      <radialGradient id="oceanGradient" cx="34%" cy="27%" r="79%"><stop stop-color="#70A9F4"/><stop offset=".3" stop-color="#3974CF"/><stop offset=".65" stop-color="#17478F"/><stop offset="1" stop-color="#071C48"/></radialGradient>
      <linearGradient id="landGradient" x1="330" y1="92" x2="526" y2="274"><stop stop-color="#E0EDFF"/><stop offset=".4" stop-color="#A9C9F4"/><stop offset=".72" stop-color="#76A4E1"/><stop offset="1" stop-color="#4E7FC8"/></linearGradient>
      <linearGradient id="landGradientDark" x1="330" y1="92" x2="526" y2="274"><stop stop-color="#9BACCB"/><stop offset=".45" stop-color="#748AB2"/><stop offset="1" stop-color="#465F8B"/></linearGradient>
      <linearGradient id="arcGradient" x1="325" y1="106" x2="563" y2="245"><stop stop-color="#55F0DF"/><stop offset=".52" stop-color="#69DFFF"/><stop offset="1" stop-color="#9EB8FF"/></linearGradient>
      <radialGradient id="glowGradient"><stop stop-color="#8FAEFF" stop-opacity=".62"/><stop offset=".58" stop-color="#6F8DF2" stop-opacity=".2"/><stop offset="1" stop-color="#5672E8" stop-opacity="0"/></radialGradient>
      <linearGradient id="atmosphereGradient" x1="318" y1="86" x2="568" y2="283"><stop stop-color="#CBE0FF" stop-opacity=".86"/><stop offset=".45" stop-color="#80A8FF" stop-opacity=".38"/><stop offset="1" stop-color="#5369D8" stop-opacity=".06"/></linearGradient>
      <radialGradient id="sphereSheen" cx="32%" cy="23%" r="72%"><stop stop-color="#FFFFFF" stop-opacity=".33"/><stop offset=".42" stop-color="#B8D8FF" stop-opacity=".08"/><stop offset="1" stop-color="#FFFFFF" stop-opacity="0"/></radialGradient>
      <linearGradient id="sphereShade" x1="386" y1="98" x2="568" y2="254"><stop stop-color="#041A4B" stop-opacity="0"/><stop offset=".62" stop-color="#031638" stop-opacity=".08"/><stop offset="1" stop-color="#020B24" stop-opacity=".52"/></linearGradient>
      <filter id="softGlow" x="-30%" y="-30%" width="160%" height="160%"><feGaussianBlur stdDeviation="9"/></filter>
      <filter id="globeShadow" x="-30%" y="-30%" width="170%" height="180%"><feDropShadow dx="0" dy="14" stdDeviation="12" flood-color="#061535" flood-opacity=".34"/></filter>
      <clipPath id="globeClip"><circle cx="435" cy="190" r="156"/></clipPath>
      <g id="continentShapes">
        <path d="M283 129c9-19 23-36 40-49 17-12 37-21 57-25l17 6 12 12 20 3 12 13-8 12-18 3-10 11-18-1-13 10-7 17-18 7-9 15-11-4-3-14-16-6-10-12-17-3-4-13 4-12Z"/>
        <path d="M349 158l17-8 15 5 7 12 17 5 9 13-8 10-4 22-10 19-7 25-10 17-9-12 2-18-8-19-5-22-11-16 4-13-6-11 7-9Z"/>
        <path d="M401 70l13-11 17 2 11 10-3 15-13 10-17-5-8-21Z"/>
        <path d="M432 119l11-10 17 1 8 7 14-2 8 7-5 9-13 2-8 10-13-3-8 7-12-7 4-10-3-11Z"/>
        <path d="M451 145l22-8 20 9 13 16-8 18-6 28-13 22-14 22-10-10-1-23-9-18-10-22 8-19 8-15Z"/>
        <path d="M481 111l17-17 20 2 12 9 17-2 18 12 15 2 13 12-7 12-19 2-8 10-14-1-14 13-13-5-8-16-17-4-7-12-15-5-2-9 12-3Z"/>
        <path d="M511 172l15-7 16 9 10 14-7 12-15-3-8-11-11-14Z"/>
        <path d="M529 225l20-11 22 5 13 15-6 19-20 8-20-8-9-16v-12Z"/>
        <path d="M499 230l6 7-3 15-7 2-4-11 8-13ZM582 161l7 7-4 14-7-2-1-11 5-8ZM419 130l5-8 6 5-3 10-8-7Z"/>
      </g>
    </defs>
    <ellipse class="orbit orbit-back" cx="435" cy="190" rx="226" ry="94" transform="rotate(-16 435 190)"/>
    <circle class="globe-glow" cx="435" cy="190" r="184" fill="url(#glowGradient)" filter="url(#softGlow)"/>
    <circle class="globe-disc" cx="435" cy="190" r="156" fill="url(#oceanGradient)" filter="url(#globeShadow)"/>
    <g clip-path="url(#globeClip)">
      <ellipse class="grid-line" cx="435" cy="190" rx="149" ry="48"/>
      <ellipse class="grid-line" cx="435" cy="190" rx="149" ry="100"/>
      <ellipse class="grid-line" cx="435" cy="190" rx="57" ry="154"/>
      <ellipse class="grid-line" cx="435" cy="190" rx="106" ry="154"/>
      <use href="#continentShapes" class="land-shadow" transform="translate(3 4)"/>
      <use href="#continentShapes" class="land"/>
      <ellipse class="sphere-sheen" cx="382" cy="135" rx="128" ry="148" fill="url(#sphereSheen)"/>
      <ellipse class="sphere-shade" cx="515" cy="204" rx="108" ry="166" fill="url(#sphereShade)"/>
      <path class="arc arc-major" d="M336 157Q392 102 448 137"/>
      <path class="arc arc-major arc-reverse" d="M336 157Q442 48 548 148"/>
      <path class="arc arc-major" d="M375 226Q448 103 548 148"/>
      <path class="arc arc-secondary arc-reverse" d="M375 226Q421 145 465 180"/>
      <path class="arc arc-secondary" d="M448 137Q506 96 548 148"/>
      <path class="arc arc-secondary arc-reverse" d="M465 180Q526 151 550 232"/>
      <path class="arc arc-secondary" d="M448 137Q521 122 550 232"/>
    </g>
    <circle class="sphere-rim" cx="435" cy="190" r="156"/>
    <circle class="atmosphere" cx="435" cy="190" r="160"/>
    <ellipse class="orbit-strong" cx="435" cy="190" rx="218" ry="102" transform="rotate(22 435 190)"/>
  </svg>`;
}

// 数据层：CFSM 同源 REST（原主题的 Komari JSON-RPC 接口已整体替换）。
// 分工：cfsm-api 负责请求/令牌/轮询，cfsm-map 负责三张字段映射表，theme-config 负责设置键与默认值。
const api = createCfsmApi({ onUnauthorized: handleAuthInvalidated });

// 令牌失效（401/403）：退回匿名并提示重新登录，不静默失败。
function handleAuthInvalidated() {
  state.userInfo = { logged_in: false, username: "" };
  showToast(t("disconnected"), t("signIn"), "warning");
}

const statusPoller = createPoller({
  getIntervalSeconds: () => state.config.poll_interval,
  onTick: async () => {
    await refreshStatuses(false);
    // refreshStatuses 内部已把失败写成 state.connected = false，这里抛出让 poller 退避。
    if (!state.connected) throw new Error("status refresh failed");
  },
  onError: () => scheduleStatusRender(false),
});
const app = document.querySelector("#app");
const globePortal = document.querySelector("#globe-portal");
let regionGlobeController = null;
let searchRenderFrame = null;
let mobileNavHidden = false;
let mobileNavLastScrollY = Math.max(0, window.scrollY);
let mobileNavScrollFrame = null;
let mobileInputStateFrame = null;
let mobileStatusRenderTimer = null;
let statusRefreshInFlight = false;
// 输入法组字（composition）期间不能重渲染：整页重渲染会打断候选，导致中文/日文根本打不进去
let searchComposing = false;
let drawerDrag = null;
let suppressDrawerHandleClickUntil = 0;

const state = {
  language: detectLanguage(),
  config: { ...DEFAULT_CONFIG },
  publicInfo: {},
  userInfo: null,
  // CFSM 原始响应与站点配置（线路名、开关、theme_options 原件——保存设置时必须读-改-写）
  cfsmConfig: null,
  sysConfig: null,
  themeOptions: {},
  turnstileBlocked: false,
  version: { version: "unknown", hash: "unknown" },
  nodes: [],
  statuses: {},
  nodeSamples: new Map(),
  networkSamples: [],
  trafficHistory: new Map(),
  trafficHistoryLoading: false,
  trafficHistoryLoadedAt: 0,
  loading: true,
  error: null,
  connected: false,
  lastUpdated: 0,
  currentView: initialView(),
  filter: initialView() === "favorites" ? "favorites" : "all",
  query: "",
  sort: DEFAULT_CONFIG.default_sort,
  cardMode: safeStorageGet(STORAGE.cardMode) === "list" ? "list" : "grid",
  favorites: new Set(readStoredArray(STORAGE.favorites)),
  sidebarCollapsed: safeStorageGet(STORAGE.sidebar) === "collapsed",
  sidebarOpen: false,
  regionSelected: null,
  drawerUuid: null,
  drawerRecords: null,
  drawerLoading: false,
  globeOpen: false,
  globeSelectedRegion: null,
  mobileSearchOpen: false,
  notificationsOpen: false,
  settingsOpen: false,
  settingsDraft: null,
  settingsSaving: false,
  pollTimer: null,
  clockTimer: null,
  demoMode: shouldUseDemo(),
};

function detectLanguage() {
  let cookieValue = "";
  try {
    const cookie = document.cookie.split(";").map(value => value.trim()).find(value => value.startsWith("language="));
    cookieValue = cookie ? decodeURIComponent(cookie.slice("language=".length)).replace("_", "-") : "";
  } catch {
    cookieValue = "";
  }
  const language = cookieValue || navigator.language || "en";
  if (language.toLowerCase().startsWith("zh")) return "zh-CN";
  if (language.toLowerCase().startsWith("ja")) return "ja";
  return "en";
}

function shouldUseDemo() {
  const params = new URLSearchParams(location.search);
  return params.get("demo") === "1" || location.protocol === "file:";
}

function initialView() {
  const view = new URLSearchParams(location.search).get("view");
  return ["overview", "regions", "traffic", "favorites", "about"].includes(view) ? view : "overview";
}

function t(key, variables = {}) {
  const dictionary = STRINGS[state.language] || STRINGS.en;
  const template = dictionary[key] ?? STRINGS.en[key] ?? key;
  return String(template).replace(/\{([A-Za-z0-9_]+)\}/g, (_, name) => String(variables[name] ?? ""));
}

function safeStorageGet(key) {
  try { return localStorage.getItem(key); } catch { return null; }
}

function safeStorageSet(key, value) {
  try { localStorage.setItem(key, value); } catch { /* storage can be disabled */ }
}

function readStoredArray(key) {
  try {
    const parsed = JSON.parse(safeStorageGet(key) || "[]");
    return Array.isArray(parsed) ? parsed.filter(value => typeof value === "string") : [];
  } catch {
    return [];
  }
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function finiteNumber(value, fallback = 0) {
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function clamp(value, min, max) {
  return Math.min(Math.max(finiteNumber(value, min), min), max);
}

function percent(used, total) {
  const safeTotal = finiteNumber(total);
  if (safeTotal <= 0) return 0;
  return clamp((finiteNumber(used) / safeTotal) * 100, 0, 100);
}

function mean(values) {
  const numbers = values.filter(Number.isFinite);
  return numbers.length ? numbers.reduce((sum, value) => sum + value, 0) / numbers.length : 0;
}

function sum(values) {
  return values.reduce((total, value) => total + finiteNumber(value), 0);
}

function formatPercent(value) {
  return `${Math.round(clamp(value, 0, 100))}%`;
}

function formatBytes(value, decimals = 1) {
  const bytes = Math.max(0, finiteNumber(value));
  if (bytes === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB", "PB"];
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const scaled = bytes / 1024 ** index;
  const digits = scaled >= 100 || index === 0 ? 0 : scaled >= 10 ? Math.min(decimals, 1) : decimals;
  return `${scaled.toFixed(digits)} ${units[index]}`;
}

function formatRate(value) {
  return `${formatBytes(Math.max(0, finiteNumber(value)))}/s`;
}

function formatTrafficTime(timestamp, withDay = false) {
  const date = new Date(timestamp);
  if (!Number.isFinite(date.getTime())) return t("unknown");
  const time = date.toLocaleTimeString(state.language, { hour: "2-digit", minute: "2-digit", hour12: false });
  if (!withDay) return time;
  const today = new Date();
  const startToday = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();
  const startDate = new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  if (startDate === startToday) return t("todayAt", { time });
  if (startDate === startToday - 86400000) return t("yesterdayAt", { time });
  return `${date.toLocaleDateString(state.language, { month: "2-digit", day: "2-digit" })} ${time}`;
}

function niceTrafficMaximum(value) {
  const safe = Math.max(1, finiteNumber(value, 1));
  const magnitude = 10 ** Math.floor(Math.log10(safe));
  const normalized = safe / magnitude;
  const step = normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 5 ? 5 : 10;
  return step * magnitude;
}

function formatDuration(seconds) {
  const total = Math.max(0, Math.floor(finiteNumber(seconds)));
  if (!total) return t("unknown");
  const days = Math.floor(total / 86400);
  const hours = Math.floor((total % 86400) / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

function formatRelativeTime(timestamp) {
  const time = timestamp instanceof Date ? timestamp.getTime() : new Date(timestamp).getTime();
  if (!Number.isFinite(time)) return t("justNow");
  const seconds = Math.max(0, Math.floor((Date.now() - time) / 1000));
  if (seconds < 60) return t("justNow");
  if (seconds < 3600) return t("minutesAgo", { value: Math.floor(seconds / 60) });
  return t("hoursAgo", { value: Math.floor(seconds / 3600) });
}

function initials(value) {
  const parts = String(value || "K").trim().split(/\s+/).filter(Boolean);
  return (parts.slice(0, 2).map(part => part[0]).join("") || "K").toUpperCase();
}

function isRecord(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

// 计算"最佳延迟"时排除 BGP 线路：CFSM 的 `ping_bd` 实测 11/12 台为 1–2 ms，
// 与福建到美日的真实 RTT 不符（电信/联通/移动为 21–354 ms），会污染卡片延迟胶囊、
// 延迟分布直方图、区域均值、抽屉"平均延迟"与按延迟排序。
// 线路延迟面板与详情抽屉仍照常显示 BGP（用户 2026-09-14 决定：BGP 保留展示，不参与取最小值）。
const BEST_LATENCY_EXCLUDED_LINES = new Set(["bd"]);

function bestLatency(status) {
  if (!isRecord(status?.ping)) return null;
  let best = null;
  for (const [id, entry] of Object.entries(status.ping)) {
    if (BEST_LATENCY_EXCLUDED_LINES.has(id)) continue;
    if (!isRecord(entry)) continue;
    const value = finiteNumber(entry.latest, -1);
    if (value >= 0 && (best === null || value < best)) best = value;
  }
  return best;
}

function bestLoss(status) {
  if (!isRecord(status?.ping)) return 0;
  let maximum = 0;
  for (const entry of Object.values(status.ping)) {
    if (!isRecord(entry)) continue;
    maximum = Math.max(maximum, clamp(entry.loss, 0, 100));
  }
  return maximum;
}

function regionCode(region) {
  if (typeof region !== "string") return "";
  const value = region.trim();
  if (/^[A-Za-z]{2}$/.test(value)) return value.toUpperCase();
  const chars = [...value];
  if (chars.length < 2) return "";
  const first = chars[0].codePointAt(0) ?? 0;
  const second = chars[1].codePointAt(0) ?? 0;
  if (first < 0x1F1E6 || first > 0x1F1FF || second < 0x1F1E6 || second > 0x1F1FF) return "";
  return String.fromCharCode(65 + first - 0x1F1E6, 65 + second - 0x1F1E6);
}

function regionEmoji(code) {
  if (!/^[A-Z]{2}$/.test(code)) return "";
  return [...code].map(character => String.fromCodePoint(127397 + character.charCodeAt(0))).join("");
}

function regionFlag(region) {
  const code = regionCode(region);
  if (!code) return icon("globe", 14);
  // 旗帜改由 CFSM 同源提供（小写两位码）；主题不再打包 272 个 SVG。
  return `<img class="country-flag" src="/flags/${code.toLowerCase()}.svg" alt="" loading="lazy" decoding="async"/>`;
}

// 未知/未配置的地区码会让 /flags/<code>.svg 返回 200 text/html（不是图片），
// <img> 只会静默破图 → 捕获 error 换回地球图标（捕获阶段，图片 error 不冒泡）。
function handleFlagError(event) {
  const target = event.target;
  if (!(target instanceof HTMLImageElement) || !target.classList.contains("country-flag")) return;
  const fallback = document.createElement("span");
  fallback.className = "country-flag country-flag-fallback";
  fallback.innerHTML = icon("globe", 14);
  target.replaceWith(fallback);
}

function regionDisplayName(region) {
  const value = typeof region === "string" ? region.trim() : "";
  const code = regionCode(value);
  if (!code) return value || t("unknown");
  const chars = [...value];
  const first = chars[0]?.codePointAt(0) ?? 0;
  const hasLeadingFlag = first >= 0x1F1E6 && first <= 0x1F1FF;
  const explicitText = hasLeadingFlag ? chars.slice(2).join("").trim() : "";
  if (explicitText) return explicitText;
  try {
    const displayNames = new Intl.DisplayNames([state.language], { type: "region" });
    const localized = displayNames.of(code);
    if (localized && localized !== code) return localized;
  } catch {
    // Older browsers fall through to the bundled English region name.
  }
  return REGION_NAMES[code] || code;
}

function buildGlobeRegions() {
  const groups = new Map();
  for (const node of state.nodes) {
    const code = regionCode(node.region);
    const location = REGION_COORDS[code];
    if (!code || !Array.isArray(location) || location.length < 2) continue;
    if (!groups.has(code)) {
      groups.set(code, {
        code,
        flag: regionEmoji(code),
        label: regionDisplayName(node.region),
        lat: finiteNumber(location[0]),
        lng: finiteNumber(location[1]),
        total: 0,
        online: 0,
        netIn: 0,
        netOut: 0,
        latencies: [],
        nodes: [],
      });
    }
    const group = groups.get(code);
    const status = nodeStatus(node.uuid) || {};
    const online = status.online === true;
    const latency = bestLatency(status);
    group.total += 1;
    if (online) group.online += 1;
    group.netIn += online ? Math.max(0, finiteNumber(status.net_in)) : 0;
    group.netOut += online ? Math.max(0, finiteNumber(status.net_out)) : 0;
    if (latency !== null) group.latencies.push(latency);
    group.nodes.push({
      uuid: node.uuid,
      name: node.name || node.uuid,
      online,
      latency,
    });
  }

  return [...groups.values()].map(group => ({
    ...group,
    status: group.online === 0 ? "offline" : group.online === group.total ? "online" : "mixed",
    avgLatency: group.latencies.length ? mean(group.latencies) : null,
  })).sort((a, b) => b.online - a.online || b.total - a.total || a.label.localeCompare(b.label, state.language));
}

function preferredGlobeRegion(regions) {
  if (!Array.isArray(regions) || regions.length === 0) return null;
  return [...regions].sort((a, b) => {
    const onlineDelta = Number(b.online > 0) - Number(a.online > 0);
    if (onlineDelta) return onlineDelta;
    if (b.online !== a.online) return b.online - a.online;
    const latencyA = a.avgLatency === null ? Number.POSITIVE_INFINITY : a.avgLatency;
    const latencyB = b.avgLatency === null ? Number.POSITIVE_INFINITY : b.avgLatency;
    if (latencyA !== latencyB) return latencyA - latencyB;
    if (b.total !== a.total) return b.total - a.total;
    return a.label.localeCompare(b.label, state.language);
  })[0] || null;
}

function renderGlobeRegionButton(region) {
  const selected = state.globeSelectedRegion === region.code;
  const statusLabel = t("globeOnlineSummary", { online: region.online, total: region.total });
  const latency = region.avgLatency === null ? t("noLatency") : `${Math.round(region.avgLatency)}ms`;
  return `<button class="globe-region-item${selected ? " is-selected" : ""}" type="button" data-globe-region-code="${escapeHtml(region.code)}" aria-pressed="${selected}">
    <span class="globe-region-flag">${regionFlag(region.code)}</span>
    <span class="globe-region-copy"><strong>${escapeHtml(region.label)}</strong><span>${escapeHtml(statusLabel)}</span></span>
    <span class="globe-region-latency">${escapeHtml(latency)}</span>
    <span class="globe-region-status is-${region.status}" aria-hidden="true"></span>
  </button>`;
}

function renderGlobeSelection(regions, code) {
  const region = regions.find(entry => entry.code === code);
  if (!region) {
    return `<div class="globe-selection-empty">${icon("globe", 24)}<span>${escapeHtml(t("globeSelectRegion"))}</span></div>`;
  }
  const nodes = [...region.nodes].sort((a, b) => Number(b.online) - Number(a.online) || a.name.localeCompare(b.name, state.language));
  return `<div class="globe-selection-head">
      <span class="globe-selection-flag">${regionFlag(region.code)}</span>
      <span><strong>${escapeHtml(region.label)}</strong><small>${escapeHtml(t("globeOnlineSummary", { online: region.online, total: region.total }))}</small></span>
      <span class="globe-selection-code">${escapeHtml(region.code)}</span>
    </div>
    <div class="globe-selection-metrics">
      <span><strong>${region.avgLatency === null ? "—" : `${Math.round(region.avgLatency)}ms`}</strong><small>${escapeHtml(t("averageLatency"))}</small></span>
      <span><strong>${escapeHtml(formatRate(region.netIn + region.netOut))}</strong><small>${escapeHtml(t("networkSpeed"))}</small></span>
    </div>
    <div class="globe-node-list">${nodes.map(node => {
      const latency = node.latency === null ? t("noLatency") : `${Math.round(node.latency)}ms`;
      return `<button class="globe-node-item" type="button" data-globe-node-uuid="${escapeHtml(node.uuid)}">
        <span class="globe-node-dot${node.online ? "" : " is-offline"}"></span>
        <span class="globe-node-name">${escapeHtml(node.name)}</span>
        <span class="globe-node-latency">${escapeHtml(latency)}</span>
        <span class="globe-node-open">${escapeHtml(t("globeOpenNode"))}${icon("chevronRight", 13)}</span>
      </button>`;
    }).join("")}</div>`;
}

function renderGlobePortal(regions = buildGlobeRegions()) {
  if (!globePortal) return;
  regionGlobeController?.destroy();
  regionGlobeController = null;
  if (!state.globeOpen) {
    globePortal.replaceChildren();
    return;
  }

  if (state.globeSelectedRegion && !regions.some(region => region.code === state.globeSelectedRegion)) {
    state.globeSelectedRegion = null;
  }
  if (!state.globeSelectedRegion) {
    state.globeSelectedRegion = preferredGlobeRegion(regions)?.code || null;
  }
  const metrics = aggregateMetrics();
  globePortal.innerHTML = `<button class="globe-backdrop" type="button" data-globe-action="close" aria-label="${escapeHtml(t("close"))}"></button>
    <section class="globe-dialog" role="dialog" aria-modal="true" aria-labelledby="globe-dialog-title">
      <header class="globe-dialog-header">
        <div class="globe-dialog-title-wrap">
          <span class="globe-dialog-icon">${icon("globe", 21)}</span>
          <span><h2 id="globe-dialog-title">${escapeHtml(t("globeTitle"))}</h2><p>${escapeHtml(t("globeSubtitle"))}</p></span>
        </div>
        <button class="icon-button globe-close-button" type="button" data-globe-action="close" aria-label="${escapeHtml(t("close"))}">${icon("close", 18)}</button>
      </header>
      <div class="globe-dialog-body">
        <div class="globe-stage-panel">
          <div class="globe-stage-summary">
            <span><strong>${regions.length}</strong>${escapeHtml(t("regionsMetric"))}</span>
            <span><strong>${metrics.online}</strong>${escapeHtml(t("onlineNodes"))}</span>
            <span><strong>${escapeHtml(formatRate(metrics.uploadRate + metrics.downloadRate))}</strong>${escapeHtml(t("networkSpeed"))}</span>
          </div>
          <div class="globe-canvas-wrap">
            <canvas id="region-globe-canvas" class="region-globe-canvas" aria-label="${escapeHtml(t("globeTitle"))}"></canvas>
            <div class="globe-canvas-overlay" aria-hidden="true"></div>
          </div>
          <div class="globe-stage-hint">${icon("activity", 14)}<span>${escapeHtml(t("globeHint"))}</span></div>
        </div>
        <aside class="globe-fleet-panel">
          <div class="globe-fleet-heading">
            <span><strong>${escapeHtml(t("globalCoverage"))}</strong><small>${escapeHtml(t("globeMappedRegions", { count: regions.length }))}</small></span>
            <button class="panel-link" type="button" data-globe-action="nodes">${escapeHtml(t("globeBackToNodes"))}</button>
          </div>
          ${regions.length ? `<div class="globe-region-list" role="listbox">${regions.map(renderGlobeRegionButton).join("")}</div>` : `<div class="globe-region-empty">${icon("globe", 28)}<p>${escapeHtml(t("globeNoRegions"))}</p></div>`}
          <div class="globe-selection-card" data-globe-selection>${renderGlobeSelection(regions, state.globeSelectedRegion)}</div>
        </aside>
      </div>
    </section>`;

  requestAnimationFrame(() => {
    if (!state.globeOpen) return;
    const canvas = globePortal.querySelector("#region-globe-canvas");
    if (!(canvas instanceof HTMLCanvasElement)) return;
    const controller = createRegionGlobe(canvas, regions, code => selectGlobeRegion(code));
    regionGlobeController = controller;
    loadWorldLandVectors()
      .then(vectors => {
        if (regionGlobeController === controller) controller.setLandVectors(vectors);
      })
      .catch(error => console.error("[CFSM Butterfly] Failed to load globe map data", error));
    if (state.globeSelectedRegion) {
      regionGlobeController.selectRegion(state.globeSelectedRegion);
      centerSelectedGlobeRegion(state.globeSelectedRegion, false);
    }
    globePortal.querySelector(".globe-close-button")?.focus({ preventScroll: true });
  });
}

function refreshOpenGlobe() {
  if (!state.globeOpen || !globePortal?.childElementCount) return;
  const regions = buildGlobeRegions();
  if (state.globeSelectedRegion && !regions.some(region => region.code === state.globeSelectedRegion)) {
    state.globeSelectedRegion = null;
  }
  if (!state.globeSelectedRegion) {
    state.globeSelectedRegion = preferredGlobeRegion(regions)?.code || null;
  }
  regionGlobeController?.setRegions(regions);
  if (state.globeSelectedRegion) regionGlobeController?.selectRegion(state.globeSelectedRegion);
  const list = globePortal.querySelector(".globe-region-list");
  if (list) list.innerHTML = regions.map(renderGlobeRegionButton).join("");
  if (state.globeSelectedRegion) centerSelectedGlobeRegion(state.globeSelectedRegion, false);
  const selection = globePortal.querySelector("[data-globe-selection]");
  if (selection) selection.innerHTML = renderGlobeSelection(regions, state.globeSelectedRegion);
}

function openGlobe() {
  resetMobileNavVisibility();
  state.notificationsOpen = false;
  state.globeOpen = true;
  renderGlobePortal();
  document.body.style.overflow = "hidden";
}

function closeGlobe() {
  state.globeOpen = false;
  regionGlobeController?.destroy();
  regionGlobeController = null;
  globePortal?.replaceChildren();
  document.body.style.overflow = state.drawerUuid ? "hidden" : "";
  resetMobileNavVisibility();
}

function centerSelectedGlobeRegion(code, smooth = true) {
  if (!matchMedia(MOBILE_LAYOUT_QUERY).matches) return;
  const buttons = globePortal?.querySelectorAll("[data-globe-region-code]") || [];
  const button = [...buttons].find(element => element.dataset.globeRegionCode === code);
  const list = button?.closest(".globe-region-list");
  if (!(button instanceof HTMLElement) || !(list instanceof HTMLElement)) return;
  const canScrollX = list.scrollWidth > list.clientWidth + 1;
  const canScrollY = list.scrollHeight > list.clientHeight + 1;
  const listRect = list.getBoundingClientRect();
  const buttonRect = button.getBoundingClientRect();
  const left = canScrollX
    ? list.scrollLeft + buttonRect.left - listRect.left - (list.clientWidth - button.clientWidth) / 2
    : list.scrollLeft;
  const top = canScrollY
    ? list.scrollTop + buttonRect.top - listRect.top - (list.clientHeight - button.clientHeight) / 2
    : list.scrollTop;
  const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;
  list.scrollTo({
    left: Math.max(0, left),
    top: Math.max(0, top),
    behavior: smooth && !reducedMotion ? "smooth" : "auto",
  });
}

function selectGlobeRegion(code) {
  const regions = buildGlobeRegions();
  const region = regions.find(entry => entry.code === code);
  if (!region) return;
  state.globeSelectedRegion = code;
  regionGlobeController?.selectRegion(code);
  globePortal?.querySelectorAll("[data-globe-region-code]").forEach(button => {
    const selected = button.dataset.globeRegionCode === code;
    button.classList.toggle("is-selected", selected);
    button.setAttribute("aria-pressed", String(selected));
  });
  centerSelectedGlobeRegion(code);
  const selection = globePortal?.querySelector("[data-globe-selection]");
  if (selection) selection.innerHTML = renderGlobeSelection(regions, code);
}

function createRegionGlobe(canvas, initialRegions, onSelect) {
  const context = canvas.getContext("2d", { alpha: true });
  if (!context) return { destroy() {}, setLandVectors() {}, setRegions() {}, selectRegion() {}, refreshTheme() {} };

  const degrees = Math.PI / 180;
  const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const mobileGlobe = matchMedia(MOBILE_GLOBE_QUERY).matches;
  const targetFrameInterval = mobileGlobe ? 1000 / 24 : 0;
  const landStride = mobileGlobe ? 3 : 1;
  let landVectors = [];
  let regions = initialRegions;
  let selectedCode = null;
  let width = 0;
  let height = 0;
  let centerX = 0;
  let centerY = 0;
  let radius = 0;
  let pixelRatio = 1;
  let rotation = -0.45;
  let tilt = 0.18;
  let targetRotation = null;
  let targetTilt = null;
  let spinVelocity = 0;
  let tiltVelocity = 0;
  let frameId = 0;
  let previousTime = performance.now();
  let dragging = false;
  let moved = 0;
  let pointerX = 0;
  let pointerY = 0;
  let pointerTime = performance.now();
  let visibleMarkers = [];
  let palette = readPalette();
  let haloPaint = null;
  let spherePaint = null;
  let cosRotation = Math.cos(rotation);
  let sinRotation = Math.sin(rotation);
  let cosTilt = Math.cos(tilt);
  let sinTilt = Math.sin(tilt);
  const arcRouteCache = new Map();
  const regionVectorCache = new Map();
  const canvasFont = getComputedStyle(document.body).fontFamily;

  function readPalette() {
    const styles = getComputedStyle(document.documentElement);
    const value = (name, fallback) => styles.getPropertyValue(name).trim() || fallback;
    const dark = document.documentElement.dataset.theme === "dark";
    return {
      dark,
      accent: value("--accent", "#5364f4"),
      cyan: value("--cyan", "#38bfc1"),
      green: value("--green", "#23b782"),
      amber: value("--amber", "#ec9d2b"),
      red: value("--red", "#e75f67"),
      text: value("--text", dark ? "#dce4f2" : "#17203b"),
      muted: value("--muted", dark ? "#93a0b5" : "#66708f"),
      line: value("--line-strong", dark ? "rgba(151,166,192,.2)" : "rgba(72,92,150,.22)"),
      land: value("--globe-land", dark ? "#8da6ce" : "#456890"),
      landGlow: value("--globe-land-glow", dark ? "#7b88ff" : "#3976ea"),
    };
  }

  function rebuildSpherePaints() {
    if (!radius) return;
    haloPaint = context.createRadialGradient(centerX, centerY, radius * 0.62, centerX, centerY, radius * 1.28);
    haloPaint.addColorStop(0, "rgba(0,0,0,0)");
    haloPaint.addColorStop(0.72, palette.dark ? "rgba(83,100,244,.12)" : "rgba(83,100,244,.09)");
    haloPaint.addColorStop(1, "rgba(0,0,0,0)");

    spherePaint = context.createRadialGradient(centerX - radius * 0.34, centerY - radius * 0.38, radius * 0.08, centerX, centerY, radius * 1.08);
    if (palette.dark) {
      spherePaint.addColorStop(0, "#24395f");
      spherePaint.addColorStop(0.48, "#14243f");
      spherePaint.addColorStop(1, "#09111f");
    } else {
      spherePaint.addColorStop(0, "#f8fbff");
      spherePaint.addColorStop(0.52, "#dbe8fb");
      spherePaint.addColorStop(1, "#aebfda");
    }
  }

  function resize() {
    const rect = canvas.getBoundingClientRect();
    width = Math.max(1, rect.width);
    height = Math.max(1, rect.height);
    pixelRatio = Math.min(window.devicePixelRatio || 1, mobileGlobe ? 1.25 : 2);
    canvas.width = Math.round(width * pixelRatio);
    canvas.height = Math.round(height * pixelRatio);
    context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
    centerX = width / 2;
    centerY = height / 2;
    radius = Math.max(80, Math.min(width, height) * 0.39);
    rebuildSpherePaints();
    queueDraw();
  }

  function vectorFromLatLng(lat, lng) {
    const latitude = lat * degrees;
    const longitude = lng * degrees;
    const cosLatitude = Math.cos(latitude);
    return {
      x: cosLatitude * Math.sin(longitude),
      y: Math.sin(latitude),
      z: cosLatitude * Math.cos(longitude),
    };
  }

  const gridSampleStep = mobileGlobe ? 6 : 3;
  const latitudeGridVectors = (mobileGlobe ? [-45, 0, 45] : [-60, -30, 0, 30, 60]).map(lat => {
    const vectors = [];
    for (let lng = -180; lng <= 180; lng += gridSampleStep) vectors.push(vectorFromLatLng(lat, lng));
    return vectors;
  });
  const longitudeGridVectors = (mobileGlobe ? [-135, -90, -45, 0, 45, 90, 135, 180] : [-150, -120, -90, -60, -30, 0, 30, 60, 90, 120, 150, 180]).map(lng => {
    const vectors = [];
    for (let lat = -88; lat <= 88; lat += gridSampleStep) vectors.push(vectorFromLatLng(lat, lng));
    return vectors;
  });

  function updateProjectionMatrix() {
    cosRotation = Math.cos(rotation);
    sinRotation = Math.sin(rotation);
    cosTilt = Math.cos(tilt);
    sinTilt = Math.sin(tilt);
  }

  function projectVector(vector, altitude = 1) {
    const x = vector.x * cosRotation - vector.z * sinRotation;
    const z = vector.x * sinRotation + vector.z * cosRotation;
    const y = vector.y * cosTilt - z * sinTilt;
    const depth = vector.y * sinTilt + z * cosTilt;
    return {
      x: centerX + x * radius * altitude,
      y: centerY - y * radius * altitude,
      z: depth,
    };
  }

  function drawProjectedLine(vectors, alpha = 0.2, widthValue = 1) {
    context.beginPath();
    let active = false;
    for (const vector of vectors) {
      const point = projectVector(vector);
      if (point.z <= 0) {
        active = false;
        continue;
      }
      if (!active) {
        context.moveTo(point.x, point.y);
        active = true;
      } else {
        context.lineTo(point.x, point.y);
      }
    }
    context.globalAlpha = alpha;
    context.strokeStyle = palette.line;
    context.lineWidth = widthValue;
    context.stroke();
    context.globalAlpha = 1;
  }

  function drawGrid() {
    context.save();
    context.beginPath();
    context.arc(centerX, centerY, radius, 0, Math.PI * 2);
    context.clip();
    for (const vectors of latitudeGridVectors) drawProjectedLine(vectors, palette.dark ? 0.2 : 0.24, 0.8);
    for (const vectors of longitudeGridVectors) drawProjectedLine(vectors, palette.dark ? 0.17 : 0.2, 0.8);
    context.restore();
  }

  function drawLand() {
    context.save();
    context.beginPath();
    context.arc(centerX, centerY, radius * 0.995, 0, Math.PI * 2);
    context.clip();
    context.beginPath();
    for (let index = 0; index < landVectors.length; index += landStride) {
      const vector = landVectors[index];
      const point = projectVector(vector, 0.993);
      if (point.z <= 0) continue;
      const dot = 0.62 + point.z * 0.72;
      context.moveTo(point.x + dot, point.y);
      context.arc(point.x, point.y, dot, 0, Math.PI * 2);
    }
    context.globalAlpha = palette.dark ? 0.72 : 0.6;
    context.fillStyle = palette.land;
    context.fill();

    context.beginPath();
    for (let index = 0; index < landVectors.length; index += mobileGlobe ? 30 : 11) {
      const point = projectVector(landVectors[index], 0.998);
      if (point.z <= 0.18) continue;
      const dot = 0.7 + point.z * 0.52;
      context.moveTo(point.x + dot, point.y);
      context.arc(point.x, point.y, dot, 0, Math.PI * 2);
    }
    context.globalAlpha = palette.dark ? 0.32 : 0.22;
    context.fillStyle = palette.landGlow;
    context.fill();
    context.restore();
  }

  function slerp(from, to, amount) {
    const dot = clamp(from.x * to.x + from.y * to.y + from.z * to.z, -1, 1);
    const angle = Math.acos(dot);
    if (angle < 0.0001) return { ...from };
    const sinAngle = Math.sin(angle);
    const first = Math.sin((1 - amount) * angle) / sinAngle;
    const second = Math.sin(amount * angle) / sinAngle;
    return {
      x: from.x * first + to.x * second,
      y: from.y * first + to.y * second,
      z: from.z * first + to.z * second,
    };
  }

  function drawArc(fromRegion, toRegion, index) {
    const routeKey = `${fromRegion.code}:${fromRegion.lat}:${fromRegion.lng}>${toRegion.code}:${toRegion.lat}:${toRegion.lng}:${index}`;
    let route = arcRouteCache.get(routeKey);
    if (!route) {
      const from = vectorFromLatLng(fromRegion.lat, fromRegion.lng);
      const to = vectorFromLatLng(toRegion.lat, toRegion.lng);
      route = [];
      for (let step = 0; step <= 42; step += 1) {
        const amount = step / 42;
        route.push({
          vector: slerp(from, to, amount),
          altitude: 1.015 + Math.sin(Math.PI * amount) * (0.1 + Math.min(index, 3) * 0.012),
        });
      }
      arcRouteCache.set(routeKey, route);
    }
    context.beginPath();
    let active = false;
    for (const sample of route) {
      const projected = projectVector(sample.vector, sample.altitude);
      if (projected.z <= -0.03) {
        active = false;
        continue;
      }
      if (!active) {
        context.moveTo(projected.x, projected.y);
        active = true;
      } else {
        context.lineTo(projected.x, projected.y);
      }
    }
    context.globalAlpha = palette.dark ? 0.32 : 0.28;
    context.strokeStyle = index % 2 === 0 ? palette.cyan : palette.accent;
    context.lineWidth = 1.1;
    context.stroke();
    context.globalAlpha = 1;
  }

  function markerColor(region) {
    if (region.status === "offline") return palette.red;
    if (region.status === "mixed") return palette.amber;
    return palette.green;
  }

  function drawMarker(region, index, time) {
    const vectorKey = `${region.code}:${region.lat}:${region.lng}`;
    let vector = regionVectorCache.get(vectorKey);
    if (!vector) {
      vector = vectorFromLatLng(region.lat, region.lng);
      regionVectorCache.set(vectorKey, vector);
    }
    const point = projectVector(vector, 1.025);
    if (point.z <= 0) return;
    const color = markerColor(region);
    const depthAlpha = 0.35 + point.z * 0.65;
    const pulse = reducedMotion || mobileGlobe ? 0 : (Math.sin(time / 720 + index * 0.9) + 1) * 0.5;
    const selected = selectedCode === region.code;
    context.save();
    context.globalAlpha = depthAlpha;
    context.shadowColor = color;
    context.shadowBlur = mobileGlobe ? 0 : selected ? 22 : 13;
    context.beginPath();
    context.arc(point.x, point.y, selected ? 6.4 : 4.6, 0, Math.PI * 2);
    context.fillStyle = color;
    context.fill();
    context.shadowBlur = 0;
    context.globalAlpha = depthAlpha * (selected ? 0.8 : 0.42);
    context.beginPath();
    context.arc(point.x, point.y, (selected ? 13 : 9) + pulse * 4, 0, Math.PI * 2);
    context.strokeStyle = color;
    context.lineWidth = selected ? 1.8 : 1.2;
    context.stroke();
    if (selected) {
      context.globalAlpha = Math.min(1, depthAlpha + 0.2);
      context.font = `600 12px ${canvasFont}`;
      context.textAlign = "center";
      context.fillStyle = palette.text;
      context.fillText(`${region.flag} ${region.code}`, point.x, point.y - 18);
    }
    context.restore();
    visibleMarkers.push({ code: region.code, x: point.x, y: point.y, radius: selected ? 20 : 15, depth: point.z });
  }

  function drawSphere() {
    context.save();
    context.fillStyle = haloPaint || "rgba(0,0,0,0)";
    context.beginPath();
    context.arc(centerX, centerY, radius * 1.3, 0, Math.PI * 2);
    context.fill();

    context.beginPath();
    context.arc(centerX, centerY, radius, 0, Math.PI * 2);
    context.fillStyle = spherePaint || (palette.dark ? "#14243f" : "#dbe8fb");
    context.fill();
    context.globalAlpha = palette.dark ? 0.48 : 0.42;
    context.strokeStyle = palette.accent;
    context.lineWidth = 1.2;
    context.stroke();
    context.restore();
  }

  function shortestAngleDelta(target, current) {
    return Math.atan2(Math.sin(target - current), Math.cos(target - current));
  }

  function queueDraw() {
    if (!frameId) frameId = requestAnimationFrame(draw);
  }

  function draw(time) {
    frameId = 0;
    if (document.hidden) {
      if (!mobileGlobe) queueDraw();
      return;
    }
    const frameElapsed = time - previousTime;
    if (targetFrameInterval && frameElapsed < targetFrameInterval) {
      queueDraw();
      return;
    }
    const elapsed = Math.min(48, frameElapsed);
    previousTime = time;
    if (!dragging) {
      if (targetRotation !== null && targetTilt !== null) {
        const rotationDelta = shortestAngleDelta(targetRotation, rotation);
        const tiltDelta = targetTilt - tilt;
        if (Math.abs(rotationDelta) < 0.0005 && Math.abs(tiltDelta) < 0.0005) {
          rotation = targetRotation;
          tilt = targetTilt;
          targetRotation = null;
          targetTilt = null;
        } else {
          rotation += rotationDelta * 0.075;
          tilt += tiltDelta * 0.075;
        }
        spinVelocity = 0;
        tiltVelocity = 0;
      } else {
        const hasMomentum = !reducedMotion && (Math.abs(spinVelocity) > 0.000002 || Math.abs(tiltVelocity) > 0.000002);
        if (hasMomentum) {
          rotation += spinVelocity * elapsed;
          tilt = clamp(tilt + tiltVelocity * elapsed, -0.78, 0.78);
          const decay = Math.pow(0.9, elapsed / (1000 / 60));
          spinVelocity *= decay;
          tiltVelocity *= decay;
          if (Math.abs(spinVelocity) < 0.000002) spinVelocity = 0;
          if (Math.abs(tiltVelocity) < 0.000002) tiltVelocity = 0;
        } else if (!reducedMotion && !selectedCode) {
          rotation += elapsed * 0.000045;
        }
      }
    }

    updateProjectionMatrix();

    context.clearRect(0, 0, width, height);
    drawSphere();
    drawLand();
    drawGrid();

    const selectedRegion = regions.find(region => region.code === selectedCode) || regions.find(region => region.online > 0) || regions[0];
    if (selectedRegion) {
      regions.filter(region => region.code !== selectedRegion.code && region.online > 0).slice(0, mobileGlobe ? 4 : 7).forEach((region, index) => drawArc(selectedRegion, region, index));
    }

    visibleMarkers = [];
    regions.forEach((region, index) => drawMarker(region, index, time));
    const hasMotion = dragging
      || (targetRotation !== null && targetTilt !== null)
      || Math.abs(spinVelocity) > 0.000002
      || Math.abs(tiltVelocity) > 0.000002
      || (!selectedCode && !reducedMotion);
    if (!mobileGlobe || hasMotion) queueDraw();
  }

  function hitTest(x, y) {
    return [...visibleMarkers].sort((a, b) => b.depth - a.depth).find(marker => Math.hypot(marker.x - x, marker.y - y) <= marker.radius) || null;
  }

  function pointerDown(event) {
    dragging = true;
    moved = 0;
    pointerX = event.clientX;
    pointerY = event.clientY;
    pointerTime = performance.now();
    targetRotation = null;
    targetTilt = null;
    spinVelocity = 0;
    tiltVelocity = 0;
    canvas.setPointerCapture?.(event.pointerId);
    canvas.classList.add("is-dragging");
    queueDraw();
  }

  function pointerMove(event) {
    if (!dragging) return;
    const now = performance.now();
    const sampleTime = clamp(now - pointerTime, 8, 64);
    const deltaX = event.clientX - pointerX;
    const deltaY = event.clientY - pointerY;
    pointerX = event.clientX;
    pointerY = event.clientY;
    pointerTime = now;
    moved += Math.abs(deltaX) + Math.abs(deltaY);

    const rotationDelta = -deltaX / Math.max(radius, 1) * 0.85;
    const nextTilt = clamp(tilt + deltaY / Math.max(radius, 1) * 0.7, -0.78, 0.78);
    const tiltDelta = nextTilt - tilt;
    rotation += rotationDelta;
    tilt = nextTilt;
    spinVelocity = clamp(spinVelocity * 0.42 + rotationDelta / sampleTime * 0.58, -0.0045, 0.0045);
    tiltVelocity = clamp(tiltVelocity * 0.42 + tiltDelta / sampleTime * 0.58, -0.003, 0.003);
    queueDraw();
  }

  function pointerUp(event) {
    if (!dragging) return;
    dragging = false;
    canvas.releasePointerCapture?.(event.pointerId);
    canvas.classList.remove("is-dragging");
    if (reducedMotion || event.type === "pointercancel") {
      spinVelocity = 0;
      tiltVelocity = 0;
    }
    if (moved <= 7) {
      spinVelocity = 0;
      tiltVelocity = 0;
      const rect = canvas.getBoundingClientRect();
      const marker = hitTest(event.clientX - rect.left, event.clientY - rect.top);
      if (marker) onSelect(marker.code);
    }
    queueDraw();
  }

  function selectRegion(code) {
    const region = regions.find(entry => entry.code === code);
    if (!region) return;
    selectedCode = code;
    targetRotation = region.lng * degrees;
    targetTilt = clamp(region.lat * degrees * 0.72, -0.58, 0.58);
    spinVelocity = 0;
    tiltVelocity = 0;
    queueDraw();
  }

  function setRegions(nextRegions) {
    regions = nextRegions;
    if (selectedCode && !regions.some(region => region.code === selectedCode)) {
      selectedCode = null;
      targetRotation = null;
      targetTilt = null;
      spinVelocity = 0;
      tiltVelocity = 0;
    }
    queueDraw();
  }

  function setLandVectors(nextVectors) {
    landVectors = nextVectors;
    queueDraw();
  }

  function refreshTheme() {
    palette = readPalette();
    rebuildSpherePaints();
    queueDraw();
  }

  canvas.addEventListener("pointerdown", pointerDown);
  canvas.addEventListener("pointermove", pointerMove);
  canvas.addEventListener("pointerup", pointerUp);
  canvas.addEventListener("pointercancel", pointerUp);
  const resizeObserver = typeof ResizeObserver === "function" ? new ResizeObserver(resize) : null;
  resizeObserver?.observe(canvas);
  window.addEventListener("resize", resize);
  resize();
  queueDraw();

  return {
    destroy() {
      cancelAnimationFrame(frameId);
      resizeObserver?.disconnect();
      window.removeEventListener("resize", resize);
      canvas.removeEventListener("pointerdown", pointerDown);
      canvas.removeEventListener("pointermove", pointerMove);
      canvas.removeEventListener("pointerup", pointerUp);
      canvas.removeEventListener("pointercancel", pointerUp);
    },
    setLandVectors,
    setRegions,
    selectRegion,
    refreshTheme,
  };
}


function nodeSubtitle(node) {
  if (typeof node.public_remark === "string" && node.public_remark.trim()) return node.public_remark.trim();
  const values = [node.region, node.group].filter(value => typeof value === "string" && value.trim());
  return values.join(" · ") || node.os || t("unknown");
}

function nodeTags(node) {
  if (typeof node.tags !== "string") return [];
  return node.tags.split(/[,;|]/).map(tag => tag.trim()).filter(Boolean);
}

function nodeStatus(uuid) {
  return state.statuses[uuid] || null;
}

// 线路名来源：优先 `/api/servers` 的 sysConfig.custom_*_name，回落到 `/api/config`。
function lineSources() {
  return [state.sysConfig, state.cfsmConfig];
}

function nodeIsOnline(uuid) {
  return nodeStatus(uuid)?.online === true;
}

function getNodeByUuid(uuid) {
  return state.nodes.find(node => node.uuid === uuid) || null;
}

function mergeConfig(themeSettings) {
  const source = isRecord(themeSettings) ? themeSettings : {};
  const config = { ...DEFAULT_CONFIG };
  const accepted = {
    color_scheme: ["system", "light", "dark"],
    accent_color: ["indigo", "blue", "teal", "violet", "rose"],
    density: ["comfortable", "compact"],
    corner_style: ["soft", "rounded"],
    default_sort: ["sort_order", "name", "latency", "traffic"],
    offline_position: ["last", "first", "keep"],
  };
  for (const [key, options] of Object.entries(accepted)) {
    if (options.includes(source[key])) config[key] = source[key];
  }
  for (const key of ["background_image", "brand_text", "hero_title", "hero_subtitle", "custom_footer_html"]) {
    if (typeof source[key] === "string") config[key] = source[key];
  }
  for (const key of ["show_network_hero", "show_latency_panel", "show_ip_tags"]) {
    if (typeof source[key] === "boolean") config[key] = source[key];
  }
  config.background_opacity = clamp(source.background_opacity ?? config.background_opacity, 0, 100);
  config.poll_interval = clamp(source.poll_interval ?? config.poll_interval, POLL_INTERVAL_MIN, POLL_INTERVAL_MAX);
  return config;
}

function validBackgroundUrl(value) {
  if (typeof value !== "string" || !value.trim()) return "";
  try {
    const parsed = new URL(value.trim(), location.href);
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed.href : "";
  } catch {
    return "";
  }
}

function resolveTheme() {
  const queryTheme = new URLSearchParams(location.search).get("theme");
  if (["light", "dark"].includes(queryTheme)) return queryTheme;
  const local = safeStorageGet(STORAGE.theme);
  if (["light", "dark"].includes(local)) return local;
  if (state.config.color_scheme === "light" || state.config.color_scheme === "dark") return state.config.color_scheme;
  return matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function applyAppearance() {
  const root = document.documentElement;
  root.dataset.theme = resolveTheme();
  root.dataset.accent = state.config.accent_color;
  root.dataset.density = state.config.density;
  root.dataset.corners = state.config.corner_style;
  const background = validBackgroundUrl(state.config.background_image);
  root.style.setProperty("--custom-background-image", background ? `url(${JSON.stringify(background)})` : "none");
  root.style.setProperty("--custom-background-opacity", background ? String(state.config.background_opacity / 100) : "0");
  const themeMeta = document.querySelector('meta[name="theme-color"]');
  if (themeMeta) themeMeta.content = root.dataset.theme === "dark" ? "#0b0f17" : "#f3f6ff";
}

function setTheme(theme, notify = false) {
  safeStorageSet(STORAGE.theme, theme);
  applyAppearance();
  updateThemeButtons();
  regionGlobeController?.refreshTheme();
  if (notify) showToast(t("appearanceChanged"), theme === "dark" ? t("dark") : t("light"), "info");
}

function updateThemeButtons() {
  document.querySelectorAll('[data-action="toggle-theme"]').forEach(button => {
    const dark = document.documentElement.dataset.theme === "dark";
    button.innerHTML = dark ? icon("sun") : icon("moon");
    button.setAttribute("aria-label", t("themeToggle"));
    button.title = dark ? t("light") : t("dark");
  });
}

function pushSample(uuid, value) {
  const samples = state.nodeSamples.get(uuid) || [];
  samples.push(clamp(value, 0, 100));
  state.nodeSamples.set(uuid, samples.slice(-24));
}

function updateSamples() {
  for (const node of state.nodes) {
    const status = nodeStatus(node.uuid);
    pushSample(node.uuid, status ? status.cpu : 0);
  }
  const current = aggregateMetrics();
  state.networkSamples.push({ upload: current.uploadRate, download: current.downloadRate, time: Date.now() });
  state.networkSamples = state.networkSamples.slice(-36);
}

function aggregateMetrics() {
  const statuses = state.nodes.map(node => nodeStatus(node.uuid)).filter(Boolean);
  const onlineStatuses = statuses.filter(status => status.online === true);
  const online = state.nodes.filter(node => nodeIsOnline(node.uuid)).length;
  const regions = new Set(state.nodes.map(node => String(node.region || "").trim()).filter(Boolean)).size;
  const latencies = onlineStatuses.map(bestLatency).filter(value => value !== null);
  return {
    total: state.nodes.length,
    online,
    offline: Math.max(state.nodes.length - online, 0),
    regions,
    onlineRate: state.nodes.length ? (online / state.nodes.length) * 100 : 0,
    avgLatency: latencies.length ? mean(latencies) : null,
    uploadRate: sum(onlineStatuses.map(status => status.net_in)),
    downloadRate: sum(onlineStatuses.map(status => status.net_out)),
    totalUpload: sum(statuses.map(status => status.net_total_up)),
    totalDownload: sum(statuses.map(status => status.net_total_down)),
    avgCpu: mean(onlineStatuses.map(status => finiteNumber(status.cpu))),
    avgMemory: mean(onlineStatuses.map(status => percent(status.ram, status.ram_total))),
    avgDisk: mean(onlineStatuses.map(status => percent(status.disk, status.disk_total))),
  };
}

function latencyClass(value) {
  if (value === null || !Number.isFinite(value)) return { color: "var(--muted-2)", label: t("noLatency") };
  if (value < 50) return { color: "var(--green)", label: t("excellent") };
  if (value < 100) return { color: "#2ab5a7", label: t("good") };
  if (value < 150) return { color: "var(--amber)", label: t("fair") };
  if (value < 250) return { color: "#e47b4f", label: t("poor") };
  return { color: "var(--red)", label: t("bad") };
}

function sparklinePoints(values, width = 120, height = 48, padding = 3, fixedMax = null) {
  const source = values.length ? values : [0, 0];
  const minimum = fixedMax === null ? Math.min(...source) : 0;
  const maximum = fixedMax === null ? Math.max(...source) : fixedMax;
  const span = Math.max(maximum - minimum, 1);
  return source.map((value, index) => {
    const x = padding + (index / Math.max(source.length - 1, 1)) * (width - padding * 2);
    const y = height - padding - ((finiteNumber(value) - minimum) / span) * (height - padding * 2);
    return `${x.toFixed(2)},${y.toFixed(2)}`;
  }).join(" ");
}

function areaPath(values, width = 120, height = 48, fixedMax = null) {
  const points = sparklinePoints(values, width, height, 3, fixedMax);
  const list = points.split(" ");
  return `M ${list.join(" L ")} L ${width - 3},${height - 2} L 3,${height - 2} Z`;
}

function lineChart(values, className = "node-sparkline", width = 120, height = 80, fixedMax = 100) {
  const source = values.length ? values : [0, 0];
  const points = sparklinePoints(source, width, height, 4, fixedMax);
  const last = points.split(" ").at(-1).split(",");
  return `<svg class="${className}" viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" aria-hidden="true">
    <path class="area" d="${areaPath(source, width, height, fixedMax)}"/>
    <polyline class="line" points="${points}"/>
    <circle class="last-dot" cx="${last[0]}" cy="${last[1]}" r="2.8"/>
  </svg>`;
}

function dualLineChart(first, second, width = 620, height = 130) {
  const all = [...first, ...second];
  const maximum = Math.max(...all, 1);
  const p1 = sparklinePoints(first.length ? first : [0, 0], width, height, 6, maximum);
  const p2 = sparklinePoints(second.length ? second : [0, 0], width, height, 6, maximum);
  return `<svg viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" aria-hidden="true">
    <path class="area" d="${areaPath(first.length ? first : [0, 0], width, height, maximum)}"/>
    <polyline class="line" points="${p1}"/>
    <polyline class="line-secondary" points="${p2}"/>
  </svg>`;
}

function trafficChartPoints(values, maximum, width = 1000, height = 240) {
  const source = values.length > 1 ? values : [values[0] || 0, values[0] || 0];
  const safeMaximum = Math.max(1, maximum);
  return source.map((value, index) => {
    const x = (index / Math.max(source.length - 1, 1)) * width;
    const y = height - clamp(value / safeMaximum, 0, 1) * height;
    return `${x.toFixed(2)},${y.toFixed(2)}`;
  }).join(" ");
}

function trafficAreaPath(values, maximum, width = 1000, height = 240) {
  const points = trafficChartPoints(values, maximum, width, height).split(" ");
  return `M ${points.join(" L ")} L ${width},${height} L 0,${height} Z`;
}

function radialRing(value) {
  const percentage = clamp(value, 0, 100);
  const radius = 25;
  const circumference = 2 * Math.PI * radius;
  const offset = circumference * (1 - percentage / 100);
  return `<div class="metric-ring">
    <svg viewBox="0 0 60 60" aria-hidden="true"><circle class="metric-ring-track" cx="30" cy="30" r="${radius}"/><circle class="metric-ring-value" cx="30" cy="30" r="${radius}" stroke-dasharray="${circumference.toFixed(2)}" stroke-dashoffset="${offset.toFixed(2)}"/></svg>
    <span class="metric-ring-label">${Math.round(percentage)}%</span>
  </div>`;
}

function renderLoading() {
  app.innerHTML = `<main class="loading-screen" aria-busy="true"><section class="loading-card">
    <div class="loading-logo">${butterflyLogo()}</div>
    <h1>Komari Butterfly</h1>
    <p>${escapeHtml(t("dashboardSubtitle"))}</p>
    <div class="loading-progress" aria-label="Loading"></div>
  </section></main>`;
}

function renderFatalError() {
  app.innerHTML = `<main class="loading-screen"><section class="loading-card" role="alert">
    <div class="loading-logo">${icon("warning", 34)}</div>
    <h1>${escapeHtml(t("loadFailedTitle"))}</h1>
    <p>${escapeHtml(t("loadFailedCopy"))}</p>
    <button class="primary-button" type="button" data-action="retry">${icon("refresh", 15)}${escapeHtml(t("retry"))}</button>
  </section></main>`;
}

function captureRenderContinuity() {
  const activeElement = document.activeElement;
  const activeInput = activeElement instanceof HTMLInputElement ? activeElement : null;
  const activeSelect = activeElement instanceof HTMLSelectElement ? activeElement : null;
  return {
    statusScrollLeft: document.querySelector(".status-ribbon")?.scrollLeft ?? null,
    filterScrollLeft: document.querySelector(".filter-group")?.scrollLeft ?? null,
    drawerScrollTop: document.querySelector(".drawer-scroll")?.scrollTop ?? null,
    activeId: activeInput?.id || activeSelect?.id || "",
    selectionStart: activeInput?.selectionStart ?? null,
    selectionEnd: activeInput?.selectionEnd ?? null,
  };
}

function restoreRenderContinuity(snapshot) {
  requestAnimationFrame(() => {
    const statusRibbon = document.querySelector(".status-ribbon");
    if (statusRibbon && snapshot.statusScrollLeft !== null) statusRibbon.scrollLeft = snapshot.statusScrollLeft;

    const filterGroup = document.querySelector(".filter-group");
    if (filterGroup && snapshot.filterScrollLeft !== null) filterGroup.scrollLeft = snapshot.filterScrollLeft;

    const drawerScroll = document.querySelector(".drawer-scroll");
    if (drawerScroll && state.drawerUuid && snapshot.drawerScrollTop !== null) drawerScroll.scrollTop = snapshot.drawerScrollTop;

    if (!snapshot.activeId || (snapshot.activeId === "mobile-search" && !state.mobileSearchOpen)) return;
    const nextActive = document.getElementById(snapshot.activeId);
    if (!(nextActive instanceof HTMLInputElement || nextActive instanceof HTMLSelectElement)) return;
    nextActive.focus({ preventScroll: true });
    if (nextActive instanceof HTMLInputElement && snapshot.selectionStart !== null && snapshot.selectionEnd !== null) {
      nextActive.setSelectionRange(snapshot.selectionStart, snapshot.selectionEnd);
    }
  });
}

function renderApp() {
  if (mobileStatusRenderTimer !== null) {
    clearTimeout(mobileStatusRenderTimer);
    mobileStatusRenderTimer = null;
  }
  const continuity = captureRenderContinuity();
  const metrics = aggregateMetrics();
  const brand = state.config.brand_text.trim() || String(state.publicInfo.sitename || "CF-Server-Monitor");
  const currentViewTitle = t(state.currentView === "favorites" ? "favorites" : state.currentView);
  const userName = state.userInfo?.logged_in ? state.userInfo.username || "Admin" : t("signIn");
  const sidebarClass = state.sidebarCollapsed ? " sidebar-collapsed" : "";
  const openClass = state.sidebarOpen ? " sidebar-open" : "";
  const alerts = buildAlerts();
  const alertCount = alerts.length;
  const viewClass = ` view-${state.currentView}`;
  const overlayClass = state.drawerUuid ? " has-mobile-overlay" : "";
  const mobileNavClass = mobileNavHidden ? " mobile-nav-hidden" : "";
  const mobileSearchClass = state.mobileSearchOpen ? " mobile-search-active" : "";

  app.innerHTML = `<div class="app-shell${sidebarClass}${openClass}${viewClass}${overlayClass}${mobileNavClass}${mobileSearchClass}">
    <aside class="app-sidebar" aria-label="Primary navigation">
      <div class="sidebar-head">
        <a class="brand-mark" href="/" aria-label="${escapeHtml(brand)}">${butterflyLogo()}</a>
        <div class="brand-copy"><div class="brand-name">${escapeHtml(brand)}</div><div class="brand-subtitle">Butterfly</div></div>
        <button class="sidebar-toggle" type="button" data-action="toggle-sidebar" aria-label="${escapeHtml(state.sidebarCollapsed ? t("expandSidebar") : t("collapseSidebar"))}" title="${escapeHtml(state.sidebarCollapsed ? t("expandSidebar") : t("collapseSidebar"))}">${icon("panelLeft")}</button>
      </div>
      <div class="sidebar-scroll">
        <div class="sidebar-section-title">${escapeHtml(t("monitor"))}</div>
        <nav class="sidebar-nav">
          ${navItem("overview", "overview")}
          ${navItem("regions", "regions")}
          ${navItem("traffic", "traffic")}
          ${navItem("favorites", "favorites")}
          ${navItem("about", "about")}
        </nav>
      </div>
      <div class="sidebar-bottom">
        <a class="sidebar-user" href="/admin#admin">
          <div class="user-avatar">${escapeHtml(initials(userName))}</div>
          <div class="sidebar-user-copy"><div class="sidebar-user-name">${escapeHtml(userName)}</div><div class="sidebar-user-state">${escapeHtml(state.userInfo?.logged_in ? t("admin") : t("poweredBy"))}</div></div>
          <span class="sidebar-user-chevron">${icon("chevronRight", 15)}</span>
        </a>
      </div>
    </aside>
    <button class="sidebar-scrim" type="button" data-action="close-sidebar" aria-label="${escapeHtml(t("close"))}"></button>
    <main class="app-main">
      <header class="topbar${state.mobileSearchOpen ? " is-mobile-search-open" : ""}${state.notificationsOpen ? " is-notification-open" : ""}">
        <button class="mobile-brand" type="button" data-view="overview">
          <span class="mobile-brand-mark">${butterflyLogo()}</span>
          <span class="mobile-brand-copy"><strong>${escapeHtml(brand)}</strong><small>${escapeHtml(currentViewTitle)}</small></span>
        </button>
        <div class="page-heading"><div class="page-heading-title">${escapeHtml(currentViewTitle)}</div><div class="page-heading-subtitle">${escapeHtml(t("dashboardSubtitle"))}</div></div>
        <label class="top-search desktop-top-search">${icon("search")}<span class="sr-only">${escapeHtml(t("searchPlaceholder"))}</span><input id="global-search" type="search" value="${escapeHtml(state.query)}" placeholder="${escapeHtml(t("searchPlaceholder"))}" autocomplete="off" autocapitalize="none" spellcheck="false" enterkeyhint="search"/><span class="search-shortcut">Ctrl K</span></label>
        <div class="top-actions">
          ${state.demoMode ? `<span class="demo-badge">${escapeHtml(t("demoMode"))}</span>` : ""}
          <button class="icon-button" type="button" data-action="open-settings" aria-expanded="${state.settingsOpen}" aria-label="${escapeHtml(t("themeSettings"))}" title="${escapeHtml(t("themeSettings"))}">${icon("settings")}</button>
          <button class="icon-button" type="button" data-action="refresh" aria-label="${escapeHtml(t("refresh"))}">${icon("refresh")}</button>
          <button class="icon-button mobile-search-button" type="button" data-action="toggle-mobile-search" aria-expanded="${state.mobileSearchOpen}" aria-label="${escapeHtml(t("mobileSearch"))}">${icon("search")}</button>
          <button class="icon-button" type="button" data-action="toggle-theme" aria-label="${escapeHtml(t("themeToggle"))}"></button>
          <button class="icon-button notification-button${alertCount ? " has-dot" : ""}${state.notificationsOpen ? " is-active" : ""}" type="button" data-action="toggle-notifications" aria-expanded="${state.notificationsOpen}" aria-controls="notification-popover" aria-label="${escapeHtml(t("recentAlerts"))}">${icon("bell")}</button>
          <a class="action-button" href="/admin#admin">${icon("user", 16)}<span>${escapeHtml(state.userInfo?.logged_in ? t("admin") : t("signIn"))}</span></a>
        </div>
        ${state.notificationsOpen ? renderNotificationPopover(alerts) : ""}
        <div class="mobile-search-row">
          <label class="mobile-search-field">${icon("search")}<span class="sr-only">${escapeHtml(t("searchNodes"))}</span><input id="mobile-search" type="search" value="${escapeHtml(state.query)}" placeholder="${escapeHtml(t("searchNodes"))}" autocomplete="off" autocapitalize="none" spellcheck="false" enterkeyhint="search"/></label>
          <button class="icon-button mobile-search-close" type="button" data-action="close-mobile-search" aria-label="${escapeHtml(t("closeSearch"))}">${icon("close")}</button>
        </div>
      </header>
      <div class="content-shell">
        ${renderCurrentView(metrics)}
        ${renderFooter()}
      </div>
    </main>
    ${renderMobileNav()}
    <div class="toast-stack" aria-live="polite"></div>
    <div class="drawer-backdrop${state.drawerUuid ? " is-open" : ""}" data-action="close-drawer"></div>
    <aside class="node-drawer${state.drawerUuid ? " is-open" : ""}" aria-label="${escapeHtml(t("nodeDetails"))}">${state.drawerUuid ? renderDrawer() : ""}</aside>
    ${renderSettingsPanel()}
  </div>`;
  updateThemeButtons();
  refreshOpenGlobe();
  restoreRenderContinuity(continuity);
  requestAnimationFrame(updateMobileNavVisibility);
  scheduleMobileInputState();
}

function navItem(view, iconName, badge = null) {
  const active = state.currentView === view;
  return `<button class="nav-item${active ? " is-active" : ""}" type="button" data-view="${view}">
    <span class="nav-icon">${icon(iconName)}</span><span class="sidebar-label">${escapeHtml(t(view))}</span>${badge ? `<span class="nav-badge">${badge}</span>` : ""}
  </button>`;
}

function renderCurrentView(metrics) {
  if (state.currentView === "regions") return renderRegionsView(metrics);
  if (state.currentView === "traffic") return renderTrafficView(metrics);
  if (state.currentView === "favorites") return renderFavoritesView(metrics);
  if (state.currentView === "about") return renderAboutView();
  return renderDashboard(metrics);
}

function renderDashboard(metrics) {
  const degraded = metrics.offline > 0 || buildAlerts().some(alert => alert.severity === "warning");
  return `${renderStatusRibbon(metrics)}
    ${(state.config.show_network_hero || state.config.show_latency_panel) ? `<section class="dashboard-top" style="${!state.config.show_network_hero || !state.config.show_latency_panel ? "grid-template-columns:1fr" : ""}">
      ${state.config.show_network_hero ? renderHero(metrics, degraded) : ""}
      ${state.config.show_latency_panel ? renderLatencyPanel() : ""}
    </section>` : ""}
    ${renderToolbar(metrics)}
    <section class="content-grid">
      ${renderNodeGrid()}
      ${renderAlertsPanel()}
    </section>`;
}

function renderStatusRibbon(metrics) {
  const now = new Date();
  const time = now.toLocaleTimeString(state.language, { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
  const onlineLabel = `${metrics.online} / ${metrics.total}`;
  const latency = metrics.avgLatency === null ? t("noLatency") : `${Math.round(metrics.avgLatency)} ms`;
  const samples = state.networkSamples.map(sample => sample.download);
  return `<section class="status-ribbon">
    <article class="metric-card" style="--metric-glow:var(--green-soft)"><div class="metric-card-title">${escapeHtml(t("liveStatus"))}</div><div class="metric-card-value" data-live-clock>${escapeHtml(time)}</div><div class="metric-card-foot"><span class="metric-dot"></span><span data-updated-label>${escapeHtml(updatedLabel())}</span></div></article>
    <article class="metric-card"><div class="metric-card-inner-split"><div><div class="metric-card-title">${escapeHtml(t("onlineNodes"))}</div><div class="metric-card-value">${escapeHtml(onlineLabel)}</div><div class="metric-card-foot">${escapeHtml(`${Math.round(metrics.onlineRate)}% ${t("online")}`)}</div></div>${radialRing(metrics.onlineRate)}</div></article>
    <article class="metric-card" style="--metric-glow:rgba(83,100,244,.10)"><div class="metric-card-title">${escapeHtml(t("regionsMetric"))}</div><div class="metric-card-value">${metrics.regions}</div><div class="metric-card-foot">${icon("globe", 13)} ${escapeHtml(t("globalCoverage"))}</div></article>
    <article class="metric-card" style="--metric-glow:var(--green-soft)"><div class="metric-card-title">${escapeHtml(t("totalTraffic"))}</div><div class="metric-dual"><div class="metric-dual-row"><span class="direction">↑</span>${escapeHtml(formatBytes(metrics.totalUpload))}</div><div class="metric-dual-row"><span class="direction">↓</span>${escapeHtml(formatBytes(metrics.totalDownload))}</div></div></article>
    <article class="metric-card" style="--metric-glow:rgba(56,191,193,.12)"><div class="metric-card-title">${escapeHtml(t("networkSpeed"))}</div><div class="metric-dual"><div class="metric-dual-row"><span class="direction">↑</span>${escapeHtml(formatRate(metrics.uploadRate))}</div><div class="metric-dual-row"><span class="direction">↓</span>${escapeHtml(formatRate(metrics.downloadRate))}</div></div>${samples.length ? `<svg class="metric-sparkline" viewBox="0 0 120 39" preserveAspectRatio="none" aria-hidden="true"><path class="area" d="${areaPath(samples, 120, 39)}"/><polyline class="line" points="${sparklinePoints(samples, 120, 39)}"/></svg>` : ""}</article>
  </section>`;
}

function renderHero(metrics, degraded) {
  return `<article class="hero-panel panel">
    <div class="hero-copy">
      <div class="hero-eyebrow"><span class="hero-eyebrow-dot"></span>${escapeHtml(t("realtimeMonitoring"))}</div>
      <h1 class="hero-title">${escapeHtml(state.config.hero_title || DEFAULT_CONFIG.hero_title)}</h1>
      <p class="hero-subtitle">${escapeHtml(state.config.hero_subtitle || DEFAULT_CONFIG.hero_subtitle)}</p>
      <button class="hero-button" type="button" data-action="open-globe">${escapeHtml(t("viewNodes"))}${icon("arrowRight", 15)}</button>
    </div>
    <div class="hero-status${degraded ? " has-warning" : ""}">${degraded ? icon("warning", 13) : icon("check", 13)}${escapeHtml(degraded ? t("degraded", { count: metrics.offline }) : t("operational"))}</div>
    ${networkArt()}
  </article>`;
}

function latencyBuckets() {
  const values = state.nodes.map(node => bestLatency(nodeStatus(node.uuid))).filter(value => value !== null);
  const buckets = [0, 0, 0, 0, 0];
  for (const value of values) {
    if (value <= 100) buckets[0] += 1;
    else if (value <= 150) buckets[1] += 1;
    else if (value <= 250) buckets[2] += 1;
    else if (value <= 300) buckets[3] += 1;
    else buckets[4] += 1;
  }
  return { values, buckets };
}

// 线路级摘要（电信/联通/移动/BGP，名称取自 CFSM 的 custom_*_name）：只统计在线机器；
// 某条线路在所有机器上都没有数值时整块不渲染（未配置的线路 CFSM 会给 false）。
function lineSummary() {
  const rows = new Map();
  for (const node of state.nodes) {
    const status = nodeStatus(node.uuid);
    if (!status || status.online !== true) continue;
    for (const [id, line] of Object.entries(status.ping || {})) {
      if (!isRecord(line)) continue;
      const entry = rows.get(id) || { id, name: line.name || id, values: [], loss: 0 };
      if (typeof line.name === "string" && line.name) entry.name = line.name;
      if (Number.isFinite(line.latest)) entry.values.push(line.latest);
      if (Number.isFinite(line.loss)) entry.loss = Math.max(entry.loss, line.loss);
      rows.set(id, entry);
    }
  }
  return [...rows.values()]
    .map(entry => ({
      ...entry,
      average: entry.values.length ? entry.values.reduce((total, value) => total + value, 0) / entry.values.length : null,
      best: entry.values.length ? Math.min(...entry.values) : null,
      nodes: entry.values.length,
    }))
    .sort((a, b) => (a.average ?? Number.POSITIVE_INFINITY) - (b.average ?? Number.POSITIVE_INFINITY));
}

function renderLineSummary() {
  const lines = lineSummary();
  if (!lines.length) return "";
  const items = lines
    .map(line => `<div class="line-summary-item"><span class="line-summary-name">${escapeHtml(line.name)}</span><span class="line-summary-metrics"><span class="line-summary-avg">${line.average === null ? escapeHtml(t("noLatency")) : `${Math.round(line.average)} ms`}</span><span class="line-summary-best">min ${line.best === null ? "—" : `${Math.round(line.best)} ms`}</span><span class="line-summary-loss${line.loss > 0 ? " is-warm" : ""}">${line.loss.toFixed(1)}%</span></span></div>`)
    .join("");
  return `<div class="line-summary"><div class="line-summary-title">${escapeHtml(t("threeNetLatency"))}</div>${items}</div>`;
}

function renderLatencyPanel() {
  const { values, buckets } = latencyBuckets();
  const histogram = Array.from({ length: 24 }, (_, index) => {
    const lower = index * 16;
    const upper = lower + 16;
    return values.filter(value => value >= lower && (index === 23 ? true : value < upper)).length;
  });
  const max = Math.max(...histogram, 1);
  const labels = [t("excellent"), t("good"), t("fair"), t("poor"), t("bad")];
  const ranges = ["1–100ms", "100–150ms", "150–250ms", "250–300ms", "300ms+"];
  return `<article class="latency-panel panel">
    <div class="panel-heading"><div class="panel-title panel-title-accent">${escapeHtml(t("latencyDistribution"))}</div><span class="connection-pill${state.connected ? "" : " is-offline"}">${escapeHtml(state.connected ? t("connected") : t("disconnected"))}</span></div>
    <div class="latency-chart">${histogram.map((count, index) => `<span class="latency-bar-wrap"><span class="latency-bar${index > 9 ? " is-warm" : ""}" style="height:${Math.max(6, (count / max) * 100)}%;animation-delay:${index * 18}ms"></span></span>`).join("")}</div>
    <div class="latency-axis">${ranges.map(range => `<span>${escapeHtml(range)}</span>`).join("")}</div>
    <div class="latency-legend">${buckets.map((count, index) => `<div class="latency-legend-item"><div class="latency-legend-value">${count}</div><div class="latency-legend-label">${escapeHtml(labels[index])}</div></div>`).join("")}</div>
    ${renderLineSummary()}
  </article>`;
}

function renderToolbar(metrics) {
  const searchLabel = matchMedia(MOBILE_LAYOUT_QUERY).matches ? t("searchCompact") : t("searchNodes");
  return `<section class="toolbar-panel">
    <div class="filter-group">
      ${filterChip("all", t("all"), metrics.total)}
      ${filterChip("online", t("online"), metrics.online)}
      ${filterChip("offline", t("offline"), metrics.offline)}
      ${filterChip("favorites", t("favorites"), state.favorites.size)}
    </div>
    <div class="toolbar-spacer"></div>
    <label class="toolbar-search">${icon("search", 14)}<span class="sr-only">${escapeHtml(searchLabel)}</span><input id="node-search" type="search" value="${escapeHtml(state.query)}" placeholder="${escapeHtml(searchLabel)}" autocomplete="off" autocapitalize="none" spellcheck="false" enterkeyhint="search"/></label>
    <select class="toolbar-select" id="node-sort" aria-label="${escapeHtml(t("sortBy"))}">
      ${sortOption("sort_order", "sortWeight")}${sortOption("name", "sortName")}${sortOption("latency", "sortLatency")}${sortOption("traffic", "sortTraffic")}
    </select>
    <button class="compact-button" type="button" data-action="refresh" aria-label="${escapeHtml(t("refresh"))}">${icon("refresh", 15)}</button>
    <div class="view-toggle"><button class="view-button${state.cardMode === "grid" ? " is-active" : ""}" type="button" data-card-mode="grid" aria-label="${escapeHtml(t("gridView"))}">${icon("grid", 15)}</button><button class="view-button${state.cardMode === "list" ? " is-active" : ""}" type="button" data-card-mode="list" aria-label="${escapeHtml(t("listView"))}">${icon("list", 15)}</button></div>
  </section>`;
}

function filterChip(filter, label, count) {
  const active = state.filter === filter || (state.currentView === "favorites" && filter === "favorites");
  return `<button class="filter-chip${active ? " is-active" : ""}" type="button" data-filter="${filter}">${escapeHtml(label)}<span class="filter-count">${count}</span></button>`;
}

function sortOption(value, labelKey) {
  const label = matchMedia(MOBILE_LAYOUT_QUERY).matches ? t(labelKey) : t("sortBy") + t(labelKey);
  return `<option value="${value}"${state.sort === value ? " selected" : ""}>${escapeHtml(label)}</option>`;
}

function filteredNodes() {
  const query = state.query.trim().toLocaleLowerCase(state.language);
  const activeFilter = state.currentView === "favorites" ? "favorites" : state.filter;
  const nodes = state.nodes.filter(node => {
    if (activeFilter === "online" && !nodeIsOnline(node.uuid)) return false;
    if (activeFilter === "offline" && nodeIsOnline(node.uuid)) return false;
    if (activeFilter === "favorites" && !state.favorites.has(node.uuid)) return false;
    if (!query) return true;
    const haystack = [node.name, node.region, node.group, node.tags, node.public_remark, node.os, node.cpu_name].filter(Boolean).join(" ").toLocaleLowerCase(state.language);
    return haystack.includes(query);
  });

  const offlinePosition = state.config.offline_position;
  return nodes.sort((a, b) => {
    const aOnline = nodeIsOnline(a.uuid);
    const bOnline = nodeIsOnline(b.uuid);
    if (offlinePosition !== "keep" && aOnline !== bOnline) {
      return offlinePosition === "first" ? (aOnline ? 1 : -1) : (aOnline ? -1 : 1);
    }
    if (state.sort === "name") return String(a.name || "").localeCompare(String(b.name || ""), state.language);
    if (state.sort === "latency") {
      const aLatency = bestLatency(nodeStatus(a.uuid));
      const bLatency = bestLatency(nodeStatus(b.uuid));
      return (aLatency ?? Number.POSITIVE_INFINITY) - (bLatency ?? Number.POSITIVE_INFINITY);
    }
    if (state.sort === "traffic") {
      const aStatus = nodeStatus(a.uuid) || {};
      const bStatus = nodeStatus(b.uuid) || {};
      return (finiteNumber(bStatus.net_in) + finiteNumber(bStatus.net_out)) - (finiteNumber(aStatus.net_in) + finiteNumber(aStatus.net_out));
    }
    // 原主题按 weight 排序；CFSM 用 sort_order 填充 node.weight，保持同一路径
    return finiteNumber(b.weight) - finiteNumber(a.weight);
  });
}

function renderNodeGrid() {
  const nodes = filteredNodes();
  if (!nodes.length) {
    return `<section class="empty-card"><div><div class="empty-card-icon">${icon("filter", 28)}</div><h2>${escapeHtml(t("noNodesTitle"))}</h2><p>${escapeHtml(t("noNodesCopy"))}</p><button class="secondary-button" type="button" data-action="clear-filters">${escapeHtml(t("clearFilters"))}</button></div></section>`;
  }
  return `<section class="node-grid${state.cardMode === "list" ? " is-list" : ""}">${nodes.map((node, index) => renderNodeCard(node, index)).join("")}</section>`;
}

function renderNodeCard(node, index) {
  const status = nodeStatus(node.uuid) || {};
  const online = status.online === true;
  const cpu = clamp(status.cpu, 0, 100);
  const memory = percent(status.ram, status.ram_total || node.mem_total);
  const disk = percent(status.disk, status.disk_total || node.disk_total);
  const latency = bestLatency(status);
  const latencyInfo = latencyClass(latency);
  const colors = ["var(--accent)", "#2aa6d6", "#8a61e8", "#ec8d3d", "#2ab59b", "#d35f91", "#4f83e6", "#e06067"];
  const color = colors[index % colors.length];
  const samples = state.nodeSamples.get(node.uuid) || [cpu, cpu];
  const favorite = state.favorites.has(node.uuid);
  const totalTraffic = finiteNumber(status.net_total_up) + finiteNumber(status.net_total_down);
  // CFSM 的 ip_v4/ip_v6 是可达性标志（"1"/"0"），不是地址文本 → 渲染成协议徽标
  const protocolTags = state.config.show_ip_tags
    ? [node.cfsm?.ipV4 === "1" ? `<span class="ip-tag">IPv4</span>` : "", node.cfsm?.ipV6 === "1" ? `<span class="ip-tag is-v6">IPv6</span>` : ""].join("")
    : "";
  const nodeName = String(node.name || node.uuid);
  return `<article class="node-card${online ? "" : " is-offline"}" style="--node-accent:${color}">
    <button class="node-card-open" type="button" data-node-uuid="${escapeHtml(node.uuid)}" aria-label="${escapeHtml(`${nodeName} · ${t("nodeDetails")}`)}"></button>
    <div class="node-card-top">
      <span class="node-flag">${regionFlag(node.region)}</span>
      <div class="node-heading"><div class="node-name-row"><span class="node-status-dot"></span><span class="node-name">${escapeHtml(nodeName)}</span></div><div class="node-subtitle">${escapeHtml(nodeSubtitle(node))}</div></div>
      <span class="latency-pill" style="--latency-color:${latencyInfo.color}">${latency === null ? t("noLatency") : `${Math.round(latency)}ms`}</span>
    </div>
    <button class="favorite-button${favorite ? " is-active" : ""}" type="button" data-favorite-uuid="${escapeHtml(node.uuid)}" aria-label="${escapeHtml(t("favorites"))}">${icon("favorites", 16)}</button>
    <div class="node-main">
      <div class="node-meters">${meter(t("cpu"), cpu)}${meter(t("memory"), memory)}${meter(t("disk"), disk, disk > 82 ? "var(--red)" : undefined)}</div>
      ${lineChart(samples)}
    </div>
    ${protocolTags ? `<div class="ip-tags">${protocolTags}</div>` : ""}
    ${renderRemainingTraffic(node)}
    <div class="node-footer"><span class="node-footer-item">↑ ${escapeHtml(formatRate(status.net_in))} · ↓ ${escapeHtml(formatRate(status.net_out))}</span><span class="node-footer-item">${escapeHtml(formatBytes(totalTraffic))}</span><span class="node-footer-item">${escapeHtml(formatDuration(status.uptime))}</span></div>
  </article>`;
}

// 剩余流量条：限额为空或 ≤0 的机器（实例中"香港Azure""日本Azure"）降级显示当月已用，
// 不画进度条、不出现 NaN。
function renderRemainingTraffic(node) {
  const remaining = node?.cfsm?.remaining;
  if (!remaining) return "";
  if (remaining.degraded) {
    return `<div class="node-traffic is-degraded"><div class="node-traffic-head"><span class="node-traffic-label">${escapeHtml(t("usedThisMonth"))}</span><span class="node-traffic-value">${escapeHtml(formatBytes(remaining.usedBytes, 2))}</span></div></div>`;
  }
  const percentUsed = clamp(remaining.percent ?? 0, 0, 100);
  const rawPercent = Number.isFinite(remaining.percent) ? remaining.percent : 0;
  const tone = rawPercent >= 95 ? " is-danger" : rawPercent >= 80 ? " is-warm" : "";
  const resetText = remaining.resetDay ? t("monthReset", { day: remaining.resetDay }) : "";
  return `<div class="node-traffic${tone}"${resetText ? ` title="${escapeHtml(resetText)}"` : ""}><div class="node-traffic-head"><span class="node-traffic-label">${escapeHtml(t("remainingTraffic"))}</span><span class="node-traffic-value">${escapeHtml(formatBytes(remaining.remainingBytes, 2))}<small>${escapeHtml(`${rawPercent.toFixed(1)}%`)}</small></span></div><div class="node-traffic-track"><div class="node-traffic-usage" style="width:${percentUsed.toFixed(2)}%"></div></div></div>`;
}

function meter(label, value, color) {
  return `<div class="meter-row"><div class="meter-label"><span>${escapeHtml(label)}</span><strong>${formatPercent(value)}</strong></div><div class="meter-track"><div class="meter-value" style="width:${clamp(value, 0, 100)}%;${color ? `--meter-color:${color}` : ""}"></div></div></div>`;
}

function buildAlerts() {
  const alerts = [];
  for (const node of state.nodes) {
    const status = nodeStatus(node.uuid);
    if (!status || status.online !== true) {
      alerts.push({ uuid: node.uuid, title: node.name || node.uuid, message: t("maintenance"), severity: "offline", time: node.updated_at || new Date().toISOString() });
      continue;
    }
    const cpu = clamp(status.cpu, 0, 100);
    const memory = percent(status.ram, status.ram_total || node.mem_total);
    const disk = percent(status.disk, status.disk_total || node.disk_total);
    const loss = bestLoss(status);
    if (cpu >= 85) alerts.push({ uuid: node.uuid, title: node.name || node.uuid, message: t("highCpu", { value: Math.round(cpu) }), severity: "warning", time: status.time });
    if (memory >= 90) alerts.push({ uuid: node.uuid, title: node.name || node.uuid, message: t("highMemory", { value: Math.round(memory) }), severity: "warning", time: status.time });
    if (disk >= 90) alerts.push({ uuid: node.uuid, title: node.name || node.uuid, message: t("highDisk", { value: Math.round(disk) }), severity: "danger", time: status.time });
    if (loss > 0) alerts.push({ uuid: node.uuid, title: node.name || node.uuid, message: t("packetLoss", { value: Math.round(loss * 10) / 10 }), severity: "warning", time: status.time });
  }
  return alerts.sort((a, b) => new Date(b.time || 0) - new Date(a.time || 0));
}

function renderNotificationPopover(alerts = buildAlerts()) {
  const visible = alerts.slice(0, 8);
  return `<button class="notification-scrim" type="button" data-action="close-notifications" aria-label="${escapeHtml(t("close"))}"></button>
    <section class="notification-popover" id="notification-popover" role="dialog" aria-modal="false" aria-label="${escapeHtml(t("recentAlerts"))}" tabindex="-1">
      <header class="notification-popover-head">
        <span class="notification-heading-icon">${icon("bell", 17)}</span>
        <span class="notification-heading-copy"><strong>${escapeHtml(t("recentAlerts"))}</strong><small>${alertCountLabel(alerts.length)}</small></span>
        <button class="notification-close" type="button" data-action="close-notifications" aria-label="${escapeHtml(t("close"))}">${icon("close", 15)}</button>
      </header>
      ${visible.length ? `<div class="notification-list">${visible.map(alert => {
        const color = alert.severity === "danger" ? "var(--red)" : alert.severity === "offline" ? "var(--muted-2)" : "var(--amber)";
        return `<button class="notification-item" type="button" data-node-uuid="${escapeHtml(alert.uuid)}">
          <span class="notification-item-icon" style="--notification-color:${color}">${icon(alert.severity === "offline" ? "info" : "warning", 14)}</span>
          <span class="notification-item-copy"><strong>${escapeHtml(alert.title)}</strong><small>${escapeHtml(alert.message)}</small></span>
          <time>${escapeHtml(formatRelativeTime(alert.time))}</time>
        </button>`;
      }).join("")}</div>
      <button class="notification-view-all" type="button" data-action="view-alerts-panel">${escapeHtml(t("viewAll"))}${icon("arrowRight", 14)}</button>` : `<div class="notification-empty"><span>${icon("shield", 25)}</span><strong>${escapeHtml(t("noAlerts"))}</strong></div>`}
    </section>`;
}

function alertCountLabel(count) {
  if (state.language === "zh-CN") return `${count} 条通知`;
  if (state.language === "ja") return `${count} 件の通知`;
  return `${count} notification${count === 1 ? "" : "s"}`;
}

function renderAlertsPanel() {
  const alerts = buildAlerts().slice(0, 4);
  return `<section class="dashboard-alerts side-panel panel" id="alerts-panel"><div class="panel-heading"><div class="panel-title panel-title-accent">${escapeHtml(t("recentAlerts"))}</div><button class="panel-link" type="button" data-action="toggle-notifications">${escapeHtml(t("viewAll"))}</button></div>
    ${alerts.length ? `<div class="alert-list">${alerts.map(alert => {
      const color = alert.severity === "danger" ? "var(--red)" : alert.severity === "offline" ? "var(--muted-2)" : "var(--amber)";
      return `<button class="alert-item" type="button" data-node-uuid="${escapeHtml(alert.uuid)}"><span class="alert-icon" style="--alert-color:${color}">${icon(alert.severity === "offline" ? "info" : "warning", 13)}</span><span><span class="alert-title">${escapeHtml(alert.title)}</span><span class="alert-message">${escapeHtml(alert.message)}</span></span><span class="alert-time">${escapeHtml(formatRelativeTime(alert.time))}</span></button>`;
    }).join("")}</div>` : `<div class="no-alerts"><div>${icon("shield", 25)}<span>${escapeHtml(t("noAlerts"))}</span></div></div>`}
  </section>`;
}

function renderFooter() {
  if (state.config.custom_footer_html.trim()) return `<footer class="app-footer"><div class="custom-footer">${state.config.custom_footer_html}</div></footer>`;
  return `<footer class="app-footer"><span>${escapeHtml(t("footer", { theme: THEME_VERSION, komari: state.version.version || "unknown" }))}</span><span class="footer-links"><a href="${THEME_REPOSITORY}" target="_blank" rel="noreferrer">GitHub</a><a href="/admin#admin">${escapeHtml(t("admin"))}</a></span></footer>`;
}

function groupByRegion() {
  const groups = new Map();
  for (const node of state.nodes) {
    const key = typeof node.region === "string" && node.region.trim() ? node.region.trim() : t("unknown");
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(node);
  }
  return [...groups.entries()].sort((a, b) => b[1].length - a[1].length);
}

function renderRegionsView() {
  const groups = groupByRegion();
  const selected = groups.find(([region]) => region === state.regionSelected);
  if (selected) return renderRegionNodes(selected[0], selected[1]);
  return `<section class="regions-view"><div class="panel traffic-chart-card" style="min-height:auto"><div class="panel-heading"><div><div class="panel-title panel-title-accent">${escapeHtml(t("regionSummary"))}</div><div class="bottom-stat-copy">${escapeHtml(t("globalCoverageCopy", { regions: groups.length, nodes: state.nodes.length }))}</div></div></div></div>
    ${groups.length ? `<div class="region-summary-grid">${groups.map(([region, nodes]) => renderRegionCard(region, nodes)).join("")}</div>` : renderEmptyRegions()}
  </section>`;
}

function renderRegionCard(region, nodes) {
  const statuses = nodes.map(node => nodeStatus(node.uuid)).filter(status => status?.online === true);
  const latencies = statuses.map(bestLatency).filter(value => value !== null);
  const label = regionDisplayName(region);
  return `<button class="region-card" type="button" data-region="${escapeHtml(region)}" aria-label="${escapeHtml(t("regionOpen", { region: label }))}"><div class="region-card-head"><span class="region-card-flag">${regionFlag(region)}</span><span><span class="region-card-name">${escapeHtml(label)}</span><span class="region-card-count">${nodes.length} ${escapeHtml(t("nodesCount"))}</span></span><span class="region-card-chevron">${icon("chevronRight", 16)}</span></div>
    <div class="region-card-metrics"><div class="region-card-metric"><strong>${Math.round(mean(statuses.map(status => finiteNumber(status.cpu))))}%</strong><span>${escapeHtml(t("avgCpu"))}</span></div><div class="region-card-metric"><strong>${Math.round(mean(statuses.map(status => percent(status.ram, status.ram_total))))}%</strong><span>${escapeHtml(t("avgMemory"))}</span></div><div class="region-card-metric"><strong>${latencies.length ? `${Math.round(mean(latencies))}ms` : "—"}</strong><span>${escapeHtml(t("avgLatencyShort"))}</span></div></div>
  </button>`;
}

function renderRegionNodes(region, nodes) {
  const label = regionDisplayName(region);
  const orderedNodes = [...nodes].sort((a, b) => Number(nodeIsOnline(b.uuid)) - Number(nodeIsOnline(a.uuid)) || String(a.name || "").localeCompare(String(b.name || ""), state.language));
  return `<section class="regions-view region-detail-view">
    <article class="region-detail-heading panel">
      <button class="region-back-button" type="button" data-action="back-regions">${icon("arrowLeft", 15)}${escapeHtml(t("regionBack"))}</button>
      <div class="region-detail-title"><span class="region-card-flag">${regionFlag(region)}</span><span><strong>${escapeHtml(t("regionNodesTitle", { region: label }))}</strong><small>${orderedNodes.length} ${escapeHtml(t("nodesCount"))}</small></span></div>
    </article>
    <section class="node-grid${state.cardMode === "list" ? " is-list" : ""}">${orderedNodes.map((node, index) => renderNodeCard(node, index)).join("")}</section>
  </section>`;
}

function renderEmptyRegions() {
  return `<section class="empty-card"><div><div class="empty-card-icon">${icon("globe", 28)}</div><h2>${escapeHtml(t("noNodesTitle"))}</h2><p>${escapeHtml(t("noNodesCopy"))}</p></div></section>`;
}

function renderFavoritesView(metrics) {
  return `<section class="favorites-view">
    ${renderToolbar(metrics)}
    <section class="content-grid">${renderNodeGrid()}</section>
  </section>`;
}

function buildTrafficSeries() {
  const histories = state.nodes
    .map(node => state.trafficHistory.get(node.uuid) || [])
    .filter(records => records.length > 0);

  if (!histories.length) {
    const fallback = state.networkSamples.length ? state.networkSamples : [{ upload: 0, download: 0, time: Date.now() }];
    const start = Date.now() - Math.max(fallback.length - 1, 1) * state.config.poll_interval * 1000;
    return fallback.map((sample, index) => ({
      upload: Math.max(0, finiteNumber(sample.upload)),
      download: Math.max(0, finiteNumber(sample.download)),
      time: finiteNumber(sample.time, start + index * state.config.poll_interval * 1000),
    }));
  }

  const count = Math.max(...histories.map(records => records.length), 1);
  return Array.from({ length: count }, (_, index) => {
    let upload = 0;
    let download = 0;
    const times = [];
    for (const records of histories) {
      const recordIndex = records.length - count + index;
      if (recordIndex < 0 || !records[recordIndex]) continue;
      const record = records[recordIndex];
      upload += Math.max(0, finiteNumber(record.net_in));
      download += Math.max(0, finiteNumber(record.net_out));
      const time = new Date(record.time).getTime();
      if (Number.isFinite(time)) times.push(time);
    }
    return { upload, download, time: times.length ? Math.max(...times) : Date.now() };
  });
}

function enrichTrafficSeries(series, totals = null) {
  let cumulativeUpload = 0;
  let cumulativeDownload = 0;
  const enriched = series.map((sample, index) => {
    if (index > 0) {
      const previous = series[index - 1];
      const elapsed = clamp((sample.time - previous.time) / 1000, 1, 3600);
      cumulativeUpload += (previous.upload + sample.upload) * 0.5 * elapsed;
      cumulativeDownload += (previous.download + sample.download) * 0.5 * elapsed;
    }
    return { ...sample, cumulativeUpload, cumulativeDownload };
  });
  const uploadScale = cumulativeUpload > 0 && finiteNumber(totals?.totalUpload) > 0 ? finiteNumber(totals.totalUpload) / cumulativeUpload : 1;
  const downloadScale = cumulativeDownload > 0 && finiteNumber(totals?.totalDownload) > 0 ? finiteNumber(totals.totalDownload) / cumulativeDownload : 1;
  return enriched.map(sample => ({
    ...sample,
    cumulativeUpload: sample.cumulativeUpload * uploadScale,
    cumulativeDownload: sample.cumulativeDownload * downloadScale,
  }));
}

function trafficAxisLabels(maximum, formatter) {
  return [1, 0.75, 0.5, 0.25, 0].map(ratio => `<span>${escapeHtml(formatter(maximum * ratio))}</span>`).join("");
}

function trafficTimeLabels(series) {
  const count = Math.min(7, Math.max(2, series.length));
  return Array.from({ length: count }, (_, index) => {
    const sourceIndex = Math.round((index / Math.max(count - 1, 1)) * Math.max(series.length - 1, 0));
    return `<span>${escapeHtml(formatTrafficTime(series[sourceIndex]?.time || Date.now()))}</span>`;
  }).join("");
}

function renderTrafficChart(series, metrics) {
  const enriched = enrichTrafficSeries(series, metrics);
  const upload = enriched.map(sample => sample.upload);
  const download = enriched.map(sample => sample.download);
  const cumulativeUpload = enriched.map(sample => sample.cumulativeUpload);
  const cumulativeDownload = enriched.map(sample => sample.cumulativeDownload);
  const rateMaximum = niceTrafficMaximum(Math.max(...upload, ...download, 1));
  const totalMaximum = Math.max(...cumulativeUpload, ...cumulativeDownload, 1) * 1.04;

  return `<div class="traffic-chart-frame">
    <div class="traffic-y-axis traffic-y-axis-left">${trafficAxisLabels(rateMaximum, value => formatRate(value))}</div>
    <div class="traffic-plot">
      <svg viewBox="0 0 1000 240" preserveAspectRatio="none" role="img" aria-label="${escapeHtml(t("recent24hTraffic"))}">
        <path class="traffic-download-area" d="${trafficAreaPath(download, rateMaximum)}"/>
        <path class="traffic-upload-area" d="${trafficAreaPath(upload, rateMaximum)}"/>
        <polyline class="traffic-download-line" points="${trafficChartPoints(download, rateMaximum)}"/>
        <polyline class="traffic-upload-line" points="${trafficChartPoints(upload, rateMaximum)}"/>
        <polyline class="traffic-cumulative-download" points="${trafficChartPoints(cumulativeDownload, totalMaximum)}"/>
        <polyline class="traffic-cumulative-upload" points="${trafficChartPoints(cumulativeUpload, totalMaximum)}"/>
      </svg>
    </div>
    <div class="traffic-y-axis traffic-y-axis-right">${trafficAxisLabels(totalMaximum, value => formatBytes(value, 2))}</div>
    <div class="traffic-time-axis">${trafficTimeLabels(enriched)}</div>
  </div>`;
}

function trafficRankings() {
  return state.nodes.map(node => {
    const status = nodeStatus(node.uuid) || {};
    const records = state.trafficHistory.get(node.uuid) || [];
    const peakRecord = records.reduce((best, record) => {
      const rate = Math.max(0, finiteNumber(record.net_in)) + Math.max(0, finiteNumber(record.net_out));
      return !best || rate > best.rate ? { rate, time: record.time } : best;
    }, null);
    const upload = Math.max(0, finiteNumber(status.net_total_up));
    const download = Math.max(0, finiteNumber(status.net_total_down));
    return {
      node,
      upload,
      download,
      total: upload + download,
      peakRate: peakRecord?.rate ?? Math.max(0, finiteNumber(status.net_in)) + Math.max(0, finiteNumber(status.net_out)),
      peakTime: peakRecord?.time ?? status.time ?? Date.now(),
    };
  }).sort((a, b) => b.total - a.total).slice(0, 5);
}

function renderTrafficRankings() {
  const rankings = trafficRankings();
  if (!rankings.length) return `<div class="traffic-rank-empty">${icon("traffic", 22)}<span>${escapeHtml(t("trafficNoHistory"))}</span></div>`;
  const maximum = Math.max(rankings[0]?.total || 0, 1);
  return `<div class="traffic-rank-list">${rankings.map((entry, index) => `<button class="traffic-rank-row" type="button" data-node-uuid="${escapeHtml(entry.node.uuid)}">
      <span class="traffic-rank-head"><span class="traffic-rank-name"><span class="traffic-rank-index">${index + 1}.</span>${escapeHtml(entry.node.name || entry.node.uuid)}</span><span class="traffic-rank-totals"><span>↑ ${escapeHtml(formatBytes(entry.upload, 2))}</span><span>↓ ${escapeHtml(formatBytes(entry.download, 2))}</span>${icon("traffic", 15)}</span></span>
      <span class="traffic-rank-peak">${escapeHtml(t("peakAt", { rate: formatRate(entry.peakRate), time: formatTrafficTime(entry.peakTime, true) }))}</span>
      <span class="traffic-rank-track"><span style="width:${Math.max(1.4, entry.total / maximum * 100).toFixed(2)}%"></span></span>
    </button>`).join("")}</div>`;
}

function renderTrafficView(metrics) {
  const series = buildTrafficSeries();
  return `<section class="traffic-view">
    <article class="traffic-dashboard panel">
      <div class="traffic-dashboard-head"><div><div class="panel-title traffic-dashboard-title">${escapeHtml(t("recent24hTraffic"))}</div><div class="traffic-dashboard-copy">${escapeHtml(t("trafficWindow"))}</div></div>
        <div class="traffic-dashboard-legend">
          <span><i class="traffic-dot is-upload"></i>${escapeHtml(t("upload"))} <strong>${escapeHtml(formatRate(metrics.uploadRate))}</strong></span>
          <span><i class="traffic-dot is-download"></i>${escapeHtml(t("download"))} <strong>${escapeHtml(formatRate(metrics.downloadRate))}</strong></span>
          <span><i class="traffic-dash is-upload"></i>${escapeHtml(t("cumulativeUpload"))}</span>
          <span><i class="traffic-dash is-download"></i>${escapeHtml(t("cumulativeDownload"))}</span>
          <span class="traffic-total-summary">↑ ${escapeHtml(formatBytes(metrics.totalUpload, 2))} <b>↓ ${escapeHtml(formatBytes(metrics.totalDownload, 2))}</b></span>
        </div>
      </div>
      <div class="traffic-chart-shell">${renderTrafficChart(series, metrics)}${state.trafficHistoryLoading ? `<div class="traffic-loading"><span></span>${escapeHtml(t("trafficHistoryLoading"))}</div>` : ""}</div>
      <div class="traffic-ranking">
        <div class="traffic-ranking-head"><div><h2>${escapeHtml(t("trafficTop5"))}</h2><p>${escapeHtml(t("trafficRankCopy"))}</p></div><span class="traffic-ranking-icon">${icon("list", 18)}</span></div>
        ${renderTrafficRankings()}
      </div>
    </article>
  </section>`;
}

function renderAboutView() {
  const description = state.publicInfo.description || t("aboutDescription");
  return `<section class="about-view">
    <article class="about-hero"><div class="about-logo">${butterflyLogo()}</div><h1 class="about-title">Butterfly</h1><p class="about-description">${escapeHtml(description)}</p><div class="about-badges"><span class="about-badge">${icon("activity", 13)} ${escapeHtml(t("themeVersion"))} ${escapeHtml(THEME_VERSION)}</span><span class="about-badge">${icon("server", 13)} ${escapeHtml(t("komariVersion"))} ${escapeHtml(state.version.version || "unknown")}</span><a class="about-badge" href="${THEME_REPOSITORY}" target="_blank" rel="noreferrer">${icon("github", 13)} ${escapeHtml(t("sourceCode"))}</a></div></article>
    <div class="about-grid">${aboutCard("panelLeft", "designLanguage", "designLanguageCopy")}${aboutCard("network", "nativeIntegration", "nativeIntegrationCopy")}${aboutCard("grid", "responsive", "responsiveCopy")}</div>
  </section>`;
}

function aboutCard(iconName, titleKey, copyKey) {
  return `<article class="about-card"><div class="about-card-icon">${icon(iconName, 19)}</div><h3>${escapeHtml(t(titleKey))}</h3><p>${escapeHtml(t(copyKey))}</p></article>`;
}

function renderMobileNav() {
  return `<nav class="mobile-bottom-nav" aria-label="Mobile navigation">${mobileNavItem("overview", "overview")}${mobileNavItem("regions", "regions")}${mobileGlobeNavItem()}${mobileNavItem("traffic", "traffic")}${mobileNavItem("favorites", "favorites")}</nav>`;
}

function mobileNavItem(view, iconName) {
  const active = state.currentView === view;
  const current = active ? ' aria-current="page"' : "";
  return `<button class="mobile-nav-item${active ? " is-active" : ""}" type="button" data-view="${view}"${current}>${icon(iconName, 19)}<span class="mobile-nav-label">${escapeHtml(t(view))}</span></button>`;
}

function mobileGlobeNavItem() {
  return `<button class="mobile-nav-item mobile-nav-globe" type="button" data-action="open-globe" aria-label="${escapeHtml(t("globeTitle"))}"><span class="mobile-nav-globe-icon">${icon("globe", 21)}</span></button>`;
}

function renderDrawer() {
  if (!state.drawerUuid) return "";
  const node = getNodeByUuid(state.drawerUuid);
  // 已删除/已隐藏/深链接有误：给"未找到"反馈，不留空抽屉
  if (!node) return renderDrawerMissing(state.drawerUuid);
  const status = nodeStatus(node.uuid) || {};
  const latency = bestLatency(status);
  const memory = percent(status.ram, status.ram_total || node.mem_total);
  const disk = percent(status.disk, status.disk_total || node.disk_total);
  return `<button class="drawer-handle" type="button" data-action="close-drawer" aria-label="${escapeHtml(t("close"))}"><span></span></button><div class="drawer-scroll"><header class="drawer-header"><span class="drawer-node-flag">${regionFlag(node.region)}</span><div class="drawer-title"><h2>${escapeHtml(node.name || node.uuid)}</h2><p>${escapeHtml(nodeSubtitle(node))}</p></div><button class="icon-button drawer-close" type="button" data-action="close-drawer" aria-label="${escapeHtml(t("close"))}">${icon("close")}</button></header>
    <div class="drawer-body"><div class="drawer-status-strip">${drawerStat(t("cpu"), formatPercent(status.cpu))}${drawerStat(t("memory"), formatPercent(memory))}${drawerStat(t("disk"), formatPercent(disk))}${drawerStat(t("averageLatency"), latency === null ? "—" : `${Math.round(latency)} ms`)}</div>
      ${state.drawerLoading ? `<div class="drawer-loading"><div><div class="drawer-loading-spinner"></div>${escapeHtml(t("loadingDetails"))}</div></div>` : `${renderDrawerCharts(node, status)}${renderDrawerLines(node, status)}${renderBilling(node, status)}`}
      ${renderHardware(node, status)}
    </div></div>`;
}

function renderDrawerMissing(uuid) {
  return `<button class="drawer-handle" type="button" data-action="close-drawer" aria-label="${escapeHtml(t("close"))}"><span></span></button><div class="drawer-scroll"><header class="drawer-header"><span class="drawer-node-flag">${icon("globe", 14)}</span><div class="drawer-title"><h2>${escapeHtml(t("nodeNotFound"))}</h2><p>${escapeHtml(uuid)}</p></div><button class="icon-button drawer-close" type="button" data-action="close-drawer" aria-label="${escapeHtml(t("close"))}">${icon("close")}</button></header>
    <div class="drawer-body"><div class="drawer-empty">${escapeHtml(t("nodeNotFoundCopy"))}</div></div></div>`;
}

function drawerStat(label, value) {
  return `<div class="drawer-stat"><div class="drawer-stat-label">${escapeHtml(label)}</div><div class="drawer-stat-value">${escapeHtml(value)}</div></div>`;
}

function renderDrawerCharts(node, status) {
  const records = Array.isArray(state.drawerRecords) && state.drawerRecords.length ? state.drawerRecords : [];
  const cpu = records.map(record => clamp(record.cpu, 0, 100));
  const memory = records.map(record => percent(record.ram, record.ram_total || node.mem_total));
  const download = records.map(record => Math.max(0, finiteNumber(record.net_out)));
  const upload = records.map(record => Math.max(0, finiteNumber(record.net_in)));
  if (!cpu.length) cpu.push(...(state.nodeSamples.get(node.uuid) || [status.cpu || 0]));
  if (!memory.length) memory.push(percent(status.ram, status.ram_total || node.mem_total));
  if (!download.length) download.push(finiteNumber(status.net_out));
  if (!upload.length) upload.push(finiteNumber(status.net_in));
  return `<section class="drawer-section"><div class="drawer-section-heading"><h3>${escapeHtml(t("recentPerformance"))}</h3><div class="chart-legend"><span class="chart-legend-item"><span class="chart-legend-line"></span>${escapeHtml(t("cpu"))}</span><span class="chart-legend-item"><span class="chart-legend-line" style="--legend-color:var(--cyan)"></span>${escapeHtml(t("memory"))}</span></div></div><div class="drawer-chart">${dualLineChart(cpu, memory, 620, 130)}</div></section>
    <section class="drawer-section"><div class="drawer-section-heading"><h3>${escapeHtml(t("networkActivity"))}</h3><div class="chart-legend"><span class="chart-legend-item"><span class="chart-legend-line"></span>${escapeHtml(t("download"))}</span><span class="chart-legend-item"><span class="chart-legend-line" style="--legend-color:var(--cyan)"></span>${escapeHtml(t("upload"))}</span></div></div><div class="drawer-chart">${dualLineChart(download, upload, 620, 130)}</div></section>`;
}

// 线路级近期延迟：迷你柱用列表缓存里的 20 点窗口（`/api/server` 不返回窗口数组）。
function renderDrawerLines(node, status) {
  const lines = Object.values(status.ping || {}).filter(isRecord);
  if (!lines.length) return "";
  const window = Array.isArray(node?.cfsm?.latencyWindow) ? node.cfsm.latencyWindow : [];
  const rows = lines
    .map(line => {
      const samples = window
        .map(point => finiteNumber(point?.[line.id], -1))
        .filter(value => value >= 0)
        .slice(-20);
      const max = samples.length ? Math.max(...samples) : 0;
      const bars = samples
        .map(value => `<span class="line-spark-bar" style="height:${max > 0 ? Math.max(12, Math.round((value / max) * 100)) : 12}%"></span>`)
        .join("");
      const loss = finiteNumber(line.loss);
      const latest = Number.isFinite(line.latest) ? `${Math.round(line.latest)} ms` : t("noLatency");
      return `<div class="line-row"><div class="line-row-head"><span class="line-row-name">${escapeHtml(line.name || line.id)}</span><span class="line-row-value">${escapeHtml(latest)}</span><span class="line-row-loss${loss > 0 ? " is-warm" : ""}">${escapeHtml(`${loss.toFixed(1)}%`)}</span></div>${bars ? `<div class="line-spark">${bars}</div>` : ""}</div>`;
    })
    .join("");
  return `<section class="drawer-section"><div class="drawer-section-heading"><h3>${escapeHtml(t("threeNetLatency"))}</h3><span class="connection-pill">${escapeHtml(t("lossRate"))}</span></div>${rows}</section>`;
}

// 到期天数：CFSM 的 expire_date 是日期串（如 "2026-10-01"），非法/缺失则不显示该项
function expireDays(dateString) {
  const time = new Date(dateString).getTime();
  if (!Number.isFinite(time)) return null;
  return Math.ceil((time - Date.now()) / 86400000);
}

// 计费与流量（增补块）：剩余流量、全时出/入站累计、价格与周期、到期、自动续费、重置日
function renderBilling(node, status) {
  const cfsm = node?.cfsm || {};
  const remaining = cfsm.remaining || null;
  const items = [];
  if (remaining && !remaining.degraded && Number.isFinite(remaining.remainingBytes)) {
    items.push([t("remainingTraffic"), formatBytes(remaining.remainingBytes, 2)]);
  }
  items.push([t("trafficOut"), formatBytes(status.cfsm_net_tx, 2)]);
  items.push([t("trafficIn"), formatBytes(status.cfsm_net_rx, 2)]);
  if (Number.isFinite(cfsm.price)) {
    const cycle = cfsm.billingCycle ? ` / ${cfsm.billingCycle}` : "";
    items.push([t("priceLabel"), `${cfsm.currency || ""}${cfsm.price}${cycle}`]);
  }
  if (cfsm.expireDate) {
    const days = expireDays(cfsm.expireDate);
    const suffix = days === null ? "" : days >= 0 ? `（${t("expiresIn", { days })}）` : `（${t("expired")}）`;
    items.push([t("expiresAt"), `${cfsm.expireDate}${suffix}`]);
  }
  if (cfsm.expireDate || Number.isFinite(cfsm.price)) items.push([t("autoRenewal"), cfsm.autoRenewal ? t("yes") : t("no")]);
  if (remaining?.resetDay) items.push([t("resetDay"), t("monthReset", { day: remaining.resetDay })]);
  if (!items.length) return "";
  const rows = items
    .map(([label, value]) => `<div class="hardware-item"><div class="hardware-item-label">${escapeHtml(label)}</div><div class="hardware-item-value" title="${escapeHtml(String(value))}">${escapeHtml(String(value))}</div></div>`)
    .join("");
  return `<section class="drawer-section"><div class="drawer-section-heading"><h3>${escapeHtml(t("billing"))}</h3></div><div class="hardware-grid">${rows}</div></section>`;
}

function renderHardware(node, status) {
  const connectionTotal = finiteNumber(status.connections);
  const udp = finiteNumber(status.connections_udp);
  const tcp = Math.max(connectionTotal - Math.min(udp, connectionTotal), 0);
  const items = [
    [t("os"), node.os], [t("kernel"), node.kernel_version], [t("architecture"), node.arch], [t("virtualization"), node.virtualization],
    [t("cpuName"), node.cpu_name], [t("cpuCores"), node.cpu_cores], [t("gpu"), node.gpu_name], [t("load"), `${finiteNumber(status.load).toFixed(2)} / ${finiteNumber(status.load5).toFixed(2)} / ${finiteNumber(status.load15).toFixed(2)}`],
    [t("process"), status.process], [t("connections"), `TCP ${Math.round(tcp)} · UDP ${Math.round(udp)}`], [t("group"), node.group], [t("tags"), nodeTags(node).join(", ")],
    // CFSM 无数据源的字段（虚拟化、显卡、无标签）直接隐藏，不显示成"未知"
  ].filter(([, value]) => value !== null && value !== undefined && String(value).trim() !== "");
  if (node.ipv4) items.push([t("ipv4"), node.ipv4]);
  if (node.ipv6) items.push([t("ipv6"), node.ipv6]);
  return `<section class="drawer-section"><div class="drawer-section-heading"><h3>${escapeHtml(t("systemInformation"))}</h3><span class="connection-pill${status.online === true ? "" : " is-offline"}">${escapeHtml(status.online === true ? t("online") : t("offline"))}</span></div><div class="hardware-grid">${items.map(([label, value]) => `<div class="hardware-item"><div class="hardware-item-label">${escapeHtml(label)}</div><div class="hardware-item-value" title="${escapeHtml(value ?? t("unknown"))}">${escapeHtml(value ?? t("unknown"))}</div></div>`).join("")}</div></section>`;
}

function updatedLabel() {
  if (!state.lastUpdated) return state.connected ? t("updatedNow") : t("offlineData");
  const seconds = Math.max(0, Math.floor((Date.now() - state.lastUpdated) / 1000));
  return seconds < 2 ? t("updatedNow") : t("updatedAgo", { value: seconds });
}

function showToast(title, message, type = "info") {
  const stack = document.querySelector(".toast-stack");
  if (!stack) return;
  const color = type === "success" ? "var(--green)" : type === "warning" ? "var(--amber)" : type === "danger" ? "var(--red)" : "var(--accent)";
  const element = document.createElement("div");
  element.className = "toast";
  element.innerHTML = `<span class="toast-icon" style="--toast-color:${color}">${icon(type === "success" ? "check" : type === "danger" || type === "warning" ? "warning" : "info", 15)}</span><span><span class="toast-title">${escapeHtml(title)}</span><span class="toast-message">${escapeHtml(message)}</span></span>`;
  stack.append(element);
  setTimeout(() => element.classList.add("is-leaving"), 3100);
  setTimeout(() => element.remove(), 3350);
}

function updateLiveElements() {
  const clock = document.querySelector("[data-live-clock]");
  if (clock) clock.textContent = new Date().toLocaleTimeString(state.language, { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
  document.querySelectorAll("[data-updated-label]").forEach(element => { element.textContent = updatedLabel(); });
}

function saveFavorites() {
  safeStorageSet(STORAGE.favorites, JSON.stringify([...state.favorites]));
}

// ---------- 深链接路由（#/ 与 #/server/<id>）----------

function readHashRoute() {
  const hash = String(location.hash || "");
  if (!hash || hash === "#" || hash === "#/") return { view: "root", id: null };
  if (hash.startsWith(HASH_SERVER_PREFIX)) {
    let id = "";
    try {
      id = decodeURIComponent(hash.slice(HASH_SERVER_PREFIX.length)).trim();
    } catch {
      id = "";
    }
    return id ? { view: "server", id } : { view: "root", id: null };
  }
  // 其它 hash（例如站点自身管理页的 #admin）不接管
  return { view: "other", id: null };
}

function writeHash(hash) {
  if (String(location.hash || "") === hash) return;
  location.hash = hash;
}

// 幂等：只看当前 state 与 hash 是否一致，因此 click → 写 hash → hashchange 不会递归
function applyHashRoute() {
  const route = readHashRoute();
  if (route.view === "server") {
    if (state.drawerUuid !== route.id) void openDrawer(route.id);
    return;
  }
  if (route.view === "root" && state.drawerUuid) closeDrawer({ syncHash: false });
}

// ---------- 主题设置面板（16 项，落库键前缀 butterfly_）----------

function settingOptionLabel(option) {
  if (["system", "light", "dark"].includes(option)) return t(option);
  if (option === "auto") return t("languageAuto");
  if (option === "small") return t("textSmall");
  if (option === "normal") return t("textNormal");
  if (option === "large") return t("textLarge");
  if (option === "xlarge") return t("textXLarge");
  if (option === "xxlarge") return t("textXxLarge");
  if (option === "zh-CN") return "简体中文";
  if (option === "ja") return "日本語";
  if (option === "en") return "English";
  return option;
}

// 文字缩放：写进 :root 的 CSS 变量，styles.css 里所有 font-size 都乘这个系数
function applyTextScale() {
  const factor = TEXT_SCALE_FACTORS[state.config.font_scale] ?? TEXT_SCALE_FACTORS.xlarge;
  document.documentElement.style.setProperty("--text-scale", String(factor));
}

// 界面语言：默认"跟随站点"（站点的 language cookie / 浏览器语言）；显式设置后以设置值为准
function applyConfiguredLanguage() {
  const configured = state.config.language;
  if (!configured || configured === "auto") return;
  if (configured === state.language) return;
  state.language = configured;
  document.documentElement.lang = configured;
}

function updateSettingDraft(key, rawValue) {
  if (!state.settingsDraft) state.settingsDraft = { ...state.config };
  const meta = settingsMeta(key);
  if (!meta) return;
  state.settingsDraft[key] = normalizeSettingValue(meta, rawValue);
}

function renderSettingControl(meta, draft) {
  const value = draft[meta.key];
  const id = `setting-${meta.key}`;
  const label = escapeHtml(settingLabel(meta, state.language));
  const common = `id="${id}" data-setting="${meta.key}"`;
  if (meta.type === "switch") {
    return `<div class="settings-row"><label class="settings-label" for="${id}">${label}</label><input ${common} type="checkbox"${value ? " checked" : ""}/></div>`;
  }
  if (meta.type === "select") {
    const options = (meta.options || [])
      .map(option => `<option value="${escapeHtml(option)}"${option === value ? " selected" : ""}>${escapeHtml(settingOptionLabel(option))}</option>`)
      .join("");
    return `<div class="settings-row"><label class="settings-label" for="${id}">${label}</label><select ${common}>${options}</select></div>`;
  }
  if (meta.type === "number") {
    const min = meta.min !== undefined ? ` min="${meta.min}"` : "";
    const max = meta.max !== undefined ? ` max="${meta.max}"` : "";
    return `<div class="settings-row"><label class="settings-label" for="${id}">${label}</label><input ${common} type="number"${min}${max} value="${escapeHtml(String(value))}"/></div>`;
  }
  if (meta.type === "textbox") {
    return `<div class="settings-row is-stacked"><label class="settings-label" for="${id}">${label}</label><textarea ${common} rows="3">${escapeHtml(String(value))}</textarea></div>`;
  }
  return `<div class="settings-row"><label class="settings-label" for="${id}">${label}</label><input ${common} type="text" value="${escapeHtml(String(value))}"/></div>`;
}

function renderSettingsBody() {
  const draft = state.settingsDraft || { ...state.config };
  const loggedIn = state.userInfo?.logged_in === true;
  const groups = ["appearance", "dashboard", "copy"]
    .map(section => {
      const rows = THEME_SETTINGS.filter(meta => meta.section === section).map(meta => renderSettingControl(meta, draft)).join("");
      return `<section class="settings-group"><h3>${escapeHtml(localizedValue(SECTION_LABELS[section], state.language))}</h3>${rows}</section>`;
    })
    .join("");
  const notice = state.turnstileBlocked
    ? `<p class="settings-notice is-warning">${escapeHtml(t("settingsTurnstileHint"))}</p>`
    : loggedIn
      ? ""
      : `<p class="settings-notice">${escapeHtml(t("settingsSignInHint"))}</p>`;
  const disabled = !loggedIn || state.turnstileBlocked || state.settingsSaving;
  return `<header class="settings-head"><div class="settings-head-copy"><div class="settings-title">${escapeHtml(t("themeSettings"))}</div><div class="settings-subtitle">${escapeHtml(t("settingsDraftHint"))}</div></div><button class="icon-button" type="button" data-action="close-settings" aria-label="${escapeHtml(t("close"))}">${icon("close")}</button></header>
    <div class="settings-scroll">${notice}${groups}</div>
    <footer class="settings-foot"><button class="secondary-button" type="button" data-action="reset-settings">${escapeHtml(t("settingsReset"))}</button><button class="action-button" type="button" data-action="save-settings"${disabled ? " disabled" : ""}>${escapeHtml(state.settingsSaving ? t("settingsSaving") : t("settingsSave"))}</button></footer>`;
}

function renderSettingsPanel() {
  const open = state.settingsOpen;
  return `<div class="settings-backdrop${open ? " is-open" : ""}" data-action="close-settings"></div>
    <aside class="settings-panel${open ? " is-open" : ""}" role="dialog" aria-label="${escapeHtml(t("themeSettings"))}">${open ? renderSettingsBody() : ""}</aside>`;
}

function openSettings() {
  state.settingsDraft = { ...state.config };
  state.settingsOpen = true;
  state.notificationsOpen = false;
  state.mobileSearchOpen = false;
  renderApp();
}

// 保存设置：读-改-写 `POST /api/theme_options`。
// 契约（CFSM `theme-develop.md` + `src/index.js`）：body 为 { theme_options: {...} }，
// 无论站点是否公开都必须带 JWT；该接口整对象替换 appearance_options.theme_options，
// 所以必须先取回最新值再合并 —— 读失败则不写，宁可不存也不能抹掉其它主题的键。
async function saveThemeSettings() {
  if (state.settingsSaving) return;
  if (state.userInfo?.logged_in !== true) {
    showToast(t("themeSettings"), t("settingsSignInHint"), "warning");
    return;
  }
  if (state.turnstileBlocked) {
    showToast(t("themeSettings"), t("settingsTurnstileHint"), "warning");
    return;
  }
  state.settingsSaving = true;
  renderApp();
  try {
    const fresh = await api.getConfig({ timeout: 15000 });
    const current = isRecord(fresh?.theme_options) ? fresh.theme_options : null;
    if (!current) throw new Error(t("settingsReadFailed"));
    const merged = mergeThemeSettings(current, state.settingsDraft || {});
    const result = await api.saveThemeOptions(merged);
    state.themeOptions = isRecord(result?.theme_options) ? result.theme_options : merged;
    state.config = mergeConfig(readThemeSettings(state.themeOptions));
    state.sort = state.config.default_sort;
    state.settingsDraft = { ...state.config };
    applyAppearance();
    showToast(t("settingsSaved"), t("settingsSavedCopy"), "success");
  } catch (error) {
    showToast(t("settingsSaveFailed"), error instanceof Error ? error.message : String(error), "warning");
  } finally {
    state.settingsSaving = false;
    renderApp();
  }
}

async function loadTrafficHistory(force = false) {
  if (state.trafficHistoryLoading) return;
  if (!force && state.trafficHistoryLoadedAt && Date.now() - state.trafficHistoryLoadedAt < 5 * 60 * 1000) return;
  state.trafficHistoryLoading = true;
  if (state.currentView === "traffic") renderApp();

  try {
    const history = new Map();
    if (state.demoMode) {
      for (const node of state.nodes) history.set(node.uuid, demoHistory(node.uuid));
    } else {
      let cursor = 0;
      const workers = Array.from({ length: Math.min(4, Math.max(1, state.nodes.length)) }, async () => {
        while (cursor < state.nodes.length) {
          const node = state.nodes[cursor++];
          try {
            const rows = await api.getHistory(node.uuid, TRAFFIC_HISTORY_HOURS, { timeout: 20000 });
            history.set(node.uuid, mapHistoryRows(rows, {
              node,
              status: state.statuses[node.uuid] || null,
              sources: lineSources(),
              now: Date.now(),
            }));
          } catch {
            history.set(node.uuid, []);
          }
        }
      });
      await Promise.all(workers);
    }
    state.trafficHistory = history;
    state.trafficHistoryLoadedAt = Date.now();
  } finally {
    state.trafficHistoryLoading = false;
    if (state.currentView === "traffic") renderApp();
  }
}

async function openDrawer(uuid) {
  if (typeof uuid !== "string" || !uuid) return;
  resetMobileNavVisibility();
  state.drawerUuid = uuid;
  // 同步地址栏（深链接 #/server/<id>）；applyHashRoute 幂等，重复触发不会递归
  writeHash(`${HASH_SERVER_PREFIX}${encodeURIComponent(uuid)}`);
  const node = getNodeByUuid(uuid);
  state.drawerLoading = Boolean(node) && !state.demoMode;
  state.drawerRecords = null;
  renderApp();
  document.body.style.overflow = "hidden";
  // 未找到（已删除/隐藏/链接有误）：保留抽屉显示"未找到"，不静默失败
  if (!node) return;
  if (state.demoMode) {
    state.drawerRecords = demoHistory(uuid);
    state.drawerLoading = false;
    renderApp();
    document.body.style.overflow = "hidden";
    return;
  }
  try {
    // 详情只取该机器 1 小时历史（单机约 30 KB）；失败时回落到流量视图的缓存。
    // 三网窗口（ping/loss 数组）只存在于 `/api/servers`，此处不重复拉全量列表，
    // 直接复用列表缓存里的 `node.cfsm.latencyWindow`。
    const rows = await api.getHistory(uuid, 1, { timeout: 15000 });
    state.drawerRecords = mapHistoryRows(rows, {
      node: getNodeByUuid(uuid),
      status: nodeStatus(uuid),
      sources: lineSources(),
      now: Date.now(),
    });
  } catch {
    state.drawerRecords = state.trafficHistory.get(uuid) || [];
  } finally {
    state.drawerLoading = false;
    if (state.drawerUuid === uuid) {
      renderApp();
      document.body.style.overflow = "hidden";
    }
  }
}

function closeDrawer({ syncHash = true } = {}) {
  const hadDrawer = Boolean(state.drawerUuid);
  state.drawerUuid = null;
  state.drawerRecords = null;
  state.drawerLoading = false;
  document.body.style.overflow = "";
  resetMobileNavVisibility();
  if (syncHash && hadDrawer) writeHash("#/");
  renderApp();
}

function setMobileNavHidden(hidden) {
  mobileNavHidden = Boolean(hidden);
  document.querySelector(".app-shell")?.classList.toggle("mobile-nav-hidden", mobileNavHidden);
}

function resetMobileNavVisibility() {
  mobileNavLastScrollY = Math.max(0, window.scrollY);
  setMobileNavHidden(false);
}

function scheduleStatusRender(manual = false) {
  const mobile = matchMedia(MOBILE_LAYOUT_QUERY).matches;
  if (!mobile || manual) {
    renderApp();
    return;
  }
  if (document.hidden) return;
  if (state.globeOpen) {
    refreshOpenGlobe();
    return;
  }
  if (state.drawerUuid || state.mobileSearchOpen || state.sidebarOpen || state.notificationsOpen) return;
  if (mobileStatusRenderTimer !== null) clearTimeout(mobileStatusRenderTimer);
  mobileStatusRenderTimer = window.setTimeout(() => {
    mobileStatusRenderTimer = null;
    if (!document.hidden && !state.globeOpen && !state.drawerUuid && !state.mobileSearchOpen && !state.sidebarOpen && !state.notificationsOpen) renderApp();
  }, MOBILE_STATUS_RENDER_IDLE_MS);
}

function postponeMobileStatusRender() {
  if (mobileStatusRenderTimer === null) return;
  clearTimeout(mobileStatusRenderTimer);
  mobileStatusRenderTimer = null;
  scheduleStatusRender(false);
}

function updateMobileNavVisibility() {
  if (!matchMedia(MOBILE_LAYOUT_QUERY).matches || state.drawerUuid || state.globeOpen || state.mobileSearchOpen || state.sidebarOpen) {
    resetMobileNavVisibility();
    return;
  }

  const currentY = Math.max(0, window.scrollY);
  const delta = currentY - mobileNavLastScrollY;
  const atBottom = window.innerHeight + currentY >= document.documentElement.scrollHeight - 48;
  if (currentY < 40 || atBottom || delta < -7) setMobileNavHidden(false);
  else if (currentY > 96 && delta > 7) setMobileNavHidden(true);
  mobileNavLastScrollY = currentY;
}

function scheduleMobileNavVisibility() {
  postponeMobileStatusRender();
  if (mobileNavScrollFrame !== null) return;
  mobileNavScrollFrame = requestAnimationFrame(() => {
    mobileNavScrollFrame = null;
    updateMobileNavVisibility();
  });
}

function updateMobileInputState() {
  const focused = document.activeElement;
  const acceptsText = focused instanceof HTMLInputElement
    || focused instanceof HTMLTextAreaElement
    || focused instanceof HTMLSelectElement;
  const viewport = window.visualViewport;
  const keyboardInset = viewport
    ? Math.max(0, window.innerHeight - viewport.height - viewport.offsetTop)
    : 0;
  const active = matchMedia(MOBILE_LAYOUT_QUERY).matches && (acceptsText || keyboardInset > 120);
  document.documentElement.classList.toggle("mobile-input-focused", active);
}

function scheduleMobileInputState() {
  if (mobileInputStateFrame !== null) return;
  mobileInputStateFrame = requestAnimationFrame(() => {
    mobileInputStateFrame = null;
    updateMobileInputState();
  });
}

function setView(view) {
  if (view === "nodes") view = "overview";
  if (!["overview", "nodes", "regions", "traffic", "favorites", "about"].includes(view)) return;
  state.currentView = view;
  state.sidebarOpen = false;
  state.mobileSearchOpen = false;
  state.notificationsOpen = false;
  if (view === "favorites") state.filter = "favorites";
  else if (state.filter === "favorites") state.filter = "all";
  resetMobileNavVisibility();
  renderApp();
  if (view === "traffic") void loadTrafficHistory();
  window.scrollTo({ top: 0, behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
}

function handleClick(event) {
  const view = event.target.closest("[data-view]")?.dataset.view;
  if (view) { setView(view); return; }

  const favorite = event.target.closest("[data-favorite-uuid]");
  if (favorite) {
    event.stopPropagation();
    const uuid = favorite.dataset.favoriteUuid;
    const wasFavorite = state.favorites.has(uuid);
    if (wasFavorite) state.favorites.delete(uuid);
    else state.favorites.add(uuid);
    saveFavorites();
    renderApp();
    showToast(wasFavorite ? t("favoriteRemoved") : t("favoriteAdded"), getNodeByUuid(uuid)?.name || uuid, wasFavorite ? "info" : "success");
    return;
  }

  const region = event.target.closest("[data-region]")?.dataset.region;
  if (region) {
    state.regionSelected = region;
    state.currentView = "regions";
    renderApp();
    window.scrollTo({ top: 0, behavior: "smooth" });
    return;
  }

  const card = event.target.closest("[data-node-uuid]");
  if (card) {
    state.notificationsOpen = false;
    openDrawer(card.dataset.nodeUuid);
    return;
  }

  const filter = event.target.closest("[data-filter]")?.dataset.filter;
  if (filter) {
    state.filter = filter;
    state.currentView = filter === "favorites" ? "favorites" : "overview";
    renderApp();
    window.scrollTo({ top: 0, behavior: "smooth" });
    return;
  }

  const cardMode = event.target.closest("[data-card-mode]")?.dataset.cardMode;
  if (cardMode) {
    state.cardMode = cardMode;
    safeStorageSet(STORAGE.cardMode, cardMode);
    renderApp();
    return;
  }

  const actionElement = event.target.closest("[data-action]");
  const action = actionElement?.dataset.action;
  if (!action) return;
  if (action === "open-globe") {
    state.mobileSearchOpen = false;
    openGlobe();
  } else if (action === "toggle-mobile-search") {
    state.notificationsOpen = false;
    state.mobileSearchOpen = !state.mobileSearchOpen;
    if (!state.mobileSearchOpen) resetMobileNavVisibility();
    renderApp();
    if (state.mobileSearchOpen) requestAnimationFrame(() => document.querySelector("#mobile-search")?.focus());
  } else if (action === "close-mobile-search") {
    state.mobileSearchOpen = false;
    resetMobileNavVisibility();
    renderApp();
  } else if (action === "toggle-notifications") {
    state.mobileSearchOpen = false;
    state.notificationsOpen = !state.notificationsOpen;
    renderApp();
    if (state.notificationsOpen) requestAnimationFrame(() => document.querySelector("#notification-popover")?.focus({ preventScroll: true }));
  } else if (action === "close-notifications") {
    state.notificationsOpen = false;
    renderApp();
    requestAnimationFrame(() => document.querySelector(".notification-button")?.focus({ preventScroll: true }));
  } else if (action === "view-alerts-panel") {
    state.notificationsOpen = false;
    state.currentView = "overview";
    renderApp();
    setTimeout(() => document.querySelector("#alerts-panel")?.scrollIntoView({ behavior: "smooth", block: "center" }), 0);
  } else if (action === "toggle-theme") {
    setTheme(document.documentElement.dataset.theme === "dark" ? "light" : "dark", true);
  } else if (action === "toggle-sidebar") {
    state.sidebarCollapsed = !state.sidebarCollapsed;
    safeStorageSet(STORAGE.sidebar, state.sidebarCollapsed ? "collapsed" : "expanded");
    renderApp();
  } else if (action === "open-sidebar") {
    state.sidebarOpen = true;
    resetMobileNavVisibility();
    renderApp();
  } else if (action === "close-sidebar") {
    state.sidebarOpen = false;
    resetMobileNavVisibility();
    renderApp();
  } else if (action === "open-settings") {
    openSettings();
  } else if (action === "close-settings") {
    state.settingsOpen = false;
    renderApp();
  } else if (action === "reset-settings") {
    state.settingsDraft = { ...DEFAULT_SETTINGS };
    state.settingsOpen = true;
    renderApp();
  } else if (action === "save-settings") {
    saveThemeSettings();
  } else if (action === "close-drawer") {
    if (actionElement.matches(".drawer-handle") && Date.now() < suppressDrawerHandleClickUntil) return;
    closeDrawer();
  } else if (action === "clear-filters") {
    state.filter = "all";
    state.query = "";
    state.currentView = "overview";
    renderApp();
  } else if (action === "back-regions") {
    state.regionSelected = null;
    renderApp();
  } else if (action === "refresh") {
    refreshStatuses(true);
  } else if (action === "retry") {
    initialize();
  }
}

function handleGlobePortalClick(event) {
  const action = event.target.closest("[data-globe-action]")?.dataset.globeAction;
  if (action === "close") {
    closeGlobe();
    return;
  }
  if (action === "nodes") {
    closeGlobe();
    setView("overview");
    return;
  }

  const regionButton = event.target.closest("[data-globe-region-code]");
  if (regionButton) {
    selectGlobeRegion(regionButton.dataset.globeRegionCode);
    return;
  }

  const nodeButton = event.target.closest("[data-globe-node-uuid]");
  if (nodeButton) {
    const uuid = nodeButton.dataset.globeNodeUuid;
    closeGlobe();
    openDrawer(uuid);
  }
}

const SEARCH_INPUT_SELECTOR = "#global-search, #mobile-search, #node-search";

function scheduleSearchRender(inputId) {
  const shouldOpenNodes = !["overview", "favorites"].includes(state.currentView);
  if (shouldOpenNodes) state.currentView = "overview";
  if (searchRenderFrame !== null) cancelAnimationFrame(searchRenderFrame);
  searchRenderFrame = requestAnimationFrame(() => {
    searchRenderFrame = null;
    renderApp();
    if (shouldOpenNodes) window.scrollTo({ top: 0 });
    requestAnimationFrame(() => {
      const target = document.querySelector(`#${inputId}`);
      if (target) { target.focus(); target.setSelectionRange(target.value.length, target.value.length); }
    });
  });
}

function handleInput(event) {
  const setting = event.target.closest("[data-setting]");
  if (setting && setting.tagName !== "SELECT") {
    // 设置面板的文本框/数字框只写本地草稿，不触发整页重渲染
    updateSettingDraft(setting.dataset.setting, event.target.value);
    return;
  }
  if (event.target.matches(SEARCH_INPUT_SELECTOR)) {
    state.query = event.target.value;
    if (event.target.id === "mobile-search") state.mobileSearchOpen = true;
    // 组字过程中只更新状态、不重渲染，等 compositionend 再渲染一次
    if (event.isComposing || searchComposing) return;
    scheduleSearchRender(event.target.id);
  }
}

function handleCompositionStart(event) {
  if (event.target.matches(SEARCH_INPUT_SELECTOR)) searchComposing = true;
}

function handleCompositionEnd(event) {
  if (!event.target.matches(SEARCH_INPUT_SELECTOR)) return;
  searchComposing = false;
  state.query = event.target.value;
  scheduleSearchRender(event.target.id);
}

function handleChange(event) {
  if (event.target.matches("#node-sort")) {
    state.sort = event.target.value;
    renderApp();
    return;
  }
  const setting = event.target.closest("[data-setting]");
  if (!setting) return;
  const value = setting.type === "checkbox" ? setting.checked : setting.value;
  updateSettingDraft(setting.dataset.setting, value);
  // 语言改动立即生效（面板本身也要跟着换语言），其它设置在保存后生效
  if (setting.dataset.setting === "language" && value && value !== "auto") {
    state.language = value;
    document.documentElement.lang = value;
    renderApp();
  }
  // 字体大小同样即时生效，便于边看边调
  if (setting.dataset.setting === "font_scale") {
    state.config.font_scale = value;
    applyTextScale();
    renderApp();
  }
}

function handleKeydown(event) {
  // 组字过程中的 Enter/Escape 属于输入法，主题不要抢（keyCode 229 是旧浏览器的组字标记）
  if (event.isComposing || event.keyCode === 229) return;
  if (event.key === "Enter" && event.target.matches("#mobile-search")) {
    event.target.blur();
    return;
  }
  if (event.key === "Escape") {
    if (state.globeOpen) closeGlobe();
    else if (state.settingsOpen) { state.settingsOpen = false; renderApp(); }
    else if (state.drawerUuid) closeDrawer();
    else if (state.notificationsOpen) { state.notificationsOpen = false; renderApp(); }
    else if (state.mobileSearchOpen) { state.mobileSearchOpen = false; renderApp(); }
    else if (state.sidebarOpen) { state.sidebarOpen = false; renderApp(); }
    return;
  }
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
    event.preventDefault();
    if (matchMedia(MOBILE_LAYOUT_QUERY).matches) {
      state.mobileSearchOpen = true;
      renderApp();
      requestAnimationFrame(() => document.querySelector("#mobile-search")?.focus());
    } else {
      document.querySelector("#global-search")?.focus();
    }
    return;
  }
  if (event.key === "/" && !event.target.matches("input, textarea, select")) {
    event.preventDefault();
    if (matchMedia(MOBILE_LAYOUT_QUERY).matches) {
      state.mobileSearchOpen = true;
      renderApp();
      requestAnimationFrame(() => document.querySelector("#mobile-search")?.focus());
    } else {
      document.querySelector("#global-search")?.focus();
    }
    return;
  }
}

function handleDrawerPointerDown(event) {
  const handle = event.target.closest(".drawer-handle");
  if (!handle || !state.drawerUuid || !matchMedia(MOBILE_LAYOUT_QUERY).matches) return;
  if (event.pointerType === "mouse" && event.button !== 0) return;
  const drawer = handle.closest(".node-drawer");
  if (!(drawer instanceof HTMLElement)) return;

  const backdrop = document.querySelector(".drawer-backdrop");
  drawerDrag = {
    pointerId: event.pointerId,
    startY: event.clientY,
    currentY: event.clientY,
    startTime: performance.now(),
    drawer,
    backdrop: backdrop instanceof HTMLElement ? backdrop : null,
    handle,
    moved: false,
  };
  drawer.classList.add("is-dragging");
  handle.setPointerCapture?.(event.pointerId);
}

function handleDrawerPointerMove(event) {
  if (!drawerDrag || event.pointerId !== drawerDrag.pointerId) return;
  const delta = Math.max(0, event.clientY - drawerDrag.startY);
  drawerDrag.currentY = event.clientY;
  if (delta > 5) drawerDrag.moved = true;
  drawerDrag.drawer.style.setProperty("--drawer-drag-y", `${delta}px`);
  const fadeDistance = Math.max(220, window.innerHeight * 0.55);
  drawerDrag.backdrop?.style.setProperty("--drawer-drag-opacity", String(clamp(1 - delta / fadeDistance, 0, 1)));
  if (delta > 0) event.preventDefault();
}

function finishDrawerDrag(event, cancelled = false) {
  if (!drawerDrag || event.pointerId !== drawerDrag.pointerId) return;
  const drag = drawerDrag;
  drawerDrag = null;
  const delta = Math.max(0, drag.currentY - drag.startY);
  const elapsed = Math.max(1, performance.now() - drag.startTime);
  const velocity = delta / elapsed;
  const shouldClose = !cancelled && (delta > Math.min(112, window.innerHeight * 0.16) || (delta > 28 && velocity > 0.5));

  if (drag.moved) suppressDrawerHandleClickUntil = Date.now() + 360;
  if (drag.handle.hasPointerCapture?.(event.pointerId)) drag.handle.releasePointerCapture(event.pointerId);

  if (shouldClose) {
    closeDrawer();
    return;
  }

  drag.drawer.classList.remove("is-dragging");
  requestAnimationFrame(() => {
    drag.drawer.style.removeProperty("--drawer-drag-y");
    drag.backdrop?.style.removeProperty("--drawer-drag-opacity");
  });
}

function handleDrawerPointerUp(event) {
  finishDrawerDrag(event, false);
}

function handleDrawerPointerCancel(event) {
  finishDrawerDrag(event, true);
}

// `GET /api/config` → 站点信息 + 主题设置（theme_options 里的 butterfly_* 键）。
async function loadSiteConfig() {
  const config = await api.getConfig();
  if (!isRecord(config)) throw new Error(t("loadFailedTitle"));
  state.cfsmConfig = config;
  state.themeOptions = isRecord(config.theme_options) ? config.theme_options : {};
  state.turnstileBlocked = isTurnstileBlocking(config);
  state.publicInfo = {
    sitename: typeof config.site_title === "string" ? config.site_title : "",
    description: "",
    theme: typeof config.preferred_theme === "string" ? config.preferred_theme : "",
    theme_settings: readThemeSettings(state.themeOptions),
    is_public: config.is_public === true,
  };
  state.version = { version: typeof config.version === "string" ? config.version : "unknown", hash: "" };
  state.config = mergeConfig(state.publicInfo.theme_settings);
  state.sort = state.config.default_sort;
  applyConfiguredLanguage();
  applyTextScale();
  applyAppearance();
  return config;
}

// `/api/servers` 一次给出节点、实时状态与三网窗口（原主题是 getNodes + getNodesLatestStatus 两个调用）。
function applyServersPayload(payload) {
  const mapped = mapServers(payload, { config: state.cfsmConfig, now: Date.now() });
  state.sysConfig = mapped.sysConfig;
  state.nodes = mapped.nodes;
  state.statuses = mapped.statuses;
  state.connected = true;
  state.lastUpdated = Date.now();
  updateSamples();
  return mapped;
}

async function loadLiveData() {
  await loadSiteConfig();
  applyServersPayload(await api.getServers({ timeout: 20000 }));
  // CFSM 没有 `/api/me`：本地有 jwt_token 即视为已登录（可看隐藏机器、可查 >24h 历史）。
  state.userInfo = { logged_in: hasStoredToken(), username: "" };
}

async function refreshStatuses(manual = false) {
  if (statusRefreshInFlight) return;
  statusRefreshInFlight = true;
  try {
    if (state.demoMode) {
      mutateDemoStatuses();
      state.connected = true;
      state.lastUpdated = Date.now();
      updateSamples();
      scheduleStatusRender(manual);
      if (manual) showToast(t("realtimeMonitoring"), t("updatedNow"), "success");
      return;
    }
    try {
      applyServersPayload(await api.getServers({ timeout: 15000 }));
      scheduleStatusRender(manual);
      if (manual) showToast(t("realtimeMonitoring"), t("updatedNow"), "success");
    } catch (error) {
      state.connected = false;
      scheduleStatusRender(manual);
      if (manual) showToast(t("disconnected"), error instanceof Error ? error.message : t("offlineData"), "warning");
    }
  } finally {
    statusRefreshInFlight = false;
  }
}

// 轮询由 cfsm-api 的 poller 负责：页面不可见暂停，恢复可见先立即拉一次，失败按 2 的幂退避。
function startTimers() {
  stopTimers();
  if (document.hidden) return;
  statusPoller.start();
  state.clockTimer = setInterval(updateLiveElements, 1000);
}

function stopTimers() {
  statusPoller.stop();
  clearInterval(state.clockTimer);
  state.pollTimer = null;
  state.clockTimer = null;
}

function handleVisibilityChange() {
  if (document.hidden) {
    stopTimers();
    if (mobileStatusRenderTimer !== null) {
      clearTimeout(mobileStatusRenderTimer);
      mobileStatusRenderTimer = null;
    }
    return;
  }
  if (state.loading || state.error) return;
  updateLiveElements();
  // poller 在可见性恢复时会立即执行一次；这里重新起表并由它接管排程。
  startTimers();
}

async function initialize() {
  state.loading = true;
  state.error = null;
  renderLoading();
  applyAppearance();
  try {
    if (state.demoMode) loadDemoData();
    else await loadLiveData();
    state.loading = false;
    renderApp();
    if (state.currentView === "traffic") void loadTrafficHistory();
    // 深链接：首次进入按 #/server/<id> 打开详情抽屉
    applyHashRoute();
    if (new URLSearchParams(location.search).get("globe") === "1") openGlobe();
    startTimers();
  } catch (error) {
    console.error("[CFSM Butterfly] initialization failed", error);
    state.loading = false;
    state.error = error instanceof Error ? error.message : String(error);
    renderFatalError();
  }
}

function seededSeries(seed, count, center, spread, min = 0, max = 100) {
  let value = seed >>> 0;
  return Array.from({ length: count }, (_, index) => {
    value = (value * 1664525 + 1013904223) >>> 0;
    const noise = value / 4294967295 - 0.5;
    const wave = Math.sin((index + seed % 7) * 0.72) * spread * 0.42;
    return clamp(center + noise * spread + wave, min, max);
  });
}

function loadDemoData() {
  state.publicInfo = {
    sitename: "Komari",
    description: "A simple server monitor tool.",
    oauth_enable: true,
    theme: "Butterfly",
    theme_settings: {},
  };
  state.config = { ...DEFAULT_CONFIG, color_scheme: "light", default_sort: "sort_order" };
  state.sort = state.config.default_sort;
  state.userInfo = { logged_in: false, username: "", uuid: "", "2fa_enabled": false, sso_id: "", sso_type: "" };
  state.version = { version: "demo", hash: "demo" };
  state.nodes = demoNodes();
  state.statuses = demoStatuses();
  state.connected = true;
  state.lastUpdated = Date.now();
  state.networkSamples = Array.from({ length: 30 }, (_, index) => ({
    upload: seededSeries(31, 30, 75_000_000, 45_000_000, 5_000_000, 150_000_000)[index],
    download: seededSeries(77, 30, 110_000_000, 64_000_000, 8_000_000, 220_000_000)[index],
    time: Date.now() - (29 - index) * 50 * 60 * 1000,
  }));
  for (const [index, node] of state.nodes.entries()) state.nodeSamples.set(node.uuid, seededSeries(index * 53 + 19, 24, state.statuses[node.uuid].cpu || 30, 28, 4, 96));
  applyAppearance();
}

function demoNodes() {
  const now = new Date().toISOString();
  return [
    { uuid: "demo-hk01", name: "Hong Kong HK01", cpu_name: "AMD EPYC 7B13", virtualization: "KVM", arch: "x86_64", cpu_cores: 4, os: "Debian 13", kernel_version: "6.12.38", gpu_name: "", ipv4: "103.71.*.*", ipv6: "2406:da1a:*", region: "HK", remark: "", public_remark: "Hong Kong · HKT", mem_total: 8 * 1024 ** 3, swap_total: 2 * 1024 ** 3, disk_total: 160 * 1024 ** 3, weight: 100, price: 7, billing_cycle: 30, auto_renewal: true, currency: "USD", expired_at: "2027-01-01T00:00:00Z", group: "Asia", tags: "edge, premium", hidden: false, traffic_limit: 2 * 1024 ** 4, traffic_limit_type: "sum", created_at: now, updated_at: now },
    { uuid: "demo-sg01", name: "Singapore SG01", cpu_name: "AMD EPYC 7763", virtualization: "KVM", arch: "x86_64", cpu_cores: 4, os: "Ubuntu 24.04", kernel_version: "6.8.0", gpu_name: "", ipv4: "139.99.*.*", ipv6: "2402:1f00:*", region: "SG", public_remark: "Singapore · AWS", mem_total: 12 * 1024 ** 3, swap_total: 2 * 1024 ** 3, disk_total: 200 * 1024 ** 3, weight: 95, price: 9, billing_cycle: 30, auto_renewal: true, currency: "USD", expired_at: "2027-02-08T00:00:00Z", group: "Asia", tags: "core, aws", hidden: false, traffic_limit: 2 * 1024 ** 4, traffic_limit_type: "sum", created_at: now, updated_at: now },
    { uuid: "demo-jp01", name: "Tokyo JP01", cpu_name: "Intel Xeon Platinum 8370C", virtualization: "KVM", arch: "x86_64", cpu_cores: 6, os: "Arch Linux", kernel_version: "6.17.1-zen1", gpu_name: "", ipv4: "160.16.*.*", ipv6: "2001:e42:*", region: "JP", public_remark: "Tokyo · Linode", mem_total: 16 * 1024 ** 3, swap_total: 4 * 1024 ** 3, disk_total: 320 * 1024 ** 3, weight: 90, price: 12, billing_cycle: 30, auto_renewal: true, currency: "USD", expired_at: "2027-03-15T00:00:00Z", group: "Asia", tags: "compute, zen", hidden: false, traffic_limit: 3 * 1024 ** 4, traffic_limit_type: "sum", created_at: now, updated_at: now },
    { uuid: "demo-de01", name: "Frankfurt DE01", cpu_name: "AMD EPYC 9454P", virtualization: "KVM", arch: "x86_64", cpu_cores: 8, os: "Debian 13", kernel_version: "6.12.43", gpu_name: "", ipv4: "49.12.*.*", ipv6: "2a01:4f8:*", region: "DE", public_remark: "Frankfurt · Hetzner", mem_total: 24 * 1024 ** 3, swap_total: 4 * 1024 ** 3, disk_total: 480 * 1024 ** 3, weight: 85, price: 16, billing_cycle: 30, auto_renewal: true, currency: "EUR", expired_at: "2027-04-02T00:00:00Z", group: "Europe", tags: "storage, hetzner", hidden: false, traffic_limit: 4 * 1024 ** 4, traffic_limit_type: "sum", created_at: now, updated_at: now },
    { uuid: "demo-us01", name: "Los Angeles US01", cpu_name: "AMD EPYC 7R13", virtualization: "KVM", arch: "x86_64", cpu_cores: 4, os: "AlmaLinux 9", kernel_version: "5.14.0", gpu_name: "", ipv4: "198.55.*.*", ipv6: "2607:f2d8:*", region: "US", public_remark: "Los Angeles · DMIT", mem_total: 12 * 1024 ** 3, swap_total: 2 * 1024 ** 3, disk_total: 256 * 1024 ** 3, weight: 80, price: 14, billing_cycle: 30, auto_renewal: true, currency: "USD", expired_at: "2027-04-20T00:00:00Z", group: "America", tags: "west, premium", hidden: false, traffic_limit: 3 * 1024 ** 4, traffic_limit_type: "sum", created_at: now, updated_at: now },
    { uuid: "demo-nl01", name: "Amsterdam NL01", cpu_name: "Intel Xeon Gold 6338", virtualization: "KVM", arch: "x86_64", cpu_cores: 4, os: "Ubuntu 24.04", kernel_version: "6.8.0", gpu_name: "", ipv4: "185.107.*.*", ipv6: "2a03:3b40:*", region: "NL", public_remark: "Amsterdam · Online.net", mem_total: 8 * 1024 ** 3, swap_total: 2 * 1024 ** 3, disk_total: 200 * 1024 ** 3, weight: 75, price: 10, billing_cycle: 30, auto_renewal: true, currency: "EUR", expired_at: "2027-05-14T00:00:00Z", group: "Europe", tags: "transit, eu", hidden: false, traffic_limit: 2 * 1024 ** 4, traffic_limit_type: "sum", created_at: now, updated_at: now },
    { uuid: "demo-br01", name: "São Paulo BR01", cpu_name: "AMD EPYC 7502P", virtualization: "KVM", arch: "x86_64", cpu_cores: 4, os: "Debian 12", kernel_version: "6.1.0", gpu_name: "", ipv4: "177.54.*.*", ipv6: "2804:23c:*", region: "BR", public_remark: "São Paulo · EQT", mem_total: 8 * 1024 ** 3, swap_total: 2 * 1024 ** 3, disk_total: 180 * 1024 ** 3, weight: 70, price: 11, billing_cycle: 30, auto_renewal: false, currency: "USD", expired_at: "2026-12-01T00:00:00Z", group: "America", tags: "south, edge", hidden: false, traffic_limit: 2 * 1024 ** 4, traffic_limit_type: "sum", created_at: now, updated_at: now },
    { uuid: "demo-in01", name: "Mumbai IN01", cpu_name: "Intel Xeon Platinum 8259CL", virtualization: "KVM", arch: "x86_64", cpu_cores: 4, os: "Ubuntu 22.04", kernel_version: "5.15.0", gpu_name: "", ipv4: "103.27.*.*", ipv6: "2401:4900:*", region: "IN", public_remark: "Mumbai · Vultr", mem_total: 8 * 1024 ** 3, swap_total: 2 * 1024 ** 3, disk_total: 160 * 1024 ** 3, weight: 65, price: 10, billing_cycle: 30, auto_renewal: true, currency: "USD", expired_at: "2027-06-21T00:00:00Z", group: "Asia", tags: "south-asia, edge", hidden: false, traffic_limit: 2 * 1024 ** 4, traffic_limit_type: "sum", created_at: now, updated_at: now },
  ];
}

function demoStatuses() {
  const values = [
    [23, 45, 62, 12, 31_200_000, 56_300_000, 12, true, 15 * 86400 + 8 * 3600],
    [34, 67, 43, 28, 48_400_000, 89_100_000, 28, true, 12 * 86400 + 3 * 3600],
    [32, 32, 48, 45, 42_100_000, 73_700_000, 45, true, 7 * 86400 + 11 * 3600],
    [56, 78, 71, 156, 65_500_000, 104_200_000, 156, true, 3 * 86400 + 14 * 3600],
    [18, 39, 24, 81, 37_800_000, 90_300_000, 81, true, 9 * 86400 + 6 * 3600],
    [43, 61, 59, 112, 50_200_000, 84_100_000, 112, true, 6 * 86400 + 22 * 3600],
    [64, 71, 80, 186, 33_500_000, 58_700_000, 186, true, 4 * 86400 + 9 * 3600],
    [92, 68, 83, 214, 18_100_000, 42_400_000, 214, false, 0],
  ];
  const result = {};
  demoNodes().forEach((node, index) => {
    const [cpu, ramPct, diskPct, latency, netIn, netOut, ping, online, uptime] = values[index];
    const ramTotal = node.mem_total;
    const diskTotal = node.disk_total;
    result[node.uuid] = {
      client: node.uuid, time: new Date(Date.now() - index * 120000).toISOString(), cpu, gpu: 0, ram: ramTotal * ramPct / 100, ram_total: ramTotal, swap: 0, swap_total: node.swap_total,
      load: cpu / 35, load5: cpu / 39, load15: cpu / 44, temp: 49 + index * 2, disk: diskTotal * diskPct / 100, disk_total: diskTotal,
      net_in: netIn, net_out: netOut, net_total_up: (0.8 + index * 0.31) * 1024 ** 4, net_total_down: (1.1 + index * 0.42) * 1024 ** 4,
      process: 104 + index * 11, connections: 180 + index * 22, connections_udp: 24 + index * 3, online, uptime, message: online ? "" : "Agent disconnected",
      ping: { "1": { name: "Global", latest: ping, avg: ping + 4, tail: ping + 16, loss: index === 6 ? 1.2 : 0, min: Math.max(1, ping - 8), max: ping + 24 } },
    };
  });
  return result;
}

function mutateDemoStatuses() {
  for (const [index, node] of state.nodes.entries()) {
    const status = state.statuses[node.uuid];
    if (!status) continue;
    const drift = Math.sin(Date.now() / 6200 + index) * 4 + (Math.random() - 0.5) * 5;
    status.cpu = clamp(status.cpu + drift, 6, index === 7 ? 96 : 88);
    status.ram = clamp(percent(status.ram, status.ram_total) + drift * 0.25, 18, 94) / 100 * status.ram_total;
    status.net_in = Math.max(1_000_000, status.net_in * (0.9 + Math.random() * 0.2));
    status.net_out = Math.max(1_000_000, status.net_out * (0.9 + Math.random() * 0.2));
    status.net_total_up += status.net_in * state.config.poll_interval;
    status.net_total_down += status.net_out * state.config.poll_interval;
    status.time = new Date().toISOString();
    if (status.ping?.["1"] && status.online) status.ping["1"].latest = Math.max(2, status.ping["1"].latest + (Math.random() - 0.5) * 5);
  }
}

function demoHistory(uuid) {
  const node = getNodeByUuid(uuid);
  const status = nodeStatus(uuid);
  if (!node || !status) return [];
  const cpu = seededSeries(uuid.length * 17, 36, status.cpu, 23, 3, 98);
  const memory = seededSeries(uuid.length * 29, 36, percent(status.ram, status.ram_total), 12, 10, 96);
  const input = seededSeries(uuid.length * 41, 36, status.net_in, Math.max(status.net_in * 0.7, 1), 1_000_000, status.net_in * 2.2);
  const output = seededSeries(uuid.length * 57, 36, status.net_out, Math.max(status.net_out * 0.65, 1), 1_000_000, status.net_out * 2.2);
  const intervalSeconds = 40 * 60;
  return cpu.map((value, index) => ({
    client: uuid,
    time: new Date(Date.now() - (35 - index) * intervalSeconds * 1000).toISOString(),
    cpu: value,
    gpu: 0,
    ram: node.mem_total * memory[index] / 100,
    ram_total: node.mem_total,
    swap: 0,
    swap_total: node.swap_total,
    load: value / 35,
    load5: value / 39,
    load15: value / 44,
    temp: 48 + value / 8,
    disk: status.disk,
    disk_total: status.disk_total,
    net_in: input[index],
    net_out: output[index],
    net_total_up: status.net_total_up,
    net_total_down: status.net_total_down,
    process: status.process,
    connections: status.connections,
    connections_udp: status.connections_udp,
    uptime: Math.max(0, status.uptime - (35 - index) * intervalSeconds),
    message: "",
  }));
}

app.addEventListener("click", handleClick);
globePortal?.addEventListener("click", handleGlobePortalClick);
app.addEventListener("input", handleInput);
app.addEventListener("compositionstart", handleCompositionStart);
app.addEventListener("compositionend", handleCompositionEnd);
app.addEventListener("change", handleChange);
app.addEventListener("pointerdown", handleDrawerPointerDown);
document.addEventListener("pointermove", handleDrawerPointerMove, { passive: false });
document.addEventListener("pointerup", handleDrawerPointerUp);
document.addEventListener("pointercancel", handleDrawerPointerCancel);
document.addEventListener("keydown", handleKeydown);
document.addEventListener("error", handleFlagError, true);
window.addEventListener("hashchange", applyHashRoute);
document.addEventListener("visibilitychange", handleVisibilityChange);
document.addEventListener("focusin", scheduleMobileInputState);
document.addEventListener("focusout", () => setTimeout(scheduleMobileInputState, 0));
window.addEventListener("scroll", scheduleMobileNavVisibility, { passive: true });
matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
  if (!safeStorageGet(STORAGE.theme) && state.config.color_scheme === "system") {
    applyAppearance();
    updateThemeButtons();
  }
});
matchMedia(MOBILE_LAYOUT_QUERY).addEventListener("change", () => {
  resetMobileNavVisibility();
  scheduleMobileInputState();
  if (!state.loading && !state.error) renderApp();
});
window.addEventListener("resize", scheduleMobileNavVisibility, { passive: true });
window.addEventListener("resize", scheduleMobileInputState, { passive: true });
window.visualViewport?.addEventListener("resize", scheduleMobileInputState, { passive: true });
window.visualViewport?.addEventListener("scroll", scheduleMobileInputState, { passive: true });

updateMobileInputState();
initialize();
