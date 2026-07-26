// Bandai global stock monitor — fully decoupled from checkout adapters.
// Polls list/search endpoints (NOT per-SKU PDP) and emits stock_changed.
//
// Emits: stock_changed({ productId, inStock, timestamp, meta })
// Has zero knowledge of tasks / profiles / payment.

import { EventEmitter } from "node:events";
import { createJar, makeDispatcher, request, UA } from "../http.js";
import { createMonitorProxyPool } from "./monitor-proxy-pool.js";

const ORIGIN = "https://p-bandai.com";

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function areaLang(area) {
  const a = String(area || "au").toLowerCase();
  if (a === "fr") return "fr";
  return "en";
}

function navHeaders(area, referer) {
  const a = String(area || "au").toLowerCase();
  return {
    "user-agent": UA,
    accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "accept-language": a === "fr" ? "fr-FR,fr;q=0.9" : "en-AU,en;q=0.9",
    "upgrade-insecure-requests": "1",
    ...(referer ? { referer } : {}),
  };
}

function apiHeaders(area, referer) {
  const a = String(area || "au").toLowerCase();
  return {
    "user-agent": UA,
    accept: "application/json, text/plain, */*",
    "accept-language": areaLang(a),
    "x-g1-area-code": a,
    "x-requested-with": "XMLHttpRequest",
    origin: ORIGIN,
    referer: referer || `${ORIGIN}/${a}/`,
  };
}

/**
 * Normalize a search/list card into a snapshot row.
 * @param {object} p
 */
export function normalizeCatalogCard(p) {
  if (!p || typeof p !== "object") return null;
  const productId = String(p.productCode || p.code || p.productSn || "").trim();
  if (!productId) return null;
  const purchaseAvailable = Boolean(p.purchaseAvailable);
  const flags = Array.isArray(p.flags) ? p.flags.map(String) : [];
  const oos = flags.some((f) => /OUT_OF_STOCK/i.test(f));
  const inStock = purchaseAvailable && !oos;
  return {
    productId,
    inStock,
    purchaseAvailable,
    saleStatus: p.saleStatus || null,
    productType: p.productType || null,
    title: p.productName || p.name || null,
    flags,
  };
}

/**
 * Diff previous → next catalog maps. Emits restocks + newly seen in-stock items.
 * @param {Map<string, object>|null} prev
 * @param {Map<string, object>} next
 * @returns {object[]}
 */
export function diffCatalog(prev, next) {
  const events = [];
  const now = Date.now();
  for (const [id, row] of next) {
    const before = prev?.get(id);
    if (!before) {
      if (row.inStock) {
        events.push({
          productId: id,
          inStock: true,
          timestamp: now,
          reason: "new_in_stock",
          meta: row,
        });
      }
      continue;
    }
    if (!before.inStock && row.inStock) {
      events.push({
        productId: id,
        inStock: true,
        timestamp: now,
        reason: "restock",
        meta: row,
      });
    } else if (before.inStock && !row.inStock) {
      events.push({
        productId: id,
        inStock: false,
        timestamp: now,
        reason: "went_oos",
        meta: row,
      });
    }
  }
  return events;
}

/**
 * @param {object} [opts]
 */
