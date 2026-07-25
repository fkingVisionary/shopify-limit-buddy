// Thin connector: stock_changed → (future) runCheckout.
// V1 global monitor: log + optional onTrigger hook only.
// When tasks are wired later, this is the ONLY file that may call checkout.

/**
 * @param {object} opts
 * @param {import('./bandai-stock-monitor.js').createBandaiStockMonitor extends Function ? any : any} opts.monitor
 * @param {ReturnType<import('./task-state-machine.js').createTaskStateMachine>} [opts.stateMachine]
 * @param {(taskId: string, ev: object) => void|Promise<void>} [opts.runCheckout]
 * @param {(line: string) => void} [opts.log]
 */
export function attachStockCheckoutBridge(opts = {}) {
  const monitor = opts.monitor;
  const sm = opts.stateMachine || null;
  const runCheckout = typeof opts.runCheckout === "function" ? opts.runCheckout : null;
  const log = opts.log || ((line) => console.log(line));

  if (!monitor?.on) throw new Error("monitor required");

  const handler = (ev) => {
    if (!ev?.inStock) return;
    const productId = ev.productId;
    // Single hot-path log line — keep this listener thin.
    log(`stock_changed in_stock productId=${productId} ts=${ev.timestamp}`);

    if (!sm || !runCheckout) return;

    const tasks = sm.listMonitoring(productId);
    for (const t of tasks) {
      try {
        sm.transition(t.taskId, "triggered", `stock ${productId}`);
      } catch {
        continue;
      }
      // Fire without awaiting — latency over serial checkout.
      Promise.resolve()
        .then(() => {
          try {
            sm.transition(t.taskId, "checking_out", "runCheckout");
          } catch {
            /* ignore */
          }
          return runCheckout(t.taskId, ev);
        })
        .then(() => {
          try {
            sm.transition(t.taskId, "success", "runCheckout ok");
          } catch {
            /* ignore */
          }
        })
        .catch((e) => {
          try {
            sm.transition(t.taskId, "failed", e?.message || "runCheckout fail");
          } catch {
            /* ignore */
          }
        });
    }
  };

  monitor.on("stock_changed", handler);
  return () => monitor.off("stock_changed", handler);
}

export default { attachStockCheckoutBridge };
