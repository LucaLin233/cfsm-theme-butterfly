// 轮询器（cfsm-api.js 的 createPoller）单元测试：失败退避、成功复位、立即执行、停止语义。
// `createPoller` 直接用全局 setTimeout/clearTimeout，因此这里替换全局计时器后手动驱动，
// 不依赖墙钟。用法：npm test
import assert from "node:assert/strict";

import { createPoller } from "../src/assets/cfsm-api.js";

let passed = 0;
const failures = [];

async function check(name, fn) {
  try {
    await fn();
    passed += 1;
  } catch (error) {
    failures.push(`${name}: ${error?.message || error}`);
  }
}

// --- 可控计时器（替换全局，测试后还原）---

const realSetTimeout = globalThis.setTimeout;
const realClearTimeout = globalThis.clearTimeout;
let pending = [];

function installTimers() {
  pending = [];
  globalThis.setTimeout = (fn, ms) => {
    const handle = { fn, ms };
    pending.push(handle);
    return handle;
  };
  globalThis.clearTimeout = (handle) => {
    const index = pending.indexOf(handle);
    if (index >= 0) pending.splice(index, 1);
  };
}

function restoreTimers() {
  globalThis.setTimeout = realSetTimeout;
  globalThis.clearTimeout = realClearTimeout;
}

// 取出当前挂起的计时器并触发；返回触发数量
async function fireTimers() {
  const entries = pending.slice();
  pending = [];
  for (const entry of entries) entry.fn();
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  return entries.length;
}

const delay = () => pending.at(-1)?.ms ?? null;

// --- 用例 ---

await check("首次调度使用基础间隔（poll_interval 秒 → 毫秒）", async () => {
  installTimers();
  const poller = createPoller({ getIntervalSeconds: () => 30, onTick: async () => {} });
  poller.start();
  assert.equal(pending.length, 1);
  assert.equal(delay(), 30000);
  poller.stop();
  restoreTimers();
});

await check("连续失败按 2 的幂退避并在上限封顶（30→60→120→120 秒）", async () => {
  installTimers();
  let calls = 0;
  const poller = createPoller({
    getIntervalSeconds: () => 30,
    onTick: async () => { calls += 1; throw new Error("boom"); },
  });
  poller.start();
  for (const expected of [60000, 120000, 120000]) {
    await fireTimers();
    assert.equal(delay(), expected, `第 ${calls} 次失败后的间隔应为 ${expected}`);
  }
  assert.equal(poller.backoffStep, 3);
  poller.stop();
  restoreTimers();
});

await check("成功一次即复位到基础间隔", async () => {
  installTimers();
  let shouldFail = true;
  const poller = createPoller({
    getIntervalSeconds: () => 30,
    onTick: async () => { if (shouldFail) throw new Error("boom"); },
  });
  poller.start();
  await fireTimers();
  assert.equal(delay(), 60000);
  shouldFail = false;
  await fireTimers();
  assert.equal(poller.backoffStep, 0);
  assert.equal(delay(), 30000);
  poller.stop();
  restoreTimers();
});

await check("refreshNow 立即执行且不并发", async () => {
  installTimers();
  let running = 0;
  let maxConcurrent = 0;
  let resolved = 0;
  let release = null;
  const poller = createPoller({
    getIntervalSeconds: () => 30,
    onTick: () => new Promise((resolve) => {
      running += 1;
      maxConcurrent = Math.max(maxConcurrent, running);
      release = () => { running -= 1; resolved += 1; resolve(); };
    }),
  });
  poller.start();
  const first = poller.refreshNow();
  const second = poller.refreshNow(); // 在途期间的第二次调用必须被跳过
  release();
  await first;
  await second;
  assert.equal(maxConcurrent, 1, "同一时刻只允许一次执行");
  assert.equal(resolved, 1, "在途期间的重复调用不得再次执行");
  poller.stop();
  restoreTimers();
});

await check("stop 后不再调度，且在途完成也不再排下一次", async () => {
  installTimers();
  let release = null;
  const poller = createPoller({
    getIntervalSeconds: () => 30,
    onTick: () => new Promise((resolve) => { release = resolve; }),
  });
  poller.start();
  const inFlight = poller.refreshNow();
  poller.stop();
  assert.equal(pending.length, 0);
  release();
  await inFlight;
  assert.equal(pending.length, 0, "停止后不得再排下一次");
  assert.equal(poller.isRunning(), false);
  restoreTimers();
});

await check("间隔取值异常时回落到 30 秒并夹取到 [1, 3600]", async () => {
  installTimers();
  const poller = createPoller({ getIntervalSeconds: () => "abc", onTick: async () => {} });
  poller.start();
  assert.equal(delay(), 30000);
  poller.stop();
  const tiny = createPoller({ getIntervalSeconds: () => 0.1, onTick: async () => {} });
  tiny.start();
  assert.equal(delay(), 1000);
  tiny.stop();
  const huge = createPoller({ getIntervalSeconds: () => 99999, onTick: async () => {} });
  huge.start();
  assert.equal(delay(), 3600000);
  huge.stop();
  restoreTimers();
});

// --- 结果 ---

restoreTimers();
if (failures.length) {
  console.error(`✗ ${failures.length} 项失败，${passed} 项通过`);
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}
console.log(`✓ 全部 ${passed} 项通过`);
process.exit(0);
