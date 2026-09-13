// CF-Server-Monitor → 原 Komari 数据模型的映射层（移植版的三张映射表）。
//
// 设计原则：把 CFSM 字段映射回原主题已经消费的模型（`node.*` 与 `state.statuses[uuid]`），
// 让 app.js 的视图/排序/聚合代码基本不动。三个必须写死、不能靠猜测的地方：
//   1. 方向交叉：原主题的 `net_in` 是"上传"、`net_out` 是"下载"（卡片上 ↑ net_in / ↓ net_out），
//      而 CFSM 的 `net_in_speed` 是下载、`net_out_speed` 是上传 → 必须交叉赋值。
//   2. 累计方向：累计上传 ← `net_tx`、累计下载 ← `net_rx`；当月口径用 `net_tx_monthly` / `net_rx_monthly`。
//   3. 单位：CFSM 的 ram/swap/disk 是 MB，原模型是字节 → ×1048576；`traffic_limit` 是 GB → ×1024³。
//
// 注意：CFSM 的 `/api/servers` 里几乎所有标量都是**字符串**（含 `"false"`、`"null"`），
// 因此本文件一律走显式解析，不做隐式转换。

const MEGABYTE = 1048576;
const GIGABYTE = 1024 ** 3;

// CFSM 没有 `status.online`；沿用 `last_updated` 5 分钟窗口判定在线。
export const ONLINE_WINDOW_MS = 5 * 60 * 1000;

// 三网 + BGP 线路：字段名来自 `/api/servers`，名称来自 `/api/config.sysConfig.custom_*_name`。
export const NET_LINES = Object.freeze([
  { id: "ct", pingKey: "ping_ct", lossKey: "loss_ct", nameKey: "custom_ct_name", fallbackName: "CT" },
  { id: "cu", pingKey: "ping_cu", lossKey: "loss_cu", nameKey: "custom_cu_name", fallbackName: "CU" },
  { id: "cm", pingKey: "ping_cm", lossKey: "loss_cm", nameKey: "custom_cm_name", fallbackName: "CM" },
  { id: "bd", pingKey: "ping_bd", lossKey: "loss_bd", nameKey: "custom_bd_name", fallbackName: "BGP" },
]);

// 站点自定义 ping 任务（本实例 4 条全部未启用，`ping_node_*` 恒为 "false"）。
export const NODE_LINES = Object.freeze(
  [1, 2, 3, 4].map(index => ({
    id: `node_${index}`,
    pingKey: `ping_node_${index}`,
    lossKey: `loss_node_${index}`,
    nameKey: `node_${index}_name`,
    fallbackName: `Ping ${index}`,
  })),
);

export const ALL_LINES = Object.freeze([...NET_LINES, ...NODE_LINES]);

