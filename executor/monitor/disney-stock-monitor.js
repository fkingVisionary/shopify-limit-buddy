// Disney Store AU global stock monitor — decoupled from checkout adapters.
// Polls SFCC search PLP (not per-SKU PDP), diffs tealium product cards, emits stock_changed.
//
// Emits: stock_changed({ productId, inStock, timestamp, title, reason })
// Has zero knowledge of tasks / profiles / payment.

import { EventEmitter } from "node:events";
import { createJar, makeDispatcher, request, UA } from "../http.js";
import { DISNEY_ORIGIN, disneyUrls } from "../adapters/disney-session.js";
import { createMonitorProxyPool } from "./monitor-proxy-pool.js";
import { diffCatalog } from "./bandai-stock-monitor.js";

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function navHeaders(referer) {
  return {
    "user-agent": UA,
    accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "accept-language": "en-AU,en;q=0.9",
    "upgrade-insecure-requests": "1",
    ...(referer ? { referer } : {}),
  };
}

/**
 * Normalize a Disney search PLP tealium card / tile into a snapshot row.
 * @param {object} p
 */
export function normalizeDisneyCatalogCard(p) {
  if (!p || typeof p !== "object") return null;
  const productId = String(p.id || p.pid || p.productId || p.variant_id || "").trim();
  if (!productId || !/^\d{6,}$/.test(productId)) return null;
  const availability = String(p.availability || p.stock || "").toLowerCase();
  const badge = String(p.badge || "").toLowerCase();
  const message = String(p.message || "").toLowerCase();
  const soldOut =
    p.soldOut === true ||
    /out.?of.?stock|sold.?out|unavailable/.test(`${availability} ${badge} ${message}`);
  const comingSoon = /coming.?soon/.test(`${availability} ${badge} ${message}`);
  const inStockMarker =
    /in_stock|in.stock|available/.test(availability) || availability === "online - in_stock";
  const inStock = Boolean(productId && !soldOut && !comingSoon && (inStockMarker || !availability));
  return {
    productId,
    inStock,
    availability: p.availability || null,
    title: p.name || p.title || null,
    price: p.price || null,
    badge: p.badge || null,
    href: p.href || p.url || null,
  };
}

/**
 * Parse SFCC search HTML → catalog Map keyed by pid.
 * @param {string} html
 * @returns {Map<string, object>}
 */
