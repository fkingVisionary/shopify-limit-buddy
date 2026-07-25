#!/usr/bin/env node
/**
 * Prove global filter + task-local monitor against live Bandai (executor code).
 *
 * Env:
 *   BANDAI_MONITOR_ISP_FILE / pool — global monitor proxies
 *   BANDAI_TASK_PROXY_FILE — local task proxies (defaults to same pool)
 *   BANDAI_MONITOR_MAX_POLLS=2
 */
import fs from "node:fs";
import { createGlobalMonitorHub } from "../monitor/global-monitor-hub.js";
import { createTaskLocalMonitor } from "../monitor/task-local-monitor.js";

const poolFile =
  process.env.BANDAI_MONITOR_ISP_FILE ||
  process.env.BANDAI_PROXY_POOL ||
  "/tmp/bandai-proxy-pool.txt";
const taskProxyFile = process.env.BANDAI_TASK_PROXY_FILE || poolFile;
const maxPolls = Number(process.env.BANDAI_MONITOR_MAX_POLLS) || 2;

function loadLines(file) {
  try {
    return fs
      .readFileSync(file, "utf8")
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter((s) => s && !s.startsWith("#"));
  } catch {
    return [];
  }
}

const ispLines = loadLines(poolFile).slice(0, 8);
if (!ispLines.length) {
  console.error("need proxies in", poolFile);
  process.exit(1);
}

process.env.BANDAI_MONITOR_ISP_PROXIES = ispLines.join("\n");
process.env.BANDAI_MONITOR_DC_PROXIES = "";
process.env.BANDAI_MONITOR_INTERVAL_MS =
  process.env.BANDAI_MONITOR_INTERVAL_MS || "8000";
process.env.BANDAI_MONITOR_KEYWORDS =
  process.env.BANDAI_MONITOR_KEYWORDS || "ONE PIECE";

const hits = [];
const hub = createGlobalMonitorHub({
  attachBridge: true,
  log: (l) => console.log(`[bridge] ${l}`),
});

hub.subscribeTask(
  {
    id: "global-kw-op",
    bandaiMonitorMode: "global",
    keywords: "ONE PIECE",
  },
  {
    onHit: (ev) => {
      hits.push({ via: "global-kw", ...ev });
      console.log(`[HIT global-kw] ${ev.productId} ${ev.title || ""}`);
    },
  },
);

hub.subscribeTask(
  {
    id: "global-sku-miss",
    bandaiMonitorMode: "global",
    productId: "N0000000000",
  },
  {
    onHit: (ev) => {
      hits.push({ via: "global-sku", ...ev });
      console.log(`[HIT global-sku] ${ev.productId}`);
    },
  },
);

console.log("[hub] status", JSON.stringify(hub.status().subscriptions));

let polls = 0;
hub.monitor.on("poll", (s) => {
  polls += 1;
  console.log(
    `[global:poll] #${s.polls} products=${s.products} inStock=${s.inStock} events=${s.events} baseline=${s.firstSnapshot}`,
  );
  if (polls >= maxPolls) {
    finish();
  }
});
hub.monitor.on("error", (e) => console.warn("[global:error]", e.error));

const taskProxies = loadLines(taskProxyFile).slice(0, 5);
const local = createTaskLocalMonitor(
  {
    keywords: "ONE PIECE",
    proxies: taskProxies,
    monitorIntervalMs: 8000,
    bandaiArea: "au",
  },
  {},
);
local.on("poll", (s) => {
  console.log(
    `[local:poll] #${s.polls} products=${s.products} inStock=${s.inStock} events=${s.events}`,
  );
});
local.on("stock_changed", (ev) => {
  hits.push({ via: "local", ...ev });
  console.log(`[HIT local] ${ev.productId} ${ev.reason}`);
});
local.on("error", (e) => console.warn("[local:error]", e.error));

let done = false;
async function finish() {
  if (done) return;
  done = true;
  await local.stop();
  await hub.stop();
  console.log(
    "SUMMARY",
    JSON.stringify(
      {
        globalPolls: polls,
        hits: hits.length,
        byVia: hits.reduce((a, h) => {
          a[h.via] = (a[h.via] || 0) + 1;
          return a;
        }, {}),
        note: "baseline polls usually produce 0 hits; inject/restock needed for stock_changed",
      },
      null,
      2,
    ),
  );
  process.exit(0);
}

hub.start();
await local.start();

setTimeout(() => {
  console.log("[lab] timeout stop");
  finish();
}, Number(process.env.BANDAI_MONITOR_LAB_TIMEOUT_MS) || 45_000).unref?.();
