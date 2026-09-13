// CF-Server-Monitor 移植版设置层。
//
// 原主题把设置放在 `komari-theme.json` 的 `configuration.data` 里交给 Komari 托管；
// CFSM 没有等价清单，改为本文件保存默认值与类型元数据，运行时存到 CFSM 的
// `appearance_options.theme_options`（整体替换语义，必须读-改-写）。
// 落库时统一加 `butterfly_` 前缀，避免与其它主题（该实例上原有 LuminaPlus 的 38 个键）互相覆盖。

export const THEME_SETTING_PREFIX = "butterfly_";

// 轮询间隔：CFSM `/api/servers` 单次约 230 KB，默认 30 秒；页面不可见时暂停。
export const POLL_INTERVAL_MIN = 15;
export const POLL_INTERVAL_MAX = 300;

// 与原 komari-theme.json 的 configuration.data 逐项对应（16 项），保持原键名以便沿用原 UI 逻辑。
// 两处按移植决策改了默认值：default_sort 由 Komari 的 `weight` 改为 CFSM 的 `sort_order`；
// poll_interval 由 5 秒改为 30 秒。
export const SECTION_LABELS = Object.freeze({
  appearance: { "zh-CN": "外观", en: "Appearance", ja: "外観" },
  dashboard: { "zh-CN": "面板", en: "Dashboard", ja: "ダッシュボード" },
  copy: { "zh-CN": "文案与页脚", en: "Copy and footer", ja: "文言とフッター" },
});

export const THEME_SETTINGS = Object.freeze([
  { section: "appearance", key: "color_scheme", type: "select", options: ["system", "light", "dark"], default: "system",
    label: { "zh-CN": "默认配色", en: "Default color scheme", ja: "既定の配色" } },
  { section: "appearance", key: "accent_color", type: "select", options: ["indigo", "blue", "teal", "violet", "rose"], default: "indigo",
    label: { "zh-CN": "强调色", en: "Accent color", ja: "アクセントカラー" } },
  { section: "appearance", key: "density", type: "select", options: ["comfortable", "compact"], default: "comfortable",
    label: { "zh-CN": "信息密度", en: "Information density", ja: "情報密度" } },
  { section: "appearance", key: "corner_style", type: "select", options: ["soft", "rounded"], default: "soft",
    label: { "zh-CN": "圆角风格", en: "Corner style", ja: "角丸スタイル" } },
  { section: "appearance", key: "background_image", type: "string", default: "",
    label: { "zh-CN": "自定义背景图 URL", en: "Custom background image URL", ja: "背景画像 URL" } },
  { section: "appearance", key: "background_opacity", type: "number", min: 0, max: 100, default: 16,
    label: { "zh-CN": "背景图可见度", en: "Background image visibility", ja: "背景画像の不透明度" } },
  { section: "dashboard", key: "show_network_hero", type: "switch", default: true,
    label: { "zh-CN": "显示全局网络头图", en: "Show global network hero", ja: "グローバルネットワーク表示" } },
  { section: "dashboard", key: "show_latency_panel", type: "switch", default: true,
    label: { "zh-CN": "显示延迟分布", en: "Show latency distribution", ja: "遅延分布を表示" } },
  { section: "dashboard", key: "show_ip_tags", type: "switch", default: true,
    label: { "zh-CN": "显示协议徽标（V4/V6）", en: "Show protocol badges (V4/V6)", ja: "プロトコルバッジ（V4/V6）" } },
  { section: "dashboard", key: "poll_interval", type: "number", min: POLL_INTERVAL_MIN, max: POLL_INTERVAL_MAX, default: 30,
    label: { "zh-CN": "状态刷新间隔（秒）", en: "Status refresh interval (seconds)", ja: "状態更新間隔（秒）" } },
  { section: "dashboard", key: "default_sort", type: "select", options: ["sort_order", "name", "latency", "traffic"], default: "sort_order",
    label: { "zh-CN": "默认排序", en: "Default node sorting", ja: "既定の並び順" } },
  { section: "dashboard", key: "offline_position", type: "select", options: ["last", "first", "keep"], default: "last",
    label: { "zh-CN": "离线机器位置", en: "Offline node position", ja: "オフライン機の位置" } },
  { section: "copy", key: "brand_text", type: "string", default: "",
    label: { "zh-CN": "品牌文字", en: "Brand text", ja: "ブランド名" } },
  { section: "copy", key: "hero_title", type: "string", default: "Global Network",
    label: { "zh-CN": "主标题", en: "Hero title", ja: "ヒーロータイトル" } },
  { section: "copy", key: "hero_subtitle", type: "string", default: "Real-time status at a glance",
    label: { "zh-CN": "副标题", en: "Hero subtitle", ja: "ヒーローサブタイトル" } },
  { section: "copy", key: "custom_footer_html", type: "textbox", default: "",
    label: { "zh-CN": "自定义页脚 HTML", en: "Custom footer HTML", ja: "フッター HTML" } },
]);

