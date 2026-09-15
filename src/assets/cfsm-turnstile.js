// 批次 6：Turnstile 凭证链（DOM 无关核心 + 浏览器运行时适配）。
//
// 契约（CFSM workers 2.8.5，`src/index.js`）：
// - 站点开启全局 Turnstile 时，除 `/api/ws`、`/admin/api` 外的所有 `/api/*` 都要求凭证；
// - `/api/config` **仅当两个 Turnstile 头都不带**时豁免 → 「裸探测 → 挑战 → 交换」是唯一可用的启动顺序；
// - 服务端先验 `X-Turnstile-Verified`，失败才验 `X-Turnstile-Token`；两者都可带来凭证；
// - 凭证是 base64(IV‖AES-GCM) 的**不透明**串，客户端读不到明文与过期时间 → 一律以服务端 `verified`
//   与已识别的 403（`{"error":"Turnstile verification failed"}`）为准，不做本地「存在即有效」判断；
// - `/api/config` 响应体的 `turnstile_enabled` 是**全局闸门**；`turnstile_login_enabled` 是 OR 派生值，
//   不能用来判断全局是否开启。
//
// 本模块不 import 任何东西（node 可直接加载），DOM 只经由可注入的 runtime 触碰。

export const TURNSTILE_TOKEN_KEY = "turnstile_token";
export const TURNSTILE_VERIFIED_KEY = "turnstile_verified";
export const TURNSTILE_SCRIPT_SRC = "https://challenges.cloudflare.com/turnstile/v0/api.js";
export const TURNSTILE_SCRIPT_ID = "cfsm-turnstile-script";
export const TURNSTILE_FORBIDDEN_ERROR = "Turnstile verification failed";
// 一次恢复过程内，自动挑战/交换**连续**最多 2 次；第 2 次仍失败即终止并锁定错误态。
export const TURNSTILE_MAX_ATTEMPTS = 2;
// 三阶段超时：加载脚本 / 等待用户 / 交换（交换覆盖发请求 + 读体 + 解析 + 凭证提交）。
export const DEFAULT_TURNSTILE_TIMEOUTS = Object.freeze({ script: 15000, user: 90000, exchange: 20000 });

export const TURNSTILE_STATE = Object.freeze({
  idle: "idle",
  probing: "probing",
  challenging: "challenging",
  exchanging: "exchanging",
  ready: "ready",
  off: "off",
  failed: "failed",
});

export const TURNSTILE_REASON = Object.freeze({
  config: "config",
  configInvalid: "config-invalid",
  missingSiteKey: "missing-site-key",
  scriptBlocked: "script-blocked",
  widgetError: "widget-error",
  widgetExpired: "widget-expired",
  userTimeout: "user-timeout",
  exchangeRejected: "exchange-rejected",
  exchangeFailed: "exchange-failed",
  exchangeIncomplete: "exchange-incomplete",
  exhausted: "exhausted",
  locked: "locked",
  cancelled: "cancelled",
});

export function isTurnstileEnabledValue(value) {
  return value === true || value === "true";
}

export function normalizeTurnstileSiteKey(value) {
  return String(value ?? "").trim();
}

// 配置响应必须是「记录」（对象、非数组）。200 但 body 非记录说明响应不可信（反代/中间层返回 JSON 错误体
// 即属此类），必须走 configInvalid 失败——否则会被当成「站点未开 Turnstile」静默放行，既不挑战也不提示，
// 还会让应用再读一次 /api/config（启动请求次数失真）。
export function isTurnstileConfigRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

// 只认「已识别的 Turnstile 403」：其余 403（权限、Origin 限制）一律按普通错误处理。
export function isTurnstileForbidden(status, payload) {
  return status === 403 && Boolean(payload) && typeof payload === "object" && payload.error === TURNSTILE_FORBIDDEN_ERROR;
}

export function isTurnstileCredential(value) {
  return typeof value === "string" && value.length > 0;
}

