// Kmart monitor service — detect + publish SSE. Never places orders.

const http = require("http");
const { loadWatchlist } = require("./watchlist.cjs");
const { createIspPoolFromEnv } = require("./proxies.cjs");
const { FeedHub } = require("./feed.cjs");
const { startSkuPoller } = require("./pollers/kmart-sku.cjs");
const { startDiscoveryPoller } = require("./pollers/kmart-discovery.cjs");
const { executorConfig, probeViaExecutor } = require("./executor-probe.cjs");

const PORT = Number(process.env.PORT) || 8091;
const log = (msg) => console.log(`[monitor] ${msg}`);

const watchlist = loadWatchlist();
const ispPool = createIspPoolFromEnv();
const feed = new FeedHub();
/** @type {Map<string, boolean | null>} */
const stockState = new Map();
const seenDiscoverySkus = new Set(watchlist.skus.map((s) => s.sku));
const execCfg = executorConfig();

log(
  `watchlist skus=${watchlist.skus.length} discovery=${watchlist.discovery.length} isp=${ispPool.size()} executor=${execCfg.configured ? execCfg.base : "MISSING (Hyper probes disabled)"}`,
);

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

const server = http.createServer((req, res) => {
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);

  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "Authorization, Content-Type",
      "Access-Control-Allow-Methods": "GET, OPTIONS",
    });
    res.end();
    return;
  }

  if (url.pathname === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        ok: true,
        service: "j1ms-kmart-monitor",
        watchlist: {
          skus: watchlist.skus.length,
          discovery: watchlist.discovery.length,
        },
        isp: ispPool.stats ? ispPool.stats() : { total: ispPool.size() },
        executor: { configured: execCfg.configured, url: execCfg.configured ? execCfg.base : null },
        stockKnown: stockState.size,
        feed: feed.stats(),
      }),
    );
    return;
  }

  if (url.pathname === "/probe" && req.method === "GET") {
    if (!feed.authOk(req)) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: "unauthorized" }));
      return;
    }
    const target =
      url.searchParams.get("url") ||
      watchlist.skus[0]?.url ||
      "https://www.kmart.com.au/product/junk-journal-sticker-pad-43671588/";
    const wantDirect = url.searchParams.get("direct") === "1";
    const fallbackProxy = String(process.env.MONITOR_FALLBACK_PROXY || process.env.PROXY_URL_RESI || "").trim() || null;
    const proxyUrl = wantDirect ? null : ispPool.next() || fallbackProxy;
    // Hyper path via executor — same as SKU poller (lightweight HTML alone gets Akamai 403).
    probeViaExecutor({
      url: target,
      proxyUrl,
      timeoutMs: Number(process.env.MONITOR_PROBE_TIMEOUT_MS) || 90_000,
    })
      .then(async (probe) => {
        if (!wantDirect && typeof ispPool.reportResult === "function") {
          ispPool.reportResult(proxyUrl, {
            ok: probe.ok === true,
            blocked: probe.blocked === true,
            softFail: !probe.ok && !probe.blocked,
          });
        }
        // Auto-retry direct/fallback when ISP is burned (manual /probe).
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
        // If in stock, also publish so the feed proves end-to-end.
        if (probe.ok && probe.inStock === true) {
          const { makeMonitorEvent } = require("./events.cjs");
          const evt = makeMonitorEvent({
            type: "restock",
            title: probe.title || `SKU ${probe.sku}`,
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
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
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
          }),
        );
      })
      .catch((e) => {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: e?.message || String(e) }));
      });
    return;
  }

  if (url.pathname === "/feed") {
    feed.subscribe(req, res);
    return;
  }

  if (url.pathname === "/recent") {
    if (!feed.authOk(req)) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: "unauthorized" }));
      return;
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, events: feed.recent.slice(0, 50) }));
    return;
  }

  res.writeHead(404, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ ok: false, error: "not found" }));
});

server.listen(PORT, "0.0.0.0", () => {
  log(`listening on :${PORT}`);
  log(`  health  http://127.0.0.1:${PORT}/health`);
  log(`  feed    http://127.0.0.1:${PORT}/feed`);
  log(`  probe   http://127.0.0.1:${PORT}/probe`);
});

function shutdown() {
  log("shutting down");
  skuPoller.stop();
  discoveryPoller.stop();
  try {
    const { stopLocalExecutor } = require("./local-executor.cjs");
    stopLocalExecutor();
  } catch {
    /* optional */
  }
  server.close(() => process.exit(0));
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
