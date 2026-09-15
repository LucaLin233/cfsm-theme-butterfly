// 批次 6 Turnstile 凭证链：确定性契约测试（纯本地、不访问网络）。
//
// 覆盖：启动判定顺序、三种头模式（互斥且抹掉调用方注入）、/api/config 请求次数、
// 旧代次迟到 403、并发 403 单次挑战、重放上限与锁定、非 Turnstile 403 零挑战、JWT 不受影响。
// 以及 widget 替身的超时 / error / expired / 迟到成功 / 重复回调场景。
//
// 用法：node scripts/test-turnstile.mjs
//
// 说明：本文件内的 `createFakeSite` 是**服务端契约模型**（与 mock-server.py 的 Turnstile 模拟同一套语义：
// 裸 config 豁免、Verified 优先、token 一次性、交换成功才给 turnstile_verified、复用有效凭证时为 null）。
// 它是纯内存实现，所以本测试不需要网络；浏览器冒烟走 mock-server.py。
import assert from "node:assert/strict";

import {
  TURNSTILE_MAX_ATTEMPTS,
  TURNSTILE_STATE,
  TURNSTILE_TOKEN_KEY,
  TURNSTILE_VERIFIED_KEY,
  createTurnstileChain,
  createTurnstileStorage,
} from "../src/assets/cfsm-turnstile.js";
import {
  AUTH_TOKEN_KEY,
  CfsmApi,
  CfsmApiError,
  TURNSTILE_HEADER_MODES,
  TURNSTILE_TOKEN_HEADER,
  TURNSTILE_VERIFIED_HEADER,
  isTurnstileForbidden,
  readStoredToken,
} from "../src/assets/cfsm-api.js";

// --- 断言计数 harness ---

let passed = 0;
const failures = [];

function check(name, fn) {
  try {
    const result = fn();
    if (result && typeof result.then === "function") throw new Error("异步用例请用 checkAsync");
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

const tick = (ms = 0) => new Promise(resolve => setTimeout(resolve, ms));

// --- 契约常量（服务端真源 upstream/src/index.js）---

const SITE_KEY = "1x00000000000000000000AA";
const TURNSTILE_403_BODY = { error: "Turnstile verification failed", code: 403 };
// 普通权限 403：文案与 Turnstile 403 不同 → 前端必须零挑战（v2-delta B2）。
const PLAIN_403_BODY = { error: "forbiddenByPolicy", code: 403, message: "你没有访问权限" };

function makeResponse({ status, body }) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() {
      return body;
    },
  };
}

function createFakeStorage(seed = {}) {
  const map = new Map(Object.entries(seed));
  return {
    // localStorage 形态（api 读取 JWT）
    getItem: key => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => void map.set(key, String(value)),
    removeItem: key => void map.delete(key),
    // 凭证链的存储形态（cfsm-turnstile 的 storage 接口）
    get: key => map.get(key) || "",
    set: (key, value) => void map.set(key, String(value)),
    remove: key => void map.delete(key),
    dump: () => Object.fromEntries(map),
  };
}

