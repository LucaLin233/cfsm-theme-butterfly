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

// --- 深链单机作用域（detail）---

check("/api/server 的单机响应可直接映射为 detailNode + status", () => {
  const raw = {
    id: "srv-1",
    name: "HK-01",
    region: "HK",
    os: "Debian 13",
    cpu: 12.34,
    cpu_info: "AMD EPYC",
    cpu_cores: 4,
    ram_total: 8192,
    ram_used: 3700,
    swap_total: 2048,
    swap_used: 100,
    disk_total: 102400,
    disk_used: 32000,
    net_in_speed: 1024,
    net_out_speed: 512,
    tcp_conn: 32,
    udp_conn: 4,
    ping_ct: 23,
    loss_ct: 0,
    boot_time: "1700000000000",
    last_updated: 1737638400000,
    sort_order: 1,
  };
  const node = mapNode(raw);
  assert.equal(node.uuid, "srv-1");
  assert.equal(node.weight, 1);
  // 详情接口不返回三网窗口数组 → window 传 null 时 buildPingMap 仍产出单值线路
  const status = mapStatus(raw, { window: null, now: 1737638400000 });
  assert.equal(status.online, true);
  assert.ok(status.ping.ct, "单值 ping 线路应存在");
  assert.equal(status.ping.ct.latest, 23);
  assert.equal(status.net_in, 512, "net_in = 上传 ← net_out_speed");
  assert.equal(status.net_out, 1024, "net_out = 下载 ← net_in_speed");
});

check("渲染闸门：detail 作用域在 renderApp 第一步分流（app.js）", () => {
  // 闸门必须早于任何全局聚合，否则单台机器会被当作全站统计
  assert.match(
    appSource,
    /function renderApp\(\)\s*\{[\s\S]{0,400}?if \(state\.dataScope === DATA_SCOPE\.detail\) \{\s*renderDetailShell\(\);\s*return;\s*\}/,
  );
  assert.match(appSource, /detailShellHint/);
  assert.match(appSource, /class="app-shell detail-scope/);
});

check("深链冷启动只调用 getServer / getServers 的时机正确（app.js）", () => {
  // 进入单机作用域只读单机接口
  const enter = appSource.match(/async function enterDetailScope\(uuid\)[\s\S]*?\n\}/);
  assert.ok(enter, "enterDetailScope 应存在");
  assert.match(enter[0], /api\.getServer\(uuid/);
  assert.doesNotMatch(enter[0], /api\.getServers\(/);
  // 离开单机作用域才拉整表快照
  const leave = appSource.match(/async function leaveDetailScope\(\)[\s\S]*?\n\}/);
  assert.ok(leave, "leaveDetailScope 应存在");
  assert.match(leave[0], /api\.getServers\(/);
});

check("单机作用域不新增整表轮询路径（app.js）", () => {
  // 只有这三处允许出现 getServers：初始列表加载、离开单机作用域、列表模式刷新
  const calls = appSource.match(/api\.getServers\(/g) || [];
  assert.equal(calls.length, 3, `api.getServers 调用点应为 3 处，实际 ${calls.length}`);
  assert.match(appSource, /function activePoller\(\) \{\s*return state\.dataScope === DATA_SCOPE\.detail \? detailPoller : statusPoller;/);
});

// --- 结果 ---

if (failures.length) {
  console.error(`✗ ${failures.length} 项失败，${passed} 项通过`);
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}
console.log(`✓ 全部 ${passed} 项通过`);
process.exit(0);
