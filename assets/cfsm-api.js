// CF-Server-Monitor REST 数据层（替代原主题的 Komari JSON-RPC `/api/rpc2`）。
//
// 只做三件事：同源 REST 请求（带可选 JWT）、登录态读写、轮询调度（页面不可见暂停 + 失败退避）。
// 字段映射不在这里，见 `cfsm-map.js`。

// CFSM 把登录令牌放在 localStorage；`cfsm_auth` Cookie 是 HttpOnly，JS 读不到。
export const AUTH_TOKEN_KEY = "jwt_token";

// 站点自身的 CFSM 资源在 `/static/`，主题资源在 `/assets/`，不冲突。
export const API_PATHS = Object.freeze({
  config: "/api/config",
  servers: "/api/servers",
  server: "/api/server",
  history: "/api/history/all",
  // 写接口：CFSM 官方 theme-develop.md 规定 body 为 { theme_options: {...} }，
  // 无论站点是否公开都必须带 JWT；该接口只更新 appearance_options.theme_options（整对象替换）。
  themeOptions: "/api/theme_options",
});

// `/api/history/all` 的 hours 只接受这组离散值（实测）。
export const HISTORY_HOURS = Object.freeze([0.167, 0.5, 1, 6, 12, 24, 48, 96, 168]);

export function nearestHistoryHours(hours) {
  const value = Number(hours);
  if (!Number.isFinite(value)) return 24;
  return HISTORY_HOURS.reduce((best, candidate) => (Math.abs(candidate - value) < Math.abs(best - value) ? candidate : best), HISTORY_HOURS[0]);
}

// 批次 6：统一请求层的三种**互斥** Turnstile 头模式，在最终头合并之后落实。
// - `verified-only`：启动探测与常规业务请求（只带长期凭证）
// - `neither`：裸探测（两个 Turnstile 头都不带，`Authorization` 不变）
// - `token-only`：凭证换发（只带一次性 token）
// 上游 `http.js` 的缺陷是 `includeTurnstile:false` 不会去掉 Verified 头，本移植版不复制：
// 合并后先**无条件删除**任何来源的 Turnstile 头，再按模式注入。
export const TURNSTILE_HEADER_MODES = Object.freeze({
  verifiedOnly: "verified-only",
  neither: "neither",
  tokenOnly: "token-only",
});

export const TURNSTILE_VERIFIED_HEADER = "X-Turnstile-Verified";
export const TURNSTILE_TOKEN_HEADER = "X-Turnstile-Token";
// 只有这个错误体的 403 才是「已识别的 Turnstile 403」，其余 403 一律透出。
export const TURNSTILE_FORBIDDEN_ERROR = "Turnstile verification failed";

export function isTurnstileForbidden(status, payload) {
  return status === 403 && Boolean(payload) && typeof payload === "object" && payload.error === TURNSTILE_FORBIDDEN_ERROR;
}

function deleteHeader(headers, name) {
  const lower = name.toLowerCase();
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === lower) delete headers[key];
  }
}

export class CfsmApiError extends Error {
  constructor(message, { status = 0, path = "", cause = null, turnstile = false, reason = "" } = {}) {
    super(message);
    this.name = "CfsmApiError";
    this.status = status;
    this.path = path;
    this.cause = cause;
    // 保留结构化分类：业务层要能直接区分「Turnstile 失败」与普通 403，而不必靠 status + 链快照反推。
    this.turnstile = turnstile === true;
    this.reason = String(reason || "");
  }
}

export function readStoredToken(storage) {
  try {
    const target = storage || (typeof localStorage === "undefined" ? null : localStorage);
    return target?.getItem(AUTH_TOKEN_KEY) || "";
  } catch {
    return "";
  }
}

export function clearStoredToken(storage) {
  try {
    const target = storage || (typeof localStorage === "undefined" ? null : localStorage);
    target?.removeItem(AUTH_TOKEN_KEY);
  } catch {
    // 忽略隐私模式下的写入失败
  }
}

export function hasStoredToken(storage) {
  return readStoredToken(storage).length > 0;
}

