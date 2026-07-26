// Task-local Bandai monitor — uses the task's own proxies + interval.
// Does not touch the global poll keyword set.

import { EventEmitter } from "node:events";
import { createBandaiStockMonitor } from "./bandai-stock-monitor.js";
import { createMonitorProxyPool } from "./monitor-proxy-pool.js";
import { parseTaskWatch } from "./event-filter.js";

/**
 * Build a local monitor instance for one task.
 * @param {object} task
 * @param {object} [opts]
 */
export function createTaskLocalMonitor(task, opts = {}) {
  const watch = parseTaskWatch(task);
  const keywords =
    watch.keywords.length > 0
      ? watch.keywords
      : watch.productIds.length > 0
        ? watch.productIds
        : [];
  if (!keywords.length) {
    throw new Error("local monitor needs keywords or productId/SKU");
  }

  const intervalMs = Math.max(
    2_000,
    Number(
      task.monitorIntervalMs ||
        task.bandaiMonitorIntervalMs ||
        task.intervalMs ||
        opts.intervalMs ||
        process.env.BANDAI_TASK_MONITOR_INTERVAL_MS,
    ) || 10_000,
  );
  const delayMs = Math.max(
    0,
    Number(task.monitorDelayMs || task.bandaiMonitorDelayMs || task.delayMs || opts.delayMs) || 0,
  );

  const proxyLines = normalizeProxyLines(
    task.proxies ||
      task.proxyList ||
      task.monitorProxies ||
      (task.proxy ? [task.proxy] : null) ||
      opts.proxies ||
      [],
  );
  if (!proxyLines.length) {
    throw new Error("local monitor needs task proxies");
  }

  // All task proxies treated as ISP tier for local (owner attached the group).
  const proxyPool = createMonitorProxyPool({
    ispRaw: proxyLines.join("\n"),
    dcRaw: "",
    ispRatio: 1,
    rotateMode: task.monitorRotate || "roundrobin",
    cooldownMs: Number(task.monitorCooldownMs) || 5 * 60_000,
  });

  const monitor = createBandaiStockMonitor({
    area: task.bandaiArea || task.area || "au",
    intervalMs,
    keywords,
    searchLimit: Number(task.monitorSearchLimit) || 40,
    stickyPolls: Number(task.monitorStickyPolls) || 3,
    proxyPool,
  });

  const bus = new EventEmitter();
  let started = false;

  monitor.on("stock_changed", (ev) => bus.emit("stock_changed", ev));
  monitor.on("poll", (s) => bus.emit("poll", s));
  monitor.on("error", (e) => bus.emit("error", e));
  monitor.on("started", (s) => bus.emit("started", s));
  monitor.on("stopped", (s) => bus.emit("stopped", s));

  async function start() {
    if (started) return;
    started = true;
    if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
    monitor.start();
  }

  async function stop() {
    started = false;
    await monitor.stop();
  }

  return {
    on: (...a) => bus.on(...a),
    off: (...a) => bus.off(...a),
    start,
    stop,
    pollOnce: () => monitor.pollOnce(),
    watch,
    intervalMs,
    delayMs,
    status: () => ({
      ...monitor.status(),
      watch,
      intervalMs,
      delayMs,
      mode: "local",
    }),
  };
}

function normalizeProxyLines(raw) {
  if (!raw) return [];
  if (typeof raw === "string") {
    return raw
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter((s) => s && !s.startsWith("#"));
  }
  if (Array.isArray(raw)) {
    return raw.map((s) => String(s || "").trim()).filter(Boolean);
  }
  return [];
}

export default { createTaskLocalMonitor };
