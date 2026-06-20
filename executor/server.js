// HTTP API for the executor service.
// Single endpoint: POST /run  → runs one checkout task, returns timeline.
// Auth: shared-secret bearer token (EXECUTOR_TOKEN env var).
// Health: GET /health → { ok: true }

import Fastify from "fastify";
import { runCheckout } from "./checkout.js";
import { makeDispatcher, createJar, request, UA } from "./http.js";

const PORT = Number(process.env.PORT ?? 8080);
const TOKEN = process.env.EXECUTOR_TOKEN;

if (!TOKEN) {
  console.error("FATAL: EXECUTOR_TOKEN env var is required");
  process.exit(1);
}

const app = Fastify({ logger: true, bodyLimit: 1_000_000 });

app.get("/health", async () => ({ ok: true, ts: Date.now() }));

function checkAuth(req, reply) {
  const auth = req.headers.authorization ?? "";
  if (auth !== `Bearer ${TOKEN}`) {
    reply.code(401);
    return false;
  }
  return true;
}

app.post("/run", async (req, reply) => {
  if (!checkAuth(req, reply)) return { ok: false, error: "unauthorized" };
  const task = req.body;
  if (!task?.taskId || !task?.storeUrl || !task?.variantId) {
    reply.code(400);
    return { ok: false, error: "missing required fields: taskId, storeUrl, variantId" };
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
  const result = await runCheckout({
    taskId: String(task.taskId),
    storeUrl: String(task.storeUrl),
    variantId: Number(task.variantId),
    qty: Number(task.qty ?? 1),
    profile: task.profile ?? null,
    card,
    proxy: task.proxy ?? null,
    dryRun: task.dryRun !== false,
  });
  return result;
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

app
  .listen({ host: "0.0.0.0", port: PORT })
  .then(() => console.log(`executor listening on :${PORT}`))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
