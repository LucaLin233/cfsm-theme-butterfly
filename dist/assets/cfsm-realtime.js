// CF-Server-Monitor 实时链路（`/api/ws`）协议层。
//
// 分工：本模块只做协议与状态机（URL 构造、消息解析、ids 校验、增量合并、连接状态机），
// 不碰 DOM 与全局状态；编排（何时建连、何时降级轮询）在 app.js。
// 依据：官方 `theme-develop.md` 与 `API.md`（v2.8.5）——`subscribe=all` 默认不推送，
// 必须显式发送 `{type:"subscribe", scope:"all", ids}`；非法 scope/ids 以关闭码 1008 断开。
import { mapStatus } from "./cfsm-map.js?v=0.9.1";

// 服务端约束（API.md）：ids ≤ 500 个，单个 id 长度 1–64，字符集 [A-Za-z0-9._:-]。
export const REALTIME_LIMITS = Object.freeze({
  maxIds: 500,
  minIdLength: 1,
  maxIdLength: 64,
  idPattern: /^[A-Za-z0-9._:-]+$/,
});

export const DEFAULT_SUBSCRIBE_SCOPE = "all";

// status 字段 ← 原始样本键。样本只带自己有的键，因此合并时**只更新样本确实提供的字段**，
// 缺失键一律沿用旧值（服务端的实时样本不是完整报告）。
const FIELD_SOURCES = Object.freeze({
  client: ["id"],
  cpu: ["cpu"],
  ram: ["ram_used"],
  ram_total: ["ram_total"],
  swap: ["swap_used"],
  swap_total: ["swap_total"],
  disk: ["disk_used"],
  disk_total: ["disk_total"],
  load: ["load_avg"],
  load5: ["load_avg"],
  load15: ["load_avg"],
  // 方向交叉见 cfsm-map.js 文件头：net_in = 上传 ← net_out_speed。
  net_in: ["net_out_speed"],
  net_out: ["net_in_speed"],
  net_total_up: ["net_tx_monthly"],
  net_total_down: ["net_rx_monthly"],
  process: ["processes"],
  connections: ["tcp_conn", "udp_conn"],
  connections_udp: ["udp_conn"],
  uptime: ["boot_time"],
  ping: ["ping"],
  cfsm_net_rx: ["net_rx"],
  cfsm_net_tx: ["net_tx"],
  cfsm_net_rx_monthly: ["net_rx_monthly"],
  cfsm_net_tx_monthly: ["net_tx_monthly"],
  cfsm_disk: ["disk"],
  cfsm_boot_time: ["boot_time"],
});

// 报告级字段（随周期性报告上报，可能不在每个实时样本里）：样本未提供时必须保留旧值，
// 绝不能因为"这个样本里没有"就当作已清除。
const REPORT_LEVEL_SOURCES = Object.freeze({
  ping: ["ping"],
  cfsm_disk: ["disk"],
  disk: ["disk_used"],
  disk_total: ["disk_total"],
  ram_total: ["ram_total"],
  swap_total: ["swap_total"],
  uptime: ["boot_time"],
  cfsm_boot_time: ["boot_time"],
});
const LINE_SOURCES = Object.freeze(["ping_", "loss_"]);

// 报告级字段分组：同一次上报的尾部样本里一起出现，因此按组维护"最后出现时间"。
// 分组的意义在于**逐组过期**——某一组持续出现不得延长其它长期缺失组的有效期。
// 键名以 `_` 结尾表示前缀匹配（探针字段是 ping_ct/ping_cu/... 这类），否则严格相等
// （`disk` 是 IO 明细对象，不能被 `disk_used` 命中）。
export const REPORT_FIELD_GROUPS = Object.freeze({
  line: Object.freeze(["ping_", "loss_"]),
  disk: Object.freeze(["disk_used", "disk_total"]),
  io: Object.freeze(["disk"]),
  memory: Object.freeze(["ram_total", "swap_total"]),
  boot: Object.freeze(["boot_time"]),
  metrics: Object.freeze(["processes", "tcp_conn", "udp_conn", "load_avg"]),
});