// localStorage 不可用（隐私模式 / 沙箱）时降级为内存凭证：只影响持久性，不影响可用性。
export function createTurnstileStorage(backing = null) {
  const memory = new Map();
  const resolve = () => {
    if (backing) return backing;
    try {
      if (typeof localStorage !== "undefined" && localStorage) {
        localStorage.getItem(TURNSTILE_VERIFIED_KEY);
        return localStorage;
      }
    } catch {
      // 访问被拒 → 内存降级
    }
    return null;
  };
  return {
    get(key) {
      const target = resolve();
      if (target) {
        try {
          return target.getItem(key) || "";
        } catch {
          // 读失败 → 退回内存
        }
      }
      return memory.get(key) || "";
    },
    set(key, value) {
      const target = resolve();
      if (target) {
        try {
          target.setItem(key, value);
          return;
        } catch {
          // 写失败（配额/禁用）→ 退回内存
        }
      }
      memory.set(key, value);
    },
    remove(key) {
      const target = resolve();
      if (target) {
        try {
          target.removeItem(key);
        } catch {
          // 忽略
        }
      }
      memory.delete(key);
    },
  };
}

// 浏览器运行时：脚本加载（含「摆脱已失败 Promise」的重置）、widget 渲染/移除。
export function createTurnstileRuntime({
  document: doc = typeof document === "undefined" ? null : document,
  window: win = typeof window === "undefined" ? null : window,
  scriptSrc = TURNSTILE_SCRIPT_SRC,
} = {}) {
  let scriptPromise = null;
  const ready = () => Boolean(win && win.turnstile && typeof win.turnstile.render === "function");
  return {
    available() {
      return Boolean(doc && win);
    },
    isReady: ready,
    loadScript() {
      if (ready()) return Promise.resolve();
      if (scriptPromise) return scriptPromise;
      scriptPromise = new Promise((resolve, reject) => {
        if (!doc) {
          reject(new Error("document is unavailable"));
          return;
        }
        const script = doc.createElement("script");
        script.src = scriptSrc;
        script.async = true;
        script.id = TURNSTILE_SCRIPT_ID;
        script.onload = () => (ready() ? resolve() : reject(new Error("turnstile global is missing")));
        script.onerror = () => reject(new Error("turnstile script failed to load"));
        doc.head.appendChild(script);
      }).catch(error => {
        // 失败的加载 Promise 必须能被摆脱，否则重试永远复用同一个 rejection
        scriptPromise = null;
        throw error;
      });
      return scriptPromise;
    },
    resetScript() {
      scriptPromise = null;
      try {
        doc?.getElementById(TURNSTILE_SCRIPT_ID)?.remove();
      } catch {
        // 忽略
      }
    },
    render(container, options) {
      if (!ready()) throw new Error("turnstile is not ready");
      return win.turnstile.render(container, {
        sitekey: options.siteKey,
        callback: options.onToken,
        // Turnstile 官方 JS API 的回调键是 kebab-case（上游 main.js 用的 camelCase 不会被调用）；
        // 两个键都传，兼容替身与旧版实现。
        "error-callback": options.onError,
        errorCallback: options.onError,
        "expired-callback": options.onExpired,
        expiredCallback: options.onExpired,
        theme: "auto",
      });
    },
    remove(handle, container) {
      try {
        if (win?.turnstile?.remove && handle !== undefined && handle !== null) {
          win.turnstile.remove(handle);
          return;
        }
      } catch {
        // 继续尝试清容器
      }
      try {
        if (container && typeof container === "object" && "innerHTML" in container) container.innerHTML = "";
      } catch {
        // 忽略
      }
    },
    // 兜底容器：应用来不及给出插槽时也不能因为拿不到容器而放弃挑战。
    createContainer() {
      if (!doc?.body) return null;
      const holder = doc.createElement("div");
      holder.setAttribute("data-turnstile-fallback", "1");
      holder.style.position = "fixed";
      holder.style.left = "-9999px";
      holder.style.top = "0";
      doc.body.appendChild(holder);
      return holder;
    },
  };
}

function withTimeout(promise, ms, onTimeout) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve(onTimeout());
    }, ms);
    Promise.resolve(promise).then(
      value => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      },
      error => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

const SCRIPT_TIMEOUT = Symbol("turnstile-script-timeout");