// 服务端契约模型。
function createFakeSite(options = {}) {
  const site = {
    enabled: options.enabled === true,
    loginEnabled: options.loginEnabled === true,
    siteKey: options.siteKey === undefined ? SITE_KEY : options.siteKey,
    ttlSeconds: options.ttlSeconds === undefined ? 3600 : options.ttlSeconds,
    // 被拒的新凭证仍然被拒：用于「带刚换发的新凭证仍 403 → 锁定」用例
    rejectFreshCredentials: options.rejectFreshCredentials === true,
    plain403Path: options.plain403Path || null,
    pendingTokens: new Set(),
    spentTokens: new Set(),
    validCredentials: new Set(),
    expiredCredentials: new Set(),
    slots: new Map(),
    tokenSeq: 0,
    credSeq: 0,
    round: 0,
    postExecutions: 0,
    requests: [],
    perPath: new Map(),
    rejects: { expired: 0, tokenSpent: 0, tokenUnknown: 0, credentialMissing: 0 },
    override: null,
  };

  site.issueToken = () => {
    const token = `mock-token-${(site.tokenSeq += 1)}`;
    site.pendingTokens.add(token);
    return token;
  };

  const issueCredential = () => {
    const credential = `mock-cred-${(site.credSeq += 1)}`;
    site.slots.set(credential, `cred#${site.credSeq}`);
    site.validCredentials.add(credential);
    return credential;
  };
  site.issueCredential = issueCredential;

  // 一次性标记的复位点：每次成功签发凭证算一轮（用于「重放次数」统计）。
  const newRound = () => {
    site.round += 1;
    site.perPath = new Map();
  };

  site.expireAll = () => {
    for (const credential of site.validCredentials) site.expiredCredentials.add(credential);
    site.validCredentials.clear();
  };

  site.revokeAll = () => {
    site.validCredentials.clear();
    site.expiredCredentials.clear();
    site.pendingTokens.clear();
  };

  site.record = (entry) => {
    const seen = site.perPath.get(entry.path) || 0;
    site.perPath.set(entry.path, seen + 1);
    site.requests.push({ ...entry, replay: seen });
    return site.requests[site.requests.length - 1];
  };

  site.pathRequests = (path, method = null) => site.requests.filter(r => r.path === path && (!method || r.method === method));

  // 服务端校验顺序（upstream/src/index.js:225-255）。
  site.handle = req => {
    const isApi = req.path.startsWith("/api/") || req.path.startsWith("/admin/api");
    const bypass = req.path === "/api/ws" || req.path === "/admin/api" || req.path.startsWith("/api/__mock/");
    const hasVerified = Boolean(req.headers["x-turnstile-verified"]);
    const hasToken = Boolean(req.headers["x-turnstile-token"]);
    const verifiedValue = req.headers["x-turnstile-verified"] || "";
    const tokenValue = req.headers["x-turnstile-token"] || "";
    let verdict = "not-required";
    let exchanged = null;
    let slot = verifiedValue ? site.slots.get(verifiedValue) || "-" : "-";

    if (site.enabled && isApi && !bypass) {
      const configBare = req.path === "/api/config" && !hasVerified && !hasToken;
      if (configBare) {
        verdict = "config-bypass";
      } else if (hasVerified && !site.rejectFreshCredentials && site.validCredentials.has(verifiedValue)) {
        verdict = "verified";
      } else if (hasVerified && site.expiredCredentials.has(verifiedValue)) {
        verdict = "expired";
        site.rejects.expired += 1;
      } else if (hasToken && site.pendingTokens.has(tokenValue) && !site.spentTokens.has(tokenValue)) {
        // token 一次性：用掉即失效
        site.pendingTokens.delete(tokenValue);
        site.spentTokens.add(tokenValue);
        verdict = "exchanged";
        newRound();
        exchanged = issueCredential();
        if (site.rejectFreshCredentials) site.validCredentials.delete(exchanged);
        slot = "new";
      } else if (hasToken && site.spentTokens.has(tokenValue)) {
        verdict = "token-spent";
        site.rejects.tokenSpent += 1;
      } else if (hasToken) {
        verdict = "token-unknown";
        site.rejects.tokenUnknown += 1;
      } else {
        verdict = "credential-missing";
        site.rejects.credentialMissing += 1;
      }
    }

    const blocked = site.enabled && isApi && !bypass && !(verdict === "config-bypass" || verdict === "verified" || verdict === "exchanged");
    const base = {
      method: req.method,
      path: req.path,
      turnstileMode: hasToken ? "token" : hasVerified ? "verified" : "neither",
      verdict,
      slot,
      round: site.round,
      hasVerifiedHeader: hasVerified,
      hasTokenHeader: hasToken,
      hasAuthorization: Boolean(req.headers.authorization),
    };

    if (blocked) {
      site.record({ ...base, status: 403 });
      return { status: 403, body: TURNSTILE_403_BODY };
    }

    if (req.path === "/api/config") {
      const body = {
        site_title: "Mock CFSM",
        version: "2.8.5-mock",
        turnstile_enabled: site.enabled,
        turnstile_login_enabled: site.enabled || site.loginEnabled,
        turnstile_site_key: site.siteKey,
        verified: site.enabled && (verdict === "verified" || verdict === "exchanged"),
        // 上游只在「本次请求使用了 token 完成交换」时给凭证；复用有效凭证时为 null
        turnstile_verified: exchanged,
      };
      site.record({ ...base, status: 200, configBody: body });
      return { status: 200, body };
    }

    if (req.method === "POST" && req.path === "/api/theme_options") {
      if (!req.headers.authorization) {
        site.record({ ...base, status: 401 });
        return { status: 401, body: { error: "unauthorized", code: 401 } };
      }
      site.postExecutions += 1;
      site.record({ ...base, status: 200, postExecuted: true });
      return { status: 200, body: { success: true } };
    }

    if (req.path === "/api/unauthorized") {
      site.record({ ...base, status: 401 });
      return { status: 401, body: { error: "unauthorized", code: 401 } };
    }

    if (req.path === site.plain403Path) {
      site.record({ ...base, status: 403 });
      return { status: 403, body: PLAIN_403_BODY };
    }

    if (req.path === "/api/servers") {
      site.record({ ...base, status: 200 });
      return { status: 200, body: { servers: [{ id: "srv-a", name: "A" }], stats: { total: 1, online: 1, offline: 0 } } };
    }

    if (req.path === "/api/server" || req.path === "/api/history/all") {
      site.record({ ...base, status: 200 });
      return { status: 200, body: req.path === "/api/history/all" ? [] : { id: "srv-a" } };
    }

    site.record({ ...base, status: 404 });
    return { status: 404, body: { error: "notFound", code: 404 } };
  };

  site.fetch = async (url, init = {}) => {
    const parsed = new URL(url);
    const headers = {};
    for (const [key, value] of Object.entries(init.headers || {})) headers[key.toLowerCase()] = value;
    const req = {
      method: (init.method || "GET").toUpperCase(),
      path: parsed.pathname,
      url: parsed.toString(),
      headers,
    };
    if (typeof site.override === "function") {
      const custom = site.override(req, () => makeResponse(site.handle(req)));
      if (custom) return custom;
    }
    return makeResponse(site.handle(req));
  };

  return site;
}

// widget 替身：实现实际被调用的接口（`isReady` / `loadScript` / `render` / `remove` / `createContainer`）。
function createWidgetStub(site, { scenario = "ok", delayMs = 20, timeoutMs = 60000 } = {}) {
  const calls = { render: 0, remove: 0, tokens: [], callbacks: 0, errors: 0, expired: 0, script: 0 };
  let handleSeq = 0;
  return {
    calls,
    runtime: {
      available: () => true,
      isReady: () => true,
      loadScript: () => {
        calls.script += 1;
        return Promise.resolve();
      },
      resetScript: () => {},
      createContainer: () => ({ innerHTML: "" }),
      render: (container, options) => {
        calls.render += 1;
        const handle = `w${(handleSeq += 1)}`;
        const later = fn => setTimeout(fn, delayMs);
        if (scenario === "ok") later(() => {
          const token = site.issueToken();
          calls.tokens.push(token);
          calls.callbacks += 1;
          options.onToken(token);
        });
        else if (scenario === "never") { /* 永不回调 */ }
        else if (scenario === "error") later(() => { calls.errors += 1; options.onError?.("mock error"); });
        else if (scenario === "expired") later(() => { calls.expired += 1; options.onExpired?.(); });
        else if (scenario === "late") {
          // 迟到成功：先超过等待超时，再回调
          setTimeout(() => { calls.tokens.push(site.issueToken()); options.onToken(calls.tokens[calls.tokens.length - 1]); }, timeoutMs + delayMs);
        } else if (scenario === "double") {
          later(() => {
            const first = site.issueToken();
            const other = site.issueToken();
            calls.tokens.push(first, other);
            calls.callbacks += 1;
            options.onToken(first);
            calls.callbacks += 1;
            options.onToken(first);
            calls.callbacks += 1;
            options.onToken(other);
          });
        }
        return handle;
      },
      remove: () => {
        calls.remove += 1;
      },
    },
  };
}

