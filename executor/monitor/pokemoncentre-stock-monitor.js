// Pokémon Centre (PKC) stock monitor — same event contract as Bandai.
// Sticky Hyper edge warm (Incapsula Reese84 + DataDome) → BFF search + product/status
// + sitemap/category discovery.
// Emits stock_changed for soft_listed (hours-ahead) / preload / restock / OOS.
// Decoupled from checkout. AU-first — no US-lag lead (AU SKUs rarely match US).

import { EventEmitter } from "node:events";
// Bandai monitor stays on slim undici. PKC checkout proves DataDome on chrome_131
// tls-worker — default that transport here (undici often interstitial→captcha / timeout).
import { makeDispatcher, createJar, request as undiciRequest } from "./http-undici.js";
import { createMonitorProxyPool } from "./monitor-proxy-pool.js";
import { createPcSession, normalizePcLocale, pcBaseFor, PC_ORIGIN } from "../adapters/pokemoncentre-session.js";
import {
  warmPokemonCentre,
  clearIncapsulaReese,
  clearDataDome,
  solveDatadomeCaptchaUrl,
} from "../adapters/pokemoncentre-edge.js";
import {
  getPublicToken,
  cortexApiHeaders,
  parsePdpAvailability,
  PC_API_BASE,
  PC_CORTEX_SCOPE,
} from "../adapters/pokemoncentre-cortex.js";
import { hyperConfigured } from "../antibot.js";

/** Default PKC search keywords (admin can still edit; boot merges these in). */
export const PC_DEFAULT_KEYWORDS = ["TCG", "binder", "playmat", "deck"];

/** @type {null | Promise<{ makeRemoteTlsDispatcher: Function, createJar: Function, request: Function, UA: string } | null>} */
let httpTlsModulePromise = null;
async function loadHttpTls() {
  if (!httpTlsModulePromise) {
    httpTlsModulePromise = import("../http.js")
      .then((m) => ({
        makeRemoteTlsDispatcher: m.makeRemoteTlsDispatcher,
        createJar: m.createJar,
        request: m.request,
        UA: m.UA,
      }))
      .catch((e) => {
        httpTlsModulePromise = null;
        throw e;
      });
  }
  return httpTlsModulePromise;
}

function wantPcTlsWorker() {
  // Default ON — matches checkout ATC proof. Set PC_MONITOR_TLS_WORKER=0 to force undici.
  return parseBool(process.env.PC_MONITOR_TLS_WORKER, true);
}

function announceSoftCap() {
  return Math.max(1, Math.min(40, Number(process.env.PC_MONITOR_ANNOUNCE_LIMIT) || 8));
}

function looksBlockedHtml(html, status) {
  if (status === 403 || status === 401) return true;
  const h = String(html || "");
  if (h.length < 2_000) return true;
  return /Pardon Our Interruption|captcha-delivery|geo\.captcha-delivery|_Incapsula_Resource|datadome/i.test(
    h,
  );
}

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
/**
 * Pull product cards with availability from category/PLP HTML (__NEXT_DATA__ / JSON blobs).
 * Falls back to URL-only rows (unknown stock) via extractPcProductUrls.
 */
