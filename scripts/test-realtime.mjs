// 实时链路（cfsm-realtime.js）单元测试：URL 构造、消息解析、ids 校验、增量合并、连接状态机。
// 全部用注入的假 WebSocket 与假计时器，不触网。用法：npm test
import assert from "node:assert/strict";

import {
  REALTIME_LIMITS,
  buildWsUrl,
  createRealtimeChannel,
  extractSamples,
  isReportStale,
  mergeStatusUpdate,
  normalizeIds,
  parseRealtimeMessage,
} from "../src/assets/cfsm-realtime.js";

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

async function checkAsync(name, fn) {
  try {
    await fn();
    passed += 1;
  } catch (error) {
    failures.push(`${name}: ${error?.message || error}`);
  }
}

// --- 假实现 ---

function createFakeWebSocket() {
  const instances = [];
  class FakeWebSocket {
    constructor(url) {
      this.url = url;
      this.readyState = 0;
      this.sent = [];
      this.closedWith = null;
      instances.push(this);
    }
    send(payload) { this.sent.push(payload); }
    close(code = 1000) {
      this.readyState = 3;
      this.closedWith = code;
      this.onclose?.({ code });
    }
    // 测试驱动
    open() { this.readyState = 1; this.onopen?.(); }
    receive(data) { this.onmessage?.({ data }); }
    serverClose(code) { this.readyState = 3; this.onclose?.({ code }); }
  }
  return { FakeWebSocket, instances };
}

function createFakeTimers() {
  let seq = 0;
  const pending = new Map();
  return {
    setTimeout(fn, ms) { const id = ++seq; pending.set(id, { fn, ms }); return id; },
    clearTimeout(id) { pending.delete(id); },
    runAll() { const entries = [...pending.entries()]; pending.clear(); for (const [, item] of entries) item.fn(); return entries.length; },
    get pendingCount() { return pending.size; },
    get delays() { return [...pending.values()].map(item => item.ms); },
    get lastDelay() { return [...pending.values()].at(-1)?.ms ?? null; },
  };
}

function createChannel({ timers, sockets, ...overrides }) {
  return createRealtimeChannel({
    url: "ws://example.test/api/ws?subscribe=all",
    WebSocketCtor: sockets.FakeWebSocket,
    random: () => 0.5,
    setTimeoutImpl: timers.setTimeout,
    clearTimeoutImpl: timers.clearTimeout,
    ...overrides,
  });
}

// --- ids 校验 ---

check("normalizeIds 接受合法 id 并去重", () => {
  const result = normalizeIds(["srv-1", "srv-1", "a.b:c_d-2"]);
  assert.equal(result.ok, true);
  assert.deepEqual(result.ids, ["srv-1", "a.b:c_d-2"]);
});

check("normalizeIds 拒绝空值、超长与非法字符", () => {
  const long = "x".repeat(REALTIME_LIMITS.maxIdLength + 1);
  const result = normalizeIds(["ok-1", "", long, "bad/id", "has space"]);
  assert.equal(result.ok, false);
  assert.deepEqual(result.ids, ["ok-1"]);
  assert.equal(result.rejected.length, 3);
});

check("normalizeIds 超过 500 个判定不合法并截断", () => {
  const many = Array.from({ length: 501 }, (_, index) => `srv-${index}`);
  const result = normalizeIds(many);
  assert.equal(result.ok, false);
  assert.equal(result.overflow, true);
  assert.equal(result.ids.length, REALTIME_LIMITS.maxIds);
});

// --- URL 构造 ---

check("buildWsUrl 使用页面协议并附带 subscribe", () => {
  const url = new URL(buildWsUrl("https://probe.example.com"));
  assert.equal(url.protocol, "wss:");
  assert.equal(url.pathname, "/api/ws");
  assert.equal(url.searchParams.get("subscribe"), "all");
  assert.equal(url.searchParams.get("token"), null);
});

check("buildWsUrl 自定义 scope；同源不把 token 放进 URL", () => {
  const original = globalThis.location;
  globalThis.location = { origin: "https://probe.example.com", host: "probe.example.com" };
  try {
    // 同 host：凭据不进 URL（同源握手由浏览器带 cfsm_auth Cookie）
    const same = new URL(buildWsUrl("https://probe.example.com", { subscribe: "srv-1", token: "jwt-token" }));
    assert.equal(same.protocol, "wss:");
    assert.equal(same.searchParams.get("subscribe"), "srv-1");
    assert.equal(same.searchParams.get("token"), null);
    // 跨 host：才附 token
    const cross = new URL(buildWsUrl("https://edge.other.com", { subscribe: "srv-1", token: "jwt-token" }));
    assert.equal(cross.searchParams.get("token"), "jwt-token");
  } finally {
    if (original === undefined) delete globalThis.location;
    else globalThis.location = original;
  }
});

