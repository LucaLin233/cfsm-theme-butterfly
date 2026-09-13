import { access, readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const distDir = resolve(root, "dist");
const errors = [];

const pkg = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));
const version = pkg.version;
if (typeof version !== "string" || !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(version)) {
  errors.push("package.json version must be a semantic version");
}

async function readIfExists(path, label) {
  try {
    return await readFile(path, "utf8");
  } catch {
    errors.push(`required file is missing: ${label}`);
    return "";
  }
}

async function assertAbsent(path, label) {
  try {
    await access(path);
    errors.push(`${label} must not exist in this port`);
  } catch {
    // expected
  }
}

// --- 产物结构：dist/ 根级只有 index.html 与 assets/，assets/ 只有 .js/.css 文件 ---
const requiredDistFiles = [
  "index.html",
  "assets/app.js",
  "assets/styles.css",
  "assets/region-data.js",
  "assets/world-data.js",
  "assets/cfsm-api.js",
  "assets/cfsm-map.js",
  "assets/theme-config.js",
];
for (const relative of requiredDistFiles) {
  try {
    await access(resolve(distDir, relative));
  } catch {
    errors.push(`required file is missing: dist/${relative}`);
  }
}

const allowedDistRoot = new Set(["index.html", "assets"]);
try {
  for (const entry of await readdir(distDir)) {
    if (!allowedDistRoot.has(entry)) errors.push(`dist/ must only contain index.html and assets/: found dist/${entry}`);
  }
  for (const entry of await readdir(resolve(distDir, "assets"), { withFileTypes: true })) {
    if (entry.isDirectory()) errors.push(`dist/assets/ must not contain directories: found dist/assets/${entry.name}/`);
    else if (!/\.(?:js|css)$/.test(entry.name)) errors.push(`dist/assets/ contains an unexpected file: ${entry.name}`);
  }
} catch {
  // missing dist/ is reported by the required-file loop above
}

// 上游市场/代理资源在本移植版必须保持删除状态
await assertAbsent(resolve(root, "komari-theme.json"), "komari-theme.json");
await assertAbsent(resolve(root, "preview.png"), "preview.png");
await assertAbsent(resolve(root, "src", "favicon.svg"), "src/favicon.svg");
await assertAbsent(resolve(root, "src", "assets", "flags"), "src/assets/flags");

// --- 产物内容 ---
const indexHtml = await readIfExists(resolve(distDir, "index.html"), "dist/index.html");
const appSource = await readIfExists(resolve(distDir, "assets", "app.js"), "dist/assets/app.js");
const cssSource = await readIfExists(resolve(distDir, "assets", "styles.css"), "dist/assets/styles.css");
const worldDataSource = await readIfExists(resolve(distDir, "assets", "world-data.js"), "dist/assets/world-data.js");

