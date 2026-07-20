// HTTP API for the executor service.
// Single endpoint: POST /run  → runs one checkout task, returns timeline.
// Auth: shared-secret bearer token (EXECUTOR_TOKEN env var).
// Health: GET /health → { ok: true }
// Deep health: POST /health/diagnose → fingerprint + proxy CONNECT probe

import Fastify from "fastify";
import { runCheckout } from "./checkout.js";
import { makeDispatcher, createJar, request, UA, HTTP_TRANSPORT } from "./http.js";
import { runDeepHealth } from "./health.js";
import { runKmartAkamaiLab } from "./experiments/kmart-akamai-lab.js";
import { runJbhifiRecon } from "./experiments/jbhifi-recon.js";
import { runJbhifiProbe } from "./experiments/jbhifi-probe.js";
import { getTaskProgress, WORKFLOW_STAGES } from "./progress.js";
import { listRunMilestones } from "./run-milestones.js";
import { resolveRunProxy, resiPoolSize } from "./proxy-pool.js";

const PORT = Number(process.env.PORT ?? 8080);
const TOKEN = (process.env.EXECUTOR_TOKEN ?? "").trim();
// Concurrency cap — protects the Fly VM from OOM under drop-time bursts.
// Each in-flight checkout holds a cookie jar, undici dispatcher, and a few
// KB of HTML in memory (~2-5 MB per task). Set generously; tune down if
// memory pressure shows in Fly metrics.
const MAX_CONCURRENT = Number(process.env.MAX_CONCURRENT ?? 120);
let inflight = 0;

if (!TOKEN) {
  console.error("FATAL: EXECUTOR_TOKEN env var is required");
  process.exit(1);
}

const app = Fastify({ logger: true, bodyLimit: 1_000_000 });

// Browser-friendly landing. This service is an API — visiting `/` in a browser
// used to look "blank" (Fastify 404). Keep /health as the probe endpoint.
const GIT_SHA = String(process.env.EXECUTOR_GIT_SHA || process.env.GIT_SHA || "unknown").slice(0, 40);
const MONITOR_ENABLE = /^(1|true|yes)$/i.test(String(process.env.MONITOR_ENABLE || ""));

app.get("/", async () => ({
  ok: true,
  service: "j1ms-bot-executor",
  health: "/health",
  diagnose: "POST /health/diagnose (Bearer auth)",
  run: "POST /run (Bearer auth)",
  progress: "GET /progress/:taskId (Bearer auth)",
  milestones: "GET /milestones (Bearer auth)",
  transport: HTTP_TRANSPORT,
  hyperApiKey: Boolean(process.env.HYPER_API_KEY),
  proxyConfigured: Boolean(process.env.PROXY_URL_RESI),
  gitSha: GIT_SHA,
  monitorEnabled: MONITOR_ENABLE,
  ts: Date.now(),
}));

app.get("/health", async () => ({
  ok: true,
  ts: Date.now(),
  inflight,
  cap: MAX_CONCURRENT,
  transport: HTTP_TRANSPORT,
  proxyTransport: HTTP_TRANSPORT,
  hyperApiKey: Boolean(process.env.HYPER_API_KEY),
  proxyConfigured: Boolean(process.env.PROXY_URL_RESI) || resiPoolSize() > 0,
  proxyPoolSize: resiPoolSize(),
  gitSha: GIT_SHA,
  monitorEnabled: MONITOR_ENABLE,
}));

// Authenticated deep health: TLS fingerprint + proxy CONNECT + direct target.
// Use this instead of a full /run when diagnosing ERR_CONNECTION_CLOSED /
// missing Hyper key / fingerprint drift.
app.post("/health/diagnose", async (req, reply) => {
  if (!checkAuth(req, reply)) return { ok: false, error: "unauthorized" };
  const body = req.body ?? {};
  try {
    return await runDeepHealth({
      proxy: body.proxy ?? null,
      targetUrl: typeof body.targetUrl === "string" ? body.targetUrl : "https://www.kmart.com.au/",
      fingerprint: body.fingerprint !== false,
      proxyProbe: body.proxyProbe !== false,
      directProbe: body.directProbe !== false,
    });
  } catch (e) {
    reply.code(500);
    return { ok: false, error: e?.message ?? String(e) };
  }
});

