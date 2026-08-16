#!/usr/bin/env node
/**
 * Toymate high-traffic rehearsal — concurrent harvest + congestion chaos.
 *
 * Modes:
 *   harvest  — fill a CF+spam bank with N parallel CapSolver mints
 *   chaos    — one harvested checkout with forced ATC 429s before success
 *   wave     — T0-style: concurrent checkouts claiming from a pre-filled bank
 *   all      — harvest → chaos → wave (default)
 *
 * Usage:
 *   CAPSOLVER_API_KEY=… PROXY_FILE=/tmp/toymate-lab/wealth.proxies \
 *   TOYMATE_HARVEST_N=4 TOYMATE_WAVE_N=3 \
 *   PAY_ISSUER_TLS_WORKER=0 \
 *     node executor/scripts/toymate-high-traffic-sim.mjs
 *
 * Chaos knobs (also read by adapters/toymate.js):
 *   TOYMATE_CHAOS_ATC_FAILS=2     force N congested ATC replies before real POST
 *   TOYMATE_CHAOS_ATC_STATUS=429
 *   TOYMATE_CHAOS_ATC_DELAY_MS=400
 *   TOYMATE_ATC_RETRIES=5         (maps to task.toymateAtcRetries)
 *
 * Does not commit secrets. Writes redacted JSON under /tmp/toymate-lab/.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ProxyAgent, fetch as undiciFetch } from "undici";
import { makeDispatcher, createJar } from "../http.js";
import { toymateAdapter } from "../adapters/toymate.js";
import { harvestToymateSession } from "../adapters/toymate-harvest-session.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = process.env.TOYMATE_SIM_OUT || "/tmp/toymate-lab";

function loadKey() {
  if (process.env.CAPSOLVER_API_KEY) return;
  try {
    const raw = fs.readFileSync(path.join(__dirname, "..", "..", ".env.local"), "utf8");
    const m = raw.match(/^CAPSOLVER_API_KEY=(.+)$/m);
    if (m) process.env.CAPSOLVER_API_KEY = m[1].trim();
  } catch {
    /* ignore */
  }
}

function toProxyUrl(raw) {
  if (!raw) return null;
  if (/^https?:\/\//i.test(raw)) return raw;
  const parts = String(raw).split(":");
  if (parts.length >= 4) {
    const [host, port, user, ...pass] = parts;
    return `http://${encodeURIComponent(user)}:${encodeURIComponent(pass.join(":"))}@${host}:${port}`;
  }
  return raw;
}

function proxyHost(raw) {
  try {
    return new URL(toProxyUrl(raw)).hostname;
  } catch {
    return String(raw || "").split(":")[0] || null;
  }
}

function stickyTag(raw) {
  const m = String(raw || "").match(/-(H|S)([a-f0-9]{8,})-/i);
  return m ? `${m[1]}${m[2].slice(0, 8)}` : proxyHost(raw);
}

function loadProxyLines() {
  // Explicit multi-line file wins over a leftover PROXY_LINE from prior labs.
  if (process.env.PROXY_FILE && fs.existsSync(process.env.PROXY_FILE)) {
    return fs
      .readFileSync(process.env.PROXY_FILE, "utf8")
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith("#"));
  }
  if (process.env.PROXY_LINE) return [process.env.PROXY_LINE.trim()];
  const fallbacks = [
    path.join(OUT_DIR, "wealth.proxies"),
    path.join(__dirname, "..", "noontide.proxies.local"),
  ];
  for (const file of fallbacks) {
    if (!fs.existsSync(file)) continue;
    return fs
      .readFileSync(file, "utf8")
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith("#"));
  }
  return [];
}

async function probeProxy(url) {
  const agent = new ProxyAgent(url);
  try {
    const r = await undiciFetch("https://api.ipify.org?format=json", {
      dispatcher: agent,
      signal: AbortSignal.timeout(15_000),
    });
    const j = await r.json();
    return { ok: true, ip: j.ip || null };
  } catch (e) {
    return { ok: false, error: e?.cause?.code || e?.message || String(e) };
  } finally {
    try {
      await agent.close?.();
    } catch {
      /* ignore */
    }
  }
}

function syntheticCard() {
  return {
    number: "4000000000000002",
    expMonth: "12",
    expYear: "29",
    cvv: "123",
    holder: "Test Buyer",
    synthetic: true,
  };
}

function log(obj) {
  console.log(JSON.stringify(obj));
}