export function parseDisneySearchCatalog(html) {
  /** @type {Map<string, object>} */
  const next = new Map();
  const h = String(html || "");
  const attrs = [...h.matchAll(/data-tealium-productstring=(["'])([\s\S]*?)\1/gi)];
  for (const m of attrs) {
    let raw = m[2] || "";
    raw = raw
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">");
    let te = null;
    try {
      te = JSON.parse(raw);
    } catch {
      continue;
    }
    const row = normalizeDisneyCatalogCard(te);
    if (!row) continue;
    next.set(row.productId, { ...row, source: "search" });
  }

  // Fallback: data-pid tiles without tealium (stock unknown → treat as listed/in-stock).
  if (!next.size) {
    for (const m of h.matchAll(/data-pid=["'](\d{6,})["']/gi)) {
      const pid = m[1];
      if (next.has(pid)) continue;
      const row = normalizeDisneyCatalogCard({ id: pid, name: null, availability: "online - in_stock" });
      if (row) next.set(pid, { ...row, source: "data-pid" });
    }
  }
  return next;
}

/**
 * @param {object} [opts]
 */
export function createDisneyStockMonitor(opts = {}) {
  const bus = new EventEmitter();
  bus.setMaxListeners(50);

  const origin = String(opts.origin || process.env.DISNEY_MONITOR_ORIGIN || DISNEY_ORIGIN).replace(
    /\/$/,
    "",
  );
  const urls = disneyUrls({ origin });
  const intervalMs = Math.max(
    2_000,
    Number(opts.intervalMs || process.env.DISNEY_MONITOR_INTERVAL_MS) || 10_000,
  );
  const stickyPolls = Math.max(
    1,
    Number(opts.stickyPolls || process.env.DISNEY_MONITOR_STICKY_POLLS) || 6,
  );
  const keywords = parseKeywords(
    opts.keywords || process.env.DISNEY_MONITOR_KEYWORDS || "lorcana",
  );

  const pool =
    opts.proxyPool ||
    createMonitorProxyPool({
      ispRaw: opts.ispRaw || process.env.DISNEY_MONITOR_ISP_PROXIES || "",
      dcRaw: opts.dcRaw || process.env.DISNEY_MONITOR_DC_PROXIES || "",
      ispFile: opts.ispFile || process.env.DISNEY_MONITOR_ISP_FILE,
      dcFile: opts.dcFile || process.env.DISNEY_MONITOR_DC_FILE,
      ispRatio: Number(opts.ispRatio || process.env.DISNEY_MONITOR_ISP_RATIO) || 0.8,
      // Fall back to shared monitor/isp.proxies (same files Bandai uses) when Disney envs empty.
      ...(opts.proxy || {}),
    });

  /** @type {Map<string, object>} */
  let snapshot = new Map();
  let running = false;
  let stopping = false;
  let loopPromise = null;
  let polls = 0;
  let lastError = null;
  let sticky = null;

  async function withProxyCtx(fn) {
    if (!sticky || sticky.used >= stickyPolls) {
      await closeSticky();
      const pick = pool.next();
      if (!pick.ok) {
        throw new Error(pick.error || "monitor_proxy_pool_exhausted");
      }
      const jar = createJar();
      // Disney browse is friendlier on TLS (same as checkout adapter default).
      const dispatcher = makeDispatcher(pick.url, { forceTls: true });
      sticky = {
        url: pick.url,
        tier: pick.tier,
        jar,
        dispatcher,
        used: 0,
        ctx: { jar, dispatcher },
      };
      try {
        const res = await request(urls.home, { method: "GET", headers: navHeaders() }, sticky.ctx);
        sticky.jar.ingest?.(res.headers);
        if (res.status >= 400) {
          pool.markFail(sticky.url);
          await closeSticky();
          throw new Error(`warm_${res.status}`);
        }
        pool.markOk(sticky.url);
      } catch (e) {
        pool.markFail(sticky.url);
        await closeSticky();
        throw e;
      }
    }
    sticky.used += 1;
    try {
      const out = await fn(sticky.ctx, sticky);
      pool.markOk(sticky.url);
      return out;
    } catch (e) {
      pool.markFail(sticky.url);
      await closeSticky();
      throw e;
    }
  }

  async function closeSticky() {
    if (!sticky) return;
    try {
      await sticky.dispatcher?.close?.();
    } catch {
      /* ignore */
    }
    sticky = null;
  }

  async function fetchCatalogOnce() {
    return withProxyCtx(async (ctx, meta) => {
      /** @type {Map<string, object>} */
      const next = new Map();
      const sources = [];

      for (const kw of keywords) {
        const q = encodeURIComponent(kw);
        const searchUrl = `${origin}/search?q=${q}`;
        const res = await request(
          searchUrl,
          { method: "GET", headers: navHeaders(urls.home) },
          ctx,
        );
        ctx.jar?.ingest?.(res.headers);
        const html = await res.text();
        if (res.status >= 400) {
          const err = new Error(`search_${res.status}`);
          err.status = res.status;
          throw err;
        }
        const catalog = parseDisneySearchCatalog(html);
        let n = 0;
        for (const [id, row] of catalog) {
          next.set(id, { ...row, source: `search:${kw}` });
          n += 1;
        }
        sources.push({ kind: "search", keyword: kw, count: n, status: res.status });
        await sleep(150 + Math.floor(Math.random() * 200));
      }

      return {
        catalog: next,
        sources,
        proxyTier: meta.tier,
        proxyHost: String(meta.url || "")
          .replace(/^https?:\/\//, "")
          .split("@")
          .pop()
          ?.split(":")[0],
      };
    });
  }

  async function pollOnce() {
    const t0 = Date.now();
    const { catalog, sources, proxyTier, proxyHost } = await fetchCatalogOnce();
    const prev = snapshot;
    const first = prev.size === 0;
    const events = first ? [] : diffCatalog(prev, catalog);
    snapshot = catalog;
    polls += 1;
    lastError = null;

    const summary = {
      at: Date.now(),
      ms: Date.now() - t0,
      polls,
      products: catalog.size,
      inStock: [...catalog.values()].filter((r) => r.inStock).length,
      events: events.length,
      firstSnapshot: first,
      sources,
      proxyTier,
      proxyHost,
      intervalMs,
    };
    bus.emit("poll", summary);

    for (const ev of events) {
      bus.emit("stock_changed", {
        productId: ev.productId,
        inStock: ev.inStock,
        timestamp: ev.timestamp,
        reason: ev.reason,
        store: "disney",
        title: ev.meta?.title || null,
      });
    }
    return { summary, events };
  }

  async function loop() {
    while (running && !stopping) {
      try {
        await pollOnce();
      } catch (e) {
        lastError = e?.message || String(e);
        bus.emit("error", {
          at: Date.now(),
          error: lastError,
          polls,
        });
        await sleep(Math.min(intervalMs, 5_000));
      }
      if (!running || stopping) break;
      await sleep(intervalMs);
    }
  }

  function start() {
    if (running) return;
    running = true;
    stopping = false;
    loopPromise = loop().finally(() => {
      running = false;
      loopPromise = null;
    });
    bus.emit("started", {
      at: Date.now(),
      intervalMs,
      keywords,
      origin,
      pool: pool.stats(),
    });
  }

  async function stop() {
    stopping = true;
    running = false;
    await loopPromise?.catch?.(() => {});
    await closeSticky();
    bus.emit("stopped", { at: Date.now(), polls });
  }

  return {
    on: (...a) => bus.on(...a),
    off: (...a) => bus.off(...a),
    once: (...a) => bus.once(...a),
    emit: (...a) => bus.emit(...a),
    start,
    stop,
    pollOnce,
    _setSnapshotForTest(map) {
      snapshot = map instanceof Map ? map : new Map(Object.entries(map || {}));
    },
    status() {
      return {
        running,
        polls,
        intervalMs,
        stickyPolls,
        origin,
        keywords,
        products: snapshot.size,
        inStock: [...snapshot.values()].filter((r) => r.inStock).length,
        lastError,
        pool: pool.stats(),
      };
    },
  };
}

function parseKeywords(raw) {
  if (Array.isArray(raw)) {
    return raw.map((s) => String(s || "").trim()).filter(Boolean);
  }
  return String(raw || "")
    .split(/[,|]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

export { diffCatalog };
export default { createDisneyStockMonitor, normalizeDisneyCatalogCard, parseDisneySearchCatalog };
