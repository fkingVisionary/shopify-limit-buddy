// Fast SKU/PDP poller — lightweight WWW HTML via ISP/resi (Zephyr-style).
// Hyper is optional fallback only (MONITOR_HYPER_FALLBACK=1).

const { probeKmartPdp } = require("../../lib/kmart-stock-probe.cjs");
const { probeViaExecutor } = require("../executor-probe.cjs");
const { makeMonitorEvent } = require("../events.cjs");

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

function pickProxy(ispPool, fallbackProxy) {
  const mode = String(process.env.MONITOR_PROXY_MODE || "auto").toLowerCase();
  if (mode === "direct") return null;
  if (mode === "desktop" && fallbackProxy) return fallbackProxy;
  return ispPool.next() || fallbackProxy || null;
}

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

  let published = 0;
  const staggerMs = Math.max(200, Number(process.env.MONITOR_SKU_STAGGER_MS) || 400);
  const timeoutMs = Math.max(4000, Number(process.env.MONITOR_PROBE_TIMEOUT_MS) || 12_000);
  const fallbackProxy =
    String(process.env.MONITOR_FALLBACK_PROXY || process.env.PROXY_URL_RESI || "").trim() || null;
  const allowDirect = process.env.MONITOR_PROBE_ALLOW_DIRECT !== "0";
  const hyperFallback = ["1", "true", "yes"].includes(
    String(process.env.MONITOR_HYPER_FALLBACK || "").toLowerCase(),
  );

  for (const item of items) {
    let proxyUrl = pickProxy(ispPool, fallbackProxy);
    let probe = await probeKmartPdp({
      url: item.url,
      proxyUrl,
      timeoutMs,
    });
    let via = "html";

    if (typeof ispPool.reportResult === "function") {
      ispPool.reportResult(proxyUrl, {
        ok: probe.ok === true,
        blocked: probe.blocked === true,
        softFail: !probe.ok && !probe.blocked,
      });
    }

    if (!probe.ok && (probe.blocked || /access denied|akamai/i.test(String(probe.error || "")))) {
      const retryProxy = fallbackProxy && fallbackProxy !== proxyUrl ? fallbackProxy : allowDirect ? null : undefined;
      if (retryProxy !== undefined) {
        log(`sku_poll retry ${item.sku} via=html fallback`);
        probe = await probeKmartPdp({ url: item.url, proxyUrl: retryProxy, timeoutMs });
        via = "html_fallback";
      }
    }

    if (
      hyperFallback &&
      !probe.ok &&
      (probe.blocked || /access denied|akamai/i.test(String(probe.error || "")))
    ) {
      log(`sku_poll hyper fallback ${item.sku}`);
      probe = await probeViaExecutor({
        url: item.url,
        proxyUrl: fallbackProxy || proxyUrl,
        timeoutMs: Math.max(timeoutMs, 60_000),
      });
      via = "hyper";
    }

    const sku = probe.sku || item.sku;
    const prev = state.has(sku) ? state.get(sku) : null;
    const inStock = probe.inStock;

    if (probe.ok) {
      log(
        `sku_poll ok sku=${sku} inStock=${inStock} title=${(probe.title || "").slice(0, 40)} via=${via}`,
      );
    } else if (probe.blocked) {
      log(`sku_poll blocked ${sku}: ${probe.error || "blocked"}`);
    } else {
      log(`sku_poll fail ${sku}: ${probe.error || "unknown"}`);
    }

    if (probe.ok && inStock === true) {
      if (!isPublishableTitle(probe.title)) {
        log(`sku_poll DROP restock ${sku} — garbage/missing title "${probe.title || ""}"`);
      } else if (prev !== true) {
        const evt = makeMonitorEvent({
          type: "restock",
          title: probe.title,
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
          log(`PUBLISH restock ${sku} ${probe.title}`);
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
  // Fast loop — light HTML probes. Override with MONITOR_POLL_MS.
  const ms = Math.max(1500, Number(process.env.MONITOR_POLL_MS) || 4000);
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

  setTimeout(tick, 500);
  return {
    stop: () => {
      stopped = true;
    },
  };
}

module.exports = { pollSkuOnce, startSkuPoller };
