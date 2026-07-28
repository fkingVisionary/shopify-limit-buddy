#!/usr/bin/env node
/**
 * Always-on Bandai global stock monitor host (Railway / any Node host).
 *
 * - Polls search/list on monitor proxies (DC+ISP)
 * - Exposes /health, /status, /events (SSE), recent /hits
 * - Does NOT run checkout (Desktop / executor claim ATC later)
 *
 * Auth: set MONITOR_TOKEN → require Bearer on /status /events /hits
 *       /health stays open for Railway healthchecks.
 */
import Fastify from "fastify";
import { createGlobalMonitorHub } from "../monitor/global-monitor-hub.js";
import { vantaRestockDiscordBody } from "./vanta-discord.mjs";

const PORT = Number(process.env.PORT) || 8080;
const TOKEN = String(process.env.MONITOR_TOKEN || process.env.EXECUTOR_TOKEN || "").trim();
const KEYWORDS =
  process.env.BANDAI_MONITOR_KEYWORDS ||
  process.env.MONITOR_KEYWORDS ||
  "GUNDAM,ONE PIECE,N2890904001";
const INTERVAL_MS = Number(process.env.BANDAI_MONITOR_INTERVAL_MS) || 5000;
const AREA = process.env.BANDAI_MONITOR_AREA || "au";
const MAX_HITS = Math.max(20, Math.min(500, Number(process.env.MONITOR_HIT_BUFFER) || 100));

/** @type {object[]} */
const recentHits = [];
/** @type {Set<import('node:http').ServerResponse>} */
const sseClients = new Set();

function authOk(req) {
  if (!TOKEN) return true;
  const h = String(req.headers.authorization || "");
  const m = h.match(/^Bearer\s+(.+)$/i);
  return Boolean(m && m[1].trim() === TOKEN);
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
    productType: meta.productType || null,
  };
  recentHits.unshift(row);
  if (recentHits.length > MAX_HITS) recentHits.length = MAX_HITS;
  const payload = `event: stock_changed\ndata: ${JSON.stringify(row)}\n\n`;
  for (const res of sseClients) {
    try {
      res.write(payload);
    } catch {
      sseClients.delete(res);
    }
  }
}

const hub = createGlobalMonitorHub({
  attachBridge: false,
  monitorOpts: {
    intervalMs: INTERVAL_MS,
    keywords: KEYWORDS,
    area: AREA,
  },
  log: (line) => console.log(`[hub] ${line}`),
});

hub.monitor.on("stock_changed", async (ev) => {
  console.log(
    `[stock_changed] ${ev.productId} inStock=${ev.inStock} reason=${ev.reason} ${ev.title || ev.meta?.title || ""}`,
  );
  if (!ev?.inStock) return;
  pushHit(ev);
  const hook = String(process.env.DISCORD_WEBHOOK_URL || "").trim();
  if (!hook || !/^https:\/\/(discord\.com|discordapp\.com)\/api\/webhooks\//i.test(hook)) return;
  try {
    const payload = vantaRestockDiscordBody(
      {
        ...ev,
        title: ev.title || ev.meta?.title,
        imageUrl: ev.imageUrl || ev.meta?.imageUrl,
        price: ev.price || ev.meta?.price,
        areaItemNo: ev.areaItemNo || ev.meta?.areaItemNo,
      },
      { area: AREA, source: "railway-monitor" },
    );
    const res = await fetch(hook, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!res.ok) console.warn("[discord]", res.status, await res.text().catch(() => ""));
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
});
hub.monitor.on("error", (e) => {
  console.warn(`[monitor:error] ${e.error || e}`);
});

const app = Fastify({ logger: false });

app.get("/", async (_req, reply) => {
  const st = hub.status();
  const m = st.monitor || {};
  const body = {
    ok: true,
    service: "bandai-monitor",
    message: "Bandai stock monitor is running. Use /health (open) or /status /hits /events with Bearer MONITOR_TOKEN.",
    area: AREA,
    intervalMs: INTERVAL_MS,
    keywords: String(KEYWORDS)
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    running: Boolean(m.running),
    polls: m.polls ?? 0,
    products: m.products ?? 0,
    inStock: m.inStock ?? 0,
    hitsBuffered: recentHits.length,
    lastError: m.lastError || null,
    pool: m.pool
      ? { isp: m.pool.isp, dc: m.pool.dc, cooling: m.pool.cooling, picks: m.pool.picks }
      : null,
    recentHits: recentHits.slice(0, 5).map((h) => ({
      at: h.at,
      productId: h.productId,
      reason: h.reason,
      title: h.title,
    })),
    links: {
      health: "/health",
      status: "/status",
      hits: "/hits",
      events: "/events",
    },
  };
  return reply.type("application/json").send(body);
});

app.get("/health", async () => {
  const st = hub.status();
  return {
    ok: true,
    service: "bandai-monitor",
    area: AREA,
    intervalMs: INTERVAL_MS,
    keywords: String(KEYWORDS)
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    monitor: st.monitor,
    hitsBuffered: recentHits.length,
    sseClients: sseClients.size,
    authRequired: Boolean(TOKEN),
  };
});

app.get("/status", async (req, reply) => {
  if (!authOk(req)) return reply.code(401).send({ ok: false, error: "unauthorized" });
  return { ok: true, ...hub.status(), recentHits: recentHits.slice(0, 20) };
});

app.get("/hits", async (req, reply) => {
  if (!authOk(req)) return reply.code(401).send({ ok: false, error: "unauthorized" });
  const limit = Math.max(1, Math.min(MAX_HITS, Number(req.query?.limit) || 50));
  return { ok: true, hits: recentHits.slice(0, limit) };
});

/** Operator test: POST /test-discord?sku=N2890904001 — Vanta restock embed from live catalog card. */
app.post("/test-discord", async (req, reply) => {
  if (!authOk(req)) return reply.code(401).send({ ok: false, error: "unauthorized" });
  const hook = String(process.env.DISCORD_WEBHOOK_URL || "").trim();
  if (!hook || !/^https:\/\/(discord\.com|discordapp\.com)\/api\/webhooks\//i.test(hook)) {
    return reply.code(400).send({ ok: false, error: "DISCORD_WEBHOOK_URL not configured" });
  }
  const q = req.query || {};
  const body = req.body && typeof req.body === "object" ? req.body : {};
  const sku = String(q.sku || body.sku || "N2890904001").trim();

  // Ensure we have a snapshot (cold deploy may still be warming).
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

  const payload = vantaRestockDiscordBody(
    {
      productId: row.productId,
      areaItemNo: row.areaItemNo,
      title: row.title,
      imageUrl: row.imageUrl,
      price: row.price,
      productType: row.productType,
      reason: "restock",
      at: new Date().toISOString(),
    },
    { area: AREA, test: true },
  );

  try {
    const res = await fetch(hook, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    const text = await res.text().catch(() => "");
    if (!res.ok) {
      return reply.code(502).send({
        ok: false,
        error: "discord_reject",
        status: res.status,
        detail: text.slice(0, 200),
      });
    }
    return {
      ok: true,
      discord: res.status,
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

app.get("/events", async (req, reply) => {
  if (!authOk(req)) return reply.code(401).send({ ok: false, error: "unauthorized" });
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
    intervalMs: INTERVAL_MS,
    keywords: KEYWORDS,
    authRequired: Boolean(TOKEN),
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