export function createTurnstileChain({
  storage = createTurnstileStorage(),
  requestRaw,
  runtime = createTurnstileRuntime(),
  timeouts = {},
  onState = null,
  containerProvider = null,
  configPath = "/api/config",
} = {}) {
  const limits = { ...DEFAULT_TURNSTILE_TIMEOUTS, ...(timeouts || {}) };
  let state = TURNSTILE_STATE.idle;
  let epoch = 0;
  let processAttempts = 0;
  let locked = false;
  let recoverPromise = null;
  let recoverTicket = 0;
  let attemptTicket = 0;
  let failure = null;
  let config = null;

  const siteKey = () => normalizeTurnstileSiteKey(config?.turnstile_site_key);
  const enabled = () => isTurnstileEnabledValue(config?.turnstile_enabled);
  const getVerified = () => storage.get(TURNSTILE_VERIFIED_KEY);
  const getToken = () => storage.get(TURNSTILE_TOKEN_KEY);
  const hasCredential = () => isTurnstileCredential(getVerified());

  function getSnapshot() {
    return {
      state,
      reason: failure?.reason || "",
      status: failure?.status || 0,
      message: failure?.message || "",
      locked,
      epoch,
      attempts: processAttempts,
      siteKey: siteKey(),
      enabled: enabled(),
      hasCredential: hasCredential(),
      config,
    };
  }

  function setState(next, detail = {}) {
    state = next;
    if (typeof onState === "function") {
      try {
        onState(getSnapshot(), detail);
      } catch {
        // UI 回调不得影响状态机
      }
    }
  }

  // 只清 Turnstile 的两个键：JWT（`jwt_token`）与登录态完全不受影响。
  function clearCredentials() {
    storage.remove(TURNSTILE_VERIFIED_KEY);
    storage.remove(TURNSTILE_TOKEN_KEY);
  }

  function fail(reason, extra = {}) {
    failure = { reason, ...extra };
    setState(TURNSTILE_STATE.failed, { reason, ...extra });
    return { ok: false, reason, ...extra };
  }

  function lock(reason = TURNSTILE_REASON.locked) {
    locked = true;
    failure = { reason };
    setState(TURNSTILE_STATE.failed, { reason });
  }

  function resolveContainer() {
    let element = null;
    try {
      element = typeof containerProvider === "function" ? containerProvider() : null;
    } catch {
      element = null;
    }
    if (element) return element;
    try {
      return runtime.createContainer ? runtime.createContainer() : null;
    } catch {
      return null;
    }
  }

  async function loadScriptWithRetry(ticket) {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      if (ticket !== attemptTicket) return { ok: false };
      try {
        if (runtime.isReady?.()) return { ok: true };
        const outcome = await withTimeout(Promise.resolve().then(() => runtime.loadScript()), limits.script, () => SCRIPT_TIMEOUT);
        if (outcome !== SCRIPT_TIMEOUT) return { ok: true };
        runtime.resetScript?.();
      } catch {
        // 超时或 onerror：重置脚本缓存后再试一次（不得复用已失败的加载 Promise）
        runtime.resetScript?.();
      }
    }
    return { ok: false };
  }

  // 等待用户完成挑战。settle 一次即止：重复 callback 不重复交换，超时后的迟到成功一律失效。
  function waitForToken(key, ticket) {
    return new Promise(resolve => {
      const container = resolveContainer();
      let settled = false;
      let handle = null;
      let timer = null;
      const finish = outcome => {
        if (settled) return;
        settled = true;
        if (timer !== null) clearTimeout(timer);
        timer = null;
        try {
          runtime.remove?.(handle, container);
        } catch {
          // 忽略
        }
        resolve(outcome);
      };
      const onToken = token => {
        if (isTurnstileCredential(token)) finish({ ok: true, token: String(token) });
      };
      const onError = () => finish({ ok: false, reason: TURNSTILE_REASON.widgetError });
      const onExpired = () => finish({ ok: false, reason: TURNSTILE_REASON.widgetExpired });
      try {
        handle = runtime.render(container, { siteKey: key, onToken, onError, onExpired });
      } catch (error) {
        finish({ ok: false, reason: TURNSTILE_REASON.widgetError, message: error instanceof Error ? error.message : String(error) });
        return;
      }
      timer = setTimeout(() => finish({ ok: false, reason: TURNSTILE_REASON.userTimeout }), limits.user);
      if (ticket !== attemptTicket) finish({ ok: false, reason: TURNSTILE_REASON.cancelled });
    });
  }

  // T3：交换凭证。计时（超时由调用方的底层请求负责，覆盖到读体与解析）与提交都在这里，
  // 因此「响应头已到但体读不出/解析失败/提交前被取消」都算交换失败。
  async function exchangeToken(token, ticket) {
    storage.set(TURNSTILE_TOKEN_KEY, token);
    let outcome;
    try {
      outcome = await requestRaw(configPath, { mode: "token-only", timeout: limits.exchange });
    } catch (error) {
      outcome = { ok: false, status: 0, data: null, payload: null, error: error instanceof Error ? error.message : String(error) };
    }
    // 取消/超时后的迟到交换成功：不得提交，也不得覆盖新流程的凭证。
    if (ticket !== attemptTicket) return { ok: false, reason: TURNSTILE_REASON.cancelled };
    if (!outcome || outcome.status !== 200 || !outcome.data) {
      storage.remove(TURNSTILE_TOKEN_KEY);
      const recognized = isTurnstileForbidden(outcome?.status, outcome?.payload);
      return { ok: false, reason: recognized ? TURNSTILE_REASON.exchangeRejected : TURNSTILE_REASON.exchangeFailed, status: outcome?.status || 0 };
    }
    const payload = outcome.data;
    const verified = typeof payload.turnstile_verified === "string" ? payload.turnstile_verified : "";
    if (payload.verified !== true || !verified) {
      storage.remove(TURNSTILE_TOKEN_KEY);
      return { ok: false, reason: TURNSTILE_REASON.exchangeIncomplete };
    }
    storage.set(TURNSTILE_VERIFIED_KEY, verified);
    storage.remove(TURNSTILE_TOKEN_KEY);
    config = payload;
    return { ok: true, verified };
  }

  // 单次挑战 + 交换（一次自动尝试）。
  async function challengeCredential({ reason = "recovery" } = {}) {
    const key = siteKey();
    if (!key) return fail(TURNSTILE_REASON.missingSiteKey);
    const ticket = ++attemptTicket;
    setState(TURNSTILE_STATE.challenging, { reason });
    const loaded = await loadScriptWithRetry(ticket);
    if (ticket !== attemptTicket) return { ok: false, reason: TURNSTILE_REASON.cancelled };
    if (!loaded.ok) return fail(TURNSTILE_REASON.scriptBlocked);
    const tokenResult = await waitForToken(key, ticket);
    if (ticket !== attemptTicket) return { ok: false, reason: TURNSTILE_REASON.cancelled };
    if (!tokenResult.ok) return fail(tokenResult.reason, tokenResult.message ? { message: tokenResult.message } : {});
    setState(TURNSTILE_STATE.exchanging, { reason });
    const exchanged = await exchangeToken(tokenResult.token, ticket);
    if (ticket !== attemptTicket) return { ok: false, reason: TURNSTILE_REASON.cancelled };
    if (!exchanged.ok) return fail(exchanged.reason, { status: exchanged.status || 0 });
    failure = null;
    setState(TURNSTILE_STATE.ready, { reason });
    return { ok: true };
  }

  // 一次恢复过程：连续自动尝试上限 2 次，仍失败即锁定错误态（人工重试才开新过程）。
  async function runProcess({ reason = "recovery" } = {}) {
    if (locked) return { ok: false, locked: true, reason: TURNSTILE_REASON.locked };
    let last = null;
    while (processAttempts < TURNSTILE_MAX_ATTEMPTS) {
      processAttempts += 1;
      epoch += 1; // 每次尝试都是新的凭证代次：旧代次的在途 403 不得开启新恢复
      clearCredentials();
      last = await challengeCredential({ reason });
      if (last.ok) return { ok: true, reason: "" };
      if (last.reason === TURNSTILE_REASON.cancelled) return last;
    }
    lock(TURNSTILE_REASON.exhausted);
    return { ok: false, locked: true, reason: TURNSTILE_REASON.exhausted };
  }

  // 共享单一恢复 Promise：并发 403 只挑战一次；失败时所有等待者一起结算并保持失败门控。
  function recover(options = {}) {
    if (locked) return Promise.resolve({ ok: false, locked: true, reason: TURNSTILE_REASON.locked });
    if (recoverPromise) return recoverPromise;
    const ticket = ++recoverTicket;
    const started = (async () => {
      try {
        return await runProcess({ reason: options.reason || "recovery" });
      } catch (error) {
        return { ok: false, reason: TURNSTILE_REASON.cancelled, message: error instanceof Error ? error.message : String(error) };
      }
    })();
    const wrapped = started.finally(() => {
      // finally 清理必须校验代次：旧流程不得释放新流程的锁
      if (ticket === recoverTicket && recoverPromise === wrapped) recoverPromise = null;
    });
    recoverPromise = wrapped;
    return wrapped;
  }

  // 人工重试：开启新过程（计数重新计），期间按钮由 UI 禁用。
  function manualRetry() {
    locked = false;
    processAttempts = 0;
    failure = null;
    recoverTicket += 1;
    recoverPromise = null;
    return recover({ reason: "manual" });
  }

  function noteDataSuccess({ withCredential = true } = {}) {
    // 只有拿到数据性成功响应才复位过程计数（仅交换成功不复位）。
    processAttempts = 0;
    if (!withCredential && locked) {
      // 不带任何凭证也能拿到数据 → 站点此刻不需要凭证，解除失败锁定（否则关闭开关后会永久卡住）
      locked = false;
      recoverTicket += 1;
      failure = null;
      setState(TURNSTILE_STATE.ready, { reason: "credential-not-required" });
    }
  }

  function failConfig(outcome) {
    const status = outcome?.status || 0;
    if (status === 403) return fail(TURNSTILE_REASON.config);
    if (status === 0) return fail(TURNSTILE_REASON.config, { message: outcome?.error || "" });
    if (status !== 200) return fail(TURNSTILE_REASON.config, { status });
    return fail(TURNSTILE_REASON.configInvalid, { status });
  }

  // 启动判定顺序（唯一入口）：
  // 1) turnstile_enabled !== true → 保留 Verified、清残留 Token、直接 ready（login-only 同样不挑战）；
  // 2) 全局开启且 verified === true → 保留旧凭证直接 ready（交换响应里的 null 属正常，不得清凭证）；
  // 3) 全局开启但未验证 → 看 sitekey：缺失即明确失败，否则挑战。
  async function bootstrap() {
    processAttempts = 0;
    locked = false;
    failure = null;
    setState(TURNSTILE_STATE.probing, { reason: "bootstrap" });
    const cached = getVerified();
    let payload = null;
    if (cached) {
      const outcome = await requestRaw(configPath, { mode: "verified-only", timeout: limits.exchange });
      if (outcome?.status === 200) {
        if (!isTurnstileConfigRecord(outcome.data)) return failConfig(outcome);
        payload = outcome.data;
      }
      else if (isTurnstileForbidden(outcome?.status, outcome?.payload)) clearCredentials();
      else return failConfig(outcome);
    }
    if (!payload) {
      const outcome = await requestRaw(configPath, { mode: "neither", timeout: limits.exchange });
      if (!outcome || outcome.status !== 200 || !isTurnstileConfigRecord(outcome.data)) return failConfig(outcome);
      payload = outcome.data;
    }
    config = payload;
    if (!enabled()) {
      // 保留 turnstile_verified（与内置前端共享缓存、避免站点再开启时白跑一次挑战），
      // 但清理残留的一次性 token；保留不等于验证有效、也不续期。
      storage.remove(TURNSTILE_TOKEN_KEY);
      setState(TURNSTILE_STATE.off, { reason: "disabled" });
      return { ok: true, mode: "disabled", config: payload };
    }
    if (payload.verified === true) {
      setState(TURNSTILE_STATE.ready, { reason: "cached" });
      return { ok: true, mode: "verified", config: payload };
    }
    if (!siteKey()) {
      fail(TURNSTILE_REASON.missingSiteKey);
      return { ok: false, reason: TURNSTILE_REASON.missingSiteKey, config: payload };
    }
    const result = await runProcess({ reason: "startup" });
    if (!result.ok) return { ok: false, reason: result.reason, config: payload };
    return { ok: true, mode: "challenged", config: getSnapshot().config || payload };
  }

  return {
    bootstrap,
    recover,
    manualRetry,
    noteDataSuccess,
    lock,
    clearCredentials,
    hasCredential,
    getVerified,
    getToken,
    getEpoch: () => epoch,
    getState: () => state,
    getSnapshot,
    isReady: () => state === TURNSTILE_STATE.ready || state === TURNSTILE_STATE.off,
    isLocked: () => locked,
    isRecovering: () => Boolean(recoverPromise),
    // 探测/交换外的受保护请求在恢复期间等待同一个恢复 Promise，避免并发重复挑战
    waitForRecovery: () => (recoverPromise ? recoverPromise : Promise.resolve({ ok: true, reason: "" })),
    setConfig(next) {
      config = next;
    },
    getConfig: () => config,
  };
}
