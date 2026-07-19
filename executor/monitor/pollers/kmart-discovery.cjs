// Fast discovery — search HTML + light PDP confirm (no Hyper by default).
// Promotes in-stock hits onto the SKU list for restock watching.

const { searchKmartProducts, probeKmartPdp } = require("../../lib/kmart-stock-probe.cjs");
const { probeViaExecutor } = require("../executor-probe.cjs");
const { makeMonitorEvent } = require("../events.cjs");
const { promoteSku } = require("../watchlist.cjs");

function isPublishableTitle(title) {
  const t = String(title || "").trim();
  if (t.length < 5) return false;
  if (
    /^(footer|header|menu|nav|home|search|cart|login|account|kmart|shop|categories|untitled)/i.test(
      t,
    )
  ) {
    return false;
  }
  return true;
}

/**
 * @param {{
 *   watchlist: { skus: { sku: string; url: string }[]; discovery: { query: string }[] };
 *   ispPool: { next: () => string | null; reportResult?: Function };
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

  let published = 0;
  const staggerMs = Math.max(300, Number(process.env.MONITOR_DISCOVERY_STAGGER_MS) || 700);
  const timeoutMs = Math.max(4000, Number(process.env.MONITOR_PROBE_TIMEOUT_MS) || 12_000);
  const fallbackProxy =
    String(process.env.MONITOR_FALLBACK_PROXY || process.env.PROXY_URL_RESI || "").trim() || null;
  const hyperFallback = ["1", "true", "yes"].includes(
    String(process.env.MONITOR_HYPER_FALLBACK || "").toLowerCase(),
  );
  // Cap how many brand-new SKUs we confirm per query per tick (keep loop snappy).
  const maxNewPerQuery = Math.max(1, Number(process.env.MONITOR_DISCOVERY_MAX_NEW) || 8);

  for (const { query } of queries) {
    const searchProxy = ispPool.next() || fallbackProxy;
    const found = await searchKmartProducts({
      query,
      proxyUrl: searchProxy,
      timeoutMs: Math.min(timeoutMs, 15_000),
    });
    if (typeof ispPool.reportResult === "function") {
      ispPool.reportResult(searchProxy, {
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

    const products = found.products || [];
    log(`discovery "${query}": ${products.length} hits`);
    let confirmed = 0;

    for (const p of products) {
      if (!p.sku || seenSkus.has(p.sku)) continue;
      if (confirmed >= maxNewPerQuery) break;

      const probeProxy = ispPool.next() || fallbackProxy;
      let probe = await probeKmartPdp({
        url: p.url,
        proxyUrl: probeProxy,
        timeoutMs,
      });
      if (typeof ispPool.reportResult === "function") {
        ispPool.reportResult(probeProxy, {
          ok: probe.ok === true,
          blocked: probe.blocked === true,
          softFail: !probe.ok && !probe.blocked,
        });
      }

      if (
        hyperFallback &&
        !probe.ok &&
        (probe.blocked || /access denied|akamai/i.test(String(probe.error || "")))
      ) {
        probe = await probeViaExecutor({
          url: p.url,
          proxyUrl: fallbackProxy || probeProxy,
          timeoutMs: Math.max(timeoutMs, 60_000),
        });
      }

      const title = probe.title || p.title;
      const url = probe.url || p.url;
      const sku = probe.sku || p.sku;

      if (!probe.ok || !isPublishableTitle(title) || probe.inStock !== true) {
        // Still mark seen if we got a real OOS read — so we can catch restock later via SKU poll.
        if (probe.ok && probe.inStock === false && sku) {
          seenSkus.add(sku);
          promoteSku(watchlist, { sku, url });
          stockState.set(sku, false);
          log(`discovery track OOS ${sku} ${(title || "").slice(0, 40)}`);
        } else {
          log(
            `discovery DROP ${sku || "?"} titleOk=${isPublishableTitle(title)} inStock=${probe.inStock} ok=${probe.ok}`,
          );
        }
        confirmed += 1;
        await new Promise((r) => setTimeout(r, staggerMs));
        continue;
      }

      seenSkus.add(sku);
      promoteSku(watchlist, { sku, url });
      confirmed += 1;

      const evt = makeMonitorEvent({
        type: "new",
        title,
        url,
        sku,
        inStock: true,
        price: probe.price ?? undefined,
        imageUrl: probe.imageUrl || undefined,
        sizes: probe.sizes || undefined,
        source: "discovery",
      });
      if (feed.publish(evt)) {
        published += 1;
        log(`PUBLISH new ${sku} ${title}`);
      }
      stockState.set(sku, true);
      await new Promise((r) => setTimeout(r, staggerMs));
    }

    await new Promise((r) => setTimeout(r, staggerMs));
  }

  return { queries: queries.length, published };
}

function startDiscoveryPoller(ctx) {
  const ms = Math.max(3000, Number(process.env.MONITOR_DISCOVERY_MS) || 8000);
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

  setTimeout(tick, 800);
  return {
    stop: () => {
      stopped = true;
    },
  };
}

module.exports = { pollDiscoveryOnce, startDiscoveryPoller };
