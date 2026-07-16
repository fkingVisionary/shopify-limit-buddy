// Fast-path SKU/PDP poller — Hyper-backed via checkout executor (never ATC).
// Soft on the ISP fleet: one proxy per SKU, report blocks, generous delays.

const { probeViaExecutor, executorConfig } = require("../executor-probe.cjs");
const { makeMonitorEvent } = require("../events.cjs");

/**
 * @param {{
 *   watchlist: { skus: { sku: string; url: string }[] };
 *   ispPool: { next: () => string | null; reportResult?: Function; stats?: Function };
 *   feed: { publish: (e: object) => boolean };
 *   state: Map<string, boolean | null>;
 *   log?: (msg: string) => void;
 * }} ctx
 */
async function pollSkuOnce(ctx) {
  const { watchlist, ispPool, feed, state } = ctx;
  const log = ctx.log || (() => {});
  const items = watchlist.skus || [];
  if (!items.length) return { polled: 0, published: 0 };

  const cfg = executorConfig();
  if (!cfg.configured) {
    log("sku_poll SKIP — set MONITOR_EXECUTOR_URL + MONITOR_EXECUTOR_TOKEN (Hyper lives on executor)");
    return { polled: 0, published: 0, skipped: true };
  }

  let published = 0;
  const staggerMs = Math.max(800, Number(process.env.MONITOR_SKU_STAGGER_MS) || 2500);

  const fallbackProxy = String(process.env.MONITOR_FALLBACK_PROXY || process.env.PROXY_URL_RESI || "").trim() || null;
  const allowDirect = process.env.MONITOR_PROBE_ALLOW_DIRECT !== "0";
  const proxyMode = String(process.env.MONITOR_PROXY_MODE || "auto").toLowerCase();

  for (const item of items) {
    // desktop = checkout-proven proxies first; isp = ISP pool only; auto = ISP then fallback
    let proxyUrl =
      proxyMode === "desktop" && fallbackProxy
        ? fallbackProxy
        : proxyMode === "direct"
          ? null
          : ispPool.next();
    let probe = await probeViaExecutor({
      url: item.url,
      proxyUrl,
      timeoutMs: Number(process.env.MONITOR_PROBE_TIMEOUT_MS) || 90_000,
    });

    if (typeof ispPool.reportResult === "function") {
      ispPool.reportResult(proxyUrl, {
        ok: probe.ok === true,
        blocked: probe.blocked === true,
        softFail: !probe.ok && !probe.blocked,
      });
    }

    // ISPs often get harder Akamai than checkout resi — retry once.
    if (!probe.ok && (probe.blocked || /access denied|akamai/i.test(String(probe.error || "")))) {
      const retryProxy = fallbackProxy || (allowDirect ? null : undefined);
      if (retryProxy !== undefined) {
        log(`sku_poll retry ${item.sku} via=${fallbackProxy ? "fallback_proxy" : "direct"}`);
        probe = await probeViaExecutor({
          url: item.url,
          proxyUrl: retryProxy,
          timeoutMs: Number(process.env.MONITOR_PROBE_TIMEOUT_MS) || 90_000,
        });
      }
    }

    const sku = probe.sku || item.sku;
    const prev = state.has(sku) ? state.get(sku) : null;
    const inStock = probe.inStock;

    if (probe.ok) {
      log(
        `sku_poll ok sku=${sku} inStock=${inStock} title=${(probe.title || "").slice(0, 40)} via=hyper proxy=${proxyUrl ? "yes" : "direct"}`,
      );
    } else if (probe.blocked) {
      log(`sku_poll blocked ${sku}: ${probe.error || "blocked"}`);
    } else {
      log(`sku_poll fail ${sku}: ${probe.error || "unknown"}`);
    }

    if (probe.ok && inStock === true) {
      if (prev !== true) {
        const evt = makeMonitorEvent({
          type: "restock",
          title: probe.title || `SKU ${sku}`,
          url: probe.url || item.url,
          sku,
          inStock: true,
          price: probe.price ?? undefined,
          imageUrl: probe.imageUrl || undefined,
          sizes: probe.sizes || undefined,
          source: "sku_poll",
        });
        if (feed.publish(evt)) {
          published += 1;
          log(`PUBLISH restock ${sku} ${probe.title || ""}`);
        }
      }
      state.set(sku, true);
    } else if (probe.ok && inStock === false) {
      state.set(sku, false);
    }

    await new Promise((r) => setTimeout(r, staggerMs));
  }

  return { polled: items.length, published };
}

function startSkuPoller(ctx) {
  // Hyper probes are heavier — default slower. Override with MONITOR_POLL_MS.
  const ms = Math.max(4000, Number(process.env.MONITOR_POLL_MS) || 20_000);
  let stopped = false;

  const tick = async () => {
    if (stopped) return;
    try {
      await pollSkuOnce(ctx);
    } catch (e) {
      (ctx.log || console.error)(`sku_poller error: ${e?.message || e}`);
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

module.exports = { pollSkuOnce, startSkuPoller };