async function runCheckout({
  proxyUrl,
  harvestedSession,
  pdpUrl,
  email,
  password,
  label,
  atcRetries,
}) {
  const dispatcher = makeDispatcher(proxyUrl, { forceUndici: true });
  const jar = createJar();
  const ctx = { dispatcher, jar, steps: [] };
  const task = {
    taskId: `sim-${label}-${Date.now().toString(36)}`,
    storeUrl: pdpUrl,
    pdpUrl,
    toymateMode: "checkout",
    proxy: proxyUrl,
    placeOrder: true,
    dryRun: false,
    paymentMethod: "credit_card",
    account: { email, password },
    card: syntheticCard(),
    qty: 1,
    toymateAtcRetries: atcRetries,
    harvestedSession: harvestedSession || null,
    captchaToken: harvestedSession?.captchaToken || null,
    profile: {
      email,
      first_name: "Test",
      last_name: "Buyer",
      phone: "0412345678",
      address1: "10 George Street",
      city: "Sydney",
      province: "NSW",
      zip: "2000",
    },
  };
  const t0 = Date.now();
  try {
    const out = await toymateAdapter.run(task, ctx);
    const steps = (out.steps || []).map((s) => ({
      step: s.step,
      ok: s.ok,
      status: s.status,
      ms: s.ms ?? null,
      note: String(s.note || "").slice(0, 180),
    }));
    const cart = steps.find((s) => s.step === "cart_add");
    const pay = steps.find((s) => s.step === "place_order");
    const cf = steps.find((s) => s.step === "cf_warm");
    const spam = steps.find((s) => s.step === "checkout_spam");
    const bigpayCode = (() => {
      const m = String(pay?.note || "").match(/"code"\s*:\s*(\d+)/);
      return m ? Number(m[1]) : null;
    })();
    return {
      label,
      wallMs: Date.now() - t0,
      ok: Boolean(out.paymentDeclined || out.orderNumber || (cart?.ok && !pay)),
      paymentDeclined: Boolean(out.paymentDeclined),
      orderNumber: out.orderNumber || null,
      failedStep: out.failedStep || null,
      error: out.error || null,
      bigpayCode,
      cfNote: cf?.note || null,
      cfMs: cf?.ms ?? null,
      spamMs: spam?.ms ?? null,
      cartNote: cart?.note || null,
      cartOk: Boolean(cart?.ok),
      chaosSurvived: (() => {
        const m = String(cart?.note || "").match(/survived (\d+) chaos/i);
        return m ? Number(m[1]) : 0;
      })(),
      placeOk: Boolean(pay?.ok),
      placeNote: pay?.note ? String(pay.note).slice(0, 160) : null,
      steps,
    };
  } finally {
    try {
      await dispatcher.close?.();
    } catch {
      /* ignore */
    }
  }
}

/** Parallel CapSolver harvest across sticky lines — measures bank fill concurrency. */
async function modeHarvest(lines, { n, solveSpam }) {
  const picks = lines.slice(0, Math.max(1, n));
  log({
    phase: "harvest_start",
    parallel: picks.length,
    solveSpam,
    stickies: picks.map(stickyTag),
  });

  // Also exercise desktop pool parallel scheduler with a fake sidecar that
  // delegates to the real harvestToymateSession (proves pool × CapSolver).
  const results = [];
  const t0 = Date.now();
  const jobs = picks.map(async (raw, i) => {
    const url = toProxyUrl(raw);
    const probe = await probeProxy(url);
    if (!probe.ok) {
      const row = {
        i,
        sticky: stickyTag(raw),
        ok: false,
        error: `probe: ${probe.error}`,
        ms: 0,
      };
      results.push(row);
      log({ phase: "harvest_lane", ...row });
      return row;
    }
    const out = await harvestToymateSession({
      proxyRaw: url,
      solveSpam,
      maxCfAttempts: 3,
    });
    const hasCf = Boolean(out.session?.cookies?.cf_clearance);
    const clearEnough =
      out.ok &&
      (hasCf ||
        /no challenge|rebind ok|cf_clearance minted/i.test(String(out.session?.cfNote || "")));
    const row = {
      i,
      sticky: stickyTag(raw),
      exitIp: probe.ip,
      ok: Boolean(clearEnough),
      ms: out.ms,
      hasSpam: Boolean(out.session?.captchaToken),
      hasCf,
      cfNote: out.session?.cfNote || null,
      spamNote: out.session?.spamNote || null,
      error: out.error || null,
      attempt: out.session?.attempt ?? out.attempt ?? null,
      session: clearEnough ? out.session : null,
    };
    results.push(row);
    log({
      phase: "harvest_lane",
      i: row.i,
      sticky: row.sticky,
      exitIp: row.exitIp,
      ok: row.ok,
      ms: row.ms,
      hasSpam: row.hasSpam,
      cfNote: row.cfNote,
      spamNote: row.spamNote,
      error: row.error,
    });
    return row;
  });

  await Promise.allSettled(jobs);
  const wallMs = Date.now() - t0;
  const ok = results.filter((r) => r.ok);
  const summary = {
    phase: "harvest_done",
    parallel: picks.length,
    ok: ok.length,
    fail: results.length - ok.length,
    wallMs,
    serialEstimateMs: results.reduce((a, r) => a + (r.ms || 0), 0),
    speedup:
      results.reduce((a, r) => a + (r.ms || 0), 0) > 0
        ? Number(
            (results.reduce((a, r) => a + (r.ms || 0), 0) / Math.max(1, wallMs)).toFixed(2),
          )
        : null,
    lanes: results.map((r) => ({
      sticky: r.sticky,
      ok: r.ok,
      ms: r.ms,
      hasSpam: r.hasSpam,
      error: r.error,
    })),
  };
  log(summary);

  // Desktop pool parallel scheduler is covered by desktop/toymate-harvest.test.cjs.

  return { summary, sessions: ok.map((r) => r.session).filter(Boolean), results };
}

