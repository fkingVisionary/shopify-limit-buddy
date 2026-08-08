#!/usr/bin/env node
/**
 * Lab: one or few PKC monitor polls (Hyper edge + BFF search/status).
 *
 *   HYPER_API_KEY=… \
 *   PC_MONITOR_LOCALE=en-us \
 *   PC_MONITOR_KEYWORDS='elite trainer box' \
 *   PC_MONITOR_SKUS='10-10186-109' \
 *   BANDAI_MONITOR_ISP_FILE=executor/monitor/isp.proxies \
 *   node scripts/pokemoncentre-stock-monitor-lab.mjs
 */
import { createPokemonCentreStockMonitor } from "../monitor/pokemoncentre-stock-monitor.js";
import { hyperConfigured } from "../antibot.js";

const maxPolls = Math.max(1, Number(process.env.PC_MONITOR_MAX_POLLS) || 2);

const mon = createPokemonCentreStockMonitor({
  locale: process.env.PC_MONITOR_LOCALE || "en-us",
  intervalMs: Number(process.env.PC_MONITOR_INTERVAL_MS) || 15_000,
  keywords: process.env.PC_MONITOR_KEYWORDS || "elite trainer box",
  skus: process.env.PC_MONITOR_SKUS || "",
});

console.log(
  JSON.stringify({
    phase: "start",
    hyperConfigured: hyperConfigured(),
    status: mon.status(),
  }),
);

mon.on("stock_changed", (ev) => {
  console.log(JSON.stringify({ phase: "stock_changed", ...ev }));
});
mon.on("poll", (s) => {
  console.log(
    JSON.stringify({
      phase: "poll",
      polls: s.polls,
      products: s.products,
      inStock: s.inStock,
      events: s.events,
      ms: s.ms,
      firstSnapshot: s.firstSnapshot,
      sources: s.sources,
      proxyHost: s.proxyHost,
    }),
  );
});
mon.on("error", (e) => {
  console.log(JSON.stringify({ phase: "error", ...e }));
});

let n = 0;
async function run() {
  while (n < maxPolls) {
    n += 1;
    try {
      await mon.pollOnce();
    } catch (e) {
      console.log(JSON.stringify({ phase: "poll_fail", n, error: e?.message || String(e) }));
    }
  }
  console.log(JSON.stringify({ phase: "done", status: mon.status() }));
  process.exit(0);
}

await run();