// 组装一套「站点 + 存储 + api + 凭证链」，返回可断言的句柄。
const stateLog = [];
function createHarness(site, { scenario = "ok", delayMs = 20, timeouts = {}, seed = {}, onState = null } = {}) {
  const storage = createFakeStorage(seed);
  const stub = createWidgetStub(site, { scenario, delayMs, timeoutMs: timeouts.user || 60000 });
  const api = new CfsmApi({
    base: "http://mock.local",
    fetchImpl: site.fetch,
    getToken: () => storage.getItem(AUTH_TOKEN_KEY) || "",
  });
  const chain = createTurnstileChain({
    storage,
    runtime: stub.runtime,
    timeouts: { script: 200, user: 80, exchange: 200, ...timeouts },
    requestRaw: (path, options) => api.requestRaw(path, options),
    onState: (snapshot, detail) => {
      stateLog.push(`${snapshot.state}${detail?.reason ? `(${detail.reason})` : ""}`);
      onState?.(snapshot, detail);
    },
  });
  api.attachTurnstile(chain);
  return { site, storage, api, chain, stub, calls: stub.calls };
}

// --- 1. 启动判定顺序（v3-delta 唯一入口：全局闸门 / login-only / 有效缓存 / 失效缓存 / 无缓存）---

const observations = [];
const waitFor = async (predicate, timeoutMs = 2000) => {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("waitFor 超时");
    await tick(5);
  }
};

await checkAsync("1a 全局关闭（login-only）→ 直接 ready 且不挑战，保留 Verified、清残留 Token", async () => {
  const site = createFakeSite({ enabled: false, loginEnabled: true });
  const h = createHarness(site, {
    seed: { [TURNSTILE_VERIFIED_KEY]: "cached-verified", [TURNSTILE_TOKEN_KEY]: "cached-token" },
  });
  const result = await h.chain.bootstrap();
  assert.equal(result.ok, true);
  assert.equal(result.mode, "disabled");
  assert.equal(h.calls.render, 0, "login-only 不得渲染挑战");
  assert.equal(h.chain.getState(), TURNSTILE_STATE.off);
  assert.equal(h.chain.isReady(), true);
  // 保留 verified（与内置前端共享缓存），但不续期、清掉一次性 token
  assert.equal(h.storage.getItem(TURNSTILE_VERIFIED_KEY), "cached-verified");
  assert.equal(h.storage.getItem(TURNSTILE_TOKEN_KEY) || "", "");
  const config = h.site.pathRequests("/api/config");
  assert.equal(config.length, 1, "有缓存时只用带凭证的那次请求");
  assert.equal(config[0].configBody.turnstile_enabled, false);
  // 上游 turnstile_login_enabled = turnstile_enabled || turnstile_login_enabled（OR 派生值）
  assert.equal(config[0].configBody.turnstile_login_enabled, true);
});

await checkAsync("1b 全局开启 + 无缓存 → 裸探测 → 挑战 → 交换 → ready", async () => {
  const site = createFakeSite({ enabled: true, loginEnabled: true });
  const h = createHarness(site, { seed: { [AUTH_TOKEN_KEY]: "JWT-1" } });
  const result = await h.chain.bootstrap();
  assert.equal(result.ok, true);
  assert.equal(result.mode, "challenged");
  assert.equal(h.calls.render, 1);
  assert.equal(h.calls.remove, 1, "挑战结束后必须移除组件");
  assert.equal(h.chain.isReady(), true);
  assert.ok(h.chain.getVerified(), "交换成功后必须落盘凭证");
  assert.equal(h.storage.getItem(TURNSTILE_TOKEN_KEY) || "", "", "一次性 token 用完即删");
  const fetchRequests = site.pathRequests("/api/config").filter(r => r.turnstileMode === "neither");
  assert.equal(fetchRequests.length, 1, "无缓存时必须有一次裸探测");
  const exchanged = site.pathRequests("/api/config").filter(r => r.verdict === "exchanged");
  assert.equal(exchanged.length, 1);
  assert.equal(exchanged[0].configBody.turnstile_verified, h.chain.getVerified());
  assert.equal(exchanged[0].configBody.verified, true);
});

await checkAsync("1c 全局开启 + 有效缓存 → 单次 verified-only 请求直接 ready，凭证保留", async () => {
  const site = createFakeSite({ enabled: true });
  const credential = site.issueCredential();
  const h = createHarness(site, { seed: { [TURNSTILE_VERIFIED_KEY]: credential } });
  const result = await h.chain.bootstrap();
  assert.equal(result.ok, true);
  assert.equal(result.mode, "verified");
  assert.equal(h.calls.render, 0, "有效凭证不得弹挑战");
  assert.equal(h.chain.getVerified(), credential, "复用时必须保留原凭证");
  const config = site.pathRequests("/api/config");
  assert.equal(config.length, 1);
  // 上游真实行为：复用仍有效的凭证时响应体 turnstile_verified 为 null
  assert.equal(config[0].configBody.verified, true);
  assert.equal(config[0].configBody.turnstile_verified, null);
});

await checkAsync("1d 全局开启 + 失效缓存 → 403 → 清凭证 → 裸探测 → 重新挑战", async () => {
  const site = createFakeSite({ enabled: true });
  site.expiredCredentials.add("stale-credential");
  const h = createHarness(site, { seed: { [TURNSTILE_VERIFIED_KEY]: "stale-credential" } });
  const result = await h.chain.bootstrap();
  assert.equal(result.ok, true);
  assert.equal(result.mode, "challenged");
  assert.equal(h.calls.render, 1);
  assert.notEqual(h.chain.getVerified(), "stale-credential", "失效凭证必须被替换");
  const config = site.pathRequests("/api/config");
  assert.equal(config.length, 3, "失效缓存：带凭证 + 裸 + 交换 = 3 次");
  assert.deepEqual(config.map(r => r.verdict), ["expired", "config-bypass", "exchanged"]);
});

await checkAsync("1e 全局开启 + sitekey 缺失 → 明确失败，不渲染挑战", async () => {
  const site = createFakeSite({ enabled: true, siteKey: "" });
  const h = createHarness(site);
  const result = await h.chain.bootstrap();
  assert.equal(result.ok, false);
  assert.equal(result.reason, "missing-site-key");
  assert.equal(h.calls.render, 0);
  assert.equal(h.chain.getState(), TURNSTILE_STATE.failed);
});

// --- 2. 配置请求次数（与 1c/1b/1d 同源，单独断言成条）---

