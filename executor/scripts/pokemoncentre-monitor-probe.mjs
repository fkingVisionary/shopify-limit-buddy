#!/usr/bin/env node
/**
 * One-shot PKC monitor probe — same path as Railway poller.
 *
 *   HYPER_API_KEY=… PROXY='host:port:user:pass' \
 *     node executor/scripts/pokemoncentre-monitor-probe.mjs
 *
 * Optional: PC_MONITOR_TLS_WORKER=0|1  PC_PROBE_KEYWORD=TCG
 */
import { createPokemonCentreStockMonitor } from "../monitor/pokemoncentre-stock-monitor.js";
import { createMonitorProxyPool } from "../monitor/monitor-proxy-pool.js";
import { hyperConfigured } from "../antibot.js";

const PROXY = String(process.env.PROXY || process.env.PROXY_URL_RESI || "").trim();
const KEYWORD = String(process.env.PC_PROBE_KEYWORD || "TCG").trim();

async function main() {
  if (!hyperConfigured()) {
    console.error(JSON.stringify({ ok: false, error: "HYPER_API_KEY missing" }));
    process.exit(2);
  }
  if (!PROXY) {
    console.error(JSON.stringify({ ok: false, error: "PROXY / PROXY_URL_RESI required" }));
    process.exit(2);
  }

  const pool = createMonitorProxyPool({
    ispRaw: PROXY,
    dcRaw: "",
    ispRatio: 1,
  });
  const mon = createPokemonCentreStockMonitor({
    locale: "en-au",
    keywords: KEYWORD,
    skus: "",
    discoveryEnable: true,
    proxyPool: pool,
    intervalMs: 60_000,
  });

  const t0 = Date.now();
  try {
    const { summary, events } = await mon.pollOnce({ announce: true });
    console.log(
      JSON.stringify(
        {
          ok: true,
          ms: Date.now() - t0,
          products: summary?.products,
          inStock: summary?.inStock,
          softListed: summary?.softListed,
          transport: summary?.transport,
          edgeNote: summary?.edgeNote,
          edgeAttempts: summary?.edgeAttempts,
          proxyHost: summary?.proxyHost,
          sources: summary?.sources,
          discordEvents: events?.length || 0,
          status: mon.status(),
        },
        null,
        2,
      ),
    );
    await mon.stop();
    process.exit(summary?.products > 0 ? 0 : 3);
  } catch (e) {
    console.log(
      JSON.stringify(
        {
          ok: false,
          ms: Date.now() - t0,
          error: e?.message || String(e),
          code: e?.code || null,
          status: mon.status(),
        },
        null,
        2,
      ),
    );
    await mon.stop().catch(() => {});
    process.exit(1);
  }
}

main();
