// Desktop Watchdog — Railway stock_changed → auto-start matching Autocheckout tasks.
// Complements Monitor-mode "checkout on hit" (which switches a Monitor task).
// This path arms idle Bandai Autocheckout lanes that already have a PDP/SKU watch.

const {
  parseWatch,
  eventMatchesWatch,
} = require("./bandai-global-monitor-client.cjs");
const { taskForMonitorCheckout } = require("./bandai-monitor-checkout.cjs");

const BUSY_STATUSES = new Set(["queued", "running"]);

/**
 * Global kill-switch (Settings). Default on.
 */
function isWatchdogEnabled(settings = {}) {
  return settings.desktopWatchdogEnabled !== false;
}

/**
 * Per-task opt-out. Default on for Bandai Autocheckout.
 */
function taskWatchdogArmed(task = {}) {
  if (task.bandaiWatchdog === false || task.watchdog === false) return false;
  return true;
}

/**
 * Idle Bandai Autocheckout tasks that match this hit.
 * Does not include Monitor tasks (those use the existing checkout-on-hit path).
 */
function listWatchdogCheckoutTasks(tasks = [], hit = {}, settings = {}) {
  if (!isWatchdogEnabled(settings)) return [];
  if (!hit?.productId) return [];
  if (hit.inStock === false) return [];

  return (Array.isArray(tasks) ? tasks : []).filter((t) => {
    if (!t || t.enabled === false) return false;
    if (String(t.store || "") !== "bandai") return false;
    const mode = String(t.bandaiMode || "checkout").toLowerCase();
    if (mode !== "checkout") return false;
    if (!taskWatchdogArmed(t)) return false;
    if (BUSY_STATUSES.has(String(t.lastStatus || "").toLowerCase())) return false;
    const watch = parseWatch(t);
    if (!watch.productIds.length && !watch.keywords.length) return false;
    return eventMatchesWatch(hit, watch);
  });
}

/**
 * Build a checkout job task from an Autocheckout row + monitor hit
 * (stamps PDP / NAI from the hit without mutating the DB row).
 */
function checkoutTaskFromWatchdogHit(task, hit) {
  return taskForMonitorCheckout(task, hit, task?.bandaiArea || "au");
}

/**
 * Per taskId+productId cooldown so SSE reconnect / flapping restocks
 * don't spam the queue. `cooldownMs` is mutable via the returned object.
 */
function createWatchdogCooldown(opts = {}) {
  const state = {
    cooldownMs: Math.max(
      5_000,
      Number(opts.cooldownMs ?? opts.defaultCooldownMs) || 60_000,
    ),
  };
  /** @type {Map<string, number>} */
  const last = new Map();

  function key(taskId, productId) {
    return `${taskId}::${String(productId || "").toUpperCase()}`;
  }

  function tryClaim(taskId, productId, now = Date.now()) {
    const windowMs = state.cooldownMs;
    const k = key(taskId, productId);
    const prev = last.get(k) || 0;
    if (now - prev < windowMs) return false;
    last.set(k, now);
    // Bound map growth
    if (last.size > 500) {
      const cutoff = now - windowMs * 2;
      for (const [kk, ts] of last) {
        if (ts < cutoff) last.delete(kk);
      }
    }
    return true;
  }

  function reset() {
    last.clear();
  }

  function setCooldownMs(ms) {
    state.cooldownMs = Math.max(5_000, Number(ms) || 60_000);
  }

  return {
    tryClaim,
    reset,
    setCooldownMs,
    get cooldownMs() {
      return state.cooldownMs;
    },
    set cooldownMs(ms) {
      setCooldownMs(ms);
    },
  };
}

/**
 * Pure planner: which tasks to fire for this hit (after cooldown).
 */
function planWatchdogStarts({
  tasks,
  hit,
  settings,
  cooldown,
} = {}) {
  const matched = listWatchdogCheckoutTasks(tasks, hit, settings);
  const starts = [];
  for (const task of matched) {
    if (cooldown && !cooldown.tryClaim(task.id, hit.productId)) continue;
    const switched = checkoutTaskFromWatchdogHit(task, hit);
    if (!switched.ok) continue;
    starts.push({
      taskId: task.id,
      label: task.label || task.id,
      productId: hit.productId,
      checkoutTask: switched.task,
      target: switched.target,
    });
  }
  return starts;
}

module.exports = {
  isWatchdogEnabled,
  taskWatchdogArmed,
  listWatchdogCheckoutTasks,
  checkoutTaskFromWatchdogHit,
  createWatchdogCooldown,
  planWatchdogStarts,
  parseWatch,
  eventMatchesWatch,
};