// 严格按 `_` 后缀约定匹配：前缀键看 startsWith，普通键要求完全相等。
function matchesReportKey(data, keys) {
  for (const key of Object.keys(data)) {
    for (const candidate of keys) {
      if (candidate.endsWith("_") ? key.startsWith(candidate) : key === candidate) return true;
    }
  }
  return false;
}

function seenReportGroups(data) {
  const seen = [];
  for (const [group, keys] of Object.entries(REPORT_FIELD_GROUPS)) {
    if (matchesReportKey(data, keys)) seen.push(group);
  }
  return seen;
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasAnyKey(data, keys) {
  for (const key of Object.keys(data)) {
    for (const prefix of keys) {
      if (key === prefix || key.startsWith(prefix)) return true;
    }
  }
  return false;
}

// 校验订阅 id 列表：去重、逐条校验长度与字符集，超限即判定为非法（服务端会以 1008 断开）。
export function normalizeIds(input) {
  const list = Array.isArray(input) ? input : [];
  const ids = [];
  const seen = new Set();
  const rejected = [];
  for (const raw of list) {
    const id = typeof raw === "string" ? raw : "";
    if (!id || id.length < REALTIME_LIMITS.minIdLength || id.length > REALTIME_LIMITS.maxIdLength || !REALTIME_LIMITS.idPattern.test(id)) {
      if (id) rejected.push(id);
      continue;
    }
    if (seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }
  const overflow = ids.length > REALTIME_LIMITS.maxIds;
  return {
    ok: !overflow && rejected.length === 0,
    ids: overflow ? ids.slice(0, REALTIME_LIMITS.maxIds) : ids,
    rejected,
    overflow,
  };
}

// `/api/ws?subscribe=...`：同源走页面协议（https→wss）。
// **凭据只在 host 不同时才进 URL**（与官方 API.md 示例一致）：
// - 公开站点（`is_public === 'true'`）的 `/api/ws` 完全不校验身份，附 token 毫无收益；
// - 私有站点同源握手由浏览器自动携带 `cfsm_auth` Cookie（HttpOnly 只阻止脚本读取，不阻止浏览器发送）；
// - token 进入 URL 会随请求进入平台日志链路，把长期凭据放到不该出现的位置。
// 代价（已知边界）：私有站点若 Cookie 缺失/过期但 localStorage JWT 仍有效，WS 得不到授权 →
// 连接失败并走既有的降级轮询；改动前本身没有 WS，不构成回归。
export function buildWsUrl(base, { subscribe = DEFAULT_SUBSCRIBE_SCOPE, token = "" } = {}) {
  const fallback = typeof location === "undefined" ? "http://localhost" : location.origin;
  const url = new URL("/api/ws", base || fallback);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  if (subscribe) url.searchParams.set("subscribe", subscribe);
  const sameHost = typeof location === "undefined" || url.host === location.host;
  if (token && !sameHost) url.searchParams.set("token", token);
  return url.toString();
}

// 服务端消息：`hello` / `subscribed` / `batchUpdate` / `pong`。
export function parseRealtimeMessage(raw) {
  if (isRecord(raw)) return raw;
  if (typeof raw !== "string" || !raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function samplePayload(sample) {
  if (!isRecord(sample)) return null;
  for (const key of ["data", "payload", "metrics"]) {
    const value = sample[key];
    if (isRecord(value)) return value;
    if (typeof value === "string" && value) {
      try {
        const parsed = JSON.parse(value);
        if (isRecord(parsed)) return parsed;
      } catch {
        // 非 JSON 的字段值：继续尝试下一个候选键
      }
    }
  }
  return null;
}

// `{type:"batchUpdate", ts, updates:[{serverId, samples:[{ts, data}]}]}` → 扁平样本列表。
export function extractSamples(message) {
  const parsed = parseRealtimeMessage(message);
  if (!parsed || parsed.type !== "batchUpdate" || !Array.isArray(parsed.updates)) return [];
  const samples = [];
  for (const update of parsed.updates) {
    if (!isRecord(update)) continue;
    const serverId = typeof update.serverId === "string" ? update.serverId : "";
    if (!serverId || !Array.isArray(update.samples)) continue;
    for (const sample of update.samples) {
      const data = samplePayload(sample);
      if (!data) continue;
      const ts = Number(sample?.ts);
      samples.push({ serverId, ts: Number.isFinite(ts) && ts > 0 ? ts : null, data });
    }
  }
  return samples;
}

function mergeLineValues(previous, incoming) {
  const merged = { ...(previous || {}) };
  for (const [lineId, value] of Object.entries(incoming || {})) {
    if (!isRecord(value)) continue;
    const patch = {};
    for (const [key, item] of Object.entries(value)) {
      if (item !== null && item !== undefined) patch[key] = item;
    }
    merged[lineId] = { ...(merged[lineId] || {}), ...patch };
  }
  return merged;
}

// 把一个实时样本合并进已有 status：样本提供的字段更新，未提供的沿用旧值。
// 首次（无旧值）时直接采用 mapStatus 的结果。
export function mergeStatusUpdate(previous, data, { sources = [], now = Date.now(), id = "" } = {}) {
  if (!isRecord(data)) return previous || null;
  const rawId = typeof data.id === "string" && data.id ? data.id : id || previous?.client || "";
  if (!rawId) return previous || null;
  const incoming = mapStatus({ id: rawId, ...data }, { sources, now });
  if (!incoming) return previous || null;
  if (!previous) {
    const reportKeys = Object.values(REPORT_LEVEL_SOURCES).flat().concat(LINE_SOURCES);
    const hasReport = matchesReportKey(data, reportKeys);
    const seen = seenReportGroups(data);
    const created = {
      ...incoming,
      cfsm_report_at: hasReport ? now : 0,
      cfsm_report_seen: seen.length ? Object.fromEntries(seen.map(group => [group, now])) : {},
    };
    // 收到实时样本即在线证据：样本不带时间字段时不要被判离线。
    const hasTimestamp = Number.isFinite(Number(data.last_updated)) || Number.isFinite(Number(data.timestamp));
    if (!hasTimestamp) created.online = true;
    if (incoming.time === null) created.time = now;
    if (incoming.cfsm_updated === null) created.cfsm_updated = now;
    return created;
  }

  const merged = { ...incoming };
  for (const [field, keys] of Object.entries(FIELD_SOURCES)) {
    if (!hasAnyKey(data, keys)) merged[field] = previous[field];
  }
  for (const [field, keys] of Object.entries(REPORT_LEVEL_SOURCES)) {
    if (!matchesReportKey(data, keys)) merged[field] = previous[field];
  }
  merged.cfsm_line_values = hasAnyKey(data, LINE_SOURCES)
    ? mergeLineValues(previous.cfsm_line_values, incoming.cfsm_line_values)
    : previous.cfsm_line_values;

  // 收到实时样本本身就是在线证据：样本不带 last_updated 时不要因缺字段被判离线。
  const hasTimestamp = Number.isFinite(Number(data.last_updated)) || Number.isFinite(Number(data.timestamp));
  merged.online = hasTimestamp ? incoming.online : true;

  const sampleTime = Number(data.last_updated ?? data.timestamp);
  merged.time = Number.isFinite(sampleTime) && sampleTime > 0 ? sampleTime : previous.time ?? null;
  merged.cfsm_updated = merged.time;
  const reportKeys = Object.values(REPORT_LEVEL_SOURCES).flat().concat(LINE_SOURCES);
  merged.cfsm_report_at = matchesReportKey(data, reportKeys) ? now : previous.cfsm_report_at || 0;
  // 逐组刷新：只更新本次确实出现的组，其余组沿用旧时间（互不延长有效期）
  const seenGroups = seenReportGroups(data);
  merged.cfsm_report_seen = { ...(previous.cfsm_report_seen || {}) };
  for (const group of seenGroups) merged.cfsm_report_seen[group] = now;
  if (!Object.keys(merged.cfsm_report_seen).length) delete merged.cfsm_report_seen;
  return merged;
}

// 报告级字段过期判定：超过 staleAfter 未再出现即视为「未知」（调用方决定如何展示）。
// 分组级过期：某一组从未出现过（时间戳缺失）→ 不判过期，避免把"服务端从不提供"误标为"已过期"。
export function isReportGroupStale(status, group, { now = Date.now(), staleAfterMs = 0 } = {}) {
  if (!staleAfterMs || !group) return false;
  const at = Number(status?.cfsm_report_seen?.[group]);
  if (!Number.isFinite(at) || at <= 0) return false;
  return now - at > staleAfterMs;
}

export function isReportStale(status, { now = Date.now(), staleAfterMs = 0 } = {}) {
  if (!staleAfterMs) return false;
  const at = Number(status?.cfsm_report_at);
  if (!Number.isFinite(at) || at <= 0) return false;
  return now - at > staleAfterMs;
}

// 连接状态机：idle → connecting → socket-open → subscription-pending → live；
// 异常关闭按指数退避重连（1s → 30s，±20% 抖动），关闭码 1008（非法 scope/ids）为终止态。
// `subscribeScope` 传 `null` 表示订阅消息不带 `scope`（沿用 URL 的 `subscribe`，用于单机订阅）。
export function createRealtimeChannel({
  url,
  WebSocketCtor = typeof WebSocket === "undefined" ? null : WebSocket,
  onMessage = null,
  onStateChange = null,
  subscribeScope = DEFAULT_SUBSCRIBE_SCOPE,
  subscribeTimeoutMs = 8000,
  // 按需心跳：进入 live 后若这段时间没有任何服务端消息才发一次 `{type:"ping"}`。
  // 服务端按合并窗口推送（约 5 秒），正常情况下永远轮不到它；只在长静默连接上保活。
  pingIdleMs = 60000,
  backoffMinMs = 1000,
  backoffMaxMs = 30000,
  random = Math.random,
  setTimeoutImpl = (fn, ms) => setTimeout(fn, ms),
  clearTimeoutImpl = (handle) => clearTimeout(handle),
} = {}) {
  let socket = null;
  let state = "idle";
  let attempt = 0;
  let reconnectTimer = null;
  let subscribeTimer = null;
  let idleTimer = null;
  let stopped = true;
  let ids = [];
  let fatalCode = 0;

  const emit = (next, extra = {}) => {
    state = next;
    onStateChange?.({ state: next, ...extra });
  };

  const clearSubscribeTimer = () => {
    if (subscribeTimer !== null) {
      clearTimeoutImpl(subscribeTimer);
      subscribeTimer = null;
    }
  };

  const clearIdlePing = () => {
    if (idleTimer !== null) {
      clearTimeoutImpl(idleTimer);
      idleTimer = null;
    }
  };

  // 「按需」= 只在 live 且长时间没有收到任何消息时才发 ping；收到任何消息都会重置计时。
  const scheduleIdlePing = () => {
    clearIdlePing();
    if (!pingIdleMs || stopped || state !== "live") return;
    idleTimer = setTimeoutImpl(() => {
      idleTimer = null;
      if (stopped || state !== "live") return;
      send({ type: "ping" });
      scheduleIdlePing();
    }, pingIdleMs);
  };

  const send = (payload) => {
    if (!socket || socket.readyState !== 1) return false;
    try {
      socket.send(JSON.stringify(payload));
      return true;
    } catch {
      return false;
    }
  };

  const sendSubscribe = () => {
    emit("subscription-pending");
    // `subscribeScope: null` = 订阅消息不带 `scope` 键：服务端 `_getSubscribeScope` 会沿用 URL 中的
    // `subscribe`（单机模式即 subscribed=<serverId>），这正是 `subscribe=<serverId>` 模式要求的形态。
    // 显式传 scope="all" 会把该连接改回全量过滤，ids 为空时一条推送都收不到。
    const payload = { type: "subscribe", ids };
    if (typeof subscribeScope === "string" && subscribeScope) payload.scope = subscribeScope;
    send(payload);
    clearSubscribeTimer();
    subscribeTimer = setTimeoutImpl(() => {
      subscribeTimer = null;
      if (stopped || state === "live") return;
      // 订阅确认超时：当作本次连接失败，走退避重连。
      try {
        socket?.close(4000);
      } catch {
        // 关闭失败时由 onclose 兜底
      }
    }, subscribeTimeoutMs);
  };

  const scheduleReconnect = (code = 0) => {
    attempt += 1;
    const step = Math.min(attempt - 1, 6);
    const capped = Math.min(backoffMinMs * 2 ** step, backoffMaxMs);
    const delay = Math.round(capped * (0.8 + random() * 0.4));
    emit("closed", { attempt, code });
    reconnectTimer = setTimeoutImpl(() => {
      reconnectTimer = null;
      connect();
    }, delay);
  };

  function connect() {
    if (stopped) return;
    if (!WebSocketCtor) {
      emit("fatal", { reason: "unsupported", code: 0 });
      return;
    }
    emit("connecting", { attempt });
    let ws;
    try {
      ws = new WebSocketCtor(url);
    } catch (error) {
      scheduleReconnect(0);
      return;
    }
    socket = ws;
    ws.onopen = () => {
      if (stopped) {
        try {
          ws.close();
        } catch {
          // 忽略
        }
        return;
      }
      emit("socket-open");
      sendSubscribe();
    };
    ws.onmessage = (event) => {
      const message = parseRealtimeMessage(event?.data);
      if (!message) return;
      // 任何服务端消息（含 pong）都算活动：重置按需心跳
      scheduleIdlePing();
      if (message.type === "subscribed") {
        clearSubscribeTimer();
        attempt = 0;
        emit("live");
        scheduleIdlePing();
        return;
      }
      // 只透传增量批次：其余（hello / pong 等）由本模块自行消化。
      if (message.type === "batchUpdate") onMessage?.(message);
    };
    ws.onerror = () => {
      // 具体原因由随后的 onclose 给出（浏览器不暴露 HTTP 状态码）。
    };
    ws.onclose = (event) => {
      clearSubscribeTimer();
      socket = null;
      if (stopped) {
        emit("idle");
        return;
      }
      const code = Number(event?.code) || 0;
      if (code === 1008) {
        fatalCode = code;
        emit("fatal", { code, reason: "invalid-subscription" });
        return;
      }
      scheduleReconnect(code);
    };
  }

  return {
    start(nextIds) {
      if (Array.isArray(nextIds)) ids = nextIds;
      if (!stopped) return;
      stopped = false;
      attempt = 0;
      connect();
    },
    stop() {
      const wasRunning = !stopped;
      stopped = true;
      clearSubscribeTimer();
      clearIdlePing();
      if (reconnectTimer !== null) {
        clearTimeoutImpl(reconnectTimer);
        reconnectTimer = null;
      }
      const ws = socket;
      socket = null;
      if (ws) {
        try {
          ws.onclose = null;
          ws.onerror = null;
          ws.close(1000);
        } catch {
          // 忽略
        }
      }
      // 幂等：重复 stop 不再触发状态回调。
      if (!wasRunning) return;
      emit("idle", { reason: "stopped" });
    },
    // 快照更新后在同一连接上重发订阅（服务端按连接维护订阅集合）。
    setIds(nextIds) {
      ids = Array.isArray(nextIds) ? nextIds : [];
      if (socket && socket.readyState === 1) sendSubscribe();
    },
    getIds() {
      return [...ids];
    },
    isLive() {
      return state === "live";
    },
    get state() {
      return state;
    },
    get attempt() {
      return attempt;
    },
    get fatalCode() {
      return fatalCode;
    },
  };
}