await checkAsync("2 配置请求次数：有效缓存 1 次 / 无缓存 2 次 / 失效缓存 3 次", async () => {
  const valid = createFakeSite({ enabled: true });
  const credential = valid.issueCredential();
  const hv = createHarness(valid, { seed: { [TURNSTILE_VERIFIED_KEY]: credential } });
  await hv.chain.bootstrap();
  const bare = createFakeSite({ enabled: true });
  const hb = createHarness(bare);
  await hb.chain.bootstrap();
  const stale = createFakeSite({ enabled: true });
  stale.expiredCredentials.add("stale");
  const hs = createHarness(stale, { seed: { [TURNSTILE_VERIFIED_KEY]: "stale" } });
  await hs.chain.bootstrap();
  const counts = [
    valid.pathRequests("/api/config").length,
    bare.pathRequests("/api/config").length,
    stale.pathRequests("/api/config").length,
  ];
  assert.deepEqual(counts, [1, 2, 3]);
});

// --- 3. 三种头模式：互斥、且在最终头合并之后（调用方注入无效）---

await checkAsync("3a 头序列：verified-only / neither / token-only 三模式互斥", async () => {
  const site = createFakeSite({ enabled: true });
  const h = createHarness(site, { seed: { [AUTH_TOKEN_KEY]: "JWT-1" } });
  await h.chain.bootstrap();
  const modeOf = r => ({ v: r.hasVerifiedHeader, t: r.hasTokenHeader });
  const config = site.pathRequests("/api/config");
  assert.deepEqual(modeOf(config[0]), { v: false, t: false }, "裸探测两个 Turnstile 头都不带");
  assert.deepEqual(modeOf(config[1]), { v: false, t: true }, "换发只带 token");
  site.requests.length = 0;
  await h.api.getServers();
  assert.deepEqual(modeOf(site.pathRequests("/api/servers")[0]), { v: true, t: false }, "常规业务只带 Verified");
  for (const request of [...config, ...site.pathRequests("/api/servers")]) {
    assert.equal(request.hasAuthorization, true, "Authorization 不受 Turnstile 头模式影响");
  }
});

await checkAsync("3b 关闭 Turnstile 头时，Verified 也必须真的不带（含调用方注入）", async () => {
  const site = createFakeSite({ enabled: false });
  const h = createHarness(site, {
    seed: {
      [TURNSTILE_VERIFIED_KEY]: "cached-verified",
      [TURNSTILE_TOKEN_KEY]: "cached-token",
      [AUTH_TOKEN_KEY]: "JWT-1",
    },
  });
  site.requests.length = 0;
  await h.api.requestRaw("/api/config", { mode: TURNSTILE_HEADER_MODES.neither });
  await h.api.requestRaw("/api/config", { mode: TURNSTILE_HEADER_MODES.tokenOnly, token: "t-injected" });
  await h.api.requestRaw("/api/config", {
    mode: TURNSTILE_HEADER_MODES.verifiedOnly,
    init: { headers: { "x-turnstile-token": "stale-token-from-caller" } },
  });
  await h.api.requestRaw("/api/config", {
    mode: TURNSTILE_HEADER_MODES.neither,
    init: { headers: { "X-Turnstile-Verified": "stale-verified-from-caller", "X-Turnstile-Token": "stale-token" } },
  });
  const sequence = site.pathRequests("/api/config").map(r => ({ v: r.hasVerifiedHeader, t: r.hasTokenHeader }));
  assert.deepEqual(sequence, [
    { v: false, t: false },
    { v: false, t: true },
    { v: true, t: false },
    { v: false, t: false },
  ]);
  // 断言没有把任何凭证/token 值写进脱敏日志
  for (const request of site.requests) {
    assert.equal(JSON.stringify(request).includes("cached-verified"), false);
    assert.equal(JSON.stringify(request).includes("cached-token"), false);
    assert.equal(JSON.stringify(request).includes("JWT-1"), false);
  }
});

// --- 4. 旧代次迟到 403：不开启新恢复，改用当前凭证重放 ---

await checkAsync("4 恢复完成后迟到 403（旧代次）→ 不开启新挑战，改用当前凭证重放", async () => {
  const site = createFakeSite({ enabled: true });
  const credential = site.issueCredential();
  const h = createHarness(site, { seed: { [TURNSTILE_VERIFIED_KEY]: credential, [AUTH_TOKEN_KEY]: "JWT-1" } });
  await h.chain.bootstrap();
  const epochBefore = h.chain.getEpoch();
  let release = null;
  site.override = (req, next) => {
    if (req.path === "/api/servers" && req.headers["x-turnstile-verified"] === credential && !release) {
      return new Promise(resolve => {
        release = () => resolve(makeResponse({ status: 403, body: TURNSTILE_403_BODY }));
      });
    }
    return next();
  };
  const inFlight = h.api.getServers();
  await waitFor(() => Boolean(release));
  // 站点让旧凭证失效，并完成一次恢复（代次 +1，换发新凭证）
  site.expireAll();
  const recovery = await h.chain.recover({ reason: "test" });
  assert.equal(recovery.ok, true);
  assert.equal(h.chain.getEpoch(), epochBefore + 1);
  const newCredential = h.chain.getVerified();
  assert.notEqual(newCredential, credential);
  assert.equal(h.chain.isRecovering(), false);
  const rendersAfterRecovery = h.calls.render;
  release();
  const data = await inFlight;
  assert.equal(data.servers.length, 1, "迟到 403 应触发一次性重放并成功");
  assert.equal(h.calls.render, rendersAfterRecovery, "旧代次 403 不得开启新恢复");
  assert.equal(h.chain.getEpoch(), epochBefore + 1, "旧代次 403 不得推进代次");
  const replayed = site.pathRequests("/api/servers");
  assert.equal(replayed.length, 1);
  assert.equal(replayed[0].slot, site.slots.get(newCredential), "重放必须使用当前凭证");
  assert.equal(replayed[0].replay, 0, "每个业务请求只允许一次重放");
});

// --- 5. 并发 403 只触发一次挑战 ---

