// Pokémon Centre (PKC) stock monitor — same event contract as Bandai.
// Sticky Hyper edge warm (Incapsula Reese84 + DataDome) → BFF search + product/status
// + sitemap/category discovery.
// Emits stock_changed for soft_listed (hours-ahead) / preload / restock / OOS.
// Decoupled from checkout. AU-first — no US-lag lead (AU SKUs rarely match US).

import { EventEmitter } from "node:events";
// Use slim undici helpers (same as Bandai) for dispatcher/jar. Session/edge still
// pull request() via adapters → http.js (baked into the Railway monitor image).
import { makeDispatcher, createJar, request as undiciRequest } from "./http-undici.js";
import { createMonitorProxyPool } from "./monitor-proxy-pool.js";
import { createPcSession, normalizePcLocale, pcBaseFor, PC_ORIGIN } from "../adapters/pokemoncentre-session.js";
import { warmPokemonCentre } from "../adapters/pokemoncentre-edge.js";
import {
  getPublicToken,
  cortexApiHeaders,
  PC_API_BASE,
  PC_CORTEX_SCOPE,
} from "../adapters/pokemoncentre-cortex.js";
import { hyperConfigured } from "../antibot.js";

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** Cortex scope by storefront locale (override via PC_*_SCOPE env). */
export function cortexScopeForLocale(locale) {
  const loc = normalizePcLocale(locale) || "en-au";
  if (loc === "en-au") return process.env.PC_AU_SCOPE || "pokemon-au";
  if (loc === "en-nz") return process.env.PC_NZ_SCOPE || "pokemon-nz";
  if (loc === "en-ca") return process.env.PC_CA_SCOPE || "pokemon-ca";
  if (loc === "en-gb") return process.env.PC_GB_SCOPE || "pokemon-uk";
  if (loc === "en-us") return process.env.PC_US_SCOPE || "pokemon";
  return PC_CORTEX_SCOPE;
}

