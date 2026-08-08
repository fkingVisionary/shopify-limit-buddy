// Bandai global stock monitor — fully decoupled from checkout adapters.
// Polls list/search endpoints (NOT per-SKU PDP) and emits stock_changed.
//
// Emits: stock_changed({ productId, inStock, timestamp, meta })
// Has zero knowledge of tasks / profiles / payment.

import { EventEmitter } from "node:events";
import {
  closeWithTimeout,
  createJar,
  makeDispatcher,
  request,
  UA,
} from "./http-undici.js";
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
  const flags = Array.isArray(p.flags) ? p.flags.map(String) : [];
  const oos = flags.some((f) => /OUT_OF_STOCK/i.test(f));
  // Search/list cards often OMIT purchaseAvailable entirely — stock is signaled by
  // the OUT_OF_STOCK flag (and saleStatus). Requiring Boolean(purchaseAvailable)
  // made every search card look OOS forever → no Discord restock pings.
  const hasPurchaseField =
    Object.prototype.hasOwnProperty.call(p, "purchaseAvailable") &&
    p.purchaseAvailable != null;
  const saleOn =
    !p.saleStatus || /^(on|sale|available)$/i.test(String(p.saleStatus).trim());
  const purchaseAvailable = hasPurchaseField ? Boolean(p.purchaseAvailable) : !oos && saleOn;
  const inStock = purchaseAvailable && !oos && saleOn;
  const areaItemNos = Array.isArray(p.areaItemNos)
    ? p.areaItemNos.map(String).filter(Boolean)
    : [];
  const areaItemNo =
    (areaItemNos[0] && String(areaItemNos[0])) ||
    (p.areaItemNo != null ? String(p.areaItemNo).trim() : null) ||
    (p.areaProductNo != null ? String(p.areaProductNo).trim() : null) ||
    null;

  let title = null;
  const pn = p.productName || p.name || null;
  if (typeof pn === "string") title = pn;
  else if (pn && typeof pn === "object") title = pn.en || pn.fr || Object.values(pn)[0] || null;

  const imgs = Array.isArray(p.productImages) ? p.productImages : [];
  const fileUrl = imgs.find((i) => i?.fileUrl)?.fileUrl || p.imageUrl || p.thumbnailUrl || null;
  const imageUrl = fileUrl
    ? String(fileUrl).startsWith("http")
      ? String(fileUrl)
      : `https://p-bandai.com/${String(fileUrl).replace(/^\//, "")}`
    : null;

  const priceAmt = p.fixedListPrice?.amount ?? p.listPrice?.amount ?? p.price?.amount ?? null;
  const priceCur = p.fixedListPrice?.currency || p.listPrice?.currency || p.price?.currency || "AUD";
  const price =
    priceAmt != null && Number.isFinite(Number(priceAmt))
      ? `${priceCur} ${Number(priceAmt).toFixed(Number(priceAmt) % 1 ? 2 : 0)}`
      : null;

  return {
    productId,
    inStock,
    purchaseAvailable,
    saleStatus: p.saleStatus || null,
    productType: p.productType || null,
    title: title ? String(title) : null,
    imageUrl,
    price,
    flags,
    ...(areaItemNo ? { areaItemNo } : {}),
    ...(areaItemNos.length ? { areaItemNos } : {}),
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
          ...(row.areaItemNo ? { areaItemNo: row.areaItemNo } : {}),
          ...(row.areaItemNos ? { areaItemNos: row.areaItemNos } : {}),
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
        ...(row.areaItemNo ? { areaItemNo: row.areaItemNo } : {}),
        ...(row.areaItemNos ? { areaItemNos: row.areaItemNos } : {}),
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
  let intervalMs = Math.max(
    2_000,
    Number(opts.intervalMs || process.env.BANDAI_MONITOR_INTERVAL_MS) || 10_000,
  );
  const stickyPolls = Math.max(
    1,
    Number(opts.stickyPolls || process.env.BANDAI_MONITOR_STICKY_POLLS) || 3,
  );
  /** Wall-clock cap on one exit — thin rotate even if poll count is under stickyPolls. */
  const stickyMaxMs = Math.max(
    15_000,
    Number(opts.stickyMaxMs || process.env.BANDAI_MONITOR_STICKY_MAX_MS) || 75_000,
  );
  const searchLimit = Math.min(
    60,
    Math.max(10, Number(opts.searchLimit || process.env.BANDAI_MONITOR_SEARCH_LIMIT) || 40),
  );
  let keywords = parseKeywords(
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
  let lastPollAt = null;
  let startedAt = null;
  let restarts = 0;
  let sticky = null; // { url, tier, jar, dispatcher, used, openedAt }
  /** Serialize proxy sessions so force-poll can't race the loop mid-request. */
  let proxyGate = Promise.resolve();
  let autoRestartTimer = null;
  let rotates = 0;
  /** Bumps on stop so a stuck loop's finally cannot auto-restart / clobber a new loop. */
  let loopGeneration = 0;
  /** In-flight poll abort — stop()/restart() must cancel, not wait forever. */
  let activePollAbort = null;

  function stickyExpired() {
    if (!sticky) return true;
    if (sticky.used >= stickyPolls) return true;
    const age = Date.now() - (sticky.openedAt || 0);
    return age >= stickyMaxMs;
  }

  async function withProxyCtx(fn) {
    const prev = proxyGate;
    let release;
    proxyGate = new Promise((r) => {
      release = r;
    });
    await prev;
    try {
      if (stickyExpired()) {
        const prevHost = sticky?.url || null;
        await closeSticky();
        const pick = pool.next();
        if (!pick.ok) {
          throw new Error(pick.error || "monitor_proxy_pool_exhausted");
        }
        if (prevHost && pick.url !== prevHost) rotates += 1;
        else if (!prevHost) rotates += 1;
        const jar = createJar();
        const dispatcher = makeDispatcher(pick.url, { forceUndici: true });
        sticky = {
          url: pick.url,
          tier: pick.tier,
          jar,
          dispatcher,
          used: 0,
          openedAt: Date.now(),
          recoveredFromExhaustion: Boolean(pick.recoveredFromExhaustion),
          ctx: { jar, dispatcher },
        };
        // Warm once per sticky window — cheap guest HTML for cookies.
        try {
          const res = await request(
            `${base}/`,
            {
              method: "GET",
              headers: navHeaders(area),
              timeoutMs: 15_000,
              signal: fn._signal,
            },
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
    } finally {
      release?.();
    }
  }

  async function closeSticky() {
    // Drop the sticky ref first so the next withProxyCtx can open a new exit
    // even if undici's ProxyAgent.close() never resolves (common hang ~every
    // sticky rotate — e.g. poll ~90 at 5s / 3-poll sticky).
    const s = sticky;
    sticky = null;
    if (!s?.dispatcher) return;
    await closeWithTimeout(s.dispatcher, 1_500);
  }

  async function apiGet(ctx, path, referer, signal) {
    const url = path.startsWith("http") ? path : `${ORIGIN}${path}`;
    const res = await request(
      url,
      {
        method: "GET",
        headers: apiHeaders(area, referer || `${base}/`),
        timeoutMs: 20_000,
        signal,
      },
      ctx,
    );
    ctx.jar?.ingest?.(res.headers);
    let json = null;
    try {
      // Body read can hang even after headers — hard-cap it.
      const bodyMs = Math.max(
        5_000,
        Number(process.env.BANDAI_MONITOR_BODY_TIMEOUT_MS) || 20_000,
      );
      json = await Promise.race([
        res.json(),
        sleep(bodyMs).then(() => {
          const err = new Error(`body_timeout_${bodyMs}ms`);
          err.code = "BODY_TIMEOUT";
          throw err;
        }),
      ]);
    } catch (e) {
      if (e?.code === "BODY_TIMEOUT") throw e;
      json = null;
    }
    if (res.status >= 400) {
      const err = new Error(`api_${res.status}`);
      err.status = res.status;
      throw err;
    }
    return { status: res.status, json };
  }

  async function fetchCatalogOnce(signal) {
    const run = async (ctx, meta) => {
      /** @type {Map<string, object>} */
      const next = new Map();
      const sources = [];

      for (const kw of keywords) {
        if (signal?.aborted) {
          const err = new Error("poll_aborted");
          err.code = "POLL_TIMEOUT";
          throw err;
        }
        const q = encodeURIComponent(kw);
        const { json } = await apiGet(
          ctx,
          `/api/search?keyword=${q}&offset=0&limit=${searchLimit}`,
          `${base}/search?keyword=${q}`,
          signal,
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
        const { json } = await apiGet(ctx, `/api/search/topSearched`, `${base}/`, signal);
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
    };
    run._signal = signal;
    return withProxyCtx(run);
  }

  async function pollOnce() {
    const t0 = Date.now();
    const pollBudgetMs = Math.max(
      30_000,
      Number(process.env.BANDAI_MONITOR_POLL_TIMEOUT_MS) || 90_000,
    );
    const ac = new AbortController();
    activePollAbort = ac;
    const timer = setTimeout(() => ac.abort(), pollBudgetMs);
    let catalog;
    let sources;
    let proxyTier;
    let proxyHost;
    try {
      const raced = await fetchCatalogOnce(ac.signal);
      catalog = raced.catalog;
      sources = raced.sources;
      proxyTier = raced.proxyTier;
      proxyHost = raced.proxyHost;
    } catch (e) {
      // Drop sticky session so the next attempt doesn't reuse a dead tunnel.
      if (sticky?.url) pool.markFail(sticky.url);
      await closeSticky();
      if (ac.signal.aborted || e?.code === "POLL_TIMEOUT" || e?.code === "BODY_TIMEOUT" || e?.name === "AbortError") {
        const err = new Error(`poll_timeout_${pollBudgetMs}ms`);
        err.code = "POLL_TIMEOUT";
        throw err;
      }
      throw e;
    } finally {
      clearTimeout(timer);
      if (activePollAbort === ac) activePollAbort = null;
    }
    const prev = snapshot;
    const first = prev.size === 0;
    const events = first ? [] : diffCatalog(prev, catalog);
    snapshot = catalog;
    polls += 1;
    lastPollAt = Date.now();
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
      // Hot-path — include search-card fields only (no extra HTTP).
      const m = ev.meta || {};
      bus.emit("stock_changed", {
        productId: ev.productId,
        inStock: ev.inStock,
        timestamp: ev.timestamp,
        reason: ev.reason,
        store: "bandai",
        area,
        title: m.title || null,
        imageUrl: m.imageUrl || null,
        price: m.price || null,
        productType: m.productType || null,
        areaItemNo: ev.areaItemNo || m.areaItemNo || null,
        meta: {
          title: m.title || null,
          imageUrl: m.imageUrl || null,
          price: m.price || null,
          productType: m.productType || null,
          areaItemNo: m.areaItemNo || null,
          store: "bandai",
        },
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
    if (autoRestartTimer) {
      clearTimeout(autoRestartTimer);
      autoRestartTimer = null;
    }
    running = true;
    stopping = false;
    startedAt = Date.now();
    const myGen = ++loopGeneration;
    loopPromise = loop()
      .catch((e) => {
        lastError = e?.message || String(e);
        bus.emit("error", { at: Date.now(), error: lastError, polls, fatal: true });
      })
      .finally(() => {
        // Ignore finally from a loop that stop() already abandoned.
        if (myGen !== loopGeneration) return;
        const intentional = stopping;
        running = false;
        loopPromise = null;
        // Unexpected exit — schedule a soft restart so overnight hangs don't stay dead.
        if (!intentional) {
          bus.emit("error", {
            at: Date.now(),
            error: "loop_exited",
            polls,
          });
          autoRestartTimer = setTimeout(() => {
            autoRestartTimer = null;
            if (!running && !stopping) {
              restarts += 1;
              bus.emit("watchdog", { at: Date.now(), reason: "loop_exited", restarts });
              start();
            }
          }, 1_500);
        }
      });
    bus.emit("started", { at: Date.now(), intervalMs, keywords, area, pool: pool.stats() });
  }

  async function stop() {
    stopping = true;
    running = false;
    // Invalidate current loop so a late finally cannot auto-restart on top of us.
    loopGeneration += 1;
    if (autoRestartTimer) {
      clearTimeout(autoRestartTimer);
      autoRestartTimer = null;
    }
    try {
      activePollAbort?.abort();
    } catch {
      /* ignore */
    }
    const pending = loopPromise;
    loopPromise = null;
    // Never block restart/watchdog on a stuck poll or ProxyAgent.close().
    if (pending) {
      await Promise.race([pending.catch(() => {}), sleep(5_000)]);
    }
    await closeSticky();
    bus.emit("stopped", { at: Date.now(), polls });
  }

  /**
   * Hard bounce: stop → clear proxy cooldowns → start.
   * Used by host watchdog when polls go quiet.
   */
  async function restart(reason = "manual") {
    restarts += 1;
    bus.emit("watchdog", { at: Date.now(), reason: String(reason || "restart"), restarts });
    await stop();
    try {
      pool.clearCooldowns?.();
    } catch {
      /* ignore */
    }
    stopping = false;
    start();
    return status();
  }

  return {
    on: (...a) => bus.on(...a),
    off: (...a) => bus.off(...a),
    once: (...a) => bus.once(...a),
    emit: (...a) => bus.emit(...a),
    start,
    stop,
    restart,
    pollOnce,
    /** Test/helper: replace snapshot without polling. */
    _setSnapshotForTest(map) {
      snapshot = map instanceof Map ? map : new Map(Object.entries(map || {}));
    },
    /** Test/helper: inject sticky session (e.g. hung dispatcher.close). */
    _setStickyForTest(value) {
      sticky = value;
    },
    status() {
      return {
        running,
        polls,
        intervalMs,
        stickyPolls,
        stickyMaxMs,
        rotates,
        area,
        keywords,
        products: snapshot.size,
        inStock: [...snapshot.values()].filter((r) => r.inStock).length,
        lastError,
        lastPollAt,
        startedAt,
        restarts,
        staleMs: lastPollAt
          ? Date.now() - lastPollAt
          : startedAt
            ? Date.now() - startedAt
            : null,
        pool: pool.stats(),
      };
    },
    /** Current search-card snapshot (for Discord test / debug). */
    getCatalog() {
      return new Map(snapshot);
    },
    getProduct(productId) {
      const id = String(productId || "").trim();
      if (!id) return null;
      if (snapshot.has(id)) return snapshot.get(id);
      const upper = id.toUpperCase();
      for (const [pid, row] of snapshot) {
        if (String(pid).toUpperCase() === upper) return row;
        if (String(row?.areaItemNo || "").toUpperCase() === upper) return row;
        if ((row?.areaItemNos || []).some((x) => String(x).toUpperCase() === upper)) return row;
      }
      return null;
    },
    /** Hot-reload search keywords (admin). */
    setKeywords(raw) {
      const next = parseKeywords(raw);
      if (!next.length) throw new Error("keywords_empty");
      keywords = next;
      return [...keywords];
    },
    setIntervalMs(ms) {
      intervalMs = Math.max(2_000, Number(ms) || intervalMs);
      return intervalMs;
    },
    /** Hot-replace monitor proxy pool lists (admin). */
    replaceProxies(patch = {}) {
      if (typeof pool.replaceLists !== "function") {
        throw new Error("proxy_pool_immutable");
      }
      return pool.replaceLists(patch);
    },
  };
}

function parseKeywords(raw) {
  if (Array.isArray(raw)) {
    return raw.map((s) => String(s || "").trim()).filter(Boolean);
  }
  return String(raw || "")
    .split(/[\n,|]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

export default { createBandaiStockMonitor, normalizeCatalogCard, diffCatalog };