await checkAsync("5a 并发 403（后续响应在恢复完成后到达）→ 只挑战一次，其余请求用当前凭证重放成功", async () => {
  const site = createFakeSite({ enabled: true });
  const credential = site.issueCredential();
  const h = createHarness(site, { seed: { [TURNSTILE_VERIFIED_KEY]: credential } });
  await h.chain.bootstrap();
  site.expireAll();
  const rendersBefore = h.calls.render;
  let held = 0;
  const releases = [];
  site.override = (req, next) => {
    if (req.path === "/api/servers" && req.headers["x-turnstile-verified"] === credential) {
      held += 1;
      if (held === 1) return next(); // 第一个由站点直接回 403（旧凭证已失效）
      return new Promise(resolve => releases.push(() => resolve(makeResponse({ status: 403, body: TURNSTILE_403_BODY }))));
    }
    return next();
  };
  const pending = [h.api.getServers(), h.api.getServers(), h.api.getServers()];
  await waitFor(() => releases.length === 2);
  const settled = Promise.allSettled(pending);
  await waitFor(() => h.calls.render > rendersBefore && !h.chain.isRecovering());
  for (const release of releases) release();
  const results = await settled;
  assert.deepEqual(results.map(r => r.status), ["fulfilled", "fulfilled", "fulfilled"]);
  assert.equal(h.calls.render - rendersBefore, 1, "并发 403 只允许一次挑战");
  const exchanged = site.pathRequests("/api/config").filter(r => r.verdict === "exchanged");
  assert.equal(exchanged.length, 1, "并发 403 只允许一次交换");
});

await checkAsync("5b 并发 403（同一批到达）→ 挑战次数仍为 1", async () => {
  const site = createFakeSite({ enabled: true });
  const credential = site.issueCredential();
  const h = createHarness(site, { seed: { [TURNSTILE_VERIFIED_KEY]: credential } });
  await h.chain.bootstrap();
  site.expireAll();
  const rendersBefore = h.calls.render;
  let recoverCalls = 0;
  const originalRecover = h.chain.recover;
  h.chain.recover = (...args) => {
    recoverCalls += 1;
    return originalRecover(...args);
  };
  const results = await Promise.allSettled([h.api.getServers(), h.api.getServers(), h.api.getServers()]);
  assert.equal(h.calls.render - rendersBefore, 1, "同一批 403 只允许一次挑战");
  assert.equal(site.pathRequests("/api/config").filter(r => r.verdict === "exchanged").length, 1);
  // 同一批并发 403 必须全部跟着同一次恢复恢复过来；只有恢复发起者成功、其余以 stale-no-credential
  // 失败是缺陷（凭证过期时表现为若干面板同时报错）。
  assert.equal(results.filter(r => r.status === "fulfilled").length, 3, "同一批 403 的三个请求都应恢复成功");
  const verdicts = site.pathRequests("/api/servers").map(r => r.verdict);
  // 三个请求各重放一次并各自成功（不是只有发起者成功、其余失败）
  assert.equal(verdicts.filter(v => v === "verified").length, 3, "三个请求各重放一次并各自成功");
  observations.push(
    `[观察] 5b 同批 403：三个请求结局 = ${results.map(r => (r.status === "fulfilled" ? "fulfilled" : "rejected(人机验证失败)")).join(", ")}`
    + `；chain.recover() 被调用 ${recoverCalls} 次；挑战 1 次；/api/servers 落库请求 = ${JSON.stringify(verdicts)}`
    + "（三个请求各重放 1 次：除恢复发起者外，其余两个先加入在途恢复、等新凭证落盘后按各自的一次性额度重放）",
  );
});

// --- 6. 重放上限与锁定 ---

await checkAsync("6a 带刚换发的新凭证仍 403 → 终止并锁定，不自动解锁", async () => {
  const site = createFakeSite({ enabled: true, rejectFreshCredentials: true });
  const credential = site.issueCredential();
  const h = createHarness(site, { seed: { [TURNSTILE_VERIFIED_KEY]: credential } });
  await h.chain.bootstrap();
  const rendersBefore = h.calls.render;
  await assert.rejects(
    () => h.api.getServers(),
    error => {
      assert.ok(error instanceof CfsmApiError);
      assert.equal(error.status, 403);
      assert.equal(error.message, "人机验证失败");
      // 结构化分类已保留（此前构造器丢弃 turnstile/reason，业务层无法区分「Turnstile 失败」与普通 403）
      assert.equal(error.turnstile, true);
      assert.equal(error.reason, "replayed-forbidden");
      return true;
    },
  );
  assert.equal(h.calls.render - rendersBefore, 1, "只挑战一次");
  assert.equal(h.chain.isLocked(), true, "必须锁定错误态");
  const afterLock = h.calls.render;
  await assert.rejects(() => h.api.getServers(), error => {
    assert.equal(error.status, 403);
    assert.equal(h.chain.isLocked(), true);
    return true;
  });
  assert.equal(h.calls.render, afterLock, "锁定后不得自动解锁、不得再次挑战");
  // 人工重试是唯一解锁入口
  site.rejectFreshCredentials = false;
  const retried = await h.chain.manualRetry();
  assert.equal(retried.ok, true);
  assert.equal(h.chain.isLocked(), false);
  const data = await h.api.getServers();
  assert.equal(data.servers.length, 1);
});

await checkAsync("6b 一次恢复过程内连续两次失败 → 锁定（上限 2）", async () => {
  const site = createFakeSite({ enabled: true });
  const h = createHarness(site, { scenario: "error" });
  const result = await h.chain.bootstrap();
  assert.equal(result.ok, false);
  assert.equal(result.reason, "exhausted");
  assert.equal(h.calls.render, TURNSTILE_MAX_ATTEMPTS, `连续自动尝试上限应为 ${TURNSTILE_MAX_ATTEMPTS}`);
  assert.equal(h.chain.isLocked(), true);
  assert.equal(h.chain.getState(), TURNSTILE_STATE.failed);
  assert.equal(h.chain.getSnapshot().reason, "exhausted");
  assert.equal(site.pathRequests("/api/config").filter(r => r.verdict === "exchanged").length, 0);
});

// --- 7. 非 Turnstile 403 → 零挑战 ---