app.post("/transport/diagnose", async (req, reply) => {
  if (!checkAuth(req, reply)) return { ok: false, error: "unauthorized" };
  const body = req.body ?? {};
  const url = String(body.url ?? "https://www.kmart.com.au/");
  if (!/^https?:\/\//i.test(url)) {
    reply.code(400);
    return { ok: false, error: "url must be http(s)" };
  }

  const resolvedProxy = body.proxy ?? (body.useProxy ? process.env.PROXY_URL_RESI ?? null : null);
  const requestedTransport = typeof body.transport === "string" ? body.transport.toLowerCase() : null;
  const dispatcher = makeDispatcher(resolvedProxy, {
    forceTls: body.forceTls === true || requestedTransport === "tls",
    forceUndici: body.forceUndici === true || requestedTransport === "undici",
  });
  const jar = createJar();
  const t0 = Date.now();

  try {
    const res = await request(
      url,
      {
        method: "GET",
        headers: {
          "user-agent": UA,
          accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          "accept-language": "en-AU,en;q=0.9",
          "upgrade-insecure-requests": "1",
        },
      },
      { dispatcher, jar },
    );
    const bodyText = await res.text();
    return {
      ok: res.ok,
      status: res.status,
      elapsedMs: Date.now() - t0,
      transport: dispatcher.transport,
      usedProxy: Boolean(resolvedProxy),
      finalUrl: res.url ?? url,
      bodyBytes: bodyText.length,
      cookies: Object.keys(jar.dump()),
      headers: {
        server: res.headers.get("server"),
        "content-type": res.headers.get("content-type"),
      },
    };
  } catch (e) {
    reply.code(500);
    req.log.error({ err: e, transport: dispatcher.transport, usedProxy: Boolean(resolvedProxy) }, "transport diagnose failed");
    return {
      ok: false,
      error: e?.message ?? String(e),
      elapsedMs: Date.now() - t0,
      transport: dispatcher.transport,
      usedProxy: Boolean(resolvedProxy),
    };
  } finally {
    try { await dispatcher?.close?.(); } catch { /* ignore */ }
  }
});

function checkAuth(req, reply) {
  const auth = String(req.headers.authorization ?? "").trim();
  if (auth !== `Bearer ${TOKEN}`) {
    reply.code(401);
    return false;
  }
  return true;
}

// Live workflow progress for an in-flight (or recently finished) /run.
app.get("/progress/:taskId", async (req, reply) => {
  if (!checkAuth(req, reply)) return { ok: false, error: "unauthorized" };
  const taskId = String(req.params?.taskId ?? "").slice(0, 100);
  if (!taskId) {
    reply.code(400);
    return { ok: false, error: "missing taskId" };
  }
  const progress = getTaskProgress(taskId);
  if (!progress) {
    return { ok: true, found: false, taskId, progress: null, stages: WORKFLOW_STAGES };
  }
  return { ok: true, found: true, taskId, progress, stages: WORKFLOW_STAGES };
});

// Recent checkout wins (cart_get+ / 3DS / place_order). Survives client timeouts.
app.get("/milestones", async (req, reply) => {
  if (!checkAuth(req, reply)) return { ok: false, error: "unauthorized" };
  const q = req.query ?? {};
  const limit = Math.min(80, Math.max(1, Number(q.limit ?? 40) || 40));
  const minStage = typeof q.minStage === "string" && q.minStage ? q.minStage : "cart_get";
  const taskId = typeof q.taskId === "string" && q.taskId ? q.taskId : null;
  const rows = listRunMilestones({ limit, minStage, taskId });
  return {
    ok: true,
    count: rows.length,
    minStage,
    taskId,
    gitSha: GIT_SHA,
    milestones: rows,
  };
});

