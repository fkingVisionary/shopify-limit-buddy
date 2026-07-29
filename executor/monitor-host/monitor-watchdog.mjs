/**
 * Pure helpers: detect when the Bandai monitor poll loop has gone quiet.
 */

/**
 * @param {{
 *   running?: boolean,
 *   lastPollAt?: number|null,
 *   startedAt?: number|null,
 *   intervalMs?: number,
 *   now?: number,
 *   staleLimitMs?: number,
 * }} opts
 */
export function computeMonitorStale(opts = {}) {
  const now = Number(opts.now) || Date.now();
  const intervalMs = Math.max(2_000, Number(opts.intervalMs) || 5_000);
  const lastPollAt = opts.lastPollAt != null ? Number(opts.lastPollAt) : null;
  const startedAt = opts.startedAt != null ? Number(opts.startedAt) : null;
  const anchor = lastPollAt || startedAt || null;
  const staleMs = anchor != null ? Math.max(0, now - anchor) : null;
  // Default: 6 intervals, floor 2 min, ceil via env override.
  const staleLimitMs = Math.max(
    120_000,
    Number(opts.staleLimitMs) || intervalMs * 6,
  );
  const running = Boolean(opts.running);
  let reason = null;
  if (!running) reason = "not_running";
  else if (staleMs != null && staleMs > staleLimitMs) reason = "stale_poll";
  const healthy = reason == null;
  return {
    healthy,
    reason,
    staleMs,
    staleLimitMs,
    running,
    lastPollAt,
    startedAt,
    intervalMs,
  };
}

/**
 * @param {ReturnType<typeof computeMonitorStale>} stale
 * @param {{ expectRunning?: boolean }} [opts]
 */
export function shouldWatchdogRestart(stale, opts = {}) {
  const expectRunning = opts.expectRunning !== false;
  if (!expectRunning) return { restart: false, reason: null };
  if (!stale) return { restart: false, reason: null };
  if (stale.reason === "not_running") return { restart: true, reason: "not_running" };
  if (stale.reason === "stale_poll") return { restart: true, reason: "stale_poll" };
  return { restart: false, reason: null };
}