function parseList(raw) {
  if (Array.isArray(raw)) return raw.map((s) => String(s || "").trim()).filter(Boolean);
  return String(raw || "")
    .split(/[\n,|]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function parseBool(raw, fallback) {
  if (raw == null || raw === "") return fallback;
  const s = String(raw).trim().toLowerCase();
  if (["0", "false", "off", "no"].includes(s)) return false;
  if (["1", "true", "on", "yes"].includes(s)) return true;
  return fallback;
}

/**
 * Pull `/en-au/product/{sku}/…` (and sibling locales) from sitemap XML or category HTML.
 * @param {string} htmlOrXml
 * @param {{ locale?: string }} [opts]
 * @returns {{ sku: string, slug: string|null, locale: string, pdpUrl: string }[]}
 */
export function extractPcProductUrls(htmlOrXml, { locale = "en-au" } = {}) {
  const text = String(htmlOrXml || "");
  if (!text) return [];
  const prefer = String(locale || "en-au").toLowerCase();
  const re =
    /(?:https?:\/\/(?:www\.)?pokemoncenter\.com)?\/(en-[a-z]{2})\/product\/([A-Za-z0-9._-]+)(?:\/([A-Za-z0-9._-]+))?/gi;
  /** @type {Map<string, { sku: string, slug: string|null, locale: string, pdpUrl: string }>} */
  const bySku = new Map();
  for (const m of text.matchAll(re)) {
    const loc = String(m[1] || prefer).toLowerCase();
    // Prefer AU (or configured locale) URLs; still accept others if AU missing.
    const sku = String(m[2] || "").trim();
    if (!sku) continue;
    const slug = m[3] ? String(m[3]).trim() : null;
    const key = sku.toUpperCase();
    const pdpUrl = `${PC_ORIGIN}/${loc}/product/${sku}${slug ? `/${slug}` : ""}`;
    const prev = bySku.get(key);
    if (!prev || (loc === prefer && prev.locale !== prefer)) {
      bySku.set(key, { sku, slug, locale: loc, pdpUrl });
    }
  }
  return [...bySku.values()];
}

/**
 * Normalize BFF search / product-status / PDP / discovery payload → catalog row.
 * Keeps NOT_AVAILABLE / coming-soon / bare search cards (hours-ahead soft list).
 * inStock true for AVAILABLE + AVAILABLE_FOR_PRE_ORDER + addToCartForm.
 */
export function normalizePcCatalogCard(p, { source } = {}) {
  if (!p || typeof p !== "object") return null;
  const productId = String(
    p.code || p.productCode || p.sku || p.productId || p.id || "",
  ).trim();
  if (!productId) return null;

  const titleRaw = p.name || p.title || p.productName || null;
  const availRaw = String(
    p.availability || p.stockStatus || p.status || p.inventoryStatus || "",
  ).toUpperCase();
  let inStock = null;
  let softListed = false;
  if (/AVAILABLE_FOR_PRE_ORDER|PRE[_-]?ORDER/i.test(availRaw)) inStock = true;
  else if (/^AVAILABLE$|IN[_-]?STOCK|IN STOCK/i.test(availRaw)) inStock = true;
  else if (/NOT_AVAILABLE|COMING[_ ]?SOON|UNAVAILABLE/i.test(availRaw)) {
    inStock = false;
    softListed = true;
  } else if (/SOLD_OUT|OUT_OF_STOCK/i.test(availRaw)) {
    inStock = false;
    // Still keep in snapshot so a later flip → restock; first-seen emits soft_listed.
    softListed = true;
  } else if (typeof p.inStock === "boolean") inStock = p.inStock;
  else if (typeof p.available === "boolean") inStock = p.available;
  else if (p.addToCartForm || p.epItemId) inStock = true;
  else if (
    titleRaw ||
    p.pdpUrl ||
    p.url ||
    p.slug ||
    /^search:|^sitemap|^category|^discovery/i.test(String(source || ""))
  ) {
    // Card / URL exists without a buyable enum — hours-ahead listing signal.
    inStock = false;
    softListed = true;
  }

  if (inStock == null) return null;

  const title = titleRaw;
  const imageUrl =
    p.imageUrl ||
    p.thumbnailUrl ||
    p.image ||
    (Array.isArray(p.images) ? p.images[0]?.url || p.images[0] : null) ||
    null;
  let price = null;
  const amt = p.purchasePrice?.amount ?? p.listPrice?.amount ?? p.price?.amount ?? p.price;
  if (amt != null && Number.isFinite(Number(amt))) {
    const cur = p.purchasePrice?.currency || p.listPrice?.currency || p.currency || "USD";
    price = `${cur} ${Number(amt).toFixed(Number(amt) % 1 ? 2 : 0)}`;
  }
  const slug = p.slug || p.seoSlug || null;
  const pdpUrl = p.pdpUrl || p.url || null;

  return {
    productId,
    inStock: Boolean(inStock),
    softListed: Boolean(softListed) && !inStock,
    availability: availRaw || null,
    preorder: /PRE[_-]?ORDER/i.test(availRaw),
    addToCartForm: p.addToCartForm || null,
    epItemId: p.epItemId || null,
    title: title ? String(title) : null,
    imageUrl: imageUrl ? String(imageUrl) : null,
    price,
    slug: slug ? String(slug) : null,
    pdpUrl: pdpUrl ? String(pdpUrl) : null,
    store: "pokemoncentre",
    source: source || null,
  };
}

/**
 * PKC catalog diff — includes hours-ahead soft_listed (new not-yet-buyable SKU).
 * Do not use Bandai diffCatalog: it ignores new OOS/listed rows.
 * @param {Map<string, object>} prev
 * @param {Map<string, object>} next
 */
export function diffPcCatalog(prev, next) {
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
      } else {
        events.push({
          productId: id,
          inStock: false,
          timestamp: now,
          reason: "soft_listed",
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

function extractSearchProducts(json) {
  if (!json || typeof json !== "object") return [];
  if (Array.isArray(json)) return json;
  const candidates = [
    json.docs,
    json.results,
    json.products,
    json.items,
    json.data?.docs,
    json.data?.results,
    json.data?.products,
    json.response?.docs,
    json.hits,
  ];
  for (const c of candidates) {
    if (Array.isArray(c)) return c;
  }
  return [];
}

/**
 * @param {object} [opts]
 */
export function createPokemonCentreStockMonitor(opts = {}) {
  const bus = new EventEmitter();
  bus.setMaxListeners(50);

  const locale = normalizePcLocale(opts.locale || process.env.PC_MONITOR_LOCALE || "en-au") || "en-au";
  const scope = opts.scope || cortexScopeForLocale(locale);
  const base = pcBaseFor(locale);
  let intervalMs = Math.max(
    5_000,
    Number(opts.intervalMs || process.env.PC_MONITOR_INTERVAL_MS) || 15_000,
  );
  const stickyPolls = Math.max(
    1,
    Number(opts.stickyPolls || process.env.PC_MONITOR_STICKY_POLLS) || 4,
  );
  const stickyMaxMs = Math.max(
    30_000,
    Number(opts.stickyMaxMs || process.env.PC_MONITOR_STICKY_MAX_MS) || 120_000,
  );
  const searchRows = Math.min(
    40,
    Math.max(5, Number(opts.searchRows || process.env.PC_MONITOR_SEARCH_ROWS) || 20),
  );
  // Watchlist is admin-dashboard owned (same as Bandai keywords). Env is bootstrap only.
  let keywords = parseList(opts.keywords ?? process.env.PC_MONITOR_KEYWORDS ?? "");
  let skus = parseList(opts.skus ?? process.env.PC_MONITOR_SKUS ?? "").map((s) => s.toUpperCase());
  // Sitemap + category URL discovery — catches random restock soft-publishes without a known SKU.
  let discoveryEnable = parseBool(
    opts.discoveryEnable ?? process.env.PC_MONITOR_DISCOVERY,
    true,
  );
  const discoveryPaths = parseList(
    opts.discoveryPaths ??
      process.env.PC_MONITOR_DISCOVERY_PATHS ??
      `/${locale}/category/trading-card-game,/sitemap.xml`,
  );
  const discoveryProbeLimit = Math.max(
    0,
    Math.min(
      40,
      Number(opts.discoveryProbeLimit ?? process.env.PC_MONITOR_DISCOVERY_PROBE_LIMIT) || 12,
    ),
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
  let rotates = 0;
  let loopGeneration = 0;
  let sticky = null;
  let proxyGate = Promise.resolve();
  let autoRestartTimer = null;
  let activePollAbort = null;
  let edgeWarms = 0;
  let hyperRequired = false;

  function stickyExpired() {
    if (!sticky) return true;
    if (sticky.used >= stickyPolls) return true;
    if (!sticky.edgeOk) return true;
    const age = Date.now() - (sticky.openedAt || 0);
    return age >= stickyMaxMs;
  }

  async function closeSticky() {
    const s = sticky;
    sticky = null;
    if (!s?.dispatcher) return;
    try {
      await Promise.race([
        s.dispatcher.close?.() || Promise.resolve(),
        sleep(1_500),
      ]);
    } catch {
      /* ignore */
    }
  }

  async function ensureEdge(session, ctx) {
    const warm = await warmPokemonCentre(session, ctx);
    edgeWarms += 1;
    if (!warm.ok) {
      const note = String(warm.note || "");
      if (/HYPER_API_KEY|hyper/i.test(note)) hyperRequired = true;
      return { ok: false, note: warm.note || "edge_warm_failed" };
    }
    const tok = await getPublicToken(session, ctx, { locale, scope });
    if (!tok.ok) {
      return { ok: false, note: tok.note || "public_token_failed" };
    }
    return { ok: true, note: warm.note || "edge+token ok", token: tok };
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
        if (!pick.ok) throw new Error(pick.error || "monitor_proxy_pool_exhausted");
        if (prevHost && pick.url !== prevHost) rotates += 1;
        else if (!prevHost) rotates += 1;
        const jar = createJar();
        const dispatcher = makeDispatcher(pick.url, { forceUndici: true });
        // Slim undici only — Railway monitor image has no tls-client; avoid full http.js.
        const ctx = { jar, dispatcher, request: undiciRequest };
        const session = createPcSession(ctx, { locale, request: undiciRequest });
        sticky = {
          url: pick.url,
          tier: pick.tier,
          jar,
          dispatcher,
          ctx,
          session,
          used: 0,
          openedAt: Date.now(),
          edgeOk: false,
        };
        const edge = await ensureEdge(session, ctx);
        if (!edge.ok) {
          pool.markFail(sticky?.url);
          await closeSticky();
          throw new Error(edge.note || "pc_edge_failed");
        }
        sticky.edgeOk = true;
        sticky.edgeNote = edge.note;
        pool.markOk(sticky?.url);
      }
      if (!sticky?.ctx || !sticky?.session) {
        throw new Error("pc_sticky_missing");
      }
      sticky.used += 1;
      try {
        const out = await fn(sticky.ctx, sticky);
        pool.markOk(sticky?.url);
        return out;
      } catch (e) {
        pool.markFail(sticky?.url);
        await closeSticky();
        throw e;
      }
    } finally {
      release?.();
    }
  }

  async function bffGet(session, path, signal) {
    const url = path.startsWith("http") ? path : `${PC_API_BASE}${path.startsWith("/") ? "" : "/"}${path}`;
    const token = session.state.cortexAuth?.accessToken;
    const headers = cortexApiHeaders({
      accessToken: token,
      locale,
      scope,
      referer: `${base}/`,
    });
    const res = await session.get(url, { headers, api: true });
    if (signal?.aborted) {
      const err = new Error("poll_aborted");
      err.code = "POLL_TIMEOUT";
      throw err;
    }
    const text = await session.readText(res);
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
    // Auth/WAF/upstream death — kill sticky so the next attempt re-warms edge.
    if (res.status === 403 || res.status === 401 || res.status >= 500) {
      if (sticky) sticky.edgeOk = false;
      const snippet = String(text || "")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 120);
      const err = new Error(snippet ? `bff_${res.status}:${snippet}` : `bff_${res.status}`);
      err.status = res.status;
      throw err;
    }
    if (res.status >= 400) {
      if (sticky) sticky.edgeOk = false;
      const err = new Error(`bff_${res.status}`);
      err.status = res.status;
      throw err;
    }
    return { status: res.status, json, text };
  }

  async function fetchCatalogOnce(signal) {
    const run = async (ctx, meta) => {
      const session = meta.session;
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
        try {
          const { json } = await bffGet(session, `/search?q=${q}&rows=${searchRows}`, signal);
          const products = extractSearchProducts(json);
          let n = 0;
          for (const p of products) {
            const row = normalizePcCatalogCard(p, { source: `search:${kw}` });
            if (!row) continue;
            next.set(row.productId.toUpperCase(), { ...row, productId: row.productId });
            n += 1;
          }
          sources.push({ kind: "search", keyword: kw, count: n, ok: true });
        } catch (e) {
          sources.push({
            kind: "search",
            keyword: kw,
            ok: false,
            note: e?.message || String(e),
          });
          throw e;
        }
        await sleep(120 + Math.floor(Math.random() * 180));
      }

      for (const sku of skus) {
        if (signal?.aborted) {
          const err = new Error("poll_aborted");
          err.code = "POLL_TIMEOUT";
          throw err;
        }
        try {
          const { json } = await bffGet(
            session,
            `/product/status/${encodeURIComponent(sku)}`,
            signal,
          );
          const payload = json?.product || json?.data || json;
          const row = normalizePcCatalogCard(
            { ...(payload && typeof payload === "object" ? payload : {}), code: sku, ...(typeof payload === "string" ? { availability: payload } : {}) },
            { source: "product_status" },
          );
          // Some status payloads are bare enum strings
          let final = row;
          if (!final && typeof json?.availability === "string") {
            final = normalizePcCatalogCard(
              { code: sku, availability: json.availability, name: json.name || json.title },
              { source: "product_status" },
            );
          }
          if (!final && typeof json === "object") {
            final = normalizePcCatalogCard(
              { code: sku, availability: json.status || json.availability, name: json.name },
              { source: "product_status" },
            );
          }
          if (final) {
            const id = final.productId.toUpperCase();
            const prev = next.get(id);
            // Status is authoritative for watched SKUs
            next.set(id, { ...prev, ...final, productId: final.productId });
            sources.push({
              kind: "product_status",
              sku,
              ok: true,
              inStock: final.inStock,
              softListed: Boolean(final.softListed),
            });
          } else {
            sources.push({ kind: "product_status", sku, ok: true, note: "unparsed" });
          }
        } catch (e) {
          sources.push({
            kind: "product_status",
            sku,
            ok: false,
            note: e?.message || String(e),
          });
          // Don't kill whole poll for one SKU miss unless auth died
          if (e?.status === 401 || e?.status === 403) throw e;
        }
        await sleep(80 + Math.floor(Math.random() * 120));
      }

      // ── Sitemap / category discovery (hours-ahead URL soft-publish) ──
      if (discoveryEnable && discoveryPaths.length) {
        /** @type {Array<{ sku: string, slug: string|null, locale: string, pdpUrl: string, from: string }>} */
        const discovered = [];
        for (const pathTry of discoveryPaths) {
          if (signal?.aborted) {
            const err = new Error("poll_aborted");
            err.code = "POLL_TIMEOUT";
            throw err;
          }
          const path = pathTry.startsWith("/") ? pathTry : `/${pathTry}`;
          const url = path.startsWith("http") ? path : `${PC_ORIGIN}${path}`;
          try {
            const res = await session.get(url, {
              headers: { referer: `${base}/` },
            });
            const text = await session.readText(res);
            if (res.status === 403 || res.status === 401 || res.status >= 500) {
              if (sticky) sticky.edgeOk = false;
              const err = new Error(`discovery_${res.status}`);
              err.status = res.status;
              throw err;
            }
            const found = extractPcProductUrls(text, { locale });
            for (const f of found) {
              discovered.push({ ...f, from: path });
            }
            sources.push({
              kind: "discovery",
              path,
              ok: true,
              status: res.status,
              urls: found.length,
            });
          } catch (e) {
            sources.push({
              kind: "discovery",
              path,
              ok: false,
              note: e?.message || String(e),
            });
            if (e?.status === 401 || e?.status === 403) throw e;
          }
          await sleep(150 + Math.floor(Math.random() * 200));
        }

        // Prefer new SKUs (not already in this poll's catalog / prior snapshot).
        const novel = [];
        const seenDisc = new Set();
        for (const f of discovered) {
          const id = f.sku.toUpperCase();
          if (seenDisc.has(id)) continue;
          seenDisc.add(id);
          if (next.has(id) || snapshot.has(id)) continue;
          novel.push(f);
        }

        let probed = 0;
        for (const f of novel) {
          if (signal?.aborted) break;
          const id = f.sku.toUpperCase();
          let row = normalizePcCatalogCard(
            {
              code: f.sku,
              slug: f.slug,
              pdpUrl: f.pdpUrl,
              name: f.slug ? f.slug.replace(/-/g, " ") : null,
              availability: "NOT_AVAILABLE",
            },
            { source: f.from.includes("sitemap") ? "sitemap" : "category" },
          );
          if (probed < discoveryProbeLimit) {
            try {
              const { json } = await bffGet(
                session,
                `/product/status/${encodeURIComponent(f.sku)}`,
                signal,
              );
              probed += 1;
              const payload = json?.product || json?.data || json;
              const statusRow = normalizePcCatalogCard(
                {
                  ...(payload && typeof payload === "object" ? payload : {}),
                  code: f.sku,
                  slug: f.slug,
                  pdpUrl: f.pdpUrl,
                  ...(typeof payload === "string" ? { availability: payload } : {}),
                },
                { source: "discovery_status" },
              );
              if (statusRow) row = { ...row, ...statusRow, pdpUrl: f.pdpUrl, slug: f.slug || statusRow.slug };
            } catch (e) {
              if (e?.status === 401 || e?.status === 403) throw e;
            }
            await sleep(60 + Math.floor(Math.random() * 100));
          }
          if (row) next.set(id, { ...row, productId: row.productId || f.sku });
        }
        sources.push({
          kind: "discovery_novel",
          ok: true,
          novel: novel.length,
          probed,
          added: novel.filter((f) => next.has(f.sku.toUpperCase())).length,
        });
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
        edgeNote: meta.edgeNote || null,
      };
    };

    // Edge/DataDome flakes are often sticky-specific — rotate and retry.
    const maxAttempts = Math.max(1, Math.min(6, Number(process.env.PC_MONITOR_EDGE_RETRIES) || 3));
    let lastErr = null;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      if (signal?.aborted) {
        const err = new Error("poll_aborted");
        err.code = "POLL_TIMEOUT";
        throw err;
      }
      try {
        const out = await withProxyCtx(run);
        return { ...out, edgeAttempts: attempt };
      } catch (e) {
        lastErr = e;
        const msg = String(e?.message || e);
        const retryable =
          /pc_edge|pc_sticky|datadome|slider|puzzle|hcaptcha|interstitial|public_token|bff_40[13]|bff_5\d\d|discovery_40[13]|discovery_5\d\d|empty_fetch|cannot read properties/i.test(
            msg,
          );
        await closeSticky();
        if (!retryable || attempt >= maxAttempts) throw e;
        await sleep(350 + attempt * 250);
      }
    }
    throw lastErr || new Error("pc_poll_failed");
  }

  async function pollOnce() {
    const t0 = Date.now();
    const pollBudgetMs = Math.max(
      45_000,
      Number(process.env.PC_MONITOR_POLL_TIMEOUT_MS) || 120_000,
    );
    const ac = new AbortController();
    activePollAbort = ac;
    const timer = setTimeout(() => ac.abort(), pollBudgetMs);
    let catalog;
    let sources;
    let proxyTier;
    let proxyHost;
    let edgeNote;
    let edgeAttempts;
    try {
      const raced = await fetchCatalogOnce(ac.signal);
      catalog = raced.catalog;
      sources = raced.sources;
      proxyTier = raced.proxyTier;
      proxyHost = raced.proxyHost;
      edgeNote = raced.edgeNote;
      edgeAttempts = raced.edgeAttempts;
    } catch (e) {
      if (sticky?.url) pool.markFail(sticky.url);
      await closeSticky();
      if (
        ac.signal.aborted ||
        e?.code === "POLL_TIMEOUT" ||
        e?.name === "AbortError"
      ) {
        const err = new Error(`poll_timeout_${pollBudgetMs}ms`);
        err.code = "POLL_TIMEOUT";
        throw err;
      }
      throw e;
    } finally {
      clearTimeout(timer);
      if (activePollAbort === ac) activePollAbort = null;
    }

    // Key map by uppercase for stable diffs
    const keyed = new Map();
    for (const [id, row] of catalog) {
      keyed.set(String(id).toUpperCase(), { ...row, productId: row.productId || id });
    }

    const prev = snapshot;
    const first = prev.size === 0;
    const events = first ? [] : diffPcCatalog(prev, keyed);
    snapshot = keyed;
    polls += 1;
    lastPollAt = Date.now();
    lastError = null;

    const summary = {
      at: Date.now(),
      ms: Date.now() - t0,
      polls,
      products: keyed.size,
      inStock: [...keyed.values()].filter((r) => r.inStock).length,
      softListed: [...keyed.values()].filter((r) => r.softListed || (!r.inStock && r.availability)).length,
      events: events.length,
      firstSnapshot: first,
      sources,
      proxyTier,
      proxyHost,
      intervalMs,
      locale,
      store: "pokemoncentre",
      discoveryEnable,
      edgeNote,
      edgeAttempts,
    };
    bus.emit("poll", summary);

    for (const ev of events) {
      const m = ev.meta || {};
      const reason =
        ev.reason === "new_in_stock" && m.preorder ? "preorder_live" : ev.reason;
      bus.emit("stock_changed", {
        productId: ev.productId,
        inStock: ev.inStock,
        timestamp: ev.timestamp,
        reason,
        store: "pokemoncentre",
        locale,
        title: m.title || null,
        imageUrl: m.imageUrl || null,
        price: m.price || null,
        availability: m.availability || null,
        preorder: Boolean(m.preorder),
        softListed: Boolean(m.softListed) || reason === "soft_listed",
        slug: m.slug || null,
        pdpUrl: m.pdpUrl || null,
        meta: {
          title: m.title || null,
          imageUrl: m.imageUrl || null,
          price: m.price || null,
          availability: m.availability || null,
          preorder: Boolean(m.preorder),
          softListed: Boolean(m.softListed) || reason === "soft_listed",
          slug: m.slug || null,
          pdpUrl: m.pdpUrl || null,
          source: m.source || null,
          store: "pokemoncentre",
          locale,
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
        bus.emit("error", { at: Date.now(), error: lastError, polls, store: "pokemoncentre" });
        await sleep(Math.min(intervalMs, 8_000));
      }
      if (!running || stopping) break;
      await sleep(intervalMs);
    }
  }

  function start() {
    if (running) return;
    // Keywords/SKUs optional when sitemap/category discovery is on (random restock catch).
    if (!keywords.length && !skus.length && !discoveryEnable) {
      lastError = "pc_monitor_needs_keywords_skus_or_discovery";
      bus.emit("error", { at: Date.now(), error: lastError, polls: 0 });
      return;
    }
    if (!hyperConfigured()) {
      hyperRequired = true;
      // Still start — clear home may work; Reese/DD needs Hyper when challenged.
      bus.emit("error", {
        at: Date.now(),
        error: "HYPER_API_KEY missing — PKC edge solve unavailable until set",
        polls: 0,
        warn: true,
      });
    }
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
        if (myGen !== loopGeneration) return;
        const intentional = stopping;
        running = false;
        loopPromise = null;
        if (!intentional) {
          autoRestartTimer = setTimeout(() => {
            autoRestartTimer = null;
            if (!running && !stopping) {
              restarts += 1;
              bus.emit("watchdog", { at: Date.now(), reason: "loop_exited", restarts });
              start();
            }
          }, 2_000);
        }
      });
    bus.emit("started", {
      at: Date.now(),
      intervalMs,
      keywords,
      skus,
      discoveryEnable,
      discoveryPaths,
      locale,
      scope,
      store: "pokemoncentre",
      pool: pool.stats(),
      origin: PC_ORIGIN,
    });
  }

  async function stop() {
    stopping = true;
    running = false;
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
    if (pending) await Promise.race([pending.catch(() => {}), sleep(5_000)]);
    await closeSticky();
    bus.emit("stopped", { at: Date.now(), polls, store: "pokemoncentre" });
  }

  async function restart(reason = "manual") {
    restarts += 1;
    bus.emit("watchdog", {
      at: Date.now(),
      reason: String(reason || "restart"),
      restarts,
      store: "pokemoncentre",
    });
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

  function status() {
    return {
      running,
      polls,
      intervalMs,
      stickyPolls,
      stickyMaxMs,
      rotates,
      locale,
      scope,
      store: "pokemoncentre",
      keywords,
      skus,
      discoveryEnable,
      discoveryPaths,
      products: snapshot.size,
      inStock: [...snapshot.values()].filter((r) => r.inStock).length,
      softListed: [...snapshot.values()].filter((r) => !r.inStock).length,
      lastError,
      lastPollAt,
      startedAt,
      restarts,
      edgeWarms,
      hyperRequired,
      hyperConfigured: hyperConfigured(),
      staleMs: lastPollAt
        ? Date.now() - lastPollAt
        : startedAt
          ? Date.now() - startedAt
          : null,
      pool: pool.stats(),
    };
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
    status,
    getCatalog() {
      return new Map(snapshot);
    },
    getProduct(productId) {
      const id = String(productId || "").trim().toUpperCase();
      if (!id) return null;
      return snapshot.get(id) || null;
    },
    setKeywords(raw) {
      keywords = parseList(raw);
      return [...keywords];
    },
    setSkus(raw) {
      skus = parseList(raw).map((s) => s.toUpperCase());
      return [...skus];
    },
    setDiscoveryEnable(on) {
      discoveryEnable = Boolean(on);
      return discoveryEnable;
    },
    setIntervalMs(ms) {
      intervalMs = Math.max(5_000, Number(ms) || intervalMs);
      return intervalMs;
    },
    replaceProxies(patch = {}) {
      if (typeof pool.replaceLists !== "function") throw new Error("proxy_pool_immutable");
      return pool.replaceLists(patch);
    },
    _setSnapshotForTest(map) {
      snapshot = map instanceof Map ? map : new Map(Object.entries(map || {}));
    },
  };
}

export default {
  createPokemonCentreStockMonitor,
  normalizePcCatalogCard,
  diffPcCatalog,
  extractPcProductUrls,
  cortexScopeForLocale,
};
