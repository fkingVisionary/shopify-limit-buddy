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
  buildQuickTaskBridgeUrl,
  buildQuickTaskLocalUrl,
  QUICKTASK_BRIDGE_PORT,
} from "./vanta-discord.mjs";
import {
  loadRuntimeConfig,
  saveRuntimeConfig,
  runtimePersistenceInfo,
  normalizeDiscordWebhooks,
  isDiscordWebhookUrl,
} from "./runtime-config.mjs";
import { resolveStateFile } from "./data-dir.mjs";
import fs from "node:fs";
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
  const merged = mergeRowsWithProductCache(parsed, productCache, AREA);
  // Attach live catalog images when the stock snapshot already has them.
  return merged.map((row) => {
    if (row.imageUrl || String(row.store || "").toLowerCase() !== "bandai") return row;
    try {
      const live = hub.monitor.getProduct?.(row.sku) || null;
      const imageUrl = String(live?.imageUrl || "").trim();
      if (!imageUrl) return row;
      return { ...row, imageUrl };
    } catch {
      return row;
    }
  });
}

const recentHitsPath = resolveStateFile("vanta-recent-hits.json").path;

function loadRecentHitsFromDisk() {
  try {
    const raw = fs.readFileSync(recentHitsPath, "utf8");
    const j = JSON.parse(raw);
    const rows = Array.isArray(j?.hits) ? j.hits : Array.isArray(j) ? j : [];
    return rows
      .filter((h) => h && h.productId)
      .slice(0, MAX_HITS);
  } catch {
    return [];
  }
}

function persistRecentHits() {
  try {
    fs.mkdirSync(path.dirname(recentHitsPath), { recursive: true });
    fs.writeFileSync(
      recentHitsPath,
      JSON.stringify({ updatedAt: new Date().toISOString(), hits: recentHits.slice(0, MAX_HITS) }, null, 2),
    );
  } catch {
    /* volume/tmp write failure — in-memory buffer still works */
  }
}

/** @type {object[]} */
const recentHits = loadRecentHitsFromDisk();
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

/** All Discord webhook URLs (admin list + env bootstrap). */
function discordHooks() {
  const fromRuntime = normalizeDiscordWebhooks(runtime?.discordWebhooks);
  if (fromRuntime.length) return fromRuntime.map((w) => w.url);
  const env = String(process.env.DISCORD_WEBHOOK_URL || "").trim().replace(/\/+$/, "");
  return isDiscordWebhookUrl(env) ? [env] : [];
}

function discordHook() {
  return discordHooks()[0] || null;
}

function maskWebhookUrl(url) {
  const u = String(url || "");
  const m = u.match(/^(https:\/\/(?:discord\.com|discordapp\.com)\/api\/webhooks\/\d+\/)([\w-]+)/i);
  if (!m) return u.slice(0, 40) + "…";
  const token = m[2];
  const tail = token.slice(-4);
  return `${m[1]}…${tail}`;
}