await checkAsync("7 普通权限 403（文案不同）→ 零挑战、零清凭证、零锁定", async () => {
  const site = createFakeSite({ enabled: true, plain403Path: "/api/denied" });
  const credential = site.issueCredential();
  const h = createHarness(site, { seed: { [TURNSTILE_VERIFIED_KEY]: credential } });
  await h.chain.bootstrap();
  const epochBefore = h.chain.getEpoch();
  const rendersBefore = h.calls.render;
  await assert.rejects(
    () => h.api.request("/api/denied"),
    error => {
      assert.ok(error instanceof CfsmApiError);
      assert.equal(error.status, 403);
      assert.equal(error.message, "forbiddenByPolicy");
      assert.equal(error.turnstile, false, "非 Turnstile 403 不得标记为凭证问题");
      return true;
    },
  );
  assert.equal(h.calls.render, rendersBefore, "非 Turnstile 403 不得挑战");
  assert.equal(h.chain.getEpoch(), epochBefore, "非 Turnstile 403 不得推进代次");
  assert.equal(h.chain.isLocked(), false);
  assert.equal(h.storage.getItem(TURNSTILE_VERIFIED_KEY), credential, "非 Turnstile 403 不得清凭证");
  assert.equal(isTurnstileForbidden(403, TURNSTILE_403_BODY), true);
  assert.equal(isTurnstileForbidden(403, PLAIN_403_BODY), false);
  assert.equal(isTurnstileForbidden(401, TURNSTILE_403_BODY), false);
  assert.equal(isTurnstileForbidden(403, null), false);
});

// --- 8. JWT 与 Turnstile 凭证互不干扰 ---

await checkAsync("8a 整个恢复过程中 JWT 不被清除，Authorization 始终存在", async () => {
  const site = createFakeSite({ enabled: true });
  site.expiredCredentials.add("stale");
  const h = createHarness(site, { seed: { [TURNSTILE_VERIFIED_KEY]: "stale", [AUTH_TOKEN_KEY]: "JWT-1" } });
  // 运行期形态：配置已在内存里（启动已完成），服务端让凭证失效
  h.chain.setConfig({ turnstile_enabled: true, turnstile_site_key: SITE_KEY });
  const data = await h.api.getServers();
  assert.equal(data.servers.length, 1);
  assert.equal(readStoredToken(h.storage), "JWT-1");
  assert.ok(h.chain.getVerified());
  assert.ok(h.calls.render >= 1, "失效凭证应触发恢复");
  for (const request of site.requests) {
    assert.equal(request.hasAuthorization, true, `${request.method} ${request.path} 丢了 Authorization`);
  }
});

await checkAsync("8b 401 行为不变：清 JWT、通知调用方，但不动 Turnstile 凭证", async () => {
  const site = createFakeSite({ enabled: true });
  const credential = site.issueCredential();
  const h = createHarness(site, { seed: { [TURNSTILE_VERIFIED_KEY]: credential, [AUTH_TOKEN_KEY]: "JWT-1" } });
  await h.chain.bootstrap();
  // cfsm-api 的 401 分支调用模块级 clearStoredToken()（不带参数）→ 只能操作全局 localStorage
  globalThis.localStorage = h.storage;
  let unauthorized = 0;
  h.api.onUnauthorized = () => {
    unauthorized += 1;
  };
  const rendersBefore = h.calls.render;
  await assert.rejects(() => h.api.request("/api/unauthorized"), error => {
    assert.equal(error.status, 401);
    return true;
  });
  assert.equal(unauthorized, 1);
  assert.equal(readStoredToken(h.storage), "", "401 必须清除 JWT（现有行为不变）");
  assert.equal(h.storage.getItem(TURNSTILE_VERIFIED_KEY), credential, "401 不得清除 Turnstile 凭证");
  assert.equal(h.calls.render, rendersBefore, "401 不得触发挑战");
  delete globalThis.localStorage;
});

// --- 9. widget 替身场景（被真实调用的接口：render / remove）---

await checkAsync("9a 永不回调 → 用户等待超时，不交换、不落凭证", async () => {
  const site = createFakeSite({ enabled: true });
  const mark = stateLog.length;
  const h = createHarness(site, { scenario: "never", timeouts: { user: 60 } });
  const result = await h.chain.bootstrap();
  assert.equal(result.ok, false);
  const reasons = h.chain.getSnapshot().reason;
  assert.equal(reasons, "exhausted");
  assert.equal(h.calls.render, TURNSTILE_MAX_ATTEMPTS);
  assert.equal(h.storage.getItem(TURNSTILE_VERIFIED_KEY) || "", "");
  assert.equal(site.pathRequests("/api/config").filter(r => r.verdict === "exchanged").length, 0);
  assert.equal(site.spentTokens.size, 0);
  observations.push(`[观察] 9a 超时用例的状态序列：${stateLog.slice(mark).join(" → ")}`);
});

await checkAsync("9b error / expired 回调 → 各自失败原因，且终态锁定", async () => {
  const site = createFakeSite({ enabled: true });
  const h = createHarness(site, { scenario: "error", timeouts: { user: 60 } });
  const result = await h.chain.bootstrap();
  assert.equal(result.ok, false);
  assert.equal(h.stub.calls.errors, TURNSTILE_MAX_ATTEMPTS);
  assert.equal(h.chain.isLocked(), true);
  const site2 = createFakeSite({ enabled: true });
  const h2 = createHarness(site2, { scenario: "expired", timeouts: { user: 60 } });
  const result2 = await h2.chain.bootstrap();
  assert.equal(result2.ok, false);
  assert.equal(h2.stub.calls.expired, TURNSTILE_MAX_ATTEMPTS);
  assert.equal(h2.chain.isLocked(), true);
});

await checkAsync("9c 超时后迟到成功 → 不再交换、凭证不落盘", async () => {
  const site = createFakeSite({ enabled: true });
  const h = createHarness(site, { scenario: "late", delayMs: 10, timeouts: { user: 40 } });
  const result = await h.chain.bootstrap();
  assert.equal(result.ok, false);
  await tick(120); // 等迟到的 onToken 真正触发
  assert.equal(site.spentTokens.size, 0, "迟到的 token 不得被交换");
  assert.equal(site.pathRequests("/api/config").filter(r => r.verdict === "exchanged").length, 0);
  assert.equal(h.storage.getItem(TURNSTILE_VERIFIED_KEY) || "", "");
  assert.equal(h.chain.isLocked(), true);
});