export class CfsmApi {
  constructor({ base = "", getToken = readStoredToken, onUnauthorized = null, timeout = 15000, fetchImpl = null, turnstile = null } = {}) {
    this.base = base;
    this.getToken = getToken;
    this.onUnauthorized = onUnauthorized;
    this.timeout = timeout;
    this.fetchImpl = fetchImpl;
    // 凭证链（`cfsm-turnstile.js`）：晚绑定——链自身要用本实例的 `requestRaw` 做探测/交换。
    this.turnstile = turnstile;
  }

  attachTurnstile(chain) {
    this.turnstile = chain;
    return chain;
  }

  readTurnstileVerified() {
    return this.turnstile?.getVerified?.() || "";
  }

  readTurnstileToken() {
    return this.turnstile?.getToken?.() || "";
  }

  // 最终头合并：基础头 → 调用方 init.headers → JWT → 抹掉所有 Turnstile 头 → 按模式注入。
  buildHeaders({ mode = TURNSTILE_HEADER_MODES.verifiedOnly, token = null, init = {} } = {}) {
    const headers = { Accept: "application/json", ...(init.headers || {}) };
    const jwt = this.getToken();
    if (jwt) headers.Authorization = `Bearer ${jwt}`;
    if (init.body) headers["Content-Type"] = "application/json";
    deleteHeader(headers, TURNSTILE_VERIFIED_HEADER);
    deleteHeader(headers, TURNSTILE_TOKEN_HEADER);
    if (mode === TURNSTILE_HEADER_MODES.tokenOnly) {
      const value = token || this.readTurnstileToken();
      if (value) headers[TURNSTILE_TOKEN_HEADER] = value;
    } else if (mode === TURNSTILE_HEADER_MODES.verifiedOnly) {
      const value = this.readTurnstileVerified();
      if (value) headers[TURNSTILE_VERIFIED_HEADER] = value;
    }
    return headers;
  }

  buildUrl(path, query) {
    const base = this.base || (typeof location === "undefined" ? "" : location.origin);
    const url = new URL(path, base);
    if (query) {
      for (const [key, value] of Object.entries(query)) {
        if (value === undefined || value === null || value === "") continue;
        url.searchParams.set(key, String(value));
      }
    }
    return url.toString();
  }

  // 底层请求：**禁止自动恢复**，供探测/交换与统一请求层复用。
  // 计时器覆盖到响应体读完并解析成功（T3 必须包含读体与解析），失败一律以返回值表达，不抛异常。
  async requestRaw(path, { query = null, timeout = this.timeout, init = {}, mode = TURNSTILE_HEADER_MODES.verifiedOnly, token = null } = {}) {
    const doFetch = this.fetchImpl || (typeof fetch === "function" ? fetch.bind(globalThis) : null);
    if (!doFetch) throw new CfsmApiError("fetch is unavailable", { path });
    const headers = this.buildHeaders({ mode, token, init });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    try {
      const response = await doFetch(this.buildUrl(path, query), {
        ...init,
        headers,
        credentials: "same-origin",
        signal: controller.signal,
      });
      const status = Number(response?.status ?? 0);
      const ok = typeof response?.ok === "boolean" ? response.ok : status >= 200 && status < 300;
      let payload = null;
      let parseFailed = false;
      try {
        payload = await response.json();
      } catch {
        payload = null;
        parseFailed = true;
      }
      return { ok, status, data: payload, payload, parseFailed };
    } catch (error) {
      const aborted = error?.name === "AbortError";
      return { ok: false, status: 0, data: null, payload: null, error: aborted ? "请求超时" : "网络请求失败", cause: error };
    } finally {
      clearTimeout(timer);
    }
  }