app.post("/run", async (req, reply) => {
  if (!checkAuth(req, reply)) return { ok: false, error: "unauthorized" };
  const task = req.body;
  if (!task?.taskId || !task?.storeUrl || !task?.variantId) {
    reply.code(400);
    return { ok: false, error: "missing required fields: taskId, storeUrl, variantId" };
  }
  if (inflight >= MAX_CONCURRENT) {
    reply.code(429);
    return { ok: false, error: `executor at capacity: ${inflight}/${MAX_CONCURRENT}` };
  }
  // Normalise + validate optional card. Never log full PAN or CVV.
  let card = null;
  if (task.card && typeof task.card === "object") {
    const c = task.card;
    const num = typeof c.number === "string" ? c.number.replace(/\s+/g, "") : "";
    const cvv = typeof c.cvv === "string" ? c.cvv : "";
    if (num.length >= 12 && num.length <= 19 && /^\d+$/.test(num) && cvv.length >= 3 && cvv.length <= 4) {
      card = {
        number: num,
        cvv,
        expMonth: String(c.expMonth ?? "").padStart(2, "0").slice(-2),
        expYear: String(c.expYear ?? "").slice(-2),
        holder: typeof c.holder === "string" ? c.holder.slice(0, 100) : "",
      };
      req.log.info({ card: { last4: num.slice(-4), holder: card.holder, exp: `${card.expMonth}/${card.expYear}` } }, "card received");
    } else {
      req.log.warn("card field present but invalid shape — ignoring");
    }
  }
  // Validate optional placeOrderMutation shape.
  let placeOrderMutation = null;
  if (task.placeOrderMutation && typeof task.placeOrderMutation === "object") {
    const m = task.placeOrderMutation;
    if (typeof m.operationName === "string" && typeof m.query === "string") {
      placeOrderMutation = {
        operationName: m.operationName.slice(0, 100),
        query: m.query.slice(0, 20_000),
        extraVars: m.extraVars && typeof m.extraVars === "object" ? m.extraVars : {},
      };
    }
  }
  // Resolve proxy on Fly: honor useProxy → resi.proxies; refuse dead
  // WealthProxies/IPFist even if the Cloudflare Worker still sends Test Pool.
  const resolved = resolveRunProxy({
    proxy: task.proxy,
    proxies: task.proxies,
    proxyEntries: task.proxyEntries,
    useProxy: task.useProxy === true,
  });
  req.log.info(
    {
      proxySource: resolved.source,
      proxyPoolSize: resolved.poolSize,
      proxyIndex: resolved.index,
      hasProxy: Boolean(resolved.proxy),
    },
    "run proxy resolved",
  );

  inflight++;
  try {
    const result = await runCheckout({
      taskId: String(task.taskId),
      storeUrl: String(task.storeUrl),
      variantId: Number(task.variantId),
      qty: Number(task.qty ?? 1),
      profile: task.profile ?? null,
      card,
      proxy: resolved.proxy,
      dryRun: task.dryRun !== false,
      placeOrder: task.placeOrder === true,
      placeOrderMutation,
      debugTrace: task.debugTrace === true,
      kmartMode: typeof task.kmartMode === "string" ? task.kmartMode : undefined,
      transport: typeof task.transport === "string" ? task.transport : undefined,
      forceTls: task.forceTls === true,
      forceUndici: task.forceUndici === true,
      // api.* chrome_131 via tls-worker after WWW undici. Default ON when proxy
      // is set; false disables; true forces even on direct.
      ...(task.apiTls === true || task.apiTls === false ? { apiTls: task.apiTls } : {}),
      // Hyper sensor phase chrome_131 (default ON). false keeps undici sensors.
      ...(task.sensorTls === true || task.sensorTls === false ? { sensorTls: task.sensorTls } : {}),
      ...(task.apiTunnelRefresh === false ? { apiTunnelRefresh: false } : {}),
      resumeFrom: typeof task.resumeFrom === "string" ? task.resumeFrom : undefined,
      seedCookies: task.seedCookies && typeof task.seedCookies === "object" ? task.seedCookies : undefined,
      httpHandoff: task.httpHandoff !== false,
      skipAtc: task.skipAtc === true,
      apiSensor: task.apiSensor === true,
      // undefined = let adapter default (skip category when proxied)
      skipCategory:
        task.skipCategory === true ? true : task.skipCategory === false ? false : undefined,
    });
    if (result && typeof result === "object") {
      result.proxySource = resolved.source;
      result.proxyPoolSize = resolved.poolSize;
      result.gitSha = GIT_SHA;
    }
    return result;
  } catch (e) {
    reply.code(500);
    req.log.error({ err: e }, "run failed");
    return { ok: false, error: e?.message ?? String(e), failedStep: "run_error" };
  } finally {
    inflight--;
  }
});

