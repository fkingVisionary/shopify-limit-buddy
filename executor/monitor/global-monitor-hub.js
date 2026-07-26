// In-process hub: one global Bandai stock monitor + task subscriptions.
// Subscribers filter events; they do not add keywords to the poll set.

import { createBandaiStockMonitor } from "./bandai-stock-monitor.js";
import { createTaskStateMachine } from "./task-state-machine.js";
import { attachStockCheckoutBridge } from "./stock-checkout-bridge.js";
import { eventMatchesWatch, parseTaskWatch, resolveMonitorMode } from "./event-filter.js";

/**
 * @param {object} [opts]
 */
export function createGlobalMonitorHub(opts = {}) {
  const monitor = opts.monitor || createBandaiStockMonitor(opts.monitorOpts || {});
  const stateMachine = opts.stateMachine || createTaskStateMachine(opts.stateOpts || {});
  /** @type {Map<string, { taskId: string, watch: object, onHit?: Function }>} */
  const subs = new Map();

  const onStock = (ev) => {
    if (!ev?.inStock) return;
    for (const sub of subs.values()) {
      if (!eventMatchesWatch(ev, sub.watch)) continue;
      try {
        const row = stateMachine.get(sub.taskId);
        if (row?.status === "monitoring") {
          stateMachine.transition(sub.taskId, "triggered", `match ${ev.productId}`);
        }
      } catch {
        /* ignore bad transitions */
      }
      sub.onHit?.(ev, sub);
    }
  };

  monitor.on("stock_changed", onStock);

  let bridgeDetach = null;
  if (opts.attachBridge !== false) {
    bridgeDetach = attachStockCheckoutBridge({
      monitor,
      stateMachine,
      runCheckout: opts.runCheckout || null,
      log: opts.log,
    });
  }

  function subscribeTask(task, { onHit } = {}) {
    const mode = resolveMonitorMode(task);
    if (mode !== "global") {
      return { ok: false, error: `not_global_mode:${mode}` };
    }
    const taskId = String(task.taskId || task.id || "");
    if (!taskId) return { ok: false, error: "taskId required" };
    const watch = parseTaskWatch(task);
    if (!watch.productIds.length && !watch.keywords.length) {
      return { ok: false, error: "watch needs productId/SKU or keywords" };
    }
    stateMachine.upsert({
      taskId,
      productId: watch.productIds[0] || watch.keywords[0] || "",
      meta: { watch, mode: "global" },
    });
    stateMachine.startMonitoring(taskId, watch.productIds[0] || "");
    subs.set(taskId, { taskId, watch, onHit: onHit || null, task });
    return { ok: true, taskId, watch, mode: "global" };
  }

  function unsubscribeTask(taskId) {
    const id = String(taskId || "");
    subs.delete(id);
    try {
      const row = stateMachine.get(id);
      if (row && row.status === "monitoring") {
        stateMachine.transition(id, "idle", "unsubscribe");
      }
    } catch {
      /* ignore */
    }
  }

  function start() {
    monitor.start();
  }

  async function stop() {
    await monitor.stop();
  }

  function status() {
    return {
      monitor: monitor.status(),
      subscriptions: [...subs.values()].map((s) => ({
        taskId: s.taskId,
        watch: s.watch,
      })),
      tasks: stateMachine.all(),
    };
  }

  function detach() {
    monitor.off("stock_changed", onStock);
    bridgeDetach?.();
  }

  return {
    monitor,
    stateMachine,
    subscribeTask,
    unsubscribeTask,
    start,
    stop,
    status,
    detach,
    /** Test helper: push a synthetic event through the filter path. */
    _injectStockChanged(ev) {
      monitor.emit("stock_changed", ev);
    },
  };
}

export default { createGlobalMonitorHub };