  // 统一请求层：头模式注入 + 「已识别 Turnstile 403 → 恢复 → 一次性重放」。
  // 计数语义（三者互相独立）：
  // 1) 一次恢复过程内自动挑战/交换连续最多 2 次（由凭证链 `recover()` 管）；
  // 2) **每个业务请求**最多重放一次（本方法内的一次性标记）；
  // 3) 只有拿到数据性成功响应才复位过程计数（链的 `noteDataSuccess`）。
  async request(path, options = {}) {
    const {
      query = null,
      timeout = this.timeout,
      init = {},
      mode = TURNSTILE_HEADER_MODES.verifiedOnly,
      token = null,
    } = options;
    const chain = this.turnstile;
    // 只有常规业务请求参与恢复：裸探测与换发自身绝不自动恢复（否则交换 403 会递归）。
    const recoverable = Boolean(chain) && mode === TURNSTILE_HEADER_MODES.verifiedOnly;
    let replayed = false;

    for (;;) {
      if (recoverable) {
        // 恢复期间门控新的受保护请求：等待同一个恢复 Promise，失败则保持失败门控。
        if (chain.isRecovering()) {
          const shared = await chain.waitForRecovery();
          if (!shared.ok) throw new CfsmApiError("人机验证失败", { status: 403, path, turnstile: true, reason: shared.reason });
        } else if (chain.isLocked()) {
          throw new CfsmApiError("人机验证失败", { status: 403, path, turnstile: true, reason: "locked" });
        }
      }
      // 发送时记录凭证代次：旧代次的 403 不开启新恢复，改用当前凭证重放。
      const sentEpoch = chain ? chain.getEpoch() : 0;
      const withCredential = recoverable ? chain.hasCredential() : false;
      const outcome = await this.requestRaw(path, { query, timeout, init, mode, token });

      if (outcome.ok) {
        if (outcome.parseFailed) throw new CfsmApiError("响应不是合法 JSON", { status: outcome.status, path });
        if (recoverable) chain.noteDataSuccess({ withCredential });
        return outcome.data;
      }

      if (recoverable && isTurnstileForbidden(outcome.status, outcome.payload)) {
        if (replayed) {
          // 带凭证重放后仍是已识别 403。**只有代次未变**才说明当前凭证确实被拒 → 终止并锁定；
          // 若期间代次已推进（同批另一路恢复刚换发新凭证），这次失败不是对新凭证的判决，只报错不锁定
          // ——否则会出现「已锁定 + 有效凭证」僵局：所有受保护请求被入口门控直接打死，只能人工重试。
          if (sentEpoch !== chain.getEpoch()) {
            throw new CfsmApiError("人机验证失败", { status: 403, path, turnstile: true, reason: "stale-forbidden" });
          }
          chain.lock("replayed-forbidden");
          throw new CfsmApiError("人机验证失败", { status: 403, path, turnstile: true, reason: "replayed-forbidden" });
        }
        if (sentEpoch !== chain.getEpoch()) {
          // 旧代次 403：不开启新恢复。若恢复仍在进行 → **加入在途恢复**，等新凭证落盘后按本请求的
          // 一次性额度重放；否则用当前凭证直接重放（v3 B3-a）。
          // 不做「加入」会让同一批并发 403 里除恢复发起者之外的请求全部失败（凭证过期时表现为
          // 若干面板同时报错），而正确语义是它们都跟着同一次恢复恢复过来。
          if (chain.isRecovering()) {
            const shared = await chain.waitForRecovery();
            if (!shared.ok) throw new CfsmApiError("人机验证失败", { status: 403, path, turnstile: true, reason: shared.reason });
          }
          if (!chain.hasCredential() || chain.isLocked()) {
            throw new CfsmApiError("人机验证失败", { status: 403, path, turnstile: true, reason: "stale-no-credential" });
          }
          replayed = true; // 旧代次：不开启新恢复，用当前凭证走本请求的一次性重放额度
          continue;
        }
        if (chain.isLocked()) {
          throw new CfsmApiError("人机验证失败", { status: 403, path, turnstile: true, reason: "locked" });
        }
        const result = await chain.recover({ reason: "forbidden" });
        if (!result.ok) throw new CfsmApiError("人机验证失败", { status: 403, path, turnstile: true, reason: result.reason });
        replayed = true;
        continue;
      }

      // 401 = 令牌无效/过期：清除本地令牌并提示重新登录（**与 Turnstile 无关，行为不变**）。
      if (outcome.status === 401) {
        clearStoredToken();
        this.onUnauthorized?.();
        throw new CfsmApiError("登录状态已失效", { status: 401, path });
      }
      // 403 = 携带的令牌被拒（未授权、Turnstile、Origin 限制）：**绝不清除令牌**——
      // 清掉等于误登出，而且对 Turnstile 站点毫无帮助。Turnstile 恢复只清 `turnstile_verified`
      // 与 `turnstile_token` 两个键，登录态不受影响。
      if (outcome.status === 0) {
        throw new CfsmApiError(outcome.error || "网络请求失败", { path, cause: outcome.cause });
      }
      // CFSM 的错误体是 { error: "invalidThemeOptionsFormat" } 这类代码，优先透出它
      const code = outcome.payload && typeof outcome.payload.error === "string" ? outcome.payload.error : "";
      throw new CfsmApiError(code || `HTTP ${outcome.status}`, { status: outcome.status, path });
    }
  }