export function createBandaiStockMonitor(opts = {}) {
  const bus = new EventEmitter();
  bus.setMaxListeners(50);

  const area = String(opts.area || process.env.BANDAI_MONITOR_AREA || "au").toLowerCase();
  const base = `${ORIGIN}/${area}`;
  const intervalMs = Math.max(
    2_000,
    Number(opts.intervalMs || process.env.BANDAI_MONITOR_INTERVAL_MS) || 10_000,
  );
  const stickyPolls = Math.max(
    1,
    Number(opts.stickyPolls || process.env.BANDAI_MONITOR_STICKY_POLLS) || 6,
  );
  const searchLimit = Math.min(
    60,
    Math.max(10, Number(opts.searchLimit || process.env.BANDAI_MONITOR_SEARCH_LIMIT) || 40),
  );
  const keywords = parseKeywords(
    opts.keywords || process.env.BANDAI_MONITOR_KEYWORDS || "ONE PIECE",
  );

  const pool = opts.proxyPool || createMonitorProxyPool(opts.proxy || {});
  /** @type {Map<string, object>} */
  let snapshot = new Map();
  let running = false;
  let stopping = false;
  let loopPromise = null;
  let polls = 0;
  let lastError = null;
  let sticky = null; // { url, tier, jar, dispatcher, used }

  async function withProxyCtx(fn) {
    if (!sticky || sticky.used >= stickyPolls) {
      await closeSticky();
      const pick = pool.next();
      if (!pick.ok) {
        throw new Error(pick.error || "monitor_proxy_pool_exhausted");
      }
      const jar = createJar();
      const dispatcher = makeDispatcher(pick.url, { forceUndici: true });
      sticky = {
        url: pick.url,
        tier: pick.tier,
        jar,
        dispatcher,
        used: 0,
        ctx: { jar, dispatcher },
      };
      // Warm once per sticky window — cheap guest HTML for cookies.
      try {
        const res = await request(
          `${base}/`,
          { method: "GET", headers: navHeaders(area) },
          sticky.ctx,
        );
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

  async function apiGet(ctx, path, referer) {
    const url = path.startsWith("http") ? path : `${ORIGIN}${path}`;
    const res = await request(
      url,
      { method: "GET", headers: apiHeaders(area, referer || `${base}/`) },
      ctx,
    );
    ctx.jar?.ingest?.(res.headers);
    let json = null;
    try {
      json = await res.json();
    } catch {
      json = null;
    }
    if (res.status >= 400) {
      const err = new Error(`api_${res.status}`);
      err.status = res.status;
      throw err;
    }
    return { status: res.status, json };
  }

  async function fetchCatalogOnce() {
    return withProxyCtx(async (ctx, meta) => {
      /** @type {Map<string, object>} */
      const next = new Map();
      const sources = [];

      for (const kw of keywords) {
        const q = encodeURIComponent(kw);
        const { json } = await apiGet(
          ctx,
          `/api/search?keyword=${q}&offset=0&limit=${searchLimit}`,
          `${base}/search?keyword=${q}`,
        );
        const products =
          json?.productResults?.products || json?.products || json?.items || [];
        let n = 0;
        for (const p of Array.isArray(products) ? products : []) {
          const row = normalizeCatalogCard(p);
          if (!row) continue;
          next.set(row.productId, { ...row, source: `search:${kw}` });
          n += 1;
        }
        sources.push({ kind: "search", keyword: kw, count: n });
        // Small gap between keywords on same sticky exit — avoid burst shapes.
        await sleep(150 + Math.floor(Math.random() * 200));
      }

      // Trends are keywords only — useful log signal, not product cards.
      try {
        const { json } = await apiGet(ctx, `/api/search/topSearched`, `${base}/`);
        const trends = Array.isArray(json)
          ? json
          : json?.keywords || json?.topSearched || json?.data || [];
        sources.push({
          kind: "topSearched",
          count: Array.isArray(trends) ? trends.length : 0,
          sample: (Array.isArray(trends) ? trends : []).slice(0, 5),
        });
      } catch {
        sources.push({ kind: "topSearched", ok: false });
      }

      return {
        catalog: next,
        sources,
        proxyTier: meta.tier,
        proxyHost: String(meta.url || "").replace(/^https?:\/\//, "").split("@").pop()?.split(":")[0],
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
      // Hot-path event — keep payload small.
      bus.emit("stock_changed", {
        productId: ev.productId,
        inStock: ev.inStock,
        timestamp: ev.timestamp,
        reason: ev.reason,
        area,
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
        // Back off slightly on failure without dying.
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
    bus.emit("started", { at: Date.now(), intervalMs, keywords, area, pool: pool.stats() });
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
    /** Test/helper: replace snapshot without polling. */
    _setSnapshotForTest(map) {
      snapshot = map instanceof Map ? map : new Map(Object.entries(map || {}));
    },
    status() {
      return {
        running,
        polls,
        intervalMs,
        stickyPolls,
        area,
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

export default { createBandaiStockMonitor, normalizeCatalogCard, diffCatalog };