export function localizedValue(source, language) {
  if (!source || typeof source !== "object") return "";
  return source[language] || source.en || source["zh-CN"] || "";
}

export function settingLabel(meta, language) {
  return localizedValue(meta?.label, language) || meta?.key || "";
}

export const THEME_SETTING_KEYS = Object.freeze(THEME_SETTINGS.map(item => item.key));

export const DEFAULT_SETTINGS = Object.freeze(
  Object.fromEntries(THEME_SETTINGS.map(item => [item.key, item.default])),
);

const SETTINGS_BY_KEY = new Map(THEME_SETTINGS.map(item => [item.key, item]));

function clampNumber(value, min, max) {
  const number = typeof value === "number" ? value : Number(String(value ?? "").trim());
  if (!Number.isFinite(number)) return null;
  if (typeof min === "number" && number < min) return min;
  if (typeof max === "number" && number > max) return max;
  return number;
}

// 按元数据把外部值收成可用值；类型不符时回落到默认值，绝不抛错（字段容错要求）。
export function normalizeSettingValue(meta, value) {
  if (!meta) return value;
  switch (meta.type) {
    case "switch":
      if (typeof value === "boolean") return value;
      if (value === "true" || value === "1" || value === 1) return true;
      if (value === "false" || value === "0" || value === 0) return false;
      return meta.default;
    case "number": {
      const number = clampNumber(value, meta.min, meta.max);
      return number === null ? meta.default : number;
    }
    case "select":
      return meta.options.includes(value) ? value : meta.default;
    case "textbox":
    case "string":
    default:
      return typeof value === "string" ? value : meta.default;
  }
}

// CFSM `theme_options` → 原主题的扁平设置对象（只含已知键，未知键忽略）。
export function readThemeSettings(themeOptions) {
  const source = themeOptions && typeof themeOptions === "object" && !Array.isArray(themeOptions) ? themeOptions : {};
  const settings = { ...DEFAULT_SETTINGS };
  for (const meta of THEME_SETTINGS) {
    const raw = source[`${THEME_SETTING_PREFIX}${meta.key}`];
    if (raw === undefined) continue;
    settings[meta.key] = normalizeSettingValue(meta, raw);
  }
  return settings;
}

// 读-改-写：保留 theme_options 里所有非本主题的键（例如同一实例上其它主题的设置），
// 只覆盖/补齐 `butterfly_` 前缀的键。返回新对象，不修改入参。
export function mergeThemeSettings(themeOptions, settings) {
  const base = themeOptions && typeof themeOptions === "object" && !Array.isArray(themeOptions) ? themeOptions : {};
  const next = { ...base };
  for (const meta of THEME_SETTINGS) {
    if (!(meta.key in (settings || {}))) continue;
    next[`${THEME_SETTING_PREFIX}${meta.key}`] = normalizeSettingValue(meta, settings[meta.key]);
  }
  return next;
}

// 仅取本主题的键（保存前的差集核对用）。
export function pickThemeSettings(themeOptions) {
  const source = themeOptions && typeof themeOptions === "object" && !Array.isArray(themeOptions) ? themeOptions : {};
  const picked = {};
  for (const key of Object.keys(source)) {
    if (key.startsWith(THEME_SETTING_PREFIX)) picked[key] = source[key];
  }
  return picked;
}

export function settingsMeta(key) {
  return SETTINGS_BY_KEY.get(key) || null;
}