// --- 消息解析 ---

check("parseRealtimeMessage 解析字符串与对象，拒绝非法输入", () => {
  assert.deepEqual(parseRealtimeMessage('{"type":"subscribed"}'), { type: "subscribed" });
  assert.deepEqual(parseRealtimeMessage({ type: "pong" }), { type: "pong" });
  assert.equal(parseRealtimeMessage("{oops"), null);
  assert.equal(parseRealtimeMessage("[1,2]"), null);
  assert.equal(parseRealtimeMessage(""), null);
});

check("extractSamples 展平 batchUpdate 并兼容 data/payload/metrics", () => {
  const message = {
    type: "batchUpdate",
    ts: 1,
    updates: [
      { serverId: "srv-1", samples: [{ ts: 111, data: { cpu: 10 } }, { ts: 112, payload: { cpu: 11 } }] },
      { serverId: "srv-2", samples: [{ ts: 113, metrics: '{"cpu":12}' }] },
      { serverId: "", samples: [{ ts: 114, data: { cpu: 13 } }] },
      { serverId: "srv-3", samples: [{ ts: 115 }] },
    ],
  };
  const samples = extractSamples(message);
  assert.equal(samples.length, 3);
  assert.deepEqual(samples.map(item => item.serverId), ["srv-1", "srv-1", "srv-2"]);
  assert.deepEqual(samples[0], { serverId: "srv-1", ts: 111, data: { cpu: 10 } });
  assert.deepEqual(samples[2].data, { cpu: 12 });
});

check("extractSamples 忽略非 batchUpdate", () => {
  assert.deepEqual(extractSamples({ type: "hello" }), []);
  assert.deepEqual(extractSamples("nope"), []);
});

// --- 增量合并 ---

check("首样本用 mapStatus 生成完整状态并标记时间", () => {
  const status = mergeStatusUpdate(null, { id: "srv-1", cpu: 12, ram_used: 512, ram_total: 1024 }, { now: 5000 });
  assert.equal(status.client, "srv-1");
  assert.equal(status.cpu, 12);
  assert.equal(status.online, true);
  assert.equal(status.time, 5000, "缺少 last_updated 时用 now 补齐");
});

check("样本缺失的报告级字段沿用旧值（不误清除）", () => {
  const first = mergeStatusUpdate(null, {
    id: "srv-1",
    cpu: 10,
    ping_ct: 20,
    loss_ct: 1,
    disk_used: 100,
    disk_total: 200,
    ram_total: 4096,
    boot_time: 1700000000,
  }, { now: 1000 });
  const lineId = Object.entries(first.cfsm_line_values).find(([, value]) => value.latest === 20)?.[0];
  assert.ok(lineId, "应至少有一条线路延迟被写入");

  const second = mergeStatusUpdate(first, { id: "srv-1", cpu: 55 }, { now: 2000 });
  assert.equal(second.cpu, 55, "高频字段应更新");
  assert.deepEqual(second.cfsm_line_values, first.cfsm_line_values, "三网延迟不得因样本缺失被清除");
  assert.deepEqual(second.cfsm_disk, first.cfsm_disk, "磁盘对象应保留");
  assert.equal(second.disk_total, first.disk_total, "磁盘容量应保留");
  assert.equal(second.ram_total, first.ram_total, "内存总量应保留");
  assert.equal(second.uptime, first.uptime, "启动时间应保留");
  assert.equal(second.online, true);
});

check("样本提供的报告级字段只更新对应线路，其余保留", () => {
  const first = mergeStatusUpdate(null, { id: "srv-1", ping_ct: 20, loss_ct: 1, ping_cu: 30 }, { now: 1000 });
  const lineId = Object.entries(first.cfsm_line_values).find(([, value]) => value.latest === 20)[0];
  const otherId = Object.entries(first.cfsm_line_values).find(([, value]) => value.latest === 30)[0];
  const second = mergeStatusUpdate(first, { id: "srv-1", ping_ct: 44 }, { now: 2000 });
  assert.equal(second.cfsm_line_values[lineId].latest, 44);
  assert.equal(second.cfsm_line_values[otherId].latest, 30, "未提供的线路不应变化");
});

