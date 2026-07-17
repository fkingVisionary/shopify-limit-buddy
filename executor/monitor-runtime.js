// Co-located global Kmart monitor — same Fly app as checkout.
// Opt-in via MONITOR_ENABLE=1 (set on Fly). Desktop sidecars stay off.

import { createRequire } from "module";
import { fileURLToPath } from "url";
import path from "path";

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * @param {{
 *   app: import('fastify').FastifyInstance;
 *   port: number;
 *   executorToken: string;
 * }} opts
 */
export function attachMonitor(opts) {
  const enabled = ["1", "true", "yes", "on"].includes(
    String(process.env.MONITOR_ENABLE || "").trim().toLowerCase(),
  );
  if (!enabled) {
    return { enabled: false, stop: () => {} };
  }

  const { app, port, executorToken } = opts;
  const log = (msg) => console.log(`[monitor] ${msg}`);

  // Pollers call the same process over loopback (existing Hyper stock-probe).
  if (!process.env.MONITOR_EXECUTOR_URL) {
    process.env.MONITOR_EXECUTOR_URL = `http://127.0.0.1:${port}`;
  }
  if (!process.env.MONITOR_EXECUTOR_TOKEN && executorToken) {
    process.env.MONITOR_EXECUTOR_TOKEN = executorToken;
  }
  if (!process.env.MONITOR_WATCHLIST) {
    process.env.MONITOR_WATCHLIST = path.join(__dirname, "watchlist.json");
  }
  // Docker has no ../desktop — always use vendored probe helpers.
  process.env.MONITOR_USE_VENDORED = process.env.MONITOR_USE_VENDORED || "1";

  const { loadWatchlist } = require("./monitor/watchlist.cjs");
  const { createIspPoolFromEnv } = require("./monitor/proxies.cjs");
  const { FeedHub } = require("./monitor/feed.cjs");
  const { startSkuPoller } = require("./monitor/pollers/kmart-sku.cjs");
  const { startDiscoveryPoller } = require("./monitor/pollers/kmart-discovery.cjs");
  const { executorConfig, probeViaExecutor } = require("./monitor/executor-probe.cjs");
  const { makeMonitorEvent } = require("./monitor/events.cjs");

  const watchlist = loadWatchlist();
  const ispPool = createIspPoolFromEnv();
  const feed = new FeedHub();
  /** @type {Map<string, boolean | null>} */
  const stockState = new Map();
  const seenDiscoverySkus = new Set(watchlist.skus.map((s) => s.sku));
  const execCfg = executorConfig();

  log(
    `enabled skus=${watchlist.skus.length} discovery=${watchlist.discovery.length} isp=${ispPool.size()} executor=${execCfg.configured ? execCfg.base : "MISSING"}`,
  );

  app.get("/feed", (req, reply) => {
    reply.hijack();
    feed.subscribe(req.raw, reply.raw);
  });

  app.get("/recent", async (req, reply) => {
    if (!feed.authOk(req.raw)) {
      reply.code(401);
      return { ok: false, error: "unauthorized" };
    }
    return { ok: true, events: feed.recent.slice(0, 50) };
  });

  app.get("/probe", async (req, reply) => {
    if (!feed.authOk(req.raw)) {
      reply.code(401);
      return { ok: false, error: "unauthorized" };
    }
    const q = req.query || {};
    const target =
      String(q.url || "").trim() ||
      watchlist.skus[0]?.url ||
      "https://www.kmart.com.au/product/junk-journal-sticker-pad-43671588/";
    const wantDirect = String(q.direct || "") === "1";
    const fallbackProxy =
      String(process.env.MONITOR_FALLBACK_PROXY || process.env.PROXY_URL_RESI || "").trim() || null;
    const proxyUrl = wantDirect ? null : ispPool.next() || fallbackProxy;

    let probe = await probeViaExecutor({
      url: target,
      proxyUrl,
      timeoutMs: Number(process.env.MONITOR_PROBE_TIMEOUT_MS) || 90_000,
    });

    if (!wantDirect && typeof ispPool.reportResult === "function") {
      ispPool.reportResult(proxyUrl, {
        ok: probe.ok === true,
        blocked: probe.blocked === true,
        softFail: !probe.ok && !probe.blocked,
      });
    }

    if (!probe.ok && !wantDirect && (probe.blocked || /access denied|akamai/i.test(String(probe.error || "")))) {
      const retryProxy = fallbackProxy || null;
      const retry = await probeViaExecutor({
        url: target,
        proxyUrl: retryProxy,
        timeoutMs: Number(process.env.MONITOR_PROBE_TIMEOUT_MS) || 90_000,
      });
      if (retry.ok || retry.blocked === false) probe = retry;
      else if (!probe.error) probe = retry;
      probe._retried = retryProxy ? "fallback_proxy" : "direct";
    }

    const titleOk =
      String(probe.title || "").trim().length >= 5 &&
      !/^(footer|header|menu|nav|home|search|cart|login|account|kmart|shop|categories|untitled)/i.test(
        String(probe.title || "").trim(),
      );
    if (probe.ok && probe.inStock === true && titleOk) {
      const evt = makeMonitorEvent({
        type: "restock",
        title: probe.title,
        url: probe.url || target,
        sku: probe.sku || "",
        inStock: true,
        price: probe.price ?? undefined,
        imageUrl: probe.imageUrl || undefined,
        sizes: probe.sizes || undefined,
        source: "sku_poll",
      });
      feed.publish(evt);
    }

    return {
      ok: true,
      via: "executor+hyper",
      proxyUsed: Boolean(proxyUrl),
      isp: ispPool.stats ? ispPool.stats() : null,
      probe: {
        ok: probe.ok,
        inStock: probe.inStock,
        sku: probe.sku,
        title: probe.title,
        price: probe.price,
        blocked: probe.blocked,
        error: probe.error,
        status: probe.status,
        imageUrl: probe.imageUrl ? true : false,
        elapsedMs: probe.elapsedMs ?? null,
        retried: probe._retried || null,
        lastSteps: Array.isArray(probe.steps)
          ? probe.steps.slice(-8).map((s) => ({
              step: s.step,
              ok: s.ok,
              note: String(s.note || "").slice(0, 160),
            }))
          : null,
      },
    };
  });

  app.get("/monitor/health", async () => ({
    ok: true,
    service: "j1ms-bot-executor-monitor",
    watchlist: {
      skus: watchlist.skus.length,
      discovery: watchlist.discovery.length,
    },
    isp: ispPool.stats ? ispPool.stats() : { total: ispPool.size() },
    executor: { configured: execCfg.configured, url: execCfg.configured ? execCfg.base : null },
    stockKnown: stockState.size,
    feed: feed.stats(),
  }));

  const skuPoller = startSkuPoller({
    watchlist,
    ispPool,
    feed,
    state: stockState,
    log,
  });
  const discoveryPoller = startDiscoveryPoller({
    watchlist,
    ispPool,
    feed,
    seenSkus: seenDiscoverySkus,
    stockState,
    log,
  });

  return {
    enabled: true,
    stats: () => ({
      watchlist: {
        skus: watchlist.skus.length,
        discovery: watchlist.discovery.length,
      },
      isp: ispPool.stats ? ispPool.stats() : { total: ispPool.size() },
      stockKnown: stockState.size,
      feed: feed.stats(),
    }),
    stop: () => {
      skuPoller.stop();
      discoveryPoller.stop();
    },
  };
}