  // `GET /api/config` → 站点标题、版本、外观选项（含 theme_options）、三网自定义线路名等。
  getConfig(options) {
    return this.request(API_PATHS.config, options);
  }

  // `GET /api/servers` → { servers, stats, sysConfig, regionStats, latestReportUpdates }。
  // 单次约 230 KB，其中大部分是 latestReportUpdates；不要用更短的间隔轮询。
  getServers(options) {
    return this.request(API_PATHS.servers, options);
  }

  // `GET /api/server?id=` → 扁平对象（不是 { server }），且**不含** ping/loss 窗口数组。
  getServer(id, options = {}) {
    return this.request(API_PATHS.server, { ...options, query: { id, ...(options.query || {}) } });
  }

  // `GET /api/history/all?id=&hours=` → 裸数组；hours 只接受离散值，这里自动取最近档。
  getHistory(id, hours = 24, options = {}) {
    return this.request(API_PATHS.history, { ...options, query: { id, hours: nearestHistoryHours(hours), ...(options.query || {}) } });
  }

  // `POST /api/theme_options`：整对象替换 theme_options → 调用方必须先读-改-写。
  // Turnstile 凭证由统一请求层按 `verified-only` 模式**动态注入**，调用方不再传校验头
  // （第二参数契约已删除；`init.headers` 里注入的 Turnstile 头也会在最终合并后被抹掉）。
  saveThemeOptions(themeOptions) {
    return this.request(API_PATHS.themeOptions, {
      timeout: 20000,
      init: {
        method: "POST",
        body: JSON.stringify({ theme_options: themeOptions }),
      },
    });
  }
}

export function createCfsmApi(options) {
  return new CfsmApi(options);
}

// Turnstile 凭证链已由 `cfsm-turnstile.js` + 本文件的统一请求层实现（启动判定顺序、三阶段超时、
// 已识别 403 的恢复与一次性重放、共享恢复 Promise、失败锁定），调用方不再需要「整站不可用」判定。

// 轮询调度：默认 30 秒（可配置），连续失败按 2 的幂退避，上限 120 秒；`onTick` 抛错即视为失败。
// 可见性与通道选择由调用方（app.js 的实时编排）负责——本函数只按 start/stop 运行，
// 避免与实时链路争夺同一事件，出现"隐藏后仍在轮询"的双通道。
export function createPoller({
  getIntervalSeconds,
  onTick,
  onError = null,
  maxBackoffSeconds = 120,
} = {}) {
  let timer = null;
  let backoffStep = 0;
  let stopped = true;
  let inFlight = false;

  const baseIntervalMs = () => {
    const seconds = Number(getIntervalSeconds?.());
    const safe = Number.isFinite(seconds) ? Math.min(Math.max(seconds, 1), 3600) : 30;
    return safe * 1000;
  };

  const delayFor = (failed) => {
    const base = baseIntervalMs();
    if (!failed) return base;
    return Math.min(Math.max(base * 2 ** Math.min(backoffStep, 6), base), maxBackoffSeconds * 1000);
  };

  const clear = () => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  };

  const schedule = (failed = false) => {
    clear();
    if (stopped) return;
    timer = setTimeout(() => void run(), delayFor(failed));
  };

  async function run() {
    clear();
    if (stopped || inFlight) return;
    inFlight = true;
    let failed = false;
    try {
      await onTick?.();
      backoffStep = 0;
    } catch (error) {
      failed = true;
      backoffStep = Math.min(backoffStep + 1, 6);
      onError?.(error);
    } finally {
      inFlight = false;
      schedule(failed);
    }
  }

  return {
    start() {
      if (!stopped) return;
      stopped = false;
      backoffStep = 0;
      schedule(false);
    },
    stop() {
      stopped = true;
      clear();
    },
    // 恢复可见/手动刷新时的立即执行入口。
    refreshNow() {
      return run();
    },
    isRunning() {
      return !stopped;
    },
    get backoffStep() {
      return backoffStep;
    },
  };
}
