// 主题模块单元测试：node 22 直接加载源码模块（这两个模块不依赖 DOM），
// 并对关键修复做源码级断言，防止回归。用法：npm test
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import assert from "node:assert/strict";

import {
  DEFAULT_SETTINGS,
  POLL_INTERVAL_MAX,
  POLL_INTERVAL_MIN,
  THEME_SETTINGS,
  THEME_SETTING_PREFIX,
  normalizeSettingValue,
  readThemeSettings,
  settingsMeta,
} from "../src/assets/theme-config.js";
import { mapNode, mapServers, mapStatus } from "../src/assets/cfsm-map.js";

const root = resolve(import.meta.dirname, "..");
const appSource = readFileSync(resolve(root, "src/assets/app.js"), "utf8");

let passed = 0;
const failures = [];

function check(name, fn) {
  try {
    fn();
    passed += 1;
  } catch (error) {
    failures.push(`${name}: ${error?.message || error}`);
  }
}

// --- 设置层 ---

check("poll_interval 默认 30、范围 15–300", () => {
  assert.equal(DEFAULT_SETTINGS.poll_interval, 30);
  assert.equal(POLL_INTERVAL_MIN, 15);
  assert.equal(POLL_INTERVAL_MAX, 300);
  const meta = settingsMeta("poll_interval");
  assert.equal(meta.min, 15);
  assert.equal(meta.max, 300);
});

check("default_sort 默认为 sort_order", () => {
  assert.equal(DEFAULT_SETTINGS.default_sort, "sort_order");
});

check("每项设置的默认值存在且可归一化", () => {
  for (const meta of THEME_SETTINGS) {
    assert.ok(Object.hasOwn(DEFAULT_SETTINGS, meta.key), `${meta.key} 缺少默认值`);
    assert.notEqual(normalizeSettingValue(meta, meta.default), null, `${meta.key} 默认值归一化失败`);
  }
});

check("越界数值按范围 clamp", () => {
  const meta = settingsMeta("poll_interval");
  assert.equal(normalizeSettingValue(meta, 1), 15);
  assert.equal(normalizeSettingValue(meta, 9999), 300);
});

check("readThemeSettings 只读取 butterfly_ 前缀的键", () => {
  const settings = readThemeSettings({ [`${THEME_SETTING_PREFIX}poll_interval`]: 45, poll_interval: 7 });
  assert.equal(settings.poll_interval, 45);
});

// --- 字段映射 ---

check("mapNode 把 sort_order 映射为 weight（升序语义在 app.js 处理）", () => {
  const node = mapNode({ id: "srv-1", name: "HK-01", sort_order: 3, ram_total: 1024, swap_total: 0, disk_total: 0 });
  assert.equal(node.uuid, "srv-1");
  assert.equal(node.weight, 3);
});

check("mapStatus 导出 time / cfsm_updated，且不含 updated_at", () => {
  const status = mapStatus({ id: "srv-1", last_updated: 1737638400000, cpu: 12.5, ram_used: 512, ram_total: 1024 });
  assert.equal(status.time, 1737638400000);
  assert.equal(status.cfsm_updated, 1737638400000);
  assert.ok(!Object.hasOwn(status, "updated_at"), "不应存在 updated_at 字段");
});

check("mapServers 保持输入顺序并建立 statuses 索引", () => {
  const payload = {
    servers: [
      { id: "b", name: "B", sort_order: 2, ram_total: 1024, ram_used: 256 },
      { id: "a", name: "A", sort_order: 1, ram_total: 1024, ram_used: 128 },
    ],
    stats: { total: 2 },
    regionStats: {},
    sysConfig: {},
  };
  const mapped = mapServers(payload, { now: Date.now() });
  assert.deepEqual(mapped.nodes.map(node => node.uuid), ["b", "a"]);
  assert.ok(mapped.statuses.b && mapped.statuses.a);
});

// --- 源码级断言（防止关键修复被回退） ---

check("节点排序按 sort_order 升序（app.js）", () => {
  assert.match(appSource, /return finiteNumber\(a\.weight\) - finiteNumber\(b\.weight\);/);
  assert.doesNotMatch(appSource, /return finiteNumber\(b\.weight\) - finiteNumber\(a\.weight\);/);
});

check("流量默认档位 6 小时、可选 6/24，且空窗口跳过默认关闭", () => {
  assert.match(appSource, /const TRAFFIC_DEFAULT_HOURS = 6;/);
  assert.match(appSource, /const TRAFFIC_HOURS_OPTIONS = Object\.freeze\(\[6, 24\]\);/);
  assert.match(appSource, /const TRAFFIC_SKIP_STALE = false;/);
});

check("流量历史缓存按档位隔离", () => {
  assert.match(appSource, /trafficHistoryCache: new Map\(\)/);
  assert.match(appSource, /trafficHistoryLoadingByHours: new Set\(\)/);
});

// --- 结果 ---

if (failures.length) {
  console.error(`✗ ${failures.length} 项失败，${passed} 项通过`);
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}
console.log(`✓ 全部 ${passed} 项通过`);
process.exit(0);
