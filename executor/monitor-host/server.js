#!/usr/bin/env node
/**
 * Always-on Bandai global stock monitor host (Railway / any Node host).
 *
 * - Polls search/list on monitor proxies (DC+ISP)
 * - Exposes /health, /status, /events (SSE), recent /hits
 * - Phone admin UI at /admin (keywords, proxies, Discord labs)
 * - Does NOT run checkout (Desktop / executor claim ATC later)
 *
 * Auth:
 *   MONITOR_TOKEN → Bearer for /status, admin, bot, writes.
 *   Consumer feed reads (/events, /hits, GET product-cache, GET preset-catalog)
 *   are public by default (MONITOR_FEED_PUBLIC unset/true) so Desktop needs zero
 *   Settings token. Set MONITOR_FEED_PUBLIC=0 to require Bearer on those too.
 *   /health stays open for Railway healthchecks. /admin HTML is public;
 *   admin API calls still need the token.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import Fastify from "fastify";
import fastifyStatic from "@fastify/static";
import { createGlobalMonitorHub } from "../monitor/global-monitor-hub.js";
import {
  vantaRestockDiscordBody,
  vantaOosDiscordBody,
  vantaPkcDiscordBody,
  vantaPkcOosDiscordBody,
  vantaPublicCheckoutDiscordBody,
  buildQuickTaskBridgeUrl,
  buildQuickTaskLocalUrl,
  pcPdpUrl,
  QUICKTASK_BRIDGE_PORT,
} from "./vanta-discord.mjs";
import { loadRuntimeConfig, saveRuntimeConfig, runtimePersistenceInfo } from "./runtime-config.mjs";
import { parseMutedSkus, mutedSkusText, isSkuMuted } from "./muted-skus.mjs";
import { computeMonitorStale, shouldWatchdogRestart } from "./monitor-watchdog.mjs";
import {
  parsePresetCatalogBulk,
  normalizePresetCatalogRaw,
} from "./preset-catalog.mjs";
import { enrichPresetTitles } from "./enrich-preset-titles.mjs";
import {
  loadProductCache,
  saveProductCache,
  upsertProductEntries,
  lookupProduct,
  mergeRowsWithProductCache,
  listProductCache,
  isBackendPid,
} from "./product-cache.mjs";
import { loadBotVault, saveBotVault, vaultPublicView } from "./bot-vault.mjs";
import {
  executorFetch,
  executorStatus,
  buildBandaiLabPayload,
  buildKmartLabPayload,
  redactRunPayload,
} from "./bot-executor.mjs";
import { labLog, getLabLogs, clearLabLogs, labLogStats } from "./lab-log.mjs";

/**
 * Pokémon Centre poller — dynamic import so a missing slim-image dep
 * (http.js / antibot / hyper-sdk-js) cannot brick Bandai boot on Railway.
 */
function createDisabledPcMonitor(reason) {
  const note = String(reason || "pkc_unavailable");
  const ee = {
    on() {
      return ee;
    },
    start() {
      return { ok: false, note };
    },
    async stop() {
      return { ok: true, note };
    },
    async restart() {
      return { ok: false, note };
    },
    async pollOnce() {
      return { summary: { ok: false, note }, events: [] };
    },
    setKeywords() {
      return [];
    },
    setSkus() {
      return [];
    },
    setIntervalMs(ms) {
      return Number(ms) || 15_000;
    },
    replaceProxies() {
      return { ok: false, note };
    },
    status() {
      return {
        store: "pokemoncentre",
        enabled: false,
        running: false,
        available: false,
        note,
      };
    },
  };
  return ee;
}