check("样本带 last_updated 时使用样本时间且按样本判定在线", () => {
  const status = mergeStatusUpdate(null, { id: "srv-1", cpu: 5, last_updated: 1737638400000 }, { now: 1737638405000 });
  assert.equal(status.time, 1737638400000);
  assert.equal(status.cfsm_updated, 1737638400000);
  assert.equal(status.online, true);
});

check("isReportStale 只在超过窗口时才为真", () => {
  const status = { cfsm_report_at: 10_000 };
  assert.equal(isReportStale(status, { now: 20_000, staleAfterMs: 15_000 }), false);
  assert.equal(isReportStale(status, { now: 30_000, staleAfterMs: 15_000 }), true);
  assert.equal(isReportStale(status, { now: 30_000, staleAfterMs: 0 }), false);
  assert.equal(isReportStale({}, { now: 30_000, staleAfterMs: 1000 }), false);
});

// --- 连接状态机 ---

await checkAsync("连接进入 live：open → 订阅 → subscribed", async () => {
  const timers = createFakeTimers();
  const sockets = createFakeWebSocket();
  const states = [];
  const channel = createChannel({ timers, sockets, onStateChange: payload => states.push(payload.state) });
  channel.start(["srv-1"]);
  assert.deepEqual(states, ["connecting"]);
  const socket = sockets.instances.at(-1);
  socket.open();
  assert.deepEqual(states.slice(1), ["socket-open", "subscription-pending"]);
  assert.deepEqual(JSON.parse(socket.sent.at(-1)), { type: "subscribe", scope: "all", ids: ["srv-1"] });
  socket.receive(JSON.stringify({ type: "subscribed" }));
  assert.equal(channel.state, "live");
  assert.equal(channel.isLive(), true);
  assert.equal(channel.attempt, 0);
  // live 后仍应挂着的是"按需心跳"，订阅超时计时器必须已清除
  assert.ok(!timers.delays.includes(8000), "订阅确认后不应再挂着订阅超时计时器");
});

await checkAsync("batchUpdate 透传给 onMessage，其他消息忽略", async () => {
  const timers = createFakeTimers();
  const sockets = createFakeWebSocket();
  const messages = [];
  const channel = createChannel({ timers, sockets, onMessage: message => messages.push(message) });
  channel.start();
  const socket = sockets.instances.at(-1);
  socket.open();
  socket.receive(JSON.stringify({ type: "hello" }));
  socket.receive(JSON.stringify({ type: "batchUpdate", updates: [] }));
  assert.equal(messages.length, 1);
  assert.equal(messages[0].type, "batchUpdate");
});

await checkAsync("关闭码 1008 进入终止态且不再重连", async () => {
  const timers = createFakeTimers();
  const sockets = createFakeWebSocket();
  const channel = createChannel({ timers, sockets });
  channel.start();
  const before = sockets.instances.length;
  sockets.instances.at(-1).open();
  sockets.instances.at(-1).serverClose(1008);
  assert.equal(channel.state, "fatal");
  assert.equal(channel.fatalCode, 1008);
  assert.equal(timers.pendingCount, 0, "终止态不得排程重连");
  assert.equal(sockets.instances.length, before);
});

await checkAsync("异常关闭按退避重连", async () => {
  const timers = createFakeTimers();
  const sockets = createFakeWebSocket();
  const states = [];
  const channel = createChannel({ timers, sockets, onStateChange: payload => states.push(payload.state) });
  channel.start();
  const before = sockets.instances.length;
  sockets.instances.at(-1).open();
  sockets.instances.at(-1).serverClose(1006);
  assert.equal(channel.state, "closed");
  assert.equal(channel.attempt, 1);
  assert.equal(timers.pendingCount, 1);
  assert.equal(timers.lastDelay, 1000, "random 固定 0.5 时首轮退避为 1s");
  timers.runAll();
  assert.equal(sockets.instances.length, before + 1, "退避后应发起新连接");
});

await checkAsync("订阅确认超时会关闭本次连接", async () => {
  const timers = createFakeTimers();
  const sockets = createFakeWebSocket();
  const channel = createChannel({ timers, sockets, subscribeTimeoutMs: 8000 });
  channel.start();
  const socket = sockets.instances.at(-1);
  socket.open();
  assert.equal(timers.lastDelay, 8000);
  timers.runAll();
  assert.equal(socket.closedWith, 4000);
});