function pushHit(ev) {
  const meta = ev?.meta || {};
  const row = {
    at: new Date().toISOString(),
    productId: ev.productId,
    inStock: ev.inStock,
    reason: ev.reason || null,
    title: ev.title || meta.title || null,
    imageUrl: ev.imageUrl || meta.imageUrl || null,
    price: ev.price || meta.price || null,
    areaItemNo: ev.areaItemNo || meta.areaItemNo || null,
    productType: meta.productType || ev.productType || null,
  };
  recentHits.unshift(row);
  if (recentHits.length > MAX_HITS) recentHits.length = MAX_HITS;
  persistRecentHits();
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

async function postDiscordOne(hook, body, timeoutMs) {
  const res = await fetch(hook, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text().catch(() => "");
  if (!res.ok) {
    return { ok: false, status: res.status, error: text.slice(0, 200), url: maskWebhookUrl(hook) };
  }
  return { ok: true, status: res.status, url: maskWebhookUrl(hook) };
}

async function postDiscord(body) {
  const hooks = discordHooks();
  if (!hooks.length) return { ok: false, skipped: true, error: "no_webhook" };
  const timeoutMs = Math.max(
    3_000,
    Number(process.env.DISCORD_WEBHOOK_TIMEOUT_MS) || 12_000,
  );
  const title = body?.embeds?.[0]?.title || body?.username || "ping";
  const results = [];
  for (const hook of hooks) {
    try {
      const r = await postDiscordOne(hook, body, timeoutMs);
      results.push(r);
      if (!r.ok) {
        labLog("discord", "err", `webhook ${r.status || "err"} · ${r.url}`, {
          detail: String(r.error || "").slice(0, 120),
        });
      }
    } catch (e) {
      const msg =
        e?.name === "TimeoutError" || e?.name === "AbortError"
          ? `webhook_timeout_${timeoutMs}ms`
          : e?.message || String(e);
      labLog("discord", "err", `${msg} · ${maskWebhookUrl(hook)}`);
      results.push({ ok: false, error: msg, url: maskWebhookUrl(hook) });
    }
  }
  const okCount = results.filter((r) => r.ok).length;
  if (okCount) {
    labLog(
      "discord",
      "info",
      `sent · ${title} · ${okCount}/${results.length} webhook(s)`.slice(0, 200),
    );
  }
  return {
    ok: okCount > 0,
    status: results.find((r) => r.ok)?.status || results[0]?.status || null,
    sent: okCount,
    total: results.length,
    results,
    error: okCount ? null : results[0]?.error || "all_webhooks_failed",
  };
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
    }
  }
} catch (e) {
  console.warn("[runtime-config]", e?.message || e);
}

hub.monitor.on("started", (s) => {
  labLog("monitor", "info", "Monitor started", {
    intervalMs: s?.intervalMs,
    keywords: s?.keywords,
  });
});
hub.monitor.on("stopped", (s) => {
  labLog("monitor", "warn", "Monitor stopped", { polls: s?.polls });
});