export function extractPcProductCardsFromHtml(htmlOrXml, { locale = "en-au", source = "category" } = {}) {
  const text = String(htmlOrXml || "");
  /** @type {Map<string, object>} */
  const bySku = new Map();
  const add = (raw) => {
    const row = normalizePcCatalogCard(raw, { source });
    if (!row) return;
    const id = row.productId.toUpperCase();
    const prev = bySku.get(id);
    // Prefer rows that carry a real availability enum.
    if (!prev || (row.availability && !prev.availability)) bySku.set(id, row);
    else if (!prev) bySku.set(id, row);
  };
  // code…availability (common Next serialize order)
  const reFwd =
    /"code"\s*:\s*"((?:10-|P[A-Z0-9-])[^"]+)"[\s\S]{0,500}?"availability"\s*:\s*"([A-Z_]+)"/gi;
  for (const m of text.matchAll(reFwd)) {
    add({ code: m[1], availability: m[2] });
  }
  const reRev =
    /"availability"\s*:\s*"([A-Z_]+)"[\s\S]{0,500}?"code"\s*:\s*"((?:10-|P[A-Z0-9-])[^"]+)"/gi;
  for (const m of text.matchAll(reRev)) {
    add({ code: m[2], availability: m[1] });
  }
  // Name near code when present
  const reName =
    /"code"\s*:\s*"((?:10-|P[A-Z0-9-])[^"]+)"[\s\S]{0,300}?"name"\s*:\s*"([^"]+)"/gi;
  for (const m of text.matchAll(reName)) {
    const id = String(m[1]).toUpperCase();
    const prev = bySku.get(id);
    if (prev && !prev.title) bySku.set(id, { ...prev, title: m[2] });
    else if (!prev) add({ code: m[1], name: m[2] });
  }
  // URL fallback for SKUs with no JSON card
  for (const u of extractPcProductUrls(text, { locale })) {
    const id = u.sku.toUpperCase();
    if (bySku.has(id)) {
      const prev = bySku.get(id);
      bySku.set(id, {
        ...prev,
        slug: prev.slug || u.slug,
        pdpUrl: prev.pdpUrl || u.pdpUrl,
      });
      continue;
    }
    add({
      code: u.sku,
      slug: u.slug,
      pdpUrl: u.pdpUrl,
      name: u.slug ? u.slug.replace(/-/g, " ") : null,
    });
  }
  return [...bySku.values()];
}

export function extractPcProductUrls(htmlOrXml, { locale = "en-au" } = {}) {
  const text = String(htmlOrXml || "");
  if (!text) return [];
  const prefer = String(locale || "en-au").toLowerCase();
  /** @type {Map<string, { sku: string, slug: string|null, locale: string, pdpUrl: string }>} */
  const bySku = new Map();
  const add = (loc, sku, slug) => {
    const s = String(sku || "").trim();
    if (!s || /^[0-9]+$/.test(s)) return; // bare numeric path noise
    const key = s.toUpperCase();
    const L = String(loc || prefer).toLowerCase();
    const sl = slug ? String(slug).trim() : null;
    const pdpUrl = `${PC_ORIGIN}/${L}/product/${s}${sl ? `/${sl}` : ""}`;
    const prev = bySku.get(key);
    if (!prev || (L === prefer && prev.locale !== prefer)) {
      bySku.set(key, { sku: s, slug: sl, locale: L, pdpUrl });
    }
  };
  // Locale-prefixed (sitemap + most PDPs)
  const reLoc =
    /(?:https?:\/\/(?:www\.)?pokemoncenter\.com)?\/(en-[a-z]{2})\/product\/([A-Za-z0-9._-]+)(?:\/([A-Za-z0-9._-]+))?/gi;
  for (const m of text.matchAll(reLoc)) {
    add(m[1], m[2], m[3]);
  }
  // Soft-clear / category shells often emit `/product/{sku}` without locale — same as
  // warm soft-clear productHits regex. Without this, discovery stays empty after a
  // successful soft-clear while BFF search is captcha'd.
  const reBare =
    /(?:https?:\/\/(?:www\.)?pokemoncenter\.com)?\/product\/([A-Za-z0-9._-]+)(?:\/([A-Za-z0-9._-]+))?/gi;
  for (const m of text.matchAll(reBare)) {
    add(prefer, m[1], m[2]);
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

/**
 * Build Discord-worthy events from a catalog snapshot (admin Force poll).
 * Prefers buyable / preload, then soft-listed watch hits. Caps spam.
 * @param {Map<string, object>|object[]} keyed
 * @param {{ skus?: string[], limit?: number }} [opts]
 */
export function buildPcAnnounceEvents(keyed, { skus = [], limit = 15 } = {}) {
  const skuSet = new Set((skus || []).map((s) => String(s).toUpperCase()));
  const rows = keyed instanceof Map ? [...keyed.values()] : Array.isArray(keyed) ? keyed : [];
  const score = (row) => {
    if (row?.inStock && row?.preorder) return 3;
    if (row?.inStock) return 2;
    if (row?.softListed || (!row?.inStock && row?.availability)) return 1;
    return 0;
  };
  const watched = (row) => {
    const id = String(row?.productId || "").toUpperCase();
    if (skuSet.has(id)) return true;
    const src = String(row?.source || "");
    // Include category/sitemap discovery — that's the hours-ahead soft-list path.
    return (
      src.startsWith("search:") ||
      src === "product_status" ||
      src === "discovery_status" ||
      src === "category" ||
      src === "sitemap" ||
      /^discovery/i.test(src)
    );
  };
  const picked = rows
    .filter((r) => score(r) > 0 && (watched(r) || score(r) >= 2))
    .sort(
      (a, b) =>
        score(b) - score(a) || String(a.productId || "").localeCompare(String(b.productId || "")),
    )
    .slice(0, Math.max(1, Math.min(40, Number(limit) || 15)));

  const now = Date.now();
  return picked.map((row) => {
    const soft = Boolean(row.softListed) || (!row.inStock && Boolean(row.availability));
    const reason = soft ? "soft_listed" : row.preorder ? "preorder_live" : "restock";
    return {
      productId: row.productId,
      inStock: Boolean(row.inStock),
      timestamp: now,
      reason,
      meta: { ...row, softListed: soft || reason === "soft_listed" },
    };
  });
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
  let keywords = parseList(
    opts.keywords ?? process.env.PC_MONITOR_KEYWORDS ?? PC_DEFAULT_KEYWORDS.join("\n"),
  );
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
  let lastTransport = null;
  let lastTransportNote = null;
  let tlsWorkerOk = null;
  /** Serialize live loop + Force poll so they don't kill each other's sticky. */
  let pollChain = Promise.resolve();

  function withPollLock(fn) {
    const run = pollChain.then(() => fn());
    pollChain = run.catch(() => {});
    return run;
  }

  function stickyExpired() {
    if (!sticky) return true;
    if (sticky.used >= stickyPolls) return true;
    if (!sticky.edgeOk) return true;
    const age = Date.now() - (sticky.openedAt || 0);
    return age >= stickyMaxMs;
  }

  async function closeDispatcher(slot) {
    if (!slot?.dispatcher) return;
    try {
      await Promise.race([
        slot.dispatcher.close?.() || Promise.resolve(),
        sleep(1_500),
      ]);
    } catch {
      /* ignore */
    }
  }

  async function closeSticky() {
    const s = sticky;
    sticky = null;
    await closeDispatcher(s);
  }

  /** Acquire proxyGate so stop/restart cannot null sticky mid-ensureEdge. */
  async function withProxyGate(fn) {
    const prev = proxyGate;
    let release;
    proxyGate = new Promise((r) => {
      release = r;
    });
    await prev;
    try {
      return await fn();
    } finally {
      release?.();
    }
  }

  async function ensureEdge(session, ctx) {
    // light: skip 2nd DD pass only — still solve interstitial/slider (required on this pool).
    const warm = await warmPokemonCentre(session, ctx, { light: true });
    edgeWarms += 1;
    if (!warm.ok) {
      const note = String(warm.note || "");
      if (/HYPER_API_KEY|hyper/i.test(note)) hyperRequired = true;
      // Only trust explicit Hyper/SDK flags — never infer burn from note text / URL t=bv.
      const isIpBanned = Boolean(warm.datadome?.isIpBanned || warm.isIpBanned);
      return {
        ok: false,
        note: warm.note || "edge_warm_failed",
        isIpBanned,
        datadome: warm.datadome || null,
      };
    }
    // Checkout grind: remint Reese before BFF auth (Imperva often 403s without it).
    try {
      await clearIncapsulaReese(session, ctx, { pageUrl: `${base}/`, html: "" });
    } catch {
      /* best-effort */
    }

    // Monitor never posts DataDome tags — tags escalate BFF/HTML to captcha 403.
    // Checkout still does tags before ATC; stock poll only needs Reese+DD cookie + token.
    let tok = null;
    try {
      tok = await getPublicToken(session, ctx, { locale, scope });
    } catch {
      tok = { ok: false, note: "public_token_failed" };
    }
    if (!tok?.ok && !warm.softClear) {
      return { ok: false, note: tok?.note || "public_token_failed", isIpBanned: false };
    }
    return {
      ok: true,
      softClear: Boolean(warm.softClear),
      note: [warm.note || "edge ok", tok?.ok ? tok.note : "html-discovery (no BFF token)"]
        .filter(Boolean)
        .join(" · "),
      token: tok?.ok ? tok : null,
    };
  }

  async function openStickyTransport(proxyUrl) {
    const preferTls = wantPcTlsWorker();
    if (preferTls) {
      try {
        const http = await loadHttpTls();
        const dispatcher = await http.makeRemoteTlsDispatcher(proxyUrl);
        if (dispatcher?.proxyParseFailed) {
          throw new Error("proxy_parse_failed");
        }
        const jar = http.createJar();
        const ctx = { jar, dispatcher, request: http.request };
        const session = createPcSession(ctx, {
          locale,
          userAgent: http.UA,
          request: http.request,
        });
        tlsWorkerOk = true;
        lastTransport = "tls-worker";
        lastTransportNote = "tls-worker chrome_131 (checkout path)";
        return { jar, dispatcher, ctx, session, transport: "tls-worker" };
      } catch (e) {
        tlsWorkerOk = false;
        lastTransportNote = `tls-worker init failed: ${e?.message || e}`.slice(0, 240);
        // Do not fall back to undici for PKC — undici BFF is what escalates to captcha/t=bv.
        throw new Error(`pc_tls_required: ${lastTransportNote}`);
      }
    }
    // Explicit undici only when PC_MONITOR_TLS_WORKER=0 (lab).
    const jar = createJar();
    const dispatcher = makeDispatcher(proxyUrl, { forceUndici: true });
    const ctx = { jar, dispatcher, request: undiciRequest };
    const session = createPcSession(ctx, { locale, request: undiciRequest });
    lastTransport = "undici";
    lastTransportNote = "undici (PC_MONITOR_TLS_WORKER=0)";
    return { jar, dispatcher, ctx, session, transport: "undici" };
  }

  async function withProxyCtx(fn) {
    return withProxyGate(async () => {
      if (stickyExpired()) {
        const prevHost = sticky?.url || null;
        await closeSticky();
        const pick = pool.next();
        if (!pick.ok) throw new Error(pick.error || "monitor_proxy_pool_exhausted");
        if (prevHost && pick.url !== prevHost) rotates += 1;
        else if (!prevHost) rotates += 1;
        const opened = await openStickyTransport(pick.url);
        // Local slot — never write edgeOk on a nulled `sticky` after stop() races.
        const slot = {
          url: pick.url,
          tier: pick.tier,
          jar: opened.jar,
          dispatcher: opened.dispatcher,
          ctx: opened.ctx,
          session: opened.session,
          transport: opened.transport,
          used: 0,
          openedAt: Date.now(),
          edgeOk: false,
          edgeNote: null,
        };
        sticky = slot;
        const edge = await ensureEdge(opened.session, opened.ctx);
        if (!edge.ok) {
          // Short cool on edge fail — do not 20min-ban the ISP pool on client DD noise.
          const banned = Boolean(edge.isIpBanned);
          pool.markFail(slot.url, banned ? 60_000 : undefined);
          if (sticky === slot) await closeSticky();
          else await closeDispatcher(slot);
          const note = edge.note || "pc_edge_failed";
          const err = new Error(note);
          err.isIpBanned = banned;
          err.code = banned ? "PC_EDGE_TBV" : "PC_EDGE_FAIL";
          throw err;
        }
        slot.edgeOk = true;
        slot.edgeNote = edge.note || null;
        if (sticky !== slot) {
          await closeDispatcher(slot);
          throw new Error("pc_sticky_superseded");
        }
        pool.markOk(slot.url);
      }
      const cur = sticky;
      if (!cur?.ctx || !cur?.session) {
        throw new Error("pc_sticky_missing");
      }
      cur.used += 1;
      try {
        const out = await fn(cur.ctx, cur);
        pool.markOk(cur.url);
        return out;
      } catch (e) {
        const msg = String(e?.message || e);
        // Cool only on explicit SDK hard-block — message matching was proxy-blaming false positives.
        const banned = e?.isIpBanned === true;
        // Keep warm sticky for catalog-empty / BFF captcha / BFF 5xx — HTML discovery needs cookies.
        const keepSticky =
          e?.code === "PC_CATALOG_EMPTY" ||
          /bff_5\d\d/i.test(msg) ||
          (/bff_403/i.test(msg) && /captcha-delivery|datadome/i.test(msg));
        if (!keepSticky) {
          pool.markFail(cur.url, banned ? 60_000 : undefined);
          if (sticky === cur) await closeSticky();
          else await closeDispatcher(cur);
        }
        throw e;
      }
    });
  }

  async function remintBffAuth(session, ctx) {
    try {
      await clearIncapsulaReese(session, ctx, { pageUrl: `${base}/`, html: "" });
    } catch {
      /* ignore */
    }
    return getPublicToken(session, ctx, { locale, scope });
  }

  async function bffGet(session, path, signal, { allowRemint = true } = {}) {
    const url = path.startsWith("http") ? path : `${PC_API_BASE}${path.startsWith("/") ? "" : "/"}${path}`;
    const doOnce = async () => {
      const token = session.state.cortexAuth?.accessToken;
      // Match checkout probeCortex: cortex headers only — NOT api:true (that injects
      // cache-control/pragma/upgrade-insecure-requests + content-type on GET = DD tell).
      const headers = {
        ...cortexApiHeaders({
          accessToken: token,
          locale,
          scope,
          referer: `${base}/`,
          userAgent: session.state.userAgent,
          method: "GET",
        }),
        "sec-fetch-site": "same-origin",
        "sec-fetch-mode": "cors",
        "sec-fetch-dest": "empty",
        "accept-language": session.state.acceptLanguage || "en-AU,en;q=0.9",
        "user-agent": session.state.userAgent,
      };
      delete headers["content-type"];
      delete headers["Content-Type"];
      // No api:true — same as working checkout BFF GETs.
      const res = await session.get(url, { headers });
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
      return { res, text, json };
    };

    let { res, text, json } = await doOnce();

    // Captcha JSON on BFF is often client-shape (headers/TLS), not burnt IP.
    // Remint Reese + token and retry once before treating URL t=bv as hard ban.
    if (
      allowRemint &&
      sticky?.ctx &&
      res.status === 403 &&
      json?.url &&
      /captcha-delivery\.com\/captcha/i.test(String(json.url))
    ) {
      try {
        await remintBffAuth(session, sticky.ctx);
        ({ res, text, json } = await doOnce());
      } catch {
        /* fall through */
      }
      if (
        res.status === 403 &&
        json?.url &&
        /captcha-delivery\.com\/captcha/i.test(String(json.url))
      ) {
        // Soft fail — let search catch fall through to HTML discovery.
        // Do not mark isIpBanned from URL t=bv (client-shape false positive).
        try {
          const solved = await solveDatadomeCaptchaUrl(session, sticky.ctx, json.url, {
            pageUrl: `${base}/`,
          });
          if (solved?.ok) {
            await remintBffAuth(session, sticky.ctx);
            ({ res, text, json } = await doOnce());
          }
          // If still captcha / hard HTML ban: throw soft bff_403 (no isIpBanned) so
          // fetchCatalogOnce can still fill products from category/sitemap.
        } catch {
          /* soft */
        }
      }
    } else if (
      allowRemint &&
      sticky?.ctx &&
      (res.status === 401 || res.status === 403 || res.status >= 500)
    ) {
      const remint = await remintBffAuth(session, sticky.ctx);
      if (remint?.ok) {
        ({ res, text, json } = await doOnce());
      }
    }

    if (res.status === 403 || res.status === 401 || res.status >= 500) {
      // Keep sticky on BFF captcha / 5xx — HTML category/sitemap discovery still works.
      // Clearing edgeOk here was rotating the ISP pool on client BFF flake.
      const keepEdge =
        res.status >= 500 ||
        (res.status === 403 && /captcha-delivery|datadome/i.test(String(text || "")));
      if (!keepEdge && sticky) sticky.edgeOk = false;
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

      const hasToken = Boolean(session.state.cortexAuth?.accessToken);
      for (const kw of keywords) {
        if (signal?.aborted) {
          const err = new Error("poll_aborted");
          err.code = "POLL_TIMEOUT";
          throw err;
        }
        if (!hasToken) {
          sources.push({ kind: "search", keyword: kw, ok: false, note: "skipped_no_token" });
          continue;
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
            status: e?.status || null,
          });
          // BFF search 403/5xx must not abort — HTML category/sitemap discovery can
          // still fill the catalog (prod saw captcha 403 after edge soft-clear).
          if (e?.status === 401 && !/captcha-delivery|datadome/i.test(String(e?.message || ""))) {
            throw e;
          }
        }
        await sleep(120 + Math.floor(Math.random() * 180));
      }

      for (const sku of skus) {
        if (signal?.aborted) {
          const err = new Error("poll_aborted");
          err.code = "POLL_TIMEOUT";
          throw err;
        }
        if (!hasToken) {
          sources.push({ kind: "product_status", sku, ok: false, note: "skipped_no_token" });
          continue;
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
          // Don't kill whole poll for one SKU miss (captcha 403 → discovery can still win).
          if (e?.status === 401 && !/captcha-delivery|datadome/i.test(String(e?.message || ""))) {
            throw e;
          }
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
              const err = new Error(`discovery_${res.status}`);
              err.status = res.status;
              throw err;
            }
            const cards = extractPcProductCardsFromHtml(text, {
              locale,
              source: path.includes("sitemap") ? "sitemap" : "category",
            });
            for (const card of cards) {
              discovered.push({
                sku: card.productId,
                slug: card.slug || null,
                locale,
                pdpUrl: card.pdpUrl || null,
                title: card.title || null,
                availability: card.availability || null,
                inStock: card.inStock,
                softListed: card.softListed,
                imageUrl: card.imageUrl || null,
                price: card.price || null,
                from: path,
                card,
              });
            }
            sources.push({
              kind: "discovery",
              path,
              ok: true,
              status: res.status,
              urls: cards.length,
              inStock: cards.filter((c) => c.inStock).length,
            });
          } catch (e) {
            sources.push({
              kind: "discovery",
              path,
              ok: false,
              note: e?.message || String(e),
              status: e?.status || null,
            });
            // Try next discovery path — don't kill the poll on one 403 page.
          }
          await sleep(150 + Math.floor(Math.random() * 200));
        }

        // Seed catalog from ALL discovered URLs when BFF search failed / is empty.
        // Novel-only seeding left next.size=0 after the first poll (snapshot already had
        // those SKUs) → false PC_CATALOG_EMPTY + sticky rotate storm on BFF 5xx.
        const novel = [];
        const refresh = [];
        const seenDisc = new Set();
        for (const f of discovered) {
          const id = f.sku.toUpperCase();
          if (seenDisc.has(id)) continue;
          seenDisc.add(id);
          if (next.has(id)) continue; // already from BFF search this poll
          if (snapshot.has(id)) refresh.push(f);
          else novel.push(f);
        }
        const toSeed = [...novel, ...refresh];

        let probed = 0;
        let skipStatusProbe = sources.some(
          (s) =>
            s?.ok === false &&
            /bff_40[13]|bff_5\d\d|captcha-delivery|datadome/i.test(String(s?.note || "")),
        );
        for (const f of toSeed) {
          if (signal?.aborted) break;
          const id = f.sku.toUpperCase();
          const prevRow = snapshot.get(id);
          const fromCard = f.card || null;
          let row =
            fromCard ||
            normalizePcCatalogCard(
              {
                code: f.sku,
                slug: f.slug || prevRow?.slug || null,
                pdpUrl: f.pdpUrl || prevRow?.pdpUrl || null,
                name:
                  f.title ||
                  prevRow?.title ||
                  (f.slug ? f.slug.replace(/-/g, " ") : null),
                // Do NOT default to NOT_AVAILABLE — that mislabeled live stock as soft_listed.
                availability: f.availability || prevRow?.availability || null,
                imageUrl: f.imageUrl || prevRow?.imageUrl || null,
                price: f.price || prevRow?.price || null,
              },
              { source: f.from.includes("sitemap") ? "sitemap" : "category" },
            );
          if (row && prevRow) {
            const htmlKnowsStock =
              Boolean(f.availability) ||
              (fromCard && (fromCard.inStock === true || fromCard.availability));
            row = {
              ...prevRow,
              ...row,
              productId: row.productId || f.sku,
              inStock: htmlKnowsStock
                ? Boolean(row.inStock)
                : prevRow.inStock === true
                  ? true
                  : Boolean(row.inStock),
              softListed: htmlKnowsStock
                ? Boolean(row.softListed) && !row.inStock
                : prevRow.inStock === true
                  ? false
                  : Boolean(row.softListed || prevRow.softListed),
              availability: f.availability || row.availability || prevRow.availability || null,
            };
          }
          // Always keep HTML discovery rows — BFF status must not abort the catalog.
          if (row) next.set(id, { ...row, productId: row.productId || f.sku });
          // Only BFF-enrich novel SKUs (refresh already known from snapshot).
          const isNovel = !snapshot.has(id);
          if (isNovel && !skipStatusProbe && probed < discoveryProbeLimit) {
            try {
              const { json } = await bffGet(
                session,
                `/product/status/${encodeURIComponent(f.sku)}`,
                signal,
                { allowRemint: false },
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
              if (statusRow) {
                next.set(id, {
                  ...row,
                  ...statusRow,
                  pdpUrl: f.pdpUrl || statusRow.pdpUrl,
                  slug: f.slug || statusRow.slug,
                  productId: statusRow.productId || f.sku,
                });
              }
            } catch (e) {
              // Captcha/5xx on enrich — keep HTML rows; stop further BFF probes.
              if (e?.status === 401 || e?.status === 403 || e?.status >= 500) {
                skipStatusProbe = true;
              }
            }
            await sleep(60 + Math.floor(Math.random() * 100));
          }
        }

        // PDP HTML stock check — category URL-only rows defaulted soft and lied about live stock.
        const pdpProbeLimit = Math.max(
          0,
          Math.min(
            20,
            Number(process.env.PC_MONITOR_PDP_PROBE_LIMIT) || Math.max(6, announceSoftCap()),
          ),
        );
        let pdpProbed = 0;
        if (pdpProbeLimit > 0) {
          const kwRe = keywords.length
            ? new RegExp(keywords.map((k) => k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|"), "i")
            : null;
          const needsProbe = [...next.values()]
            .filter((r) => {
              const a = String(r.availability || "").toUpperCase();
              const src = String(r.source || "");
              if (!r.pdpUrl) return false;
              if (/AVAILABLE|SOLD_OUT|COMING/i.test(a) && a !== "NOT_AVAILABLE") return false;
              // Prefer unknown / URL-only soft rows from discovery.
              return /category|sitemap|discovery/i.test(src) || !a || a === "NOT_AVAILABLE";
            })
            .sort((a, b) => {
              const score = (r) => {
                const blob = `${r.title || ""} ${r.slug || ""} ${r.productId || ""}`;
                if (kwRe && kwRe.test(blob)) return 2;
                if (!snapshot.has(String(r.productId || "").toUpperCase())) return 1;
                return 0;
              };
              return score(b) - score(a);
            })
            .slice(0, pdpProbeLimit);
          for (const r of needsProbe) {
            if (signal?.aborted) break;
            try {
              const res = await session.get(r.pdpUrl, { headers: { referer: `${base}/` } });
              const html = await session.readText(res);
              if (res.status >= 400 || looksBlockedHtml(html, res.status)) continue;
              const pdp = parsePdpAvailability(html);
              const availEnum =
                pdp?.product?.availability ||
                (pdp?.available === true
                  ? "AVAILABLE"
                  : pdp?.available === false
                    ? "NOT_AVAILABLE"
                    : null);
              if (!availEnum && !pdp?.title) continue;
              const enriched = normalizePcCatalogCard(
                {
                  code: pdp?.code || r.productId,
                  name: pdp?.title || r.title,
                  availability: availEnum || r.availability,
                  addToCartForm: pdp?.addToCartForm || pdp?.product?.addToCartForm,
                  slug: r.slug,
                  pdpUrl: r.pdpUrl,
                  imageUrl: r.imageUrl,
                  price: r.price || pdp?.product?.purchasePrice || pdp?.product?.listPrice,
                },
                { source: "pdp_probe" },
              );
              if (enriched) {
                next.set(String(enriched.productId).toUpperCase(), {
                  ...r,
                  ...enriched,
                  pdpUrl: r.pdpUrl,
                  slug: r.slug || enriched.slug,
                });
                pdpProbed += 1;
              }
            } catch {
              /* keep prior row */
            }
            await sleep(80 + Math.floor(Math.random() * 120));
          }
        }

        sources.push({
          kind: "discovery_seed",
          ok: true,
          novel: novel.length,
          refresh: refresh.length,
          probed,
          pdpProbed,
          added: toSeed.filter((f) => next.has(f.sku.toUpperCase())).length,
          inStock: [...next.values()].filter((r) => r.inStock).length,
        });
      }

      if (next.size === 0) {
        const failNotes = sources
          .filter((s) => s && s.ok === false && s.note)
          .map((s) => s.note);
        const err = new Error(
          failNotes[0] || "pc_catalog_empty — search/discovery returned no products",
        );
        err.code = "PC_CATALOG_EMPTY";
        err.status = sources.find((s) => s?.status)?.status || null;
        throw err;
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
        transport: meta.transport || lastTransport,
      };
    };

    if (!hyperConfigured()) {
      hyperRequired = true;
      const err = new Error("HYPER_API_KEY missing — PKC edge needs Hyper (same as checkout)");
      err.code = "PC_HYPER_MISSING";
      throw err;
    }

    // tls-worker usually clears on first sticky (checkout path). undici may need more rotates.
    const poolSize = Number(pool.stats()?.isp || 0) + Number(pool.stats()?.dc || 0);
    const envAttempts = Number(process.env.PC_MONITOR_EDGE_RETRIES);
    // Full slider solve ≈20–40s/sticky — fewer attempts, longer budget.
    const defaultAttempts = wantPcTlsWorker()
      ? Math.min(6, Math.max(3, poolSize > 0 ? Math.ceil(poolSize * 0.08) : 3))
      : Math.min(15, Math.max(4, poolSize > 0 ? Math.min(12, Math.ceil(poolSize * 0.2)) : 4));
    const maxAttempts = Math.max(
      1,
      Math.min(24, Number.isFinite(envAttempts) && envAttempts > 0 ? envAttempts : defaultAttempts),
    );
    let lastErr = null;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      if (signal?.aborted) {
        const err = new Error("poll_aborted");
        err.code = "POLL_TIMEOUT";
        throw err;
      }
      try {
        const out = await withProxyCtx(run);
        return { ...out, edgeAttempts: attempt, edgeAttemptBudget: maxAttempts };
      } catch (e) {
        lastErr = e;
        const msg = String(e?.message || e);
        const retryable =
          e?.code === "PC_EDGE_TBV" ||
          e?.isIpBanned === true ||
          /pc_edge|pc_edge_tbv|t=bv|hard.?ip|hard.?block|rotate sticky|captcha URL|pc_sticky|datadome|slider|puzzle|hcaptcha|interstitial|public_token|bff_40[13]|bff_5\d\d|discovery_40[13]|discovery_5\d\d|empty_fetch|cannot (read|set) properties/i.test(
            msg,
          );
        // Soft BFF / empty catalog: remint on same sticky; keep edge for HTML discovery.
        const softBff =
          !e?.isIpBanned &&
          (/bff_5\d\d|pc_catalog_empty|bff_403.*captcha-delivery/i.test(msg) ||
            e?.code === "PC_CATALOG_EMPTY");
        if (softBff && attempt <= 2 && sticky?.session && sticky?.ctx) {
          try {
            const remint = await remintBffAuth(sticky.session, sticky.ctx);
            sticky.edgeOk = true; // discovery path still valid even if token remint fails
            if (!remint?.ok) sticky.edgeNote = remint?.note || sticky.edgeNote;
          } catch {
            sticky.edgeOk = true;
          }
        } else if (!softBff && !sticky?.edgeOk) {
          await closeSticky();
        } else if (!softBff) {
          await closeSticky();
        }
        if (!retryable || attempt >= maxAttempts) {
          if (attempt >= maxAttempts && retryable) {
            const why = e?.isIpBanned
              ? "Hyper SDK hard-block on session"
              : /bff_5\d\d/i.test(msg)
                ? "BFF 5xx after remint — client retry exhausted"
                : "edge/BFF client retries exhausted (TLS/headers/cookies — not pool burn)";
            const wrap = new Error(`${msg} · exhausted ${attempt}/${maxAttempts} stickies (${why})`);
            wrap.code = e?.code || "PC_EDGE_EXHAUSTED";
            wrap.isIpBanned = Boolean(e?.isIpBanned);
            throw wrap;
          }
          throw e;
        }
        await sleep(200 + attempt * 150);
      }
    }
    throw lastErr || new Error("pc_poll_failed");
  }

    /**
   * @param {{ announce?: boolean }} [opts]
   *   announce:true — admin Force poll: Discord current keyword/SKU hits (not only diffs).
   *   Live loop stays diff-only (first poll still baselines with no events).
   */
  async function pollOnce(opts = {}) {
    return withPollLock(() => pollOnceLocked(opts));
  }

  async function pollOnceLocked(opts = {}) {
    const announce = opts.announce === true;
    const t0 = Date.now();
    // Force poll: allow checkout-style edge warm (+ a few sticky rotates). Live loop stays tighter.
    const envBudget = Number(process.env.PC_MONITOR_POLL_TIMEOUT_MS);
    // Slider solves need headroom; Force poll stays generous.
    const defaultBudget = announce ? 360_000 : 300_000;
    const pollBudgetMs = Math.max(
      45_000,
      Number.isFinite(envBudget) && envBudget > 0 ? envBudget : defaultBudget,
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
    let transport;
    try {
      const raced = await fetchCatalogOnce(ac.signal);
      catalog = raced.catalog;
      sources = raced.sources;
      proxyTier = raced.proxyTier;
      proxyHost = raced.proxyHost;
      edgeNote = raced.edgeNote;
      edgeAttempts = raced.edgeAttempts;
      transport = raced.transport || lastTransport;
    } catch (e) {
      if (sticky?.url) pool.markFail(sticky.url);
      await withProxyGate(() => closeSticky());
      if (
        ac.signal.aborted ||
        e?.code === "POLL_TIMEOUT" ||
        e?.name === "AbortError"
      ) {
        const err = new Error(
          `poll_timeout_${pollBudgetMs}ms · transport=${lastTransport || "n/a"} · ${lastTransportNote || ""}`.trim(),
        );
        err.code = "POLL_TIMEOUT";
        err.transport = lastTransport;
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
    const announceLimit = announceSoftCap();
    let events;
    if (announce) {
      // Force poll: ping what the watchlist / discovery soft-list sees now.
      events = buildPcAnnounceEvents(keyed, { skus, limit: announceLimit });
    } else if (first) {
      // Cold start: still webhook hours-ahead soft_listed (capped) so Discord sees the
      // catalog — silent baseline hid the first 32 soft rows in prod.
      events = diffPcCatalog(prev, keyed)
        .filter((e) => e.reason === "soft_listed" || e.inStock === true)
        .slice(0, Math.max(1, Math.min(40, announceLimit)));
    } else {
      events = diffPcCatalog(prev, keyed);
    }
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
      firstSnapshot: first && !announce,
      announced: announce,
      sources,
      proxyTier,
      proxyHost,
      intervalMs,
      locale,
      store: "pokemoncentre",
      discoveryEnable,
      edgeNote,
      edgeAttempts,
      transport: transport || lastTransport,
      transportNote: lastTransportNote,
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
    // Wait for in-flight ensureEdge / BFF before nulling sticky (avoids edgeOk TypeError).
    await withProxyGate(() => closeSticky());
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
      transport: lastTransport,
      transportNote: lastTransportNote,
      tlsWorker: wantPcTlsWorker(),
      tlsWorkerOk,
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
  buildPcAnnounceEvents,
  extractPcProductUrls,
  extractPcProductCardsFromHtml,
  PC_DEFAULT_KEYWORDS,
  cortexScopeForLocale,
};
