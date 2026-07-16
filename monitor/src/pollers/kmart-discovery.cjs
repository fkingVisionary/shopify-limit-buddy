// Operator discovery poller — search/newest surfaces → type:"new" + promote to SKU list.

const { searchKmartProducts } = require("../../lib/kmart-stock-probe.cjs");
const { probeViaExecutor, executorConfig } = require("../executor-probe.cjs");
const { makeMonitorEvent } = require("../events.cjs");
const { promoteSku } = require("../watchlist.cjs");

/**
 * @param {{
 *   watchlist: { skus: { sku: string; url: string }[]; discovery: { query: string }[] };
 *   ispPool: { next: () => string | null };
 *   feed: { publish: (e: object) => boolean };
 *   seenSkus: Set<string>;
 *   stockState: Map<string, boolean | null>;
 *   log?: (msg: string) => void;
 * }} ctx
 */
async function pollDiscoveryOnce(ctx) {
  const { watchlist, ispPool, feed, seenSkus, stockState } = ctx;
  const log = ctx.log || (() => {});
  const queries = watchlist.discovery || [];
  if (!queries.length) return { queries: 0, published: 0 };

  if (!executorConfig().configured) {
    log("discovery SKIP confirm — set MONITOR_EXECUTOR_URL + MONITOR_EXECUTOR_TOKEN");
    return { queries: 0, published: 0, skipped: true };
  }

  let published = 0;
  const staggerMs = Math.max(1500, Number(process.env.MONITOR_DISCOVERY_STAGGER_MS) || 4000);
  for (const { query } of queries) {
    const proxyUrl = ispPool.next();
    const found = await searchKmartProducts({ query, proxyUrl, timeoutMs: 18_000 });
    if (typeof ispPool.reportResult === "function") {
      ispPool.reportResult(proxyUrl, {
        ok: found.ok === true && !found.blocked,
        blocked: found.blocked === true,
        softFail: !found.ok,
      });
    }
    if (!found.ok) {
      log(`discovery "${query}": ${found.error || "fail"}`);
      await new Promise((r) => setTimeout(r, staggerMs));
      continue;
    }

    for (const p of found.products || []) {
      if (!p.sku || seenSkus.has(p.sku)) continue;

      const probeProxy = ispPool.next();
      const probe = await probeViaExecutor({
        url: p.url,
        proxyUrl: probeProxy,
        timeoutMs: Number(process.env.MONITOR_PROBE_TIMEOUT_MS) || 90_000,
      });
      if (typeof ispPool.reportResult === "function") {
        ispPool.reportResult(probeProxy, {
          ok: probe.ok === true,
          blocked: probe.blocked === true,
          softFail: !probe.ok && !probe.blocked,
        });
      }
      if (!probe.ok) {
        log(`discovery confirm fail ${p.sku}: ${probe.error || "fail"}`);
        continue;
      }

      const title = probe.title || p.title;
      const url = probe.url || p.url;
      const sku = probe.sku || p.sku;

      seenSkus.add(sku);
      promoteSku(watchlist, { sku, url });

      const evt = makeMonitorEvent({
        type: "new",
        title,
        url,
        sku,
        inStock: probe.inStock !== false,
        price: probe.price ?? undefined,
        imageUrl: probe.imageUrl || undefined,
        sizes: probe.sizes || undefined,
        source: "discovery",
      });
      if (feed.publish(evt)) {
        published += 1;
        log(`PUBLISH new ${sku} ${title}`);
      }
      if (probe.inStock === true || probe.inStock === false) {
        stockState.set(sku, probe.inStock);
      }
      await new Promise((r) => setTimeout(r, staggerMs));
    }

    await new Promise((r) => setTimeout(r, staggerMs));
  }

  return { queries: queries.length, published };
}

function startDiscoveryPoller(ctx) {
  const ms = Math.max(20_000, Number(process.env.MONITOR_DISCOVERY_MS) || 60_000);
  let stopped = false;

  const tick = async () => {
    if (stopped) return;
    try {
      await pollDiscoveryOnce(ctx);
    } catch (e) {
      (ctx.log || console.error)(`discovery error: ${e?.message || e}`);
    }
    if (!stopped) setTimeout(tick, ms);
  };

  setTimeout(tick, 2000);
  return {
    stop: () => {
      stopped = true;
    },
  };
}

module.exports = { pollDiscoveryOnce, startDiscoveryPoller };
