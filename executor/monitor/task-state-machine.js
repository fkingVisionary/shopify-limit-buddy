// Bandai monitor task state machine — independent of checkout internals.
// V1: usable in-process; desktop task wiring comes later.
//
// States: idle → monitoring → triggered → checking_out → success | failed

const STATES = Object.freeze([
  "idle",
  "monitoring",
  "triggered",
  "checking_out",
  "success",
  "failed",
]);

const TRANSITIONS = Object.freeze({
  idle: ["monitoring", "idle"],
  monitoring: ["triggered", "idle", "failed"],
  triggered: ["checking_out", "failed", "idle"],
  checking_out: ["success", "failed"],
  success: ["idle", "monitoring"],
  failed: ["idle", "monitoring"],
});

/**
 * @param {object} [opts]
 */
export function createTaskStateMachine(opts = {}) {
  /** @type {Map<string, object>} */
  const tasks = new Map();
  /** @type {Array<object>} */
  const log = [];
  const maxLog = Number(opts.maxLog) || 2_000;

  function record(taskId, from, to, note) {
    const row = {
      at: Date.now(),
      taskId,
      from,
      to,
      note: note || null,
    };
    log.push(row);
    if (log.length > maxLog) log.splice(0, log.length - maxLog);
    opts.onTransition?.(row);
    return row;
  }

  function get(taskId) {
    return tasks.get(String(taskId)) || null;
  }

  function upsert(task) {
    const id = String(task.taskId || task.id || "");
    if (!id) throw new Error("taskId required");
    const productId = String(task.productId || task.productCode || "").trim();
    const prev = tasks.get(id);
    const row = {
      taskId: id,
      productId,
      status: prev?.status || "idle",
      createdAt: prev?.createdAt || Date.now(),
      updatedAt: Date.now(),
      meta: { ...(prev?.meta || {}), ...(task.meta || {}) },
    };
    tasks.set(id, row);
    return row;
  }

  function transition(taskId, to, note) {
    const id = String(taskId);
    const row = tasks.get(id);
    if (!row) throw new Error(`unknown_task:${id}`);
    const toState = String(to);
    if (!STATES.includes(toState)) throw new Error(`invalid_state:${toState}`);
    const allowed = TRANSITIONS[row.status] || [];
    if (!allowed.includes(toState)) {
      throw new Error(`bad_transition:${row.status}→${toState}`);
    }
    const from = row.status;
    row.status = toState;
    row.updatedAt = Date.now();
    record(id, from, toState, note);
    return row;
  }

  function startMonitoring(taskId, productId) {
    const id = String(taskId);
    if (!tasks.has(id)) {
      upsert({ taskId: id, productId });
    } else if (productId) {
      tasks.get(id).productId = String(productId);
    }
    const row = tasks.get(id);
    if (row.status === "idle" || row.status === "success" || row.status === "failed") {
      return transition(id, "monitoring", productId ? `watch ${productId}` : "watch");
    }
    if (row.status === "monitoring") return row;
    throw new Error(`cannot_monitor_from:${row.status}`);
  }

  function listMonitoring(productId) {
    const pid = productId != null ? String(productId) : null;
    return [...tasks.values()].filter((t) => {
      if (t.status !== "monitoring") return false;
      if (!pid) return true;
      if (t.productId && t.productId === pid) return true;
      // Keyword watches store first keyword as productId placeholder — also
      // match via meta.watch.productIds when present.
      const ids = t.meta?.watch?.productIds || [];
      const up = pid.toUpperCase();
      return ids.some((id) => String(id).toUpperCase() === up);
    });
  }

  function all() {
    return [...tasks.values()];
  }

  function transitions() {
    return log.slice();
  }

  return {
    STATES,
    upsert,
    get,
    transition,
    startMonitoring,
    listMonitoring,
    all,
    transitions,
  };
}

export default { createTaskStateMachine, STATES };