// ─── Kmart Akamai lab ────────────────────────────────────────────────
// Isolated diagnostic endpoint. It stops after sensor rounds and never
// proceeds to PDP retry/cart/checkout, so Akamai regressions are visible.
app.post("/akamai/lab", async (req, reply) => {
  if (!checkAuth(req, reply)) return { ok: false, error: "unauthorized" };
  const body = req.body ?? {};
  const url = body.url ?? body.storeUrl ?? "https://www.kmart.com.au/product/junk-journal-sticker-pad-43671588/";
  if (!/^https:\/\/(www\.)?kmart\.com\.au\//i.test(String(url))) {
    reply.code(400);
    return { ok: false, error: "url must be a kmart.com.au https URL" };
  }
  try {
    return await runKmartAkamaiLab({
      url: String(url),
      proxy: body.proxy ?? null,
      rounds: Number(body.rounds ?? 3),
      useProxy: Boolean(body.useProxy),
      transport: body.transport ?? "tls",
      baselineTrace: body.baselineTrace ?? null,
    });
  } catch (e) {
    reply.code(500);
    return { ok: false, error: e?.message ?? String(e) };
  }
});

// ─── Recon endpoint ──────────────────────────────────────────────────
// Fetches a URL through the residential proxy and returns metadata about
// the response: status, Set-Cookie summary, all <script src> values,
// snippets of inline scripts that mention Akamai keywords, and a head
// slice of the HTML. Used by the agent to figure out the current sensor
// script URL pattern when an adapter's regex fails.
app.post("/recon", async (req, reply) => {
  if (!checkAuth(req, reply)) return { ok: false, error: "unauthorized" };
  const { url, proxy, useProxy, maxBytes = 80_000 } = req.body ?? {};
  if (!url) {
    reply.code(400);
    return { ok: false, error: "url required" };
  }
  const jar = createJar();
  // Default to direct (Fly egress). Only use residential when explicitly opted in.
  const resolvedProxy = proxy ?? (useProxy ? process.env.PROXY_URL_RESI ?? null : null);
  const dispatcher = makeDispatcher(resolvedProxy);
  const ctx = { dispatcher, jar };
  const t0 = Date.now();
  try {
    const res = await request(
      url,
      {
        method: "GET",
        headers: {
          "user-agent": UA,
          accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          "accept-language": "en-AU,en;q=0.9",
          "upgrade-insecure-requests": "1",
        },
      },
      ctx,
    );
    const html = await res.text();
    const scriptSrcs = [...html.matchAll(/<script[^>]+src=["']([^"']+)["']/g)].map((m) => m[1]).slice(0, 40);
    const inlineHits = [];
    const inlineRe = /<script\b(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g;
    let m;
    let scanned = 0;
    while ((m = inlineRe.exec(html)) && scanned < 30) {
      scanned++;
      const body = m[1];
      if (/akamai|_abck|bm_sz|sensor_data|bm_so|bmak|sbsd/i.test(body)) {
        const idx = body.search(/akamai|_abck|bm_sz|sensor_data|bm_so|bmak|sbsd/i);
        inlineHits.push(body.slice(Math.max(0, idx - 40), idx + 200));
      }
    }
    return {
      ok: res.ok,
      status: res.status,
      elapsedMs: Date.now() - t0,
      finalUrl: res.url ?? url,
      headers: {
        server: res.headers.get("server"),
        "content-type": res.headers.get("content-type"),
        "set-cookie-count": (typeof res.headers.getSetCookie === "function" ? res.headers.getSetCookie() : []).length,
      },
      cookies: Object.keys(jar.dump()),
      htmlBytes: html.length,
      scriptSrcs,
      inlineAkamaiHits: inlineHits,
      htmlHead: html.slice(0, maxBytes),
    };
  } catch (e) {
    return { ok: false, error: e?.message ?? String(e), elapsedMs: Date.now() - t0 };
  } finally {
    try { await dispatcher?.close?.(); } catch { /* ignore */ }
  }
});

// ─── JB Hi-Fi Shopify recon ─────────────────────────────────────────
// Discovers products (including hidden-but-published ones) from JB Hi-Fi's
// public Shopify surfaces. Body: { query?, limit?, hiddenOnly?, refresh?,
// hydrateAll?, useProxy? }.
app.post("/jbhifi/recon", async (req, reply) => {
  if (!checkAuth(req, reply)) return { ok: false, error: "unauthorized" };
  const body = req.body ?? {};
  const proxy = body.proxy ?? (body.useProxy ? process.env.PROXY_URL_RESI ?? null : null);
  try {
    const result = await runJbhifiRecon({
      query: body.query ?? null,
      limit: Number(body.limit ?? 200),
      hiddenOnly: !!body.hiddenOnly,
      refresh: !!body.refresh,
      hydrateAll: !!body.hydrateAll,
      proxy,
    });
    return result;
  } catch (e) {
    reply.code(500);
    return { ok: false, error: e?.message ?? String(e) };
  }
});

// ─── JB Hi-Fi per-SKU endpoint probe ─────────────────────────────────
// Body: { skus: string[], proxy?, useProxy?, concurrency? }
// Fans out ~8 public Shopify surfaces per SKU and reports which leaked
// data. Used for endpoint discovery, not routine search.
app.post("/jbhifi/probe", async (req, reply) => {
  if (!checkAuth(req, reply)) return { ok: false, error: "unauthorized" };
  const body = req.body ?? {};
  const proxy = body.proxy ?? (body.useProxy ? process.env.PROXY_URL_RESI ?? null : null);
  try {
    const result = await runJbhifiProbe({
      skus: Array.isArray(body.skus) ? body.skus : [],
      queries: Array.isArray(body.queries) ? body.queries : [],
      concurrency: Number(body.concurrency ?? 6),
      refreshKeys: !!body.refreshKeys,
      skipShopify: !!body.skipShopify,
      hitsPerQuery: body.hitsPerQuery ? Number(body.hitsPerQuery) : undefined,
      proxy,
    });

    return result;
  } catch (e) {
    reply.code(500);
    return { ok: false, error: e?.message ?? String(e) };
  }
});





app
  .listen({ host: "0.0.0.0", port: PORT })
  .then(() => {
    console.log(`executor listening on 0.0.0.0:${PORT}`);
    console.log(
      JSON.stringify({
        hyperApiKey: Boolean(process.env.HYPER_API_KEY),
        proxyConfigured: Boolean(process.env.PROXY_URL_RESI),
        transport: HTTP_TRANSPORT,
      }),
    );
  })
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