await checkAsync("9d 重复回调 → 只结算一次、只交换一次", async () => {
  const site = createFakeSite({ enabled: true });
  const h = createHarness(site, { scenario: "double" });
  const result = await h.chain.bootstrap();
  assert.equal(result.ok, true);
  assert.equal(h.calls.render, 1);
  assert.equal(h.stub.calls.callbacks, 3, "替身回调了 3 次（含重复与另一个 token）");
  assert.equal(h.stub.calls.tokens.length, 2);
  assert.equal(site.spentTokens.size, 1, "只允许交换一次");
  assert.equal(site.pendingTokens.size, 1, "重复回调带的 token 不得被消费");
  assert.equal(site.pathRequests("/api/config").filter(r => r.verdict === "exchanged").length, 1);
});

// --- 10. 设置 POST：统一注入、且执行次数受控 ---

await checkAsync("10 设置 POST 走统一请求层：带凭证执行 1 次，无凭证时被 403 拦下且不写入", async () => {
  const site = createFakeSite({ enabled: true });
  const credential = site.issueCredential();
  const h = createHarness(site, { seed: { [TURNSTILE_VERIFIED_KEY]: credential, [AUTH_TOKEN_KEY]: "JWT-1" } });
  await h.chain.bootstrap();
  site.requests.length = 0;
  const result = await h.api.saveThemeOptions({ butterfly_accent: 1 });
  assert.equal(result.success, true);
  const posts = site.pathRequests("/api/theme_options", "POST");
  assert.equal(posts.length, 1);
  assert.equal(posts[0].hasVerifiedHeader, true);
  assert.equal(posts[0].hasTokenHeader, false);
  assert.equal(site.postExecutions, 1);
  // 站点开启全局 Turnstile 且请求不带任何 Turnstile 头 → 403，服务端不执行写入
  const bareSite = createFakeSite({ enabled: true });
  const bare = createHarness(bareSite, { seed: { [AUTH_TOKEN_KEY]: "JWT-1" } });
  bare.chain.setConfig({ turnstile_enabled: true, turnstile_site_key: SITE_KEY });
  bareSite.requests.length = 0;
  const postsBefore = bareSite.postExecutions;
  const written = await bare.api.saveThemeOptions({ butterfly_accent: 2 });
  assert.equal(written.success, true);
  const barePosts = bareSite.pathRequests("/api/theme_options", "POST");
  assert.equal(barePosts.length, 2, "无凭证时先被拦下、恢复后重放一次");
  assert.equal(barePosts[0].status, 403);
  assert.equal(barePosts[0].verdict, "credential-missing");
  assert.equal(barePosts[0].postExecuted, undefined, "被拦下的 POST 不得执行写入");
  assert.equal(barePosts[1].status, 200);
  assert.equal(barePosts[1].slot, bareSite.slots.get(bare.chain.getVerified()), "重放必须使用刚换发的凭证");
  assert.equal(bareSite.postExecutions - postsBefore, 1, "写入只允许发生一次（不得重复写入）");
});

// --- 11. 底层请求异常分支（此前零覆盖：桩的 json() 永不抛错、fetch 永不失败） ---

await checkAsync("11a 响应不是合法 JSON → 抛错且不触发挑战", async () => {
  const site = createFakeSite({ enabled: true });
  const h = createHarness(site);
  site.override = (req) => {
    if (req.path === "/api/servers") {
      return { status: 200, ok: true, json: async () => { throw new Error("bad json"); } };
    }
    return null;
  };
  let error = null;
  try {
    await h.api.getServers();
  } catch (caught) {
    error = caught;
  }
  assert.ok(error instanceof CfsmApiError, "应抛出 CfsmApiError");
  assert.equal(error.status, 200);
  assert.equal(error.message, "响应不是合法 JSON");
  assert.equal(error.turnstile, false);
  assert.equal(error.reason, "");
  assert.equal(h.calls.render, 0, "解析失败不是 Turnstile 错误，不得触发挑战");
});

await checkAsync("11b 网络层抛错 → status 0、零挑战、零凭证清理", async () => {
  const site = createFakeSite({ enabled: true });
  const h = createHarness(site, { seed: { [TURNSTILE_VERIFIED_KEY]: "cred-1" } });
  site.override = (req) => {
    if (req.path === "/api/servers") throw new Error("network down");
    return null;
  };
  let error = null;
  try {
    await h.api.getServers();
  } catch (caught) {
    error = caught;
  }
  assert.ok(error instanceof CfsmApiError, "应抛出 CfsmApiError");
  assert.equal(error.status, 0);
  assert.equal(error.turnstile, false, "网络错误不得标记为凭证问题");
  assert.equal(error.reason, "");
  assert.equal(h.chain.isLocked(), false, "网络错误不得锁定");
  assert.equal(h.chain.getVerified(), "cred-1", "网络错误不得改动凭证值");
  assert.equal(h.calls.render, 0, "网络错误不得触发挑战");
});

// --- 12. 生产存储实现（真 localStorage 语义）---
// 此前只测了 harness 自己注入的另一套存储，生产实现 `createTurnstileStorage` 的读写语义零覆盖，
// 内存优先那次改动正是从这里溜过去的（读路径遮蔽外部更新/删除）。

function createMemoryBacking({ writable = true, failRead = false } = {}) {
  const map = new Map();
  let canWrite = writable;
  let readFails = failRead;
  return {
    getItem(key) {
      if (readFails) throw new Error("SecurityError");
      return map.has(key) ? map.get(key) : null;
    },
    setItem(key, value) {
      if (!canWrite) throw new Error("QuotaExceededError");
      map.set(key, String(value));
    },
    removeItem(key) {
      map.delete(key);
    },
    // 模拟「稍后恢复可写」或「外部写入者不受本实例配额限制」
    setWritable(value) {
      canWrite = value;
    },
    // 模拟读取权限被收回
    setFailRead(value) {
      readFails = value;
    },
  };
}

