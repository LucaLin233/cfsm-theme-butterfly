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

export class CfsmApiError extends Error {
  constructor(message, { status = 0, path = "", cause = null } = {}) {
    super(message);
    this.name = "CfsmApiError";
    this.status = status;
    this.path = path;
    this.cause = cause;
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
  constructor({ base = "", getToken = readStoredToken, onUnauthorized = null, timeout = 15000, fetchImpl = null } = {}) {
    this.base = base;
    this.getToken = getToken;
    this.onUnauthorized = onUnauthorized;
    this.timeout = timeout;
    this.fetchImpl = fetchImpl;
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

  async request(path, { query = null, timeout = this.timeout, init = {} } = {}) {
    const doFetch = this.fetchImpl || (typeof fetch === "function" ? fetch.bind(globalThis) : null);
    if (!doFetch) throw new CfsmApiError("fetch is unavailable", { path });
    const token = this.getToken();
    const headers = { Accept: "application/json", ...(init.headers || {}) };
    if (token) headers.Authorization = `Bearer ${token}`;
    if (init.body) headers["Content-Type"] = "application/json";

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    let response;
    try {
      response = await doFetch(this.buildUrl(path, query), {
        ...init,
        headers,
        credentials: "same-origin",
        signal: controller.signal,
      });
    } catch (error) {
      throw new CfsmApiError(error?.name === "AbortError" ? "请求超时" : "网络请求失败", { path, cause: error });
    } finally {
      clearTimeout(timer);
    }

    if (response.status === 401 || response.status === 403) {
      clearStoredToken();
      this.onUnauthorized?.();
      throw new CfsmApiError("登录状态已失效", { status: response.status, path });
    }
    if (!response.ok) {
      // CFSM 的错误体是 { error: "invalidThemeOptionsFormat" } 这类代码，优先透出它
      let code = "";
      try {
        const payload = await response.json();
        if (payload && typeof payload.error === "string") code = payload.error;
      } catch {
        // 非 JSON 错误体：保持 HTTP 状态描述
      }
      throw new CfsmApiError(code || `HTTP ${response.status}`, { status: response.status, path });
    }
    try {
      return await response.json();
    } catch (error) {
      throw new CfsmApiError("响应不是合法 JSON", { status: response.status, path, cause: error });
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
  saveThemeOptions(themeOptions, { turnstileVerified = "" } = {}) {
    const headers = {};
    if (turnstileVerified) headers["X-Turnstile-Verified"] = turnstileVerified;
    // 注意 `request()` 的签名：额外请求参数要放在 `init` 里（顶层只认 query/timeout）
    return this.request(API_PATHS.themeOptions, {
      timeout: 20000,
      init: {
        method: "POST",
        headers,
        body: JSON.stringify({ theme_options: themeOptions }),
      },
    });
  }
}

export function createCfsmApi(options) {
  return new CfsmApi(options);
}

// 站点若开启全局 Turnstile，写接口需要额外校验头，本移植版不实现 → 只读降级。
export function isTurnstileBlocking(config) {
  return config?.turnstile_enabled === true;
}

// 轮询调度：默认 30 秒（可配置），页面不可见时暂停，恢复可见先立即拉一次；
// 连续失败按 2 的幂退避，上限 120 秒。`onTick` 抛错即视为失败。
export function createPoller({
  getIntervalSeconds,
  onTick,
  onError = null,
  target = typeof document === "undefined" ? null : document,
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
    if (target?.hidden) return; // 页面不可见：不排程，等 visibilitychange
    timer = setTimeout(() => void run(), delayFor(failed));
  };

  async function run() {
    clear();
    if (stopped || inFlight) return;
    if (target?.hidden) return;
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

  const onVisibilityChange = () => {
    if (stopped) return;
    if (target?.hidden) {
      clear();
      return;
    }
    void run();
  };

  return {
    start() {
      if (!stopped) return;
      stopped = false;
      backoffStep = 0;
      target?.addEventListener?.("visibilitychange", onVisibilityChange);
      if (!target?.hidden) schedule(false);
    },
    stop() {
      stopped = true;
      clear();
      target?.removeEventListener?.("visibilitychange", onVisibilityChange);
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