/** Congestion chaos: site "barely responds" — bot retries until ATC lands. */
async function modeChaos(session, pdpUrl, email, password) {
  const fails = Math.max(1, Number(process.env.TOYMATE_CHAOS_ATC_FAILS) || 2);
  const retries = Math.max(fails + 1, Number(process.env.TOYMATE_ATC_RETRIES) || fails + 2);
  process.env.TOYMATE_CHAOS_ATC_FAILS = String(fails);
  process.env.TOYMATE_CHAOS_ATC_STATUS = process.env.TOYMATE_CHAOS_ATC_STATUS || "429";
  process.env.TOYMATE_CHAOS_ATC_DELAY_MS = process.env.TOYMATE_CHAOS_ATC_DELAY_MS || "350";

  log({
    phase: "chaos_start",
    forcedAtcFails: fails,
    atcRetries: retries,
    status: process.env.TOYMATE_CHAOS_ATC_STATUS,
    delayMs: process.env.TOYMATE_CHAOS_ATC_DELAY_MS,
    hasHarvest: Boolean(session?.cookies?.cf_clearance),
  });

  // Naive single-shot control: 1 attempt after forced fails → must fail cart_add.
  process.env.TOYMATE_CHAOS_ATC_FAILS = String(fails);
  const naive = await runCheckout({
    proxyUrl: session.proxy,
    harvestedSession: session,
    pdpUrl,
    email,
    password,
    label: "naive_no_retry",
    atcRetries: 1, // cannot survive forced fails
  });
  log({ phase: "chaos_naive", ...naive, steps: naive.steps?.filter((s) => /cart|cf_|spam|place/.test(s.step)) });

  // Bot path: enough retries to clear chaos then hit real ATC.
  process.env.TOYMATE_CHAOS_ATC_FAILS = String(fails);
  const bot = await runCheckout({
    proxyUrl: session.proxy,
    harvestedSession: {
      ...session,
      // Re-use CF cookies; spam may be spent — allow on-demand if needed
    },
    pdpUrl,
    email,
    password,
    label: "bot_retry",
    atcRetries: retries,
  });
  log({
    phase: "chaos_bot",
    ...bot,
    steps: bot.steps?.filter((s) => /cart|cf_|spam|place/.test(s.step)),
  });

  // Clear chaos for subsequent modes
  delete process.env.TOYMATE_CHAOS_ATC_FAILS;
  delete process.env.TOYMATE_CHAOS_ATC_STATUS;
  delete process.env.TOYMATE_CHAOS_ATC_DELAY_MS;

  const verdict = {
    phase: "chaos_verdict",
    naiveCartOk: naive.cartOk,
    botCartOk: bot.cartOk,
    botChaosSurvived: bot.chaosSurvived,
    botPaymentDeclined: bot.paymentDeclined,
    botBigpayCode: bot.bigpayCode,
    botsPrevail: Boolean(bot.cartOk && !naive.cartOk),
  };
  log(verdict);
  return { naive, bot, verdict };
}