await checkAsync("12a 外部上下文的更新/清除必须可见（读路径不得被内存副本遮蔽）", async () => {
  const backing = createMemoryBacking();
  const storage = createTurnstileStorage(backing);
  storage.set(TURNSTILE_VERIFIED_KEY, "mine");
  assert.equal(storage.get(TURNSTILE_VERIFIED_KEY), "mine");
  // 站点内置前端 / 其它标签页换发新凭证 → 主题必须看到（否则一直用旧值发请求）
  backing.setItem(TURNSTILE_VERIFIED_KEY, "external-new");
  assert.equal(storage.get(TURNSTILE_VERIFIED_KEY), "external-new", "外部新凭证必须可见");
  // 外部清除 → 必须跟着变空，不能回落到陈旧内存值
  backing.removeItem(TURNSTILE_VERIFIED_KEY);
  assert.equal(storage.get(TURNSTILE_VERIFIED_KEY), "", "外部清除后不得回落到陈旧内存值");
});

await checkAsync("12b 可读不可写（配额/只读沙箱）→ 如实失败，绝不谎报未持久化的值", async () => {
  const backing = createMemoryBacking({ writable: false });
  const storage = createTurnstileStorage(backing);
  storage.set(TURNSTILE_VERIFIED_KEY, "cred-not-persisted");
  // 没持久化成功就不许报可用值：读路径只能反映 backing 的真实内容
  assert.equal(storage.get(TURNSTILE_VERIFIED_KEY), "", "写失败不得谎报可用值");
  // 外部写入真值 → 必须可见
  backing.setWritable(true);
  backing.setItem(TURNSTILE_VERIFIED_KEY, "external-wins");
  assert.equal(storage.get(TURNSTILE_VERIFIED_KEY), "external-wins");
  // 外部删除 → 必须可见，不得因本实例曾写过而复活
  backing.removeItem(TURNSTILE_VERIFIED_KEY);
  assert.equal(storage.get(TURNSTILE_VERIFIED_KEY), "", "外部删除后不得复活");
  // 恢复可写后新值必须真的落盘并被读到
  storage.set(TURNSTILE_VERIFIED_KEY, "after-recover");
  assert.equal(storage.get(TURNSTILE_VERIFIED_KEY), "after-recover");
});

await checkAsync("12c 无 localStorage（backing 为空）→ 纯内存降级，读写与清除都成立", async () => {
  // 显式保证前提（LENS 建议）：createTurnstileStorage(null) 仍会探测全局 localStorage，
  // 若运行环境提供了它就会测不到降级路径 —— 这里先摘掉，测完还原。
  const saved = globalThis.localStorage;
  delete globalThis.localStorage;
  try {
    const storage = createTurnstileStorage(null);
    storage.set(TURNSTILE_VERIFIED_KEY, "mem-only");
    assert.equal(storage.get(TURNSTILE_VERIFIED_KEY), "mem-only");
    storage.remove(TURNSTILE_VERIFIED_KEY);
    assert.equal(storage.get(TURNSTILE_VERIFIED_KEY), "", "清除后不得残留");
  } finally {
    if (saved !== undefined) globalThis.localStorage = saved;
  }
});

await checkAsync("13a 存储忠实：值确实落盘；写失败不得谎报未落盘的新值", async () => {
  const backing = createMemoryBacking();
  const storage = createTurnstileStorage(backing);
  storage.set(TURNSTILE_VERIFIED_KEY, "A");
  assert.equal(backing.getItem(TURNSTILE_VERIFIED_KEY), "A", "必须真的落盘（不只是包装器回显）");
  backing.setWritable(false);
  storage.set(TURNSTILE_VERIFIED_KEY, "B"); // 配额满
  assert.equal(storage.get(TURNSTILE_VERIFIED_KEY), "A", "写失败后只能读到已持久化的 A");
  assert.equal(backing.getItem(TURNSTILE_VERIFIED_KEY), "A", "落盘内容不得被改写");
});

await checkAsync("13b 读取权限被收回 → 保守返回空，绝不用旧值", async () => {
  const backing = createMemoryBacking();
  const storage = createTurnstileStorage(backing);
  storage.set(TURNSTILE_VERIFIED_KEY, "A");
  backing.setFailRead(true);
  assert.equal(storage.get(TURNSTILE_VERIFIED_KEY), "", "读失败必须返回空");
  backing.setFailRead(false);
  backing.removeItem(TURNSTILE_VERIFIED_KEY); // 外部删除
  backing.setFailRead(true);
  assert.equal(storage.get(TURNSTILE_VERIFIED_KEY), "", "外部删除 + 读失败也不得复活旧值");
});

await checkAsync("13c 模式切换：探测被拒留下的内存副本，在存储恢复可读后必须被废弃", async () => {
  const saved = globalThis.localStorage;
  const map = new Map();
  let probeFails = true;
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    get() {
      if (probeFails) throw new Error("SecurityError");
      return {
        getItem: (key) => (map.has(key) ? map.get(key) : null),
        setItem: (key, value) => map.set(key, String(value)),
        removeItem: (key) => map.delete(key),
      };
    },
  });
  try {
    const storage = createTurnstileStorage(null);
    storage.set(TURNSTILE_VERIFIED_KEY, "M"); // 探测被拒 → 纯内存模式
    assert.equal(storage.get(TURNSTILE_VERIFIED_KEY), "M");
    probeFails = false; // 存储恢复可读
    storage.set(TURNSTILE_VERIFIED_KEY, "E");
    assert.equal(map.get(TURNSTILE_VERIFIED_KEY), "E", "恢复可读后必须真的落盘");
    map.delete(TURNSTILE_VERIFIED_KEY); // 外部删除
    assert.equal(storage.get(TURNSTILE_VERIFIED_KEY), "", "外部删除必须可见");
    probeFails = true; // 探测再次被拒
    assert.equal(storage.get(TURNSTILE_VERIFIED_KEY), "", "不得复活纯内存模式留下的旧值 M");
  } finally {
    if (saved === undefined) delete globalThis.localStorage;
    else Object.defineProperty(globalThis, "localStorage", { configurable: true, writable: true, value: saved });
  }
});

// --- 结果 ---

if (failures.length) {
  console.error(`✗ ${failures.length} 项失败，${passed} 项通过`);
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}
console.log(`✓ 全部 ${passed} 项通过`);
for (const note of observations) console.log(note);
process.exit(0);