await checkAsync("setIds 在已连接时重发订阅", async () => {
  const timers = createFakeTimers();
  const sockets = createFakeWebSocket();
  const channel = createChannel({ timers, sockets });
  channel.start(["srv-1"]);
  const socket = sockets.instances.at(-1);
  socket.open();
  socket.receive(JSON.stringify({ type: "subscribed" }));
  const before = socket.sent.length;
  channel.setIds(["srv-2", "srv-3"]);
  assert.equal(socket.sent.length, before + 1);
  assert.deepEqual(JSON.parse(socket.sent.at(-1)).ids, ["srv-2", "srv-3"]);
  assert.deepEqual(channel.getIds(), ["srv-2", "srv-3"]);
});

await checkAsync("stop 幂等且之后不再回调", async () => {
  const timers = createFakeTimers();
  const sockets = createFakeWebSocket();
  let calls = 0;
  const channel = createChannel({ timers, sockets, onStateChange: () => { calls += 1; } });
  channel.start();
  const socket = sockets.instances.at(-1);
  socket.open();
  channel.stop();
  const after = calls;
  channel.stop();
  assert.equal(calls, after, "重复 stop 不应再触发状态回调");
  assert.equal(timers.pendingCount, 0);
  assert.equal(channel.state, "idle");
});

// --- 单机订阅形态（深链 detail scope）---

check("buildWsUrl 单机订阅：subscribe=<serverId>", () => {
  const url = new URL(buildWsUrl("https://probe.example.com", { subscribe: "9b2c4d3e-1a2b-4c5d-9e8f-7a6b5c4d3e2f" }));
  assert.equal(url.pathname, "/api/ws");
  assert.equal(url.searchParams.get("subscribe"), "9b2c4d3e-1a2b-4c5d-9e8f-7a6b5c4d3e2f");
});

await checkAsync("subscribeScope=null 时订阅消息不带 scope 键（沿用 URL 的 subscribe）", async () => {
  const timers = createFakeTimers();
  const sockets = createFakeWebSocket();
  const channel = createChannel({ timers, sockets, subscribeScope: null });
  channel.start(["srv-1"]);
  const socket = sockets.instances.at(-1);
  socket.open();
  assert.equal(socket.sent.length, 1);
  const payload = JSON.parse(socket.sent[0]);
  assert.equal(payload.type, "subscribe");
  assert.deepEqual(payload.ids, ["srv-1"]);
  // 带 scope 时服务端会把连接改回全量过滤（scope=all + 空 ids 收不到任何推送）
  assert.equal(Object.hasOwn(payload, "scope"), false);
  channel.stop();
});

await checkAsync("subscribeScope 默认仍显式发送 scope=all", async () => {
  const timers = createFakeTimers();
  const sockets = createFakeWebSocket();
  const channel = createChannel({ timers, sockets });
  channel.start(["srv-1"]);
  sockets.instances.at(-1).open();
  assert.equal(JSON.parse(sockets.instances.at(-1).sent[0]).scope, "all");
  channel.stop();
});

// --- 按需心跳（A9）---

await checkAsync("按需 ping：live 且长时间无消息时才发，收到消息即重置", async () => {
  const timers = createFakeTimers();
  const sockets = createFakeWebSocket();
  const channel = createChannel({ timers, sockets, pingIdleMs: 5000 });
  channel.start([]);
  const socket = sockets.instances.at(-1);
  socket.open();
  socket.receive(JSON.stringify({ type: "subscribed", ts: 1 }));
  assert.deepEqual(socket.sent.map(payload => JSON.parse(payload).type), ["subscribe"]);
  // 静默到点 → 发一次 ping 并重新武装
  timers.runAll();
  assert.deepEqual(socket.sent.map(payload => JSON.parse(payload).type), ["subscribe", "ping"]);
  // 收到任何消息都重置：计时器仍在挂起但不会累积
  socket.receive(JSON.stringify({ type: "pong" }));
  assert.equal(timers.pendingCount, 1);
  channel.stop();
  assert.equal(timers.pendingCount, 0, "stop 必须清掉心跳计时器");
});

await checkAsync("按需 ping 关闭时（pingIdleMs=0）不产生额外计时器", async () => {
  const timers = createFakeTimers();
  const sockets = createFakeWebSocket();
  const channel = createChannel({ timers, sockets, pingIdleMs: 0 });
  channel.start([]);
  const socket = sockets.instances.at(-1);
  socket.open();
  socket.receive(JSON.stringify({ type: "subscribed", ts: 1 }));
  assert.equal(timers.pendingCount, 0);
  channel.stop();
});

// --- 结果 ---

if (failures.length) {
  console.error(`✗ ${failures.length} 项失败，${passed} 项通过`);
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}
console.log(`✓ 全部 ${passed} 项通过`);
process.exit(0);