let createPokemonCentreStockMonitor;
try {
  ({ createPokemonCentreStockMonitor } = await import("../monitor/pokemoncentre-stock-monitor.js"));
} catch (e) {
  const msg = e?.message || String(e);
  console.error(`[pkc] module load failed — Bandai-only mode: ${msg}`);
  createPokemonCentreStockMonitor = () => createDisabledPcMonitor(msg);
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 8080;
const TOKEN = String(process.env.MONITOR_TOKEN || process.env.EXECUTOR_TOKEN || "").trim();
// Desktop SSE / catalog / product-cache reads — public unless explicitly locked.
const FEED_PUBLIC = !/^(0|false|no|off)$/i.test(String(process.env.MONITOR_FEED_PUBLIC ?? "1").trim());
const AREA = process.env.BANDAI_MONITOR_AREA || "au";
const MAX_HITS = Math.max(20, Math.min(500, Number(process.env.MONITOR_HIT_BUFFER) || 100));

/** @type {ReturnType<typeof loadRuntimeConfig>} */
let runtime = loadRuntimeConfig();
const persistence = () => runtimePersistenceInfo(runtime._path);
console.log(
  JSON.stringify({
    event: "runtime_persistence",
    ...persistence(),
    fromDisk: Boolean(runtime._fromDisk),
    ispLines: String(runtime.ispProxies || "")
      .split(/\r?\n/)
      .filter((l) => l.trim() && !l.trim().startsWith("#")).length,
    dcLines: String(runtime.dcProxies || "")
      .split(/\r?\n/)
      .filter((l) => l.trim() && !l.trim().startsWith("#")).length,
  }),
);

/** Shared SKU → NAI cache for all Desktop members. */
let productCache = loadProductCache();
let productCacheDirty = false;
let productCacheFlushTimer = null;

function rememberProducts(incoming, source = "monitor") {
  const { cache, changed } = upsertProductEntries(productCache, incoming, { source, area: AREA });
  if (!changed) return 0;
  productCache = cache;
  productCacheDirty = true;
  if (!productCacheFlushTimer) {
    productCacheFlushTimer = setTimeout(() => {
      productCacheFlushTimer = null;
      flushProductCache();
    }, 2_000);
  }
  return changed;
}

function flushProductCache() {
  if (!productCacheDirty) return productCache;
  productCache = saveProductCache(productCache, productCache._path);
  productCacheDirty = false;
  return productCache;
}

function presetRowsForResponse(raw) {
  const parsed = parsePresetCatalogBulk(raw, { defaultArea: AREA });
  return mergeRowsWithProductCache(parsed, productCache, AREA);
}

/** @type {object[]} */
const recentHits = [];
/** @type {Set<import('node:http').ServerResponse>} */
const sseClients = new Set();

/** @type {ReturnType<typeof loadBotVault>} */
let botVault = loadBotVault();
/** @type {object[]} in-memory lab runs (newest first) */
const botRuns = [];
const MAX_BOT_RUNS = 40;

function authOk(req) {
  if (!TOKEN) return true;
  const h = String(req.headers.authorization || "");
  const m = h.match(/^Bearer\s+(.+)$/i);
  if (m && m[1].trim() === TOKEN) return true;
  const q = String(req.query?.token || "").trim();
  return Boolean(q && q === TOKEN);
}

/** Stock feed + Desktop read APIs — public by default (no per-user MONITOR_TOKEN). */
function feedAuthOk(req) {
  if (FEED_PUBLIC) return true;
  return authOk(req);
}

function isDiscordWebhookUrl(url) {
  return /^https:\/\/(discord\.com|discordapp\.com)\/api\/webhooks\//i.test(String(url || ""));
}

/** Restock / OOS channel — runtime admin override, else env. */
function discordHook() {
  const hook = String(runtime.restockWebhook || process.env.DISCORD_WEBHOOK_URL || "").trim();
  return isDiscordWebhookUrl(hook) ? hook : null;
}

/** Public checkouts feed — no PII; runtime admin override, else env. */
function checkoutFeedHook() {
  const hook = String(
    runtime.checkoutFeedWebhook || process.env.DISCORD_CHECKOUT_FEED_WEBHOOK || "",
  ).trim();
  return isDiscordWebhookUrl(hook) ? hook : null;
}

function maskWebhook(url) {
  const u = String(url || "");
  if (!u) return "";
  if (u.length < 24) return "••••";
  return `${u.slice(0, 40)}…${u.slice(-8)}`;
}

/** Sanitize Desktop win report — never forward PII to the public feed. */
function sanitizeCheckoutWin(body) {
  const b = body && typeof body === "object" ? body : {};
  const sku = String(b.sku || b.productId || "").trim().slice(0, 40);
  let pdp = String(b.pdpUrl || "").trim().slice(0, 400);
  if (pdp && !/^https:\/\/(www\.)?p-bandai\.com\//i.test(pdp) && sku) {
    pdp = `https://p-bandai.com/au/item/${encodeURIComponent(sku)}`;
  }
  if (pdp && !/^https:\/\//i.test(pdp)) pdp = "";
  let imageUrl = String(b.imageUrl || "").trim().slice(0, 500);
  if (imageUrl && !/^https:\/\//i.test(imageUrl)) imageUrl = "";
  return {
    store: String(b.store || "").trim().slice(0, 40),
    title: String(b.title || b.label || sku || "Checkout").trim().slice(0, 200),
    sku,
    pdpUrl: pdp,
    mode: String(b.mode || "").trim().slice(0, 60),
    payment: String(b.payment || "Card").trim().slice(0, 40) || "Card",
    price: b.price != null ? String(b.price).trim().slice(0, 40) : null,
    imageUrl: imageUrl || null,
    areaItemNo: String(b.areaItemNo || "").trim().slice(0, 40) || null,
    area: String(b.area || "au").trim().slice(0, 4) || "au",
    at: b.at || new Date().toISOString(),
  };
}

function mutedSkuList() {
  return parseMutedSkus(runtime.mutedSkus);
}

function pushHit(ev) {
  const meta = ev?.meta || {};
  const muted = isSkuMuted(mutedSkuList(), ev?.productId || ev?.sku);
  const store = String(ev?.store || meta.store || "bandai").toLowerCase();
  const row = {
    at: new Date().toISOString(),
    productId: ev.productId,
    inStock: ev.inStock,
    reason: ev.reason || null,
    store,
    locale: ev.locale || meta.locale || null,
    title: ev.title || meta.title || null,
    imageUrl: ev.imageUrl || meta.imageUrl || null,
    price: ev.price || meta.price || null,
    areaItemNo: ev.areaItemNo || meta.areaItemNo || null,
    productType: meta.productType || ev.productType || null,
    availability: ev.availability || meta.availability || null,
    preorder: ev.preorder || meta.preorder || undefined,
    muted: muted || undefined,
  };
  recentHits.unshift(row);
  if (recentHits.length > MAX_HITS) recentHits.length = MAX_HITS;
  // Global admin mute — keep in operator /hits buffer, do not fan out to Desktop SSE.
  if (muted) return row;
  // Desktop checkout only cares about in-stock; still stream OOS for operators.
  const payload = `event: stock_changed\ndata: ${JSON.stringify(row)}\n\n`;
  for (const res of sseClients) {
    try {
      res.write(payload);
    } catch {
      sseClients.delete(res);
    }
  }
  return row;
}

function hitPayload(ev) {
  const sku = String(ev?.productId || ev?.sku || "").trim();
  const cached = sku ? lookupProduct(productCache, { sku, area: AREA }) : null;
  const nai =
    ev.areaItemNo ||
    ev.meta?.areaItemNo ||
    (cached?.areaItemNo && /^NAI|^AAI/i.test(cached.areaItemNo) ? cached.areaItemNo : null);
  const title = ev.title || ev.meta?.title || cached?.title || null;
  return {
    ...ev,
    title,
    imageUrl: ev.imageUrl || ev.meta?.imageUrl,
    price: ev.price || ev.meta?.price,
    areaItemNo: nai,
    productType: ev.productType || ev.meta?.productType,
  };
}

async function postDiscordTo(hook, body, logTag = "discord") {
  if (!hook) return { ok: false, skipped: true, error: "no_webhook" };
  const timeoutMs = Math.max(
    3_000,
    Number(process.env.DISCORD_WEBHOOK_TIMEOUT_MS) || 12_000,
  );
  try {
    const res = await fetch(hook, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await res.text().catch(() => "");
    if (!res.ok) {
      labLog(logTag, "err", `webhook ${res.status}`, { detail: text.slice(0, 120) });
      return { ok: false, status: res.status, error: text.slice(0, 200) };
    }
    const title = body?.embeds?.[0]?.title || body?.username || "ping";
    labLog(logTag, "info", `sent · ${title}`.slice(0, 200));
    return { ok: true, status: res.status };
  } catch (e) {
    const msg =
      e?.name === "TimeoutError" || e?.name === "AbortError"
        ? `webhook_timeout_${timeoutMs}ms`
        : e?.message || String(e);
    labLog(logTag, "err", msg);
    return { ok: false, error: msg };
  }
}

async function postDiscord(body) {
  return postDiscordTo(discordHook(), body, "discord");
}

async function postCheckoutFeed(body) {
  return postDiscordTo(checkoutFeedHook(), body, "checkout-feed");
}

/** Post Discord; if components are rejected, retry embed-only (QT link stays in description). */
async function postDiscordWithQtFallback(body) {
  let r = await postDiscord(body);
  if (!r.ok && body?.components) {
    const { components: _drop, ...embedOnly } = body;
    r = await postDiscord(embedOnly);
    if (r.ok) return { ...r, componentsStripped: true };
  }
  return r;
}

const hub = createGlobalMonitorHub({
  attachBridge: false,
  monitorOpts: {
    intervalMs: runtime.intervalMs,
    keywords: runtime.keywords,
    area: AREA,
    proxy: {
      ispRaw: runtime.ispProxies || undefined,
      dcRaw: runtime.dcProxies || undefined,
    },
  },
  log: (line) => console.log(`[hub] ${line}`),
});

/** Pokémon Centre poller — same SSE /hits feed as Bandai (store=pokemoncentre). */
let pcMonitorEnabled = runtime.pcMonitorEnable !== false;
const pcMonitor = createPokemonCentreStockMonitor({
  locale: runtime.pcLocale || process.env.PC_MONITOR_LOCALE || "en-au",
  intervalMs: runtime.pcIntervalMs || Number(process.env.PC_MONITOR_INTERVAL_MS) || 15_000,
  // Admin dashboard owns the watchlist (persisted runtime). No baked-in keywords/SKUs.
  keywords: runtime.pcKeywords || "",
  skus: runtime.pcSkus || "",
  proxy: {
    ispRaw: runtime.ispProxies || undefined,
    dcRaw: runtime.dcProxies || undefined,
  },
});

// Apply disk overrides that may differ from constructor env (keywords already passed).
try {
  if (runtime._fromDisk) {
    hub.monitor.setKeywords(runtime.keywords);
    hub.monitor.setIntervalMs(runtime.intervalMs);
    if (runtime.ispProxies || runtime.dcProxies) {
      hub.monitor.replaceProxies({
        ispRaw: runtime.ispProxies,
        dcRaw: runtime.dcProxies,
      });
      pcMonitor.replaceProxies({
        ispRaw: runtime.ispProxies,
        dcRaw: runtime.dcProxies,
      });
    }
    if (runtime.pcKeywords) pcMonitor.setKeywords(runtime.pcKeywords);
    if (runtime.pcSkus) pcMonitor.setSkus(runtime.pcSkus);
    if (runtime.pcIntervalMs) pcMonitor.setIntervalMs(runtime.pcIntervalMs);
  }
} catch (e) {
  console.warn("[runtime-config]", e?.message || e);
}

hub.monitor.on("started", (s) => {
  labLog("monitor", "info", "Bandai monitor started", {
    intervalMs: s?.intervalMs,
    keywords: s?.keywords,
  });
});
hub.monitor.on("stopped", (s) => {
  labLog("monitor", "warn", "Bandai monitor stopped", { polls: s?.polls });
});

async function handleStockChanged(ev) {
  const store = String(ev?.store || ev?.meta?.store || "bandai").toLowerCase();
  console.log(
    `[stock_changed] store=${store} ${ev.productId} inStock=${ev.inStock} reason=${ev.reason} ${ev.title || ev.meta?.title || ""}`,
  );
  labLog(
    "monitor",
    ev?.inStock ? "info" : "warn",
    `${store} ${ev.reason || "stock"} ${ev.productId}${ev.title || ev.meta?.title ? ` · ${ev.title || ev.meta?.title}` : ""}`,
    { productId: ev.productId, inStock: ev.inStock, reason: ev.reason, store },
  );
  if (ev?.productId && store === "bandai") {
    const nai = isBackendPid(ev.areaItemNo)
      ? ev.areaItemNo
      : isBackendPid(ev.meta?.areaItemNo)
        ? ev.meta.areaItemNo
        : "";
    rememberProducts(
      {
        sku: ev.productId,
        areaItemNo: nai,
        areaItemNos: ev.areaItemNos || ev.meta?.areaItemNos,
        title: ev.title || ev.meta?.title || "",
        area: AREA,
      },
      "poll",
    );
  }
  const hitRow = pushHit(ev);
  // Muted SKUs stay out of Discord + Desktop (spam restocks).
  if (hitRow?.muted) {
    labLog("monitor", "info", `Muted restock · ${ev.productId}`, {
      productId: ev.productId,
      reason: ev.reason,
      store,
    });
    return;
  }

  const reason = String(ev?.reason || "");
  const isSoftListed =
    reason === "soft_listed" ||
    reason === "new_listing" ||
    Boolean(ev?.softListed || ev?.meta?.softListed);
  const isOos = !isSoftListed && (ev?.inStock === false || reason === "went_oos");
  if (isOos) {
    if (runtime.notifyOos === false) return;
    try {
      const oosPayload =
        store === "pokemoncentre"
          ? vantaPkcOosDiscordBody(
              { ...hitPayload(ev), locale: ev.locale || runtime.pcLocale || "en-au" },
              { locale: ev.locale || runtime.pcLocale || "en-au" },
            )
          : vantaOosDiscordBody(hitPayload(ev), {
              area: AREA,
              source: "railway-monitor",
            });
      const r = await postDiscord(oosPayload);
      if (!r.ok && !r.skipped) console.warn("[discord:oos]", r.status, r.error);
    } catch (e) {
      console.warn("[discord:oos]", e?.message || e);
    }
    return;
  }

  // Soft-listed = hours-ahead (page/search/sitemap) — ping even when inStock=false.
  if (!ev?.inStock && !isSoftListed) return;
  try {
    if (store === "pokemoncentre") {
      const locale = ev.locale || runtime.pcLocale || "en-au";
      const r = await postDiscordWithQtFallback(
        vantaPkcDiscordBody(
          {
            ...hitPayload(ev),
            locale,
            availability: ev.availability || ev.meta?.availability,
            preorder: Boolean(ev.preorder || ev.meta?.preorder || reason === "preorder_live"),
            softListed: isSoftListed,
            slug: ev.slug || ev.meta?.slug,
            pdpUrl: ev.pdpUrl || ev.meta?.pdpUrl,
            source: ev.meta?.source || ev.source,
            reason,
          },
          {
            locale,
            preload: reason === "preorder_live",
            softListed: isSoftListed,
          },
        ),
      );
      if (!r.ok && !r.skipped) console.warn("[discord:pkc]", r.status, r.error);
      else if (r.componentsStripped) console.warn("[discord:pkc] components stripped — QT description links kept");
      return;
    }
    const r = await postDiscordWithQtFallback(
      vantaRestockDiscordBody(hitPayload(ev), { area: AREA, source: "railway-monitor" }),
    );
    if (!r.ok && !r.skipped) console.warn("[discord]", r.status, r.error);
    else if (r.componentsStripped) console.warn("[discord] components stripped — QT description links kept");
  } catch (e) {
    console.warn("[discord]", e?.message || e);
  }
}

hub.monitor.on("stock_changed", (ev) => {
  void handleStockChanged({ ...ev, store: ev.store || "bandai" });
});

pcMonitor.on("started", (s) => {
  labLog("monitor", "info", "PKC monitor started", {
    intervalMs: s?.intervalMs,
    keywords: s?.keywords,
    skus: s?.skus,
    locale: s?.locale,
  });
});
pcMonitor.on("stopped", (s) => {
  labLog("monitor", "warn", "PKC monitor stopped", { polls: s?.polls });
});
pcMonitor.on("stock_changed", (ev) => {
  void handleStockChanged({ ...ev, store: "pokemoncentre" });
});
pcMonitor.on("poll", (s) => {
  if (s.polls <= 3 || s.polls % 8 === 0 || s.events > 0) {
    console.log(
      `[pkc-poll] #${s.polls} products=${s.products} inStock=${s.inStock} events=${s.events} ms=${s.ms} locale=${s.locale} host=${s.proxyHost}${s.firstSnapshot ? " (baseline)" : ""}`,
    );
  }
});
pcMonitor.on("error", (e) => {
  if (e?.warn) {
    console.warn("[pkc-monitor]", e.error);
    labLog("monitor", "warn", `PKC: ${e.error}`);
    return;
  }
  console.warn("[pkc-monitor:error]", e?.error || e);
  labLog("monitor", "err", `PKC error: ${e?.error || e}`);
});

hub.monitor.on("poll", (s) => {
  if (s.polls <= 3 || s.polls % 12 === 0 || s.events > 0) {
    console.log(
      `[poll] #${s.polls} products=${s.products} inStock=${s.inStock} events=${s.events} ms=${s.ms} tier=${s.proxyTier} host=${s.proxyHost}${s.firstSnapshot ? " (baseline)" : ""}`,
    );
  }
  // Harvest NAI/title from the live search snapshot into the shared cache.
  try {
    const catalog = hub.monitor.getCatalog?.();
    if (catalog?.size) {
      const batch = [];
      for (const row of catalog.values()) {
        if (!row?.productId) continue;
        const nai = isBackendPid(row.areaItemNo) ? row.areaItemNo : "";
        batch.push({
          sku: row.productId,
          areaItemNo: nai,
          areaItemNos: row.areaItemNos,
          title: row.title || "",
          area: AREA,
        });
      }
      if (batch.length) rememberProducts(batch, "poll");
    }
  } catch {
    /* ignore */
  }
  // Keep every poll in the lab buffer (ring-capped) so phone Logs stays useful.
  labLog("monitor", s.events > 0 ? "info" : "info", `poll #${s.polls}`, {
    products: s.products,
    inStock: s.inStock,
    events: s.events,
    ms: s.ms,
    tier: s.proxyTier,
    host: s.proxyHost,
    baseline: Boolean(s.firstSnapshot),
  });
});
hub.monitor.on("error", (e) => {
  console.warn(`[monitor:error] ${e.error || e}`);
  labLog("monitor", "err", String(e.error || e), { polls: e.polls });
});
hub.monitor.on("watchdog", (e) => {
  console.warn(`[monitor:watchdog] ${e.reason || "restart"} restarts=${e.restarts ?? "?"}`);
  labLog("monitor", "warn", `watchdog ${e.reason || "restart"}`, {
    restarts: e.restarts,
  });
});

/** Prefer in-process heal overnight; Railway 503 is the backstop. */
let monitorExpectRunning = true;
let watchdogBusy = false;
let lastWatchdogAt = 0;
const WATCHDOG_EVERY_MS = Math.max(
  15_000,
  Number(process.env.MONITOR_WATCHDOG_EVERY_MS) || 30_000,
);
const WATCHDOG_MIN_GAP_MS = Math.max(
  30_000,
  Number(process.env.MONITOR_WATCHDOG_MIN_GAP_MS) || 90_000,
);

function monitorHealthSnapshot() {
  const m = hub.monitor.status();
  if (!monitorExpectRunning) {
    return {
      monitor: m,
      stale: {
        healthy: true,
        reason: null,
        staleMs: m.staleMs ?? null,
        staleLimitMs: null,
        running: Boolean(m.running),
        intentionalStop: true,
      },
    };
  }
  const stale = computeMonitorStale({
    running: m.running,
    lastPollAt: m.lastPollAt,
    startedAt: m.startedAt,
    intervalMs: m.intervalMs ?? runtime.intervalMs,
    staleLimitMs: Number(process.env.MONITOR_STALE_LIMIT_MS) || undefined,
  });
  return { monitor: m, stale };
}

async function runMonitorWatchdog(reason = "tick") {
  if (watchdogBusy) return null;
  const { monitor: m, stale } = monitorHealthSnapshot();
  const decision = shouldWatchdogRestart(stale, { expectRunning: monitorExpectRunning });
  if (!decision.restart) return { ok: true, restarted: false, stale };
  const now = Date.now();
  if (now - lastWatchdogAt < WATCHDOG_MIN_GAP_MS) {
    return { ok: true, restarted: false, throttled: true, stale };
  }
  watchdogBusy = true;
  lastWatchdogAt = now;
  try {
    console.warn(
      `[watchdog] restarting monitor reason=${decision.reason} via=${reason} staleMs=${stale.staleMs}`,
    );
    labLog("monitor", "warn", `watchdog restart · ${decision.reason}`, {
      via: reason,
      staleMs: stale.staleMs,
      limit: stale.staleLimitMs,
    });
    if (typeof hub.monitor.restart === "function") {
      await hub.monitor.restart(decision.reason);
    } else {
      await hub.monitor.stop();
      hub.monitor.start();
    }
    monitorExpectRunning = true;
    return { ok: true, restarted: true, reason: decision.reason, stale };
  } catch (e) {
    labLog("monitor", "err", `watchdog restart failed: ${e?.message || e}`);
    return { ok: false, error: e?.message || String(e), stale };
  } finally {
    watchdogBusy = false;
  }
}

setInterval(() => {
  void runMonitorWatchdog("interval");
}, WATCHDOG_EVERY_MS);

const app = Fastify({ logger: false });

// Allow empty JSON body on POST (phone clients / curl without body).
app.addContentTypeParser("application/json", { parseAs: "string" }, (req, body, done) => {
  if (!body || !String(body).trim()) {
    done(null, {});
    return;
  }
  try {
    done(null, JSON.parse(body));
  } catch (e) {
    done(e, undefined);
  }
});

await app.register(fastifyStatic, {
  root: path.join(__dirname, "admin"),
  prefix: "/admin/",
  index: ["index.html"],
});

app.get("/admin", async (_req, reply) => reply.redirect("/admin/"));

app.get("/", async (_req, reply) => {
  const st = hub.status();
  const m = st.monitor || {};
  return reply.type("application/json").send({
    ok: true,
    service: "bandai-monitor",
    brand: "Vanta",
    gitSha: process.env.GIT_SHA || process.env.RAILWAY_GIT_COMMIT_SHA || null,
    message: "Vanta Bandai monitor. Phone lab: /admin · API needs Bearer MONITOR_TOKEN.",
    area: AREA,
    intervalMs: m.intervalMs ?? runtime.intervalMs,
    keywords: m.keywords || [],
    running: Boolean(m.running),
    polls: m.polls ?? 0,
    products: m.products ?? 0,
    inStock: m.inStock ?? 0,
    hitsBuffered: recentHits.length,
    lastError: m.lastError || null,
    pool: m.pool
      ? { isp: m.pool.isp, dc: m.pool.dc, cooling: m.pool.cooling, picks: m.pool.picks }
      : null,
    links: {
      admin: "/admin/",
      health: "/health",
      status: "/status",
      hits: "/hits",
      events: "/events",
      testDiscord: "/test-discord",
      quickTask: "/qt",
      quickTaskSetup: "/qt-setup",
    },
  });
});

function bounceHtml({ title, local, detail }) {
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>${escapeHtml(title)}</title>
<style>
  body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;
    font:15px/1.45 system-ui,sans-serif;background:#0e1012;color:#e8eaed}
  .card{max-width:420px;padding:28px;border:1px solid #2a323c;border-radius:12px;background:#161a1f}
  h1{font-size:18px;margin:0 0 8px} p{margin:0 0 12px;color:#8b949e}
  a{color:#3dd6c6} code{color:#3dd6c6;font-size:12px}
</style>
</head><body><div class="card">
  <h1>${escapeHtml(title)}</h1>
  <p>${detail}</p>
  <p><a href="${escapeHtml(local)}">Continue</a></p>
</div>
<script>setTimeout(function(){ location.replace(${JSON.stringify(local)}); }, 120);</script>
</body></html>`;
}

function escapeHtml(s) {
  return String(s || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Public Quick Task bounce (no auth) — Discord LINK buttons point here (HTTPS).
 */
app.get("/qt", async (req, reply) => {
  const q = req.query && typeof req.query === "object" ? req.query : {};
  const params = new URLSearchParams();
  for (const key of ["sku", "title", "nai", "area", "reason", "url", "store", "locale", "start"]) {
    if (q[key] != null && String(q[key]).trim()) params.set(key, String(q[key]).trim());
  }
  const qs = params.toString();
  const local = `http://127.0.0.1:${QUICKTASK_BRIDGE_PORT}/quicktask${qs ? `?${qs}` : ""}`;
  const sku = params.get("sku") || "";
  reply
    .type("text/html; charset=utf-8")
    .header("cache-control", "no-store")
    .send(
      bounceHtml({
        title: "Opening Quick Task…",
        local,
        detail: sku
          ? `SKU <code>${escapeHtml(sku)}</code>`
          : "Launching Quick Task…",
      }),
    );
});

/** Open Desktop Settings → Quick Task preset. */
app.get("/qt-setup", async (_req, reply) => {
  const local = `http://127.0.0.1:${QUICKTASK_BRIDGE_PORT}/setup`;
  reply
    .type("text/html; charset=utf-8")
    .header("cache-control", "no-store")
    .send(
      bounceHtml({
        title: "Opening Quick Task presets…",
        local,
        detail: "Desktop Settings → Quick Task preset",
      }),
    );
});

app.get("/health", async (_req, reply) => {
  const { monitor: m, stale } = monitorHealthSnapshot();
  // Soft-heal on health probe when Railway/desktop pings a dead loop.
  if (monitorExpectRunning && !stale.healthy) {
    void runMonitorWatchdog("health");
  }
  const pc = pcMonitor.status();
  const payload = {
    ok: stale.healthy,
    service: "bandai-monitor",
    gitSha: process.env.GIT_SHA || process.env.RAILWAY_GIT_COMMIT_SHA || null,
    area: AREA,
    intervalMs: m.intervalMs ?? runtime.intervalMs,
    keywords: m.keywords || [],
    mutedSkus: mutedSkuList(),
    monitor: m,
    pokemoncentre: {
      enabled: pcMonitorEnabled,
      ...pc,
    },
    healthy: stale.healthy,
    staleMs: stale.staleMs,
    staleLimitMs: stale.staleLimitMs,
    staleReason: stale.reason,
    hitsBuffered: recentHits.length,
    sseClients: sseClients.size,
    authRequired: Boolean(TOKEN),
    feedPublic: FEED_PUBLIC,
    admin: "/admin/",
    quickTask: "/qt",
  };
  // 503 lets Railway restart the service if in-process bounce fails overnight.
  return reply.code(stale.healthy ? 200 : 503).send(payload);
});

app.get("/status", async (req, reply) => {
  if (!authOk(req)) return reply.code(401).send({ ok: false, error: "unauthorized" });
  return {
    ok: true,
    ...hub.status(),
    pokemoncentre: {
      enabled: pcMonitorEnabled,
      ...pcMonitor.status(),
    },
    recentHits: recentHits.slice(0, 20),
    sseClients: sseClients.size,
    runtime: {
      notifyOos: runtime.notifyOos !== false,
      updatedAt: runtime.updatedAt || null,
      statePath: runtime._path || null,
      fromDisk: Boolean(runtime._fromDisk),
      persistence: persistence(),
      pcMonitorEnable: runtime.pcMonitorEnable !== false,
      pcLocale: runtime.pcLocale || "en-au",
      pcKeywords: runtime.pcKeywords || "",
      pcSkus: runtime.pcSkus || "",
      pcIntervalMs: runtime.pcIntervalMs || 15000,
    },
  };
});

app.get("/hits", async (req, reply) => {
  if (!feedAuthOk(req)) return reply.code(401).send({ ok: false, error: "unauthorized" });
  const limit = Math.max(1, Math.min(MAX_HITS, Number(req.query?.limit) || 50));
  // Consumers never see admin-muted SKUs (still visible on /status for operators).
  const hits = recentHits.filter((h) => !h?.muted).slice(0, limit);
  return { ok: true, hits };
});

app.get("/admin/config", async (req, reply) => {
  if (!authOk(req)) return reply.code(401).send({ ok: false, error: "unauthorized" });
  const m = hub.monitor.status();
  const pc = pcMonitor.status();
  const presetRaw = normalizePresetCatalogRaw(runtime.presetCatalog);
  return {
    ok: true,
    keywords: Array.isArray(m.keywords) ? m.keywords.join("\n") : String(runtime.keywords || ""),
    mutedSkus: mutedSkusText(mutedSkuList()),
    presetCatalog: presetRaw,
    presetCatalogRows: presetRowsForResponse(presetRaw),
    productCacheCount: Object.keys(productCache.entries || {}).length,
    ispProxies: runtime.ispProxies || "",
    dcProxies: runtime.dcProxies || "",
    intervalMs: m.intervalMs ?? runtime.intervalMs,
    notifyOos: runtime.notifyOos !== false,
    restockWebhook: runtime.restockWebhook || "",
    checkoutFeedWebhook: runtime.checkoutFeedWebhook || "",
    restockWebhookSet: Boolean(discordHook()),
    checkoutFeedWebhookSet: Boolean(checkoutFeedHook()),
    restockWebhookMasked: maskWebhook(discordHook() || ""),
    checkoutFeedWebhookMasked: maskWebhook(checkoutFeedHook() || ""),
    pcMonitorEnable: pcMonitorEnabled,
    pcLocale: pc.locale || runtime.pcLocale || "en-au",
    pcKeywords: Array.isArray(pc.keywords) ? pc.keywords.join("\n") : String(runtime.pcKeywords || ""),
    pcSkus: Array.isArray(pc.skus) ? pc.skus.join("\n") : String(runtime.pcSkus || ""),
    pcIntervalMs: pc.intervalMs ?? runtime.pcIntervalMs ?? 15000,
    updatedAt: runtime.updatedAt || null,
    pool: m.pool || null,
    persistence: persistence(),
  };
});

/**
 * Desktop reports a confirmed checkout → public feed (no PII).
 * Feed-public like /hits so members don't need MONITOR_TOKEN; webhook stays server-side.
 */
app.post("/checkout-win", async (req, reply) => {
  if (!feedAuthOk(req)) return reply.code(401).send({ ok: false, error: "unauthorized" });
  if (!checkoutFeedHook()) {
    return reply.code(400).send({ ok: false, error: "checkout_feed_webhook_not_configured" });
  }
  const win = sanitizeCheckoutWin(req.body);
  if (!win.sku && !win.title) {
    return reply.code(400).send({ ok: false, error: "sku_or_title_required" });
  }
  const payload = vantaPublicCheckoutDiscordBody(win, { test: Boolean(req.body?.test) });
  const r = await postCheckoutFeed(payload);
  if (!r.ok) {
    return reply.code(r.skipped ? 400 : 502).send({ ok: false, error: r.error || "discord_failed" });
  }
  return { ok: true, posted: true };
});

/** Desktop Action Store — curated SKU library (public read; writes stay authed). */
app.get("/preset-catalog", async (req, reply) => {
  if (!feedAuthOk(req)) return reply.code(401).send({ ok: false, error: "unauthorized" });
  const raw = normalizePresetCatalogRaw(runtime.presetCatalog);
  const rows = presetRowsForResponse(raw);
  return {
    ok: true,
    raw,
    rows,
    count: rows.length,
    productCacheCount: Object.keys(productCache.entries || {}).length,
    updatedAt: runtime.updatedAt || null,
  };
});

/** Shared Bandai product cache (SKU ↔ NAI ↔ title) for all Desktop members. */
app.get("/product-cache", async (req, reply) => {
  if (!feedAuthOk(req)) return reply.code(401).send({ ok: false, error: "unauthorized" });
  const entries = listProductCache(productCache);
  return {
    ok: true,
    updatedAt: productCache.updatedAt || null,
    count: entries.length,
    entries,
  };
});

app.get("/product-cache/lookup", async (req, reply) => {
  if (!feedAuthOk(req)) return reply.code(401).send({ ok: false, error: "unauthorized" });
  const sku = String(req.query?.sku || "").trim();
  if (!sku) return reply.code(400).send({ ok: false, error: "sku required" });
  const area = String(req.query?.area || AREA).toLowerCase().slice(0, 2);
  const entry = lookupProduct(productCache, { sku, area });
  if (!entry) return { ok: true, found: false, entry: null };
  return { ok: true, found: true, entry };
});

app.post("/product-cache", async (req, reply) => {
  if (!authOk(req)) return reply.code(401).send({ ok: false, error: "unauthorized" });
  const body = req.body && typeof req.body === "object" ? req.body : {};
  const incoming = Array.isArray(body.entries)
    ? body.entries
    : body.sku || body.productId
      ? [body]
      : [];
  if (!incoming.length) {
    return reply.code(400).send({ ok: false, error: "entries required" });
  }
  const changed = rememberProducts(incoming, body.source || "desktop");
  flushProductCache();
  return {
    ok: true,
    changed,
    count: Object.keys(productCache.entries || {}).length,
    updatedAt: productCache.updatedAt,
  };
});

app.put("/admin/config", async (req, reply) => {
  if (!authOk(req)) return reply.code(401).send({ ok: false, error: "unauthorized" });
  const body = req.body && typeof req.body === "object" ? req.body : {};
  try {
    if (body.keywords != null) {
      const list = hub.monitor.setKeywords(body.keywords);
      runtime.keywords = list.join("\n");
    }
    if (body.mutedSkus != null) {
      runtime.mutedSkus = mutedSkusText(parseMutedSkus(body.mutedSkus));
    }
    let presetEnrich = null;
    if (body.presetCatalog != null) {
      const parsed = parsePresetCatalogBulk(body.presetCatalog, { defaultArea: AREA });
      const enrich =
        body.enrichTitles === false
          ? {
              rows: parsed,
              raw: normalizePresetCatalogRaw(body.presetCatalog),
              resolved: 0,
              failed: 0,
              skipped: parsed.length,
              cacheEntries: [],
            }
          : await enrichPresetTitles(parsed, {
              area: AREA,
              proxyRaw: runtime.ispProxies || body.ispProxies || "",
              getProduct: (sku) => hub.monitor.getProduct?.(sku) || null,
              lookupCache: (sku, area) => lookupProduct(productCache, { sku, area }),
              enrich: true,
            });
      runtime.presetCatalog = normalizePresetCatalogRaw(enrich.raw);
      if (enrich.cacheEntries?.length) {
        rememberProducts(enrich.cacheEntries, "enrich");
        flushProductCache();
      }
      presetEnrich = {
        resolved: enrich.resolved,
        failed: enrich.failed,
        skipped: enrich.skipped,
        cached: enrich.cacheEntries?.filter((e) => isBackendPid(e.areaItemNo)).length || 0,
      };
    }
    if (body.intervalMs != null) {
      runtime.intervalMs = hub.monitor.setIntervalMs(body.intervalMs);
    }
    if (body.notifyOos != null) {
      runtime.notifyOos = Boolean(body.notifyOos);
    }
    if (body.restockWebhook != null) {
      const w = String(body.restockWebhook || "").trim();
      if (w && !isDiscordWebhookUrl(w)) {
        return reply.code(400).send({ ok: false, error: "restockWebhook must be a Discord webhook URL" });
      }
      // Ignore masked placeholders from the admin form (keep previous).
      if (!w || !w.includes("…")) runtime.restockWebhook = w;
    }
    if (body.checkoutFeedWebhook != null) {
      const w = String(body.checkoutFeedWebhook || "").trim();
      if (w && !isDiscordWebhookUrl(w)) {
        return reply
          .code(400)
          .send({ ok: false, error: "checkoutFeedWebhook must be a Discord webhook URL" });
      }
      if (!w || !w.includes("…")) runtime.checkoutFeedWebhook = w;
    }
    const proxPatch = {};
    if (body.ispProxies != null) {
      runtime.ispProxies = String(body.ispProxies);
      proxPatch.ispRaw = runtime.ispProxies;
    }
    if (body.dcProxies != null) {
      runtime.dcProxies = String(body.dcProxies);
      proxPatch.dcRaw = runtime.dcProxies;
    }
    if (Object.keys(proxPatch).length) {
      hub.monitor.replaceProxies(proxPatch);
      try {
        pcMonitor.replaceProxies(proxPatch);
      } catch {
        /* ignore */
      }
    }
    if (body.pcKeywords != null) {
      const list = pcMonitor.setKeywords(body.pcKeywords);
      runtime.pcKeywords = list.join("\n");
    }
    if (body.pcSkus != null) {
      const list = pcMonitor.setSkus(body.pcSkus);
      runtime.pcSkus = list.join("\n");
    }
    if (body.pcIntervalMs != null) {
      runtime.pcIntervalMs = pcMonitor.setIntervalMs(body.pcIntervalMs);
    }
    if (body.pcLocale != null) {
      runtime.pcLocale = String(body.pcLocale || "en-au").trim() || "en-au";
    }
    if (body.pcMonitorEnable != null) {
      runtime.pcMonitorEnable = Boolean(body.pcMonitorEnable);
      pcMonitorEnabled = runtime.pcMonitorEnable !== false;
    }
    // Keywords/SKUs or sitemap/category discovery can keep PKC running.
    {
      const st = pcMonitor.status();
      const hasWatch =
        (st.keywords?.length || 0) + (st.skus?.length || 0) > 0 || Boolean(st.discoveryEnable);
      if (pcMonitorEnabled && monitorExpectRunning && hasWatch && !st.running) {
        pcMonitor.start();
      }
      if ((!pcMonitorEnabled || !hasWatch) && st.running) {
        await pcMonitor.stop();
      }
    }
    runtime = { ...runtime, ...saveRuntimeConfig(runtime, runtime._path) };
    const presetRaw = normalizePresetCatalogRaw(runtime.presetCatalog);
    const pc = pcMonitor.status();
    return {
      ok: true,
      keywords: hub.monitor.status().keywords,
      mutedSkus: mutedSkusText(mutedSkuList()),
      presetCatalog: presetRaw,
      presetCatalogRows: presetRowsForResponse(presetRaw),
      presetEnrich,
      productCacheCount: Object.keys(productCache.entries || {}).length,
      intervalMs: hub.monitor.status().intervalMs,
      notifyOos: runtime.notifyOos !== false,
      restockWebhook: runtime.restockWebhook || "",
      checkoutFeedWebhook: runtime.checkoutFeedWebhook || "",
      restockWebhookSet: Boolean(discordHook()),
      checkoutFeedWebhookSet: Boolean(checkoutFeedHook()),
      ispProxies: runtime.ispProxies || "",
      dcProxies: runtime.dcProxies || "",
      pool: hub.monitor.status().pool,
      pcMonitorEnable: runtime.pcMonitorEnable !== false,
      pcLocale: runtime.pcLocale || "en-au",
      pcKeywords: Array.isArray(pc.keywords) ? pc.keywords.join("\n") : "",
      pcSkus: Array.isArray(pc.skus) ? pc.skus.join("\n") : "",
      pcIntervalMs: pc.intervalMs,
      updatedAt: runtime.updatedAt,
      persistence: persistence(),
    };
  } catch (e) {
    return reply.code(400).send({ ok: false, error: e?.message || String(e) });
  }
});

app.post("/lab/poll", async (req, reply) => {
  if (!authOk(req)) return reply.code(401).send({ ok: false, error: "unauthorized" });
  try {
    const { summary, events } = await hub.monitor.pollOnce();
    labLog("monitor", "info", "Force poll", {
      polls: summary?.polls,
      products: summary?.products,
      events: events?.length || 0,
    });
    return {
      ok: true,
      summary,
      events: (events || []).map((e) => ({
        productId: e.productId,
        inStock: e.inStock,
        reason: e.reason,
      })),
    };
  } catch (e) {
    labLog("monitor", "err", `Force poll failed: ${e?.message || e}`);
    return reply.code(503).send({ ok: false, error: e?.message || "poll_failed" });
  }
});

app.post("/monitor/start", async (req, reply) => {
  if (!authOk(req)) return reply.code(401).send({ ok: false, error: "unauthorized" });
  monitorExpectRunning = true;
  const st = hub.monitor.status();
  if (!st.running) hub.monitor.start();
  if (pcMonitorEnabled && !pcMonitor.status().running) pcMonitor.start();
  labLog("system", "info", "Monitor start requested from admin");
  return {
    ok: true,
    already: st.running,
    monitor: hub.monitor.status(),
    pokemoncentre: pcMonitor.status(),
  };
});

app.post("/monitor/stop", async (req, reply) => {
  if (!authOk(req)) return reply.code(401).send({ ok: false, error: "unauthorized" });
  monitorExpectRunning = false;
  const st = hub.monitor.status();
  if (st.running) await hub.monitor.stop();
  if (pcMonitor.status().running) await pcMonitor.stop();
  labLog("system", "warn", "Monitor stop requested from admin", { polls: st.polls });
  return { ok: true, monitor: hub.monitor.status(), pokemoncentre: pcMonitor.status() };
});

app.post("/monitor/restart", async (req, reply) => {
  if (!authOk(req)) return reply.code(401).send({ ok: false, error: "unauthorized" });
  monitorExpectRunning = true;
  try {
    if (typeof hub.monitor.restart === "function") {
      await hub.monitor.restart("admin");
    } else {
      await hub.monitor.stop();
      hub.monitor.start();
    }
    if (pcMonitorEnabled) {
      if (typeof pcMonitor.restart === "function") await pcMonitor.restart("admin");
      else {
        await pcMonitor.stop();
        pcMonitor.start();
      }
    }
    labLog("system", "warn", "Monitor restart requested from admin");
    return {
      ok: true,
      restarted: true,
      reason: "admin",
      monitor: hub.monitor.status(),
      pokemoncentre: pcMonitor.status(),
    };
  } catch (e) {
    return reply.code(500).send({ ok: false, error: e?.message || String(e) });
  }
});

/** In-flight / last Force poll — admin polls status so Railway/phone don't cut a long edge warm. */
let pkcForcePollJob = null;

function pkcForcePollHint(msg) {
  const tbv = /t=bv|pc_edge_tbv|hard.?block|hard.?ip/i.test(msg);
  const timeout = /poll_timeout/i.test(msg);
  const hyper = /HYPER_API_KEY/i.test(msg);
  const bff5 = /bff_5\d\d/i.test(msg);
  if (hyper) return "Set HYPER_API_KEY on the monitor service (same key as checkout).";
  if (tbv) {
    return "DataDome t=bv is per-sticky. Monitor uses checkout tls-worker; rotate continues on remaining ISP lines.";
  }
  if (bff5) {
    return "BFF 5xx after edge — monitor remints token and falls through to category/sitemap discovery; redeploy if still products=0.";
  }
  if (timeout) {
    return "Edge warm exceeded poll budget — check Logs for transport=tls-worker vs undici fallback; confirm HYPER_API_KEY + ISP list.";
  }
  if (
    /datadome|slider|puzzle|hcaptcha|pc_edge|pc_sticky|pc_sticky_superseded|interstitial|public_token|bff_40[13]|discovery_|empty_fetch|cannot (read|set) properties/i.test(
      msg,
    )
  ) {
    return "Edge/BFF block — monitor uses checkout tls-worker + sticky rotate; confirm HYPER_API_KEY + AU ISP proxies";
  }
  return undefined;
}

function serializePkcForcePollJob(job) {
  if (!job) return { running: false, jobId: null };
  return {
    running: Boolean(job.running),
    jobId: job.id,
    startedAt: job.startedAt,
    doneAt: job.doneAt || null,
    ok: job.ok,
    error: job.error || null,
    hint: job.hint || null,
    summary: job.summary || null,
    discordEvents: job.discordEvents ?? null,
    events: job.events || null,
    pokemoncentre: pcMonitor.status(),
  };
}

async function runPkcForcePollJob(job) {
  try {
    // announce:true → Discord current keyword/SKU hits (not silent baseline/diff-only).
    const { summary, events } = await pcMonitor.pollOnce({ announce: true });
    labLog("monitor", "info", "PKC force poll", {
      jobId: job.id,
      polls: summary?.polls,
      products: summary?.products,
      events: events?.length || 0,
      announced: Boolean(summary?.announced),
      edgeNote: summary?.edgeNote || null,
      proxyHost: summary?.proxyHost || null,
      attempts: summary?.edgeAttempts || null,
      transport: summary?.transport || null,
    });
    job.running = false;
    job.ok = true;
    job.doneAt = Date.now();
    job.summary = summary;
    job.discordEvents = events?.length || 0;
    job.events = (events || []).map((e) => ({
      productId: e.productId,
      inStock: e.inStock,
      reason: e.reason,
    }));
  } catch (e) {
    const msg = e?.message || "pkc_poll_failed";
    labLog("monitor", "err", `PKC force poll failed: ${msg}`);
    job.running = false;
    job.ok = false;
    job.doneAt = Date.now();
    job.error = msg;
    job.hint = pkcForcePollHint(msg);
  }
}

app.get("/monitor/pkc/poll/status", async (req, reply) => {
  if (!authOk(req)) return reply.code(401).send({ ok: false, error: "unauthorized" });
  return { ok: true, ...serializePkcForcePollJob(pkcForcePollJob) };
});

app.post("/monitor/pkc/poll", async (req, reply) => {
  if (!authOk(req)) return reply.code(401).send({ ok: false, error: "unauthorized" });
  const body = req.body && typeof req.body === "object" ? req.body : {};
  const sync =
    req.query?.sync === "1" ||
    req.query?.sync === "true" ||
    body.sync === true ||
    body.sync === 1;

  if (pkcForcePollJob?.running) {
    return {
      ok: true,
      accepted: true,
      running: true,
      ...serializePkcForcePollJob(pkcForcePollJob),
    };
  }

  const job = {
    id: `pkc-poll-${Date.now().toString(36)}`,
    running: true,
    startedAt: Date.now(),
    doneAt: null,
    ok: null,
    error: null,
    hint: null,
    summary: null,
    discordEvents: null,
    events: null,
  };
  pkcForcePollJob = job;
  labLog("monitor", "info", "PKC force poll started", {
    jobId: job.id,
    sync: Boolean(sync),
    tlsWorker: process.env.PC_MONITOR_TLS_WORKER !== "0",
  });

  if (sync) {
    await runPkcForcePollJob(job);
    if (job.ok) {
      return {
        ok: true,
        summary: job.summary,
        discordEvents: job.discordEvents,
        events: job.events,
        jobId: job.id,
      };
    }
    return reply.code(503).send({
      ok: false,
      error: job.error || "pkc_poll_failed",
      hint: job.hint,
      jobId: job.id,
      pokemoncentre: pcMonitor.status(),
    });
  }

  void runPkcForcePollJob(job);
  return {
    ok: true,
    accepted: true,
    running: true,
    jobId: job.id,
    note: "Force poll running (checkout tls-worker edge) — GET /monitor/pkc/poll/status",
    pokemoncentre: pcMonitor.status(),
  };
});

app.get("/logs", async (req, reply) => {
  if (!authOk(req)) return reply.code(401).send({ ok: false, error: "unauthorized" });
  const limit = Number(req.query?.limit) || 100;
  const source = req.query?.source || null;
  const level = req.query?.level || null;
  return {
    ok: true,
    ...labLogStats(),
    monitorRunning: Boolean(hub.monitor.status()?.running),
    logs: getLabLogs({ limit, source, level }),
  };
});

app.delete("/logs", async (req, reply) => {
  if (!authOk(req)) return reply.code(401).send({ ok: false, error: "unauthorized" });
  clearLabLogs();
  labLog("system", "info", "Logs cleared");
  return { ok: true, ...labLogStats() };
});

/**
 * Operator test: POST /test-discord?sku=…&kind=restock|oos|checkout|pkc|pkc-preload|pkc-oos
 * Optional store=pokemoncentre (alias pkc) routes Bandai kinds onto PKC embeds.
 */
app.post("/test-discord", async (req, reply) => {
  if (!authOk(req)) return reply.code(401).send({ ok: false, error: "unauthorized" });
  const q = req.query || {};
  const body = req.body && typeof req.body === "object" ? req.body : {};
  const kindRaw = String(q.kind || body.kind || "restock").toLowerCase();
  const storeRaw = String(q.store || body.store || "").toLowerCase();
  const isPkc =
    storeRaw === "pokemoncentre" ||
    storeRaw === "pkc" ||
    storeRaw === "pokemon-centre" ||
    kindRaw === "pkc" ||
    kindRaw.startsWith("pkc-") ||
    kindRaw === "pkc_preload" ||
    kindRaw === "pkc_oos";
  const skuDefault = isPkc ? "10-10186-109" : "N2890904001";
  const sku = String(q.sku || body.sku || skuDefault).trim();
  const kind = kindRaw;
  const pcLocale = String(
    q.locale || body.locale || runtime.pcLocale || process.env.PC_MONITOR_LOCALE || "en-au",
  ).toLowerCase();

  if (kind === "checkout") {
    if (!checkoutFeedHook()) {
      return reply.code(400).send({ ok: false, error: "checkout feed webhook not configured" });
    }
    const win = sanitizeCheckoutWin({
      store: isPkc ? "pokemoncentre" : "bandai",
      title: body.title || `Test checkout · ${sku}`,
      sku,
      pdpUrl: isPkc
        ? `https://www.pokemoncenter.com/${pcLocale}/product/${encodeURIComponent(sku)}`
        : `https://p-bandai.com/au/item/${encodeURIComponent(sku)}`,
      mode: "Checkout",
      payment: "Card",
      test: true,
    });
    const payload = vantaPublicCheckoutDiscordBody(win, { test: true });
    const r = await postCheckoutFeed(payload);
    return r.ok
      ? { ok: true, kind: "checkout", store: isPkc ? "pokemoncentre" : "bandai", posted: true }
      : reply.code(502).send({ ok: false, error: r.error || "discord_failed" });
  }

  if (!discordHook()) {
    return reply.code(400).send({ ok: false, error: "restock webhook not configured" });
  }

  // ── Pokémon Centre lab pings (same webhook as live PKC stock_changed) ──
  if (isPkc) {
    const pkcKind =
      kind === "pkc-oos" || kind === "pkc_oos" || kind === "oos"
        ? "oos"
        : kind === "pkc-preload" || kind === "pkc_preload" || kind === "preload"
          ? "preload"
          : kind === "pkc-soft" ||
              kind === "pkc_soft" ||
              kind === "soft" ||
              kind === "soft_listed" ||
              kind === "soft-listed"
            ? "soft"
            : "stock";

    let row = typeof pcMonitor.getProduct === "function" ? pcMonitor.getProduct(sku) : null;
    if (!row) {
      const cat = typeof pcMonitor.getCatalog === "function" ? pcMonitor.getCatalog() : null;
      if (cat?.size) {
        row =
          [...cat.values()].find(
            (r) =>
              String(r?.productId || "").toUpperCase() === sku.toUpperCase() ||
              (r?.imageUrl && r?.title),
          ) || [...cat.values()][0] || null;
      }
    }
    // Synthetic fixture when catalog empty — still proves webhook + embed shape.
    const hitForDiscord = {
      productId: row?.productId || sku,
      title: row?.title || body.title || `PKC lab · ${sku}`,
      imageUrl: row?.imageUrl || body.imageUrl || null,
      price: row?.price || body.price || null,
      availability:
        row?.availability ||
        (pkcKind === "preload"
          ? "AVAILABLE_FOR_PRE_ORDER"
          : pkcKind === "soft" || pkcKind === "oos"
            ? "NOT_AVAILABLE"
            : "AVAILABLE"),
      preorder: pkcKind === "preload",
      softListed: pkcKind === "soft",
      reason:
        pkcKind === "oos"
          ? "went_oos"
          : pkcKind === "preload"
            ? "preorder_live"
            : pkcKind === "soft"
              ? "soft_listed"
              : "restock",
      inStock: pkcKind !== "oos" && pkcKind !== "soft",
      locale: pcLocale,
      slug: row?.slug || row?.meta?.slug || null,
      pdpUrl: row?.pdpUrl || row?.meta?.pdpUrl || null,
      source: row?.source || (pkcKind === "soft" ? "sitemap" : null),
      at: new Date().toISOString(),
    };
    const payload =
      pkcKind === "oos"
        ? vantaPkcOosDiscordBody(hitForDiscord, { locale: pcLocale, test: true })
        : vantaPkcDiscordBody(hitForDiscord, {
            locale: pcLocale,
            test: true,
            preload: pkcKind === "preload",
            softListed: pkcKind === "soft",
          });

    const qtHit = {
      ...hitForDiscord,
      store: "pokemoncentre",
      pdpUrl: pcPdpUrl(hitForDiscord, pcLocale),
    };
    const quickTaskUrl =
      pkcKind === "oos"
        ? null
        : buildQuickTaskBridgeUrl(qtHit, { store: "pokemoncentre", locale: pcLocale });
    const quickTaskLocal =
      pkcKind === "oos"
        ? null
        : buildQuickTaskLocalUrl(qtHit, { store: "pokemoncentre", locale: pcLocale });

    try {
      const r = await postDiscordWithQtFallback(payload);
      if (!r.ok) {
        return reply.code(502).send({
          ok: false,
          error: "discord_reject",
          status: r.status,
          detail: r.error,
        });
      }
      labLog("discord", "info", `PKC lab ${pkcKind} ping · ${hitForDiscord.productId}`, {
        kind: pkcKind,
        sku: hitForDiscord.productId,
        synthetic: !row,
      });
      return {
        ok: true,
        discord: r.status,
        store: "pokemoncentre",
        kind:
          pkcKind === "oos"
            ? "pkc-oos"
            : pkcKind === "preload"
              ? "pkc-preload"
              : pkcKind === "soft"
                ? "pkc-soft"
                : "pkc",
        synthetic: !row,
        quickTaskUrl,
        quickTaskLocal,
        hasQuickTaskButton: Boolean(payload.components?.length && !r.componentsStripped),
        hasQuickTaskLink: Boolean(
          /Quick Task/i.test(String(payload.embeds?.[0]?.fields?.find((f) => f.name === "Links")?.value || "")),
        ),
        componentsStripped: Boolean(r.componentsStripped),
        product: {
          productId: hitForDiscord.productId,
          title: hitForDiscord.title,
          price: hitForDiscord.price,
          imageUrl: hitForDiscord.imageUrl,
          availability: hitForDiscord.availability,
          locale: pcLocale,
        },
      };
    } catch (e) {
      return reply.code(502).send({ ok: false, error: e?.message || String(e) });
    }
  }

  if ((hub.monitor.status()?.products || 0) === 0) {
    try {
      await hub.monitor.pollOnce();
    } catch (e) {
      return reply.code(503).send({ ok: false, error: e?.message || "poll_failed" });
    }
  }

  let row = hub.monitor.getProduct?.(sku) || null;
  if (!row) {
    const cat = hub.monitor.getCatalog?.();
    if (cat?.size) {
      row =
        [...cat.values()].find((r) => r?.imageUrl && r?.title) ||
        [...cat.values()][0] ||
        null;
    }
  }
  if (!row) {
    return reply.code(404).send({ ok: false, error: "sku_not_in_catalog", sku });
  }

  const hit = {
    productId: row.productId,
    areaItemNo: row.areaItemNo,
    title: row.title,
    imageUrl: row.imageUrl,
    price: row.price,
    productType: row.productType,
    reason: kind === "oos" ? "went_oos" : "restock",
    inStock: kind !== "oos",
    at: new Date().toISOString(),
  };
  // Prefer the SKU the operator typed (catalog row may fall back to another product).
  const hitForDiscord = {
    ...hit,
    productId: row.productId || sku,
  };
  const payload =
    kind === "oos"
      ? vantaOosDiscordBody(hitForDiscord, { area: AREA, test: true })
      : vantaRestockDiscordBody(hitForDiscord, { area: AREA, test: true });

  const quickTaskUrl =
    kind === "oos" ? null : buildQuickTaskBridgeUrl(hitForDiscord, { area: AREA });
  const quickTaskLocal =
    kind === "oos" ? null : buildQuickTaskLocalUrl(hitForDiscord, { area: AREA });

  try {
    const r = await postDiscordWithQtFallback(payload);
    if (!r.ok) {
      return reply.code(502).send({
        ok: false,
        error: "discord_reject",
        status: r.status,
        detail: r.error,
      });
    }
    return {
      ok: true,
      discord: r.status,
      store: "bandai",
      kind: kind === "oos" ? "oos" : "restock",
      quickTaskUrl,
      quickTaskLocal,
      hasQuickTaskButton: Boolean(payload.components?.length && !r.componentsStripped),
      hasQuickTaskLink: Boolean(
        /Quick Task/i.test(String(payload.embeds?.[0]?.description || "")),
      ),
      componentsStripped: Boolean(r.componentsStripped),
      product: {
        productId: row.productId,
        areaItemNo: row.areaItemNo || null,
        title: row.title,
        price: row.price,
        imageUrl: row.imageUrl,
        productType: row.productType,
      },
    };
  } catch (e) {
    return reply.code(502).send({ ok: false, error: e?.message || String(e) });
  }
});

// ── Bot lab (Fly executor proxy + operator vault) ──────────────────────────

app.get("/bot/status", async (req, reply) => {
  if (!authOk(req)) return reply.code(401).send({ ok: false, error: "unauthorized" });
  const cfg = executorStatus();
  let health = null;
  if (cfg.configured) {
    const r = await executorFetch("/health", { timeoutMs: 8000 });
    health = r.ok ? r.json : { ok: false, error: r.error, status: r.status };
  }
  let harvest = null;
  if (cfg.configured) {
    const h = await executorFetch("/bandai/harvest", { timeoutMs: 8000 });
    harvest = h.ok ? h.json : null;
  }
  return {
    ok: true,
    executor: { ...cfg, token: undefined, hasToken: Boolean(cfg.token) },
    health,
    harvest,
    runs: botRuns.slice(0, 15),
    vault: vaultPublicView(botVault),
  };
});

app.get("/bot/vault", async (req, reply) => {
  if (!authOk(req)) return reply.code(401).send({ ok: false, error: "unauthorized" });
  const full = String(req.query?.full || "") === "1";
  if (full) {
    // Full vault for editing on phone (operator-only token).
    return { ok: true, vault: botVault, public: vaultPublicView(botVault) };
  }
  return { ok: true, vault: vaultPublicView(botVault) };
});

app.put("/bot/vault", async (req, reply) => {
  if (!authOk(req)) return reply.code(401).send({ ok: false, error: "unauthorized" });
  const body = req.body && typeof req.body === "object" ? req.body : {};
  try {
    if (Array.isArray(body.accounts)) botVault.accounts = body.accounts;
    if (body.profile && typeof body.profile === "object") {
      const prev = botVault.profile || {};
      const next = { ...prev, ...body.profile };
      // Keep prior secrets when UI sends masked placeholders.
      if (/^•|^•••|\*\*\*\*/.test(String(next.card_number || ""))) next.card_number = prev.card_number;
      if (/^•|^•••|\*\*\*\*/.test(String(next.card_cvv || ""))) next.card_cvv = prev.card_cvv;
      botVault.profile = next;
    }
    if (body.checkoutProxies != null) botVault.checkoutProxies = String(body.checkoutProxies);
    if (body.defaults && typeof body.defaults === "object") {
      botVault.defaults = { ...botVault.defaults, ...body.defaults };
    }
    // Convenience: paste accounts as email:password lines
    if (typeof body.accountsText === "string") {
      const rows = [];
      for (const line of body.accountsText.split(/\r?\n/)) {
        const t = line.trim();
        if (!t || t.startsWith("#")) continue;
        const idx = t.indexOf(":");
        if (idx < 1) continue;
        const email = t.slice(0, idx).trim();
        const password = t.slice(idx + 1).trim();
        if (!email || !password) continue;
        rows.push({
          id: `acc_${email.toLowerCase().replace(/[^a-z0-9]+/g, "_").slice(0, 40)}`,
          storeId: "bandai",
          label: email,
          email,
          password,
        });
      }
      if (rows.length) botVault.accounts = rows;
    }
    botVault = { ...botVault, ...saveBotVault(botVault, botVault._path) };
    return { ok: true, vault: vaultPublicView(botVault) };
  } catch (e) {
    return reply.code(400).send({ ok: false, error: e?.message || String(e) });
  }
});

app.get("/bot/runs", async (req, reply) => {
  if (!authOk(req)) return reply.code(401).send({ ok: false, error: "unauthorized" });
  return { ok: true, runs: botRuns.slice(0, MAX_BOT_RUNS) };
});

app.get("/bot/runs/:taskId", async (req, reply) => {
  if (!authOk(req)) return reply.code(401).send({ ok: false, error: "unauthorized" });
  const taskId = String(req.params.taskId || "");
  const local = botRuns.find((r) => r.taskId === taskId) || null;
  let progress = null;
  if (executorStatus().configured) {
    const p = await executorFetch(`/progress/${encodeURIComponent(taskId)}`, { timeoutMs: 8000 });
    if (p.ok) progress = p.json;
  }
  if (!local && !progress) return reply.code(404).send({ ok: false, error: "not_found" });
  return { ok: true, run: local, progress };
});

/**
 * Start a lab run against Fly (async — returns immediately with taskId).
 * Body: { store: "bandai"|"kmart", ...form fields }
 */
app.post("/bot/run", async (req, reply) => {
  if (!authOk(req)) return reply.code(401).send({ ok: false, error: "unauthorized" });
  const cfg = executorStatus();
  if (!cfg.configured) {
    return reply.code(503).send({
      ok: false,
      error: "Set EXECUTOR_URL + EXECUTOR_TOKEN on the Railway monitor service",
    });
  }
  const body = req.body && typeof req.body === "object" ? req.body : {};
  const store = String(body.store || "bandai").toLowerCase();
  const built =
    store === "kmart"
      ? buildKmartLabPayload(body, botVault)
      : buildBandaiLabPayload(body, botVault);
  if (!built.ok) return reply.code(400).send({ ok: false, error: built.error });

  const row = {
    taskId: built.data.taskId,
    store: built.meta.store,
    mode: built.meta.mode,
    placeOrder: Boolean(built.meta.placeOrder),
    status: "queued",
    startedAt: new Date().toISOString(),
    finishedAt: null,
    ok: null,
    error: null,
    checkoutStage: null,
    failedStep: null,
    summary: null,
    request: redactRunPayload(built.data),
  };
  botRuns.unshift(row);
  if (botRuns.length > MAX_BOT_RUNS) botRuns.length = MAX_BOT_RUNS;
  labLog("bot", "info", `run start ${row.store}/${row.mode}`, {
    taskId: row.taskId,
    placeOrder: row.placeOrder,
  });

  // Fire-and-forget — checkout can run for minutes.
  row.status = "running";
  void (async () => {
    const r = await executorFetch("/run", {
      method: "POST",
      body: built.data,
      timeoutMs: Number(process.env.BOT_RUN_TIMEOUT_MS) || 12 * 60_000,
    });
    row.finishedAt = new Date().toISOString();
    if (!r.ok) {
      row.status = "error";
      row.ok = false;
      row.error = r.error || `http_${r.status}`;
      row.summary = r.json || null;
      labLog("bot", "err", `run error ${row.taskId}`, { error: row.error });
      return;
    }
    const j = r.json || {};
    row.status = "done";
    row.ok = Boolean(j.ok);
    row.error = j.error || j.consumerLabel || null;
    row.checkoutStage = j.checkoutStage || null;
    row.failedStep = j.failedStep || null;
    row.summary = {
      ok: j.ok,
      orderNumber: j.orderNumber || null,
      checkoutStage: j.checkoutStage || null,
      failedStep: j.failedStep || null,
      consumerLabel: j.consumerLabel || null,
      elapsedMs: j.elapsedMs ?? null,
      lastSteps: Array.isArray(j.steps)
        ? j.steps.slice(-8).map((s) => ({ step: s.step, ok: s.ok, status: s.status }))
        : null,
    };
    labLog("bot", row.ok ? "info" : "warn", `run done ${row.taskId}`, {
      ok: row.ok,
      checkoutStage: row.checkoutStage,
      failedStep: row.failedStep,
      error: row.error,
    });
  })().catch((e) => {
    row.status = "error";
    row.ok = false;
    row.finishedAt = new Date().toISOString();
    row.error = e?.message || String(e);
    labLog("bot", "err", `run throw ${row.taskId}`, { error: row.error });
  });

  return { ok: true, taskId: row.taskId, run: row };
});

app.get("/events", async (req, reply) => {
  if (!feedAuthOk(req)) return reply.code(401).send({ ok: false, error: "unauthorized" });
  reply.hijack();
  const res = reply.raw;
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  res.write(`event: hello\ndata: ${JSON.stringify({ ok: true, at: new Date().toISOString() })}\n\n`);
  sseClients.add(res);
  const ping = setInterval(() => {
    try {
      res.write(`: ping ${Date.now()}\n\n`);
    } catch {
      clearInterval(ping);
      sseClients.delete(res);
    }
  }, 25000);
  req.raw.on("close", () => {
    clearInterval(ping);
    sseClients.delete(res);
  });
});

await app.listen({ port: PORT, host: "0.0.0.0" });
console.log(
  JSON.stringify({
    listening: PORT,
    area: AREA,
    intervalMs: runtime.intervalMs,
    keywords: runtime.keywords,
    pkc: {
      enabled: pcMonitorEnabled,
      locale: runtime.pcLocale || "en-au",
      keywords: runtime.pcKeywords,
      skus: runtime.pcSkus,
      intervalMs: runtime.pcIntervalMs || 15000,
    },
    authRequired: Boolean(TOKEN),
    feedPublic: FEED_PUBLIC,
    admin: "/admin/",
    statePath: runtime._path,
    fromDisk: Boolean(runtime._fromDisk),
    persistence: persistence(),
    executorConfigured: executorStatus().configured,
  }),
);
hub.start();
if (pcMonitorEnabled) {
  const pcSt = pcMonitor.status();
  const hasWatch =
    (pcSt.keywords?.length || 0) + (pcSt.skus?.length || 0) > 0 || Boolean(pcSt.discoveryEnable);
  if (hasWatch) {
    pcMonitor.start();
  }
  console.log(
    JSON.stringify({
      event: hasWatch ? "pkc_monitor_start" : "pkc_monitor_idle",
      note: hasWatch
        ? pcSt.discoveryEnable && !(pcSt.keywords?.length || pcSt.skus?.length)
          ? "discovery-only (sitemap/category soft-list)"
          : "polling watchlist + discovery"
        : "waiting for admin PKC keywords/SKUs or discovery",
      locale: pcSt.locale,
      keywords: pcSt.keywords,
      skus: pcSt.skus,
      discoveryEnable: pcSt.discoveryEnable,
      hyperConfigured: pcSt.hyperConfigured,
    }),
  );
}

async function shutdown() {
  console.log("[shutdown] stopping monitor");
  try {
    await hub.stop();
  } catch {
    /* ignore */
  }
  try {
    await pcMonitor.stop();
  } catch {
    /* ignore */
  }
  hub.detach();
  await app.close();
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