/** T0 wave: concurrent checkouts from distinct harvested sessions. */
async function modeWave(sessions, lines, pdpUrl, email, password, waveN) {
  const n = Math.min(waveN, sessions.length, lines.length);
  if (n < 1) {
    log({ phase: "wave_skip", reason: "no harvested sessions" });
    return { summary: { ok: 0, n: 0 } };
  }
  const laneSessions = sessions.slice(0, n);
  log({ phase: "wave_start", lanes: n, staggerMs: 50 });

  const t0 = Date.now();
  const launched = laneSessions.map(
    (session, i) =>
      new Promise((resolve) => {
        setTimeout(async () => {
          const out = await runCheckout({
            proxyUrl: session.proxy,
            harvestedSession: session,
            pdpUrl,
            email,
            password,
            label: `wave_${i}`,
            atcRetries: Number(process.env.TOYMATE_ATC_RETRIES) || 4,
          });
          log({
            phase: "wave_lane",
            i,
            sticky: proxyHost(session.proxy),
            wallMs: out.wallMs,
            cartOk: out.cartOk,
            paymentDeclined: out.paymentDeclined,
            bigpayCode: out.bigpayCode,
            cfMs: out.cfMs,
            failedStep: out.failedStep,
            error: out.error,
          });
          resolve(out);
        }, i * 50);
      }),
  );
  const lanes = await Promise.all(launched);
  const summary = {
    phase: "wave_done",
    wallMs: Date.now() - t0,
    n,
    cartOk: lanes.filter((l) => l.cartOk).length,
    declined: lanes.filter((l) => l.paymentDeclined).length,
    bigpay30102: lanes.filter((l) => l.bigpayCode === 30102).length,
    fail: lanes.filter((l) => !l.cartOk && !l.paymentDeclined).length,
  };
  log(summary);
  return { summary, lanes };
}

loadKey();
if (!process.env.CAPSOLVER_API_KEY) {
  console.error("CAPSOLVER_API_KEY missing");
  process.exit(1);
}
// Proven Toymate BigPay path
if (process.env.PAY_ISSUER_TLS_WORKER == null) process.env.PAY_ISSUER_TLS_WORKER = "0";

const mode = (process.argv[2] || process.env.TOYMATE_SIM_MODE || "all").toLowerCase();
const lines = loadProxyLines();
if (!lines.length) {
  console.error("No proxies — set PROXY_FILE or PROXY_LINE");
  process.exit(2);
}

const harvestN = Math.max(1, Math.min(8, Number(process.env.TOYMATE_HARVEST_N) || 4));
const waveN = Math.max(1, Math.min(6, Number(process.env.TOYMATE_WAVE_N) || 3));
const solveSpam = process.env.TOYMATE_HARVEST_SPAM !== "0";
const pdpUrl =
  process.env.PDP_URL || "https://toymate.com.au/products.php?productId=53116";
const email = process.env.ACCOUNT_EMAIL || "proof3+mrv40gx11rzw@bullposted.com";
const password = process.env.ACCOUNT_PASS || "Password1";

fs.mkdirSync(OUT_DIR, { recursive: true });

log({
  phase: "start",
  mode,
  harvestN,
  waveN,
  solveSpam,
  proxyCount: lines.length,
  pdp: pdpUrl,
  payIssuerTlsWorker: process.env.PAY_ISSUER_TLS_WORKER,
});

const report = { startedAt: new Date().toISOString(), mode, harvest: null, chaos: null, wave: null };
let sessions = [];

if (mode === "harvest" || mode === "all" || mode === "wave" || mode === "chaos") {
  if (mode === "chaos" && process.env.TOYMATE_SKIP_HARVEST === "1") {
    /* caller must supply — fall through */
  } else {
    const h = await modeHarvest(lines, { n: harvestN, solveSpam });
    report.harvest = h.summary;
    sessions = h.sessions;
  }
}

if ((mode === "chaos" || mode === "all") && sessions[0]) {
  // Chaos burns one session (and its spam token). Prefer a spam-ready row.
  const chaosSession = sessions.find((s) => s.captchaToken) || sessions[0];
  sessions = sessions.filter((s) => s !== chaosSession);
  report.chaos = await modeChaos(chaosSession, pdpUrl, email, password);
}

if ((mode === "wave" || mode === "all") && sessions.length) {
  // Fresh harvest for wave if chaos consumed the bank
  if (sessions.length < waveN && mode === "all") {
    const need = waveN - sessions.length;
    log({ phase: "wave_refill", need });
    const refill = await modeHarvest(lines.slice(harvestN), {
      n: Math.max(need, waveN),
      solveSpam,
    });
    sessions = [...sessions, ...refill.sessions];
  }
  report.wave = await modeWave(sessions, lines, pdpUrl, email, password, waveN);
}

report.finishedAt = new Date().toISOString();
report.verdict = {
  harvestSpeedup: report.harvest?.speedup ?? null,
  harvestOk: report.harvest?.ok ?? null,
  botsPrevail: report.chaos?.verdict?.botsPrevail ?? null,
  waveCartOk: report.wave?.summary?.cartOk ?? null,
  waveDeclined: report.wave?.summary?.declined ?? null,
};

const outPath = path.join(OUT_DIR, `high-traffic-sim-${Date.now()}.json`);
fs.writeFileSync(outPath, JSON.stringify(report, null, 2));
log({ phase: "wrote", path: outPath, verdict: report.verdict });

const ok =
  (report.harvest?.ok ?? 1) > 0 &&
  (report.chaos ? report.chaos.verdict.botsPrevail || report.chaos.verdict.botCartOk : true);
process.exit(ok ? 0 : 3);