export function isRecord(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

// "212" / 212 / "1.5" → 数值；"" / "false" / "null" / "abc" → null（不静默当 0，交给调用方决定）。
export function toNumber(value) {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string") return null;
  const text = value.trim();
  if (!text || text === "false" || text === "null" || text === "undefined") return null;
  const number = Number(text);
  return Number.isFinite(number) ? number : null;
}

// CFSM 用 "1"/"0" 表示开关，也可能是真布尔。
export function toBool(value) {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  if (typeof value !== "string") return false;
  const text = value.trim().toLowerCase();
  return text === "1" || text === "true" || text === "yes";
}

export function megabytesToBytes(value) {
  const number = toNumber(value);
  return number === null ? null : number * MEGABYTE;
}

export function gigabytesToBytes(value) {
  const number = toNumber(value);
  return number === null ? null : number * GIGABYTE;
}

// "0.00 0.02 0.00" → { load, load5, load15 }
export function splitLoadAvg(raw) {
  const text = typeof raw === "string" ? raw.trim() : "";
  if (!text) return { load: 0, load5: 0, load15: 0 };
  const parts = text.split(/\s+/).map(part => toNumber(part) ?? 0);
  return { load: parts[0] || 0, load5: parts[1] || 0, load15: parts[2] || 0 };
}

// gpu_info 三态：数组 / JSON 字符串 / 空串（本实例 12 台全空）。返回显卡名数组。
export function parseGpuInfo(raw) {
  if (Array.isArray(raw)) {
    return raw.map(entry => (isRecord(entry) ? String(entry.name ?? entry.model ?? entry.gpu ?? "") : String(entry ?? ""))).filter(Boolean);
  }
  if (typeof raw !== "string") return [];
  const text = raw.trim();
  if (!text) return [];
  if (text.startsWith("[") || text.startsWith("{")) {
    try {
      return parseGpuInfo(JSON.parse(text));
    } catch {
      return [text];
    }
  }
  return [text];
}

// `boot_time` 是毫秒字符串，可能是负值或非法（实例中曾出现 -5184000000）。
export function uptimeSecondsFromBootTime(bootTime, now = Date.now()) {
  const milliseconds = toNumber(bootTime);
  if (milliseconds === null || milliseconds <= 0) return null;
  const seconds = (now - milliseconds) / 1000;
  return Number.isFinite(seconds) && seconds >= 0 ? seconds : null;
}

export function resolveOnline(raw, now = Date.now(), windowMs = ONLINE_WINDOW_MS) {
  const updated = toNumber(raw?.last_updated);
  if (updated === null || updated <= 0) return false;
  return now - updated < windowMs;
}

export function lineDisplayName(line, sources) {
  for (const source of sources) {
    if (!isRecord(source)) continue;
    const name = source[line.nameKey];
    if (typeof name === "string" && name.trim()) return name.trim();
  }
  return line.fallbackName;
}

// 单条线路是否有可用数据：数值型且该线路确实在采集（CFSM 未配置的线路给 "false"）。
function lineSample(source, line) {
  const latest = toNumber(source?.[line.pingKey]);
  if (latest === null) return null;
  const loss = toNumber(source?.[line.lossKey]);
  return { latest, loss: loss === null ? 0 : loss };
}

// 原主题的 `status.ping` 是 `{ [taskId]: { name, latest, loss, avg, min, max } }`。
// 只有实际取到数值的线路才写入 → 未配置/全超时的线路自然不显示。
export function buildPingMap(raw, sources = [], window = null) {
  const ping = {};
  for (const line of ALL_LINES) {
    const sample = lineSample(raw, line);
    if (!sample) continue;
    const values = [];
    if (Array.isArray(window)) {
      for (const point of window) {
        const value = toNumber(point?.[line.id]);
        if (value !== null) values.push(value);
      }
    }
    if (!values.length) values.push(sample.latest);
    const min = Math.min(...values);
    const max = Math.max(...values);
    const avg = values.reduce((total, value) => total + value, 0) / values.length;
    ping[line.id] = {
      id: line.id,
      name: lineDisplayName(line, sources),
      latest: sample.latest,
      loss: sample.loss,
      avg,
      min,
      max,
      // 原主题用 `tail` 表示"尾部延迟"，CFSM 无对应指标，用窗口最大值兜底。
      tail: max,
      samples: values.length,
    };
  }
  return ping;
}

// 卡片/列表/抽屉共用的原始服务器条目（`/api/servers` 的元素，或 `/api/server?id=` 的响应）。
export function mapNode(raw) {
  if (!isRecord(raw)) return null;
  const id = typeof raw.id === "string" && raw.id ? raw.id : "";
  if (!id) return null;
  const gpus = parseGpuInfo(raw.gpu_info);
  const trafficLimitBytes = gigabytesToBytes(raw.traffic_limit);
  const updatedAt = toNumber(raw.last_updated);
  return {
    uuid: id,
    name: typeof raw.name === "string" && raw.name ? raw.name : id,
    group: typeof raw.server_group === "string" ? raw.server_group : "",
    region: typeof raw.region === "string" ? raw.region : "",
    tags: typeof raw.tags === "string" ? raw.tags : "",
    os: typeof raw.os === "string" ? raw.os : "",
    arch: typeof raw.arch === "string" ? raw.arch : "",
    kernel_version: typeof raw.kernel_version === "string" ? raw.kernel_version : "",
    cpu_name: typeof raw.cpu_info === "string" ? raw.cpu_info : "",
    cpu_cores: toNumber(raw.cpu_cores) ?? 0,
    gpu_name: gpus[0] || "",
    // CFSM 无数据源：虚拟化类型、IPv4/IPv6 地址文本、公开备注 → 不映射，交由视图隐藏。
    virtualization: null,
    ipv4: null,
    ipv6: null,
    public_remark: null,
    remark: null,
    mem_total: megabytesToBytes(raw.ram_total),
    swap_total: megabytesToBytes(raw.swap_total),
    disk_total: megabytesToBytes(raw.disk_total),
    // 排序沿用原主题的 `weight` 语义，但取值来自 CFSM 的 `sort_order`。
    weight: toNumber(raw.sort_order) ?? 0,
    hidden: toBool(raw.is_hidden),
    online: resolveOnline(raw),
    updated_at: updatedAt,
    // 原模型字段，保留空值以免下游 `node.traffic_limit` 判定出现 undefined 分支。
    traffic_limit: trafficLimitBytes,
    traffic_limit_type: typeof raw.traffic_calc_type === "string" ? raw.traffic_calc_type : "total",
    price: toNumber(raw.price),
    currency: typeof raw.currency === "string" ? raw.currency : "",
    billing_cycle: typeof raw.billing_cycle === "string" ? raw.billing_cycle : "",
    expired_at: typeof raw.expire_date === "string" ? raw.expire_date : "",
    auto_renewal: toBool(raw.auto_renewal),
    // 移植版专用：前缀 `cfsm`，避免与原模型键冲突。
    cfsm: {
      id,
      gpus,
      ipV4: typeof raw.ip_v4 === "string" ? raw.ip_v4 : "",
      ipV6: typeof raw.ip_v6 === "string" ? raw.ip_v6 : "",
      price: toNumber(raw.price),
      currency: typeof raw.currency === "string" ? raw.currency : "",
      billingCycle: typeof raw.billing_cycle === "string" ? raw.billing_cycle : "",
      autoRenewal: toBool(raw.auto_renewal),
      expireDate: typeof raw.expire_date === "string" ? raw.expire_date : "",
      trafficLimitGb: toNumber(raw.traffic_limit),
      trafficLimitBytes,
      trafficCalcType: typeof raw.traffic_calc_type === "string" ? raw.traffic_calc_type : "total",
      resetDay: toNumber(raw.reset_day),
      isHidden: toBool(raw.is_hidden),
      sortOrder: toNumber(raw.sort_order) ?? 0,
      collectInterval: toNumber(raw.collect_interval),
      reportInterval: toNumber(raw.report_interval),
      wssReportInterval: toNumber(raw.wss_report_interval),
      connectionMode: typeof raw.connection_mode === "string" ? raw.connection_mode : "",
      pingMode: typeof raw.ping_mode === "string" ? raw.ping_mode : "",
      agentVersion: typeof raw.agent_version === "string" ? raw.agent_version : "",
      historyPartitionId: toNumber(raw.history_partition_id),
      timestamp: toNumber(raw.timestamp),
    },
  };
}

export function mapStatus(raw, { sources = [], window = null, now = Date.now() } = {}) {
  if (!isRecord(raw)) return null;
  const load = splitLoadAvg(raw.load_avg);
  const bootUptime = uptimeSecondsFromBootTime(raw.boot_time, now);
  const tcp = toNumber(raw.tcp_conn) ?? 0;
  const udp = toNumber(raw.udp_conn) ?? 0;
  const updatedAt = toNumber(raw.last_updated);
  const netInSpeed = toNumber(raw.net_in_speed) ?? 0;
  const netOutSpeed = toNumber(raw.net_out_speed) ?? 0;
  const netRxMonthly = toNumber(raw.net_rx_monthly);
  const netTxMonthly = toNumber(raw.net_tx_monthly);
  const ping = buildPingMap(raw, sources, window);
  const status = {
    client: typeof raw.id === "string" ? raw.id : "",
    online: resolveOnline(raw, now),
    time: updatedAt,
    cpu: toNumber(raw.cpu) ?? 0,
    ram: megabytesToBytes(raw.ram_used) ?? 0,
    ram_total: megabytesToBytes(raw.ram_total) ?? 0,
    swap: megabytesToBytes(raw.swap_used) ?? 0,
    swap_total: megabytesToBytes(raw.swap_total) ?? 0,
    disk: megabytesToBytes(raw.disk_used) ?? 0,
    disk_total: megabytesToBytes(raw.disk_total) ?? 0,
    load: load.load,
    load5: load.load5,
    load15: load.load15,
    // 方向交叉（见文件头注释）：net_in = 上传 ← net_out_speed；net_out = 下载 ← net_in_speed。
    net_in: netOutSpeed,
    net_out: netInSpeed,
    // 累计口径＝当月：上行 ← net_tx_monthly，下行 ← net_rx_monthly。
    net_total_up: netTxMonthly ?? 0,
    net_total_down: netRxMonthly ?? 0,
    process: toNumber(raw.processes) ?? 0,
    connections: tcp + udp,
    connections_udp: udp,
    uptime: bootUptime ?? 0,
    message: "",
    ping,
    // 移植版专用：全时累计（出站/入站）、当月累计原值、三网线路原始值、磁盘 IO、更新时间。
    cfsm_net_rx: toNumber(raw.net_rx) ?? 0,
    cfsm_net_tx: toNumber(raw.net_tx) ?? 0,
    cfsm_net_rx_monthly: netRxMonthly ?? 0,
    cfsm_net_tx_monthly: netTxMonthly ?? 0,
    cfsm_line_values: Object.fromEntries(
      ALL_LINES.map(line => [line.id, { latest: toNumber(raw[line.pingKey]), loss: toNumber(raw[line.lossKey]) }]),
    ),
    cfsm_disk: isRecord(raw.disk) ? { ...raw.disk } : null,
    cfsm_updated: updatedAt,
    cfsm_boot_time: toNumber(raw.boot_time),
  };
  return status;
}

// `/api/servers` 整体映射：nodes（原模型）+ statuses（原模型）+ sysConfig + stats。
export function mapServers(payload, { config = null, now = Date.now() } = {}) {
  const servers = Array.isArray(payload?.servers) ? payload.servers : [];
  const sysConfig = isRecord(payload?.sysConfig) ? payload.sysConfig : {};
  const sources = [sysConfig, config];
  const nodes = [];
  const statuses = {};
  for (const raw of servers) {
    const node = mapNode(raw);
    if (!node) continue;
    nodes.push(node);
    const status = mapStatus(raw, { sources, window: Array.isArray(raw.ping) ? raw.ping : null, now });
    if (status) statuses[node.uuid] = status;
    // 三网窗口序列（仅列表接口返回）供面板使用。
    node.cfsm.latencyWindow = Array.isArray(raw.ping) ? raw.ping : [];
    node.cfsm.latencyWindowPoints = toNumber(sysConfig?.latency_window?.points);
    node.cfsm.latencyWindowHours = toNumber(sysConfig?.latency_window?.hours);
  }
  return { nodes, statuses, sysConfig, stats: isRecord(payload?.stats) ? payload.stats : null, sources };
}

// 线路名集合（面板与抽屉共用）。
export function resolveLineNames(config, sysConfig) {
  return ALL_LINES.map(line => ({ ...line, name: lineDisplayName(line, [sysConfig, config]) }));
}

// `/api/history/all` 的一行 → 原主题"近期记录"模型（normalizeRecentRecords 消费的字段）。
export function mapHistoryRow(row, { node, status = null, sources = [], now = Date.now() } = {}) {
  if (!isRecord(row) || !node) return null;
  const timestamp = toNumber(row.timestamp);
  if (timestamp === null) return null;
  const tcp = toNumber(row.tcp_conn) ?? 0;
  const udp = toNumber(row.udp_conn) ?? 0;
  const currentUptime = toNumber(status?.uptime) ?? 0;
  const elapsed = Math.max(0, (now - timestamp) / 1000);
  return {
    client: node.uuid,
    time: new Date(timestamp).toISOString(),
    cpu: toNumber(row.cpu) ?? 0,
    ram: megabytesToBytes(row.ram_used) ?? 0,
    ram_total: megabytesToBytes(row.ram_total) ?? 0,
    swap: megabytesToBytes(row.swap_used) ?? 0,
    swap_total: megabytesToBytes(row.swap_total) ?? 0,
    disk: megabytesToBytes(row.disk_used) ?? 0,
    disk_total: megabytesToBytes(row.disk_total) ?? 0,
    ...splitLoadAvg(row.load_avg),
    net_in: toNumber(row.net_out_speed) ?? 0,
    net_out: toNumber(row.net_in_speed) ?? 0,
    net_total_up: toNumber(status?.net_total_up) ?? 0,
    net_total_down: toNumber(status?.net_total_down) ?? 0,
    process: toNumber(row.processes) ?? 0,
    connections: tcp + udp,
    connections_udp: udp,
    // 历史行没有 boot_time，用当前 uptime 减采样间隔回推。
    uptime: Math.max(0, currentUptime - elapsed),
    ping: buildPingMap(row, sources, null),
    message: "",
  };
}

export function mapHistoryRows(rows, options = {}) {
  if (!Array.isArray(rows)) return [];
  return rows
    .map(row => mapHistoryRow(row, options))
    .filter(Boolean)
    .sort((a, b) => new Date(a.time) - new Date(b.time));
}

const TRAFFIC_CALC_TYPES = new Set(["total", "dl", "ul", "max"]);

// 当月已用量（字节）。四分支口径，与 CFSM 内置主题一致；reset_day 不参与计算。
export function monthlyUsedBytes(raw, calcType = "total") {
  const rx = toNumber(raw?.net_rx_monthly) ?? 0;
  const tx = toNumber(raw?.net_tx_monthly) ?? 0;
  switch (TRAFFIC_CALC_TYPES.has(calcType) ? calcType : "total") {
    case "dl":
      return rx;
    case "ul":
      return tx;
    case "max":
      return Math.max(rx, tx);
    case "total":
    default:
      return rx + tx;
  }
}

// 剩余流量：`traffic_limit` 单位 GB（实例中可能是空字符串 → 降级）。
export function remainingTraffic(raw) {
  const limitGb = toNumber(raw?.traffic_limit);
  const calcType = typeof raw?.traffic_calc_type === "string" ? raw.traffic_calc_type : "total";
  const usedBytes = monthlyUsedBytes(raw, calcType);
  const resetDay = toNumber(raw?.reset_day);
  if (limitGb === null || limitGb <= 0) {
    return { degraded: true, limitBytes: null, usedBytes, remainingBytes: null, percent: null, calcType, resetDay };
  }
  const limitBytes = limitGb * GIGABYTE;
  return {
    degraded: false,
    limitBytes,
    usedBytes,
    remainingBytes: Math.max(0, limitBytes - usedBytes),
    // 允许超过 100%（超量是真实状态，UI 自行决定配色阈值）。
    percent: usedBytes / limitBytes * 100,
    calcType,
    resetDay,
  };
}

// 24 小时累计曲线：对速率序列做梯形积分，再按当前累计总量缩放（原主题做法）。
export function integratedTrafficSeries(records, { targetUp = 0, targetDown = 0 } = {}) {
  if (!Array.isArray(records) || records.length === 0) return [];
  const points = records
    .map(record => ({ time: new Date(record.time).getTime(), up: toNumber(record.net_in) ?? 0, down: toNumber(record.net_out) ?? 0 }))
    .filter(point => Number.isFinite(point.time))
    .sort((a, b) => a.time - b.time);
  if (points.length === 0) return [];

  let upRaw = 0;
  let downRaw = 0;
  const series = points.map((point, index) => {
    if (index > 0) {
      const seconds = Math.max(0, (point.time - points[index - 1].time) / 1000);
      upRaw += (point.up + points[index - 1].up) / 2 * seconds;
      downRaw += (point.down + points[index - 1].down) / 2 * seconds;
    }
    return { time: point.time, upRaw, downRaw };
  });

  const upScale = upRaw > 0 && targetUp > 0 ? targetUp / upRaw : 1;
  const downScale = downRaw > 0 && targetDown > 0 ? targetDown / downRaw : 1;

  return series.map(point => ({
    time: point.time,
    // up = 上传累计（net_tx），down = 下载累计（net_rx）
    up: point.upRaw * upScale,
    down: point.downRaw * downScale,
  }));
}

export const UNITS = Object.freeze({ MEGABYTE, GIGABYTE });