hub.monitor.on("stock_changed", async (ev) => {
  console.log(
    `[stock_changed] ${ev.productId} inStock=${ev.inStock} reason=${ev.reason} ${ev.title || ev.meta?.title || ""}`,
  );
  labLog(
    "monitor",
    ev?.inStock ? "info" : "warn",
    `${ev.reason || "stock"} ${ev.productId}${ev.title || ev.meta?.title ? ` · ${ev.title || ev.meta?.title}` : ""}`,
    { productId: ev.productId, inStock: ev.inStock, reason: ev.reason },
  );
  if (ev?.productId) {
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
  pushHit(ev);

  const reason = String(ev?.reason || "");
  const isOos = ev?.inStock === false || reason === "went_oos";
  if (isOos) {
    if (runtime.notifyOos === false) return;
    try {
      const r = await postDiscord(
        vantaOosDiscordBody(hitPayload(ev), { area: AREA, source: "railway-monitor" }),
      );
      if (!r.ok && !r.skipped) console.warn("[discord:oos]", r.status, r.error);
    } catch (e) {
      console.warn("[discord:oos]", e?.message || e);
    }
    return;
  }

  if (!ev?.inStock) return;
  try {
    const r = await postDiscordWithQtFallback(
      vantaRestockDiscordBody(hitPayload(ev), { area: AREA, source: "railway-monitor" }),
    );
    if (!r.ok && !r.skipped) console.warn("[discord]", r.status, r.error);
    else if (r.componentsStripped) console.warn("[discord] components stripped — QT description links kept");
  } catch (e) {
    console.warn("[discord]", e?.message || e);
  }
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
  for (const key of ["sku", "title", "nai", "area", "reason", "url"]) {
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
  const payload = {
    ok: stale.healthy,
    service: "bandai-monitor",
    gitSha: process.env.GIT_SHA || process.env.RAILWAY_GIT_COMMIT_SHA || null,
    area: AREA,
    intervalMs: m.intervalMs ?? runtime.intervalMs,
    keywords: m.keywords || [],
    monitor: m,
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
    recentHits: recentHits.slice(0, 20),
    sseClients: sseClients.size,
    runtime: {
      notifyOos: runtime.notifyOos !== false,
      updatedAt: runtime.updatedAt || null,
      statePath: runtime._path || null,
      fromDisk: Boolean(runtime._fromDisk),
      persistence: persistence(),
    },
  };
});

app.get("/hits", async (req, reply) => {
  if (!feedAuthOk(req)) return reply.code(401).send({ ok: false, error: "unauthorized" });
  const limit = Math.max(1, Math.min(MAX_HITS, Number(req.query?.limit) || 50));
  return { ok: true, hits: recentHits.slice(0, limit) };
});

function discordWebhooksPublic() {
  return normalizeDiscordWebhooks(runtime.discordWebhooks).map((w) => ({
    id: w.id,
    label: w.label || "",
    url: w.url,
    masked: maskWebhookUrl(w.url),
    addedAt: w.addedAt || null,
  }));
}

app.get("/admin/config", async (req, reply) => {
  if (!authOk(req)) return reply.code(401).send({ ok: false, error: "unauthorized" });
  const m = hub.monitor.status();
  const presetRaw = normalizePresetCatalogRaw(runtime.presetCatalog);
  return {
    ok: true,
    keywords: Array.isArray(m.keywords) ? m.keywords.join("\n") : String(runtime.keywords || ""),
    presetCatalog: presetRaw,
    presetCatalogRows: presetRowsForResponse(presetRaw),
    discordWebhooks: discordWebhooksPublic(),
    productCacheCount: Object.keys(productCache.entries || {}).length,
    ispProxies: runtime.ispProxies || "",
    dcProxies: runtime.dcProxies || "",
    intervalMs: m.intervalMs ?? runtime.intervalMs,
    notifyOos: runtime.notifyOos !== false,
    updatedAt: runtime.updatedAt || null,
    pool: m.pool || null,
    persistence: persistence(),
  };
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
    if (body.discordWebhooks != null) {
      runtime.discordWebhooks = normalizeDiscordWebhooks(body.discordWebhooks);
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
    }
    runtime = { ...runtime, ...saveRuntimeConfig(runtime, runtime._path) };
    const presetRaw = normalizePresetCatalogRaw(runtime.presetCatalog);
    return {
      ok: true,
      keywords: hub.monitor.status().keywords,
      presetCatalog: presetRaw,
      presetCatalogRows: presetRowsForResponse(presetRaw),
      presetEnrich,
      discordWebhooks: discordWebhooksPublic(),
      productCacheCount: Object.keys(productCache.entries || {}).length,
      intervalMs: hub.monitor.status().intervalMs,
      notifyOos: runtime.notifyOos !== false,
      ispProxies: runtime.ispProxies || "",
      dcProxies: runtime.dcProxies || "",
      pool: hub.monitor.status().pool,
      updatedAt: runtime.updatedAt,
      persistence: persistence(),
    };
  } catch (e) {
    return reply.code(400).send({ ok: false, error: e?.message || String(e) });
  }
});

/** Add a Discord webhook for restock / OOS fan-out (persisted on volume). */
app.post("/admin/discord-webhooks", async (req, reply) => {
  if (!authOk(req)) return reply.code(401).send({ ok: false, error: "unauthorized" });
  const body = req.body && typeof req.body === "object" ? req.body : {};
  const url = String(body.url || "").trim().replace(/\/+$/, "");
  if (!isDiscordWebhookUrl(url)) {
    return reply.code(400).send({
      ok: false,
      error: "Invalid Discord webhook URL (expect discord.com/api/webhooks/…)",
    });
  }
  const label = String(body.label || "").trim().slice(0, 80);
  const cur = normalizeDiscordWebhooks(runtime.discordWebhooks);
  if (cur.some((w) => w.url.toLowerCase() === url.toLowerCase())) {
    return {
      ok: true,
      already: true,
      discordWebhooks: discordWebhooksPublic(),
    };
  }
  if (cur.length >= 20) {
    return reply.code(400).send({ ok: false, error: "Max 20 Discord webhooks" });
  }
  runtime.discordWebhooks = normalizeDiscordWebhooks([
    ...cur,
    { url, label, addedAt: new Date().toISOString() },
  ]);
  runtime = { ...runtime, ...saveRuntimeConfig(runtime, runtime._path) };
  labLog("discord", "info", `webhook added · ${maskWebhookUrl(url)}${label ? ` · ${label}` : ""}`);
  return { ok: true, discordWebhooks: discordWebhooksPublic() };
});

/** Remove Discord webhook by id or exact url. */
app.delete("/admin/discord-webhooks", async (req, reply) => {
  if (!authOk(req)) return reply.code(401).send({ ok: false, error: "unauthorized" });
  const body = req.body && typeof req.body === "object" ? req.body : {};
  const id = String(body.id || req.query?.id || "").trim();
  const url = String(body.url || req.query?.url || "")
    .trim()
    .replace(/\/+$/, "");
  if (!id && !url) {
    return reply.code(400).send({ ok: false, error: "id or url required" });
  }
  const cur = normalizeDiscordWebhooks(runtime.discordWebhooks);
  const next = cur.filter((w) => {
    if (id && w.id === id) return false;
    if (url && w.url.toLowerCase() === url.toLowerCase()) return false;
    return true;
  });
  if (next.length === cur.length) {
    return reply.code(404).send({ ok: false, error: "webhook not found" });
  }
  runtime.discordWebhooks = next;
  runtime = { ...runtime, ...saveRuntimeConfig(runtime, runtime._path) };
  labLog("discord", "info", `webhook removed · ${id || maskWebhookUrl(url)}`);
  return { ok: true, discordWebhooks: discordWebhooksPublic() };
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
  if (st.running) {
    return { ok: true, already: true, monitor: st };
  }
  hub.monitor.start();
  labLog("system", "info", "Monitor start requested from admin");
  return { ok: true, monitor: hub.monitor.status() };
});

app.post("/monitor/stop", async (req, reply) => {
  if (!authOk(req)) return reply.code(401).send({ ok: false, error: "unauthorized" });
  monitorExpectRunning = false;
  const st = hub.monitor.status();
  if (!st.running) {
    return { ok: true, already: true, monitor: st };
  }
  await hub.monitor.stop();
  labLog("system", "warn", "Monitor stop requested from admin", { polls: st.polls });
  return { ok: true, monitor: hub.monitor.status() };
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
    labLog("system", "warn", "Monitor restart requested from admin");
    return { ok: true, restarted: true, reason: "admin", monitor: hub.monitor.status() };
  } catch (e) {
    return reply.code(500).send({ ok: false, error: e?.message || String(e) });
  }
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

/** Operator test: POST /test-discord?sku=…&kind=restock|oos */
app.post("/test-discord", async (req, reply) => {
  if (!authOk(req)) return reply.code(401).send({ ok: false, error: "unauthorized" });
  if (!discordHooks().length) {
    return reply.code(400).send({
      ok: false,
      error: "No Discord webhooks — add one in Admin → Discord webhooks",
    });
  }
  const q = req.query || {};
  const body = req.body && typeof req.body === "object" ? req.body : {};
  const sku = String(q.sku || body.sku || "N2890904001").trim();
  const kind = String(q.kind || body.kind || "restock").toLowerCase();

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

async function shutdown() {
  console.log("[shutdown] stopping monitor");
  try {
    await hub.stop();
  } catch {
    /* ignore */
  }
  hub.detach();
  await app.close();
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