if (!indexHtml.includes("CF-Server-Monitor")) errors.push("dist/index.html must identify CF-Server-Monitor");
if (!indexHtml.includes('src="/assets/app.js?v=' + version + '"')) {
  errors.push(`dist/index.html must load /assets/app.js with the ?v=${version} cache-busting query`);
}
if (!indexHtml.includes('href="/assets/styles.css?v=' + version + '"')) {
  errors.push(`dist/index.html must load /assets/styles.css with the ?v=${version} cache-busting query`);
}
if (!indexHtml.includes('id="globe-portal"')) errors.push("dist/index.html must provide #globe-portal");
if (!indexHtml.includes("viewport-fit=cover, interactive-widget=resizes-content")) {
  errors.push("dist/index.html must keep the mobile safe-area and keyboard-aware viewport settings");
}
if (!indexHtml.includes('<meta name="format-detection" content="telephone=no"')) {
  errors.push("dist/index.html must disable automatic telephone-number detection");
}
if (/(?:src|href)=["']https?:\/\//i.test(indexHtml)) errors.push("dist/index.html must not load remote scripts or styles");
if (indexHtml.includes("favicon.svg")) errors.push("dist/index.html must not reference favicon.svg");
if (indexHtml.includes("__THEME_VERSION__")) errors.push("dist/index.html still contains an unreplaced version token");
if (appSource.includes("__THEME_VERSION__")) errors.push("dist/assets/app.js still contains an unreplaced version token");
if (!appSource.includes(`const THEME_VERSION = "${version}"`)) {
  errors.push("dist/assets/app.js version does not match package.json");
}
// 主题模块必须带 ?v=<version> 引入：CFSM 对主题资源下发 immutable 缓存，
// 不带版本串的 import 会在浏览器里长期命中旧副本。
const versionedImports = [
  ['from "./region-data.js?v=', "the bundled region data"],
  ['from "./cfsm-api.js?v=', "the CFSM REST client"],
  ['from "./cfsm-map.js?v=', "the CFSM mapping layer"],
  ['from "./theme-config.js?v=', "the theme settings module"],
  ['import("./world-data.js?v=', "the bundled world land data (lazy)"],
];
for (const [token, label] of versionedImports) {
  if (!appSource.includes(`${token}${version}"`)) {
    errors.push(`dist/assets/app.js must import ${label} with the ?v=${version} cache-busting query`);
  }
}
if (appSource.includes("/api/rpc2") || appSource.includes("jsonrpc")) {
  errors.push("dist/assets/app.js must not keep the Komari JSON-RPC client");
}
if (appSource.includes("renderPerformancePanel")) errors.push("Top Performance panel implementation must not be present");
if (appSource.includes("highPerformance")) errors.push("Redundant performance summary must not be present");
if (worldDataSource.includes("export const REGION_COORDS")) {
  errors.push("world-data.js must not duplicate REGION_COORDS from region-data.js");
}
// 旗帜改由 CFSM 同源提供（/flags/<小写码>.svg），不得再引用主题内打包的旗帜
for (const [label, source] of [["dist/assets/app.js", appSource], ["dist/assets/styles.css", cssSource]]) {
  if (source.includes("/assets/flags/")) errors.push(`${label} must not reference the removed /assets/flags/ bundle`);
}

const requiredMobileAppTokens = [
  'const MOBILE_LAYOUT_QUERY = "(max-width: 720px), (max-width: 900px) and (orientation: landscape) and (max-height: 520px)";',
  'const MOBILE_GLOBE_QUERY = "(max-width: 680px), (max-width: 900px) and (orientation: landscape) and (max-height: 520px)";',
  'function centerSelectedGlobeRegion(code',
  'function captureRenderContinuity()',
  'function restoreRenderContinuity(snapshot)',
  'aria-current="page"',
  'enterkeyhint="search"',
  'has-mobile-overlay',
  'function handleDrawerPointerDown(event)',
  'function updateMobileNavVisibility()',
  'function updateMobileInputState()',
  'window.visualViewport?.addEventListener("resize", scheduleMobileInputState',
  'let spinVelocity = 0;',
  'const hasMomentum = !reducedMotion',
  'mobile-search-active',
  'searchCompact',
];
for (const token of requiredMobileAppTokens) {
  if (!appSource.includes(token)) errors.push(`dist/assets/app.js is missing mobile contract token: ${token}`);
}

const requiredMobileCssTokens = [
  '.app-shell.view-nodes .status-ribbon',
  '.app-shell.has-mobile-overlay .mobile-bottom-nav',
  '@media (max-width: 900px) and (orientation: landscape) and (max-height: 520px)',
  'bottom: calc(8px + env(safe-area-inset-bottom))',
  'scroll-snap-type: x mandatory',
  '.node-drawer.is-dragging',
  '.app-shell.mobile-nav-hidden .mobile-bottom-nav',
  ':root.mobile-input-focused .mobile-bottom-nav',
  '--drawer-drag-y',
  '@media (max-width: 720px) and (max-height: 650px) and (orientation: portrait)',
  '@media (max-width: 380px) and (max-height: 600px) and (orientation: portrait)',
];
for (const token of requiredMobileCssTokens) {
  if (!cssSource.includes(token)) errors.push(`dist/assets/styles.css is missing mobile contract token: ${token}`);
}

if (errors.length > 0) {
  console.error("Theme validation failed:\n" + errors.map(error => `- ${error}`).join("\n"));
  process.exit(1);
}

console.log(`Validated CFSM Butterfly ${version}`);
console.log("Deploy contract: dist/index.html + dist/assets/*  (theme_url -> <commit-sha>/dist)");
