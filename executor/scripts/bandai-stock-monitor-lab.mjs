#!/usr/bin/env node
/**
 * Bandai global stock monitor lab (V1).
 *
 * Env:
 *   BANDAI_MONITOR_INTERVAL_MS=10000
 *   BANDAI_MONITOR_KEYWORDS=ONE PIECE,GUNDAM
 *   BANDAI_MONITOR_AREA=au
 *   BANDAI_MONITOR_ISP_FILE=... / BANDAI_MONITOR_DC_FILE=...
 *   BANDAI_MONITOR_ISP_PROXIES / BANDAI_MONITOR_DC_PROXIES (multiline)
 *   BANDAI_MONITOR_ISP_RATIO=0.8
 *   BANDAI_MONITOR_STICKY_POLLS=6
 *   BANDAI_MONITOR_MAX_POLLS=3   (lab stop; omit to run until Ctrl+C)
 *
 * Does NOT call checkout. Emits stock_changed to stdout.
 */
import { createBandaiStockMonitor } from "../monitor/bandai-stock-monitor.js";
import { attachStockCheckoutBridge } from "../monitor/stock-checkout-bridge.js";
import { createTaskStateMachine } from "../monitor/task-state-machine.js";

const maxPolls = Number(process.env.BANDAI_MONITOR_MAX_POLLS) || 0;

const monitor = createBandaiStockMonitor();
const sm = createTaskStateMachine({
  onTransition: (row) => {
    console.log(
      `[state] ${new Date(row.at).toISOString()} ${row.taskId} ${row.from}→${row.to} ${row.note || ""}`,
    );
  },
});

// V1: bridge logs only (no runCheckout wired yet).
attachStockCheckoutBridge({
  monitor,
  stateMachine: sm,
  log: (line) => console.log(`[bridge] ${line}`),
});

monitor.on("started", (s) => {
  console.log("[monitor] started", JSON.stringify(s));
});
monitor.on("poll", (s) => {
  console.log(
    `[poll] #${s.polls} products=${s.products} inStock=${s.inStock} events=${s.events} ms=${s.ms} tier=${s.proxyTier} host=${s.proxyHost}${s.firstSnapshot ? " (baseline)" : ""}`,
  );
  if (maxPolls > 0 && s.polls >= maxPolls) {
    console.log(`[monitor] max polls ${maxPolls} — stopping`);
    monitor.stop();
  }
});
monitor.on("stock_changed", (ev) => {
  console.log(
    `[stock_changed] ${ev.productId} inStock=${ev.inStock} reason=${ev.reason} ${ev.title || ""}`,
  );
});
monitor.on("error", (e) => {
  console.warn(`[monitor:error] ${e.error}`);
});
monitor.on("stopped", (s) => {
  console.log("[monitor] stopped", JSON.stringify(s));
  console.log("[status]", JSON.stringify(monitor.status()));
});

monitor.start();

process.on("SIGINT", () => {
  monitor.stop().then(() => process.exit(0));
});
