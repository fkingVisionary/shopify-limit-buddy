#!/usr/bin/env node
// Prove Toymate harvest speedup: harvest CF+spam, then live checkout with
// harvestedSession vs a baseline checkout that solves CapSolver on the critical path.
//
// Usage:
//   CAPSOLVER_API_KEY=… PROXY_INDEX=1 node scripts/toymate-harvest-checkout-proof.mjs
//
// Exit 0 if harvested checkout reaches paymentDeclined / orderNumber and
// cf_warm note shows harvested clearance.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ProxyAgent, fetch as undiciFetch } from "undici";
import { makeDispatcher, createJar } from "../http.js";
import { toymateAdapter } from "../adapters/toymate.js";
import { harvestToymateSession } from "../adapters/toymate-harvest-session.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

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

function proxyLines() {
  const local = path.join(__dirname, "..", "noontide.proxies.local");
  if (!fs.existsSync(local)) return [];
  return fs
    .readFileSync(local, "utf8")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"));
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

async function probeProxy(url) {
  const agent = new ProxyAgent(url);
  try {
    const r = await undiciFetch("https://api.ipify.org?format=json", {
      dispatcher: agent,
      signal: AbortSignal.timeout(20_000),
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

async function pickWorkingProxy() {
  const lines = proxyLines();
  if (process.env.PROXY_LINE) {
    const url = toProxyUrl(process.env.PROXY_LINE.trim());
    const probe = await probeProxy(url);
    return { raw: process.env.PROXY_LINE.trim(), url, probe, index: null };
  }
  const preferred =
    process.env.PROXY_INDEX != null && process.env.PROXY_INDEX !== ""
      ? [Math.abs(Number(process.env.PROXY_INDEX)) % Math.max(1, lines.length)]
      : [];
  const order = [...preferred, ...lines.map((_, i) => i)].filter(
    (v, i, a) => a.indexOf(v) === i,
  );
  for (const i of order) {
    const raw = lines[i];
    if (!raw) continue;
    const url = toProxyUrl(raw);
    const probe = await probeProxy(url);
    console.log(
      JSON.stringify({
        phase: "proxy_probe",
        index: i,
        host: (() => {
          try {
            return new URL(url).hostname;
          } catch {
            return null;
          }
        })(),
        ok: probe.ok,
        ip: probe.ip || null,
        error: probe.error || null,
      }),
    );
    if (probe.ok) return { raw, url, probe, index: i };
  }
  return null;
}

function syntheticDeclineCard() {
  return {
    number: "4000000000000002",
    expMonth: "12",
    expYear: "29",
    cvv: "123",
    holder: "Test Buyer",
    synthetic: true,
  };
}

function loadCard() {
  const number = process.env.TOYMATE_CARD_NUMBER || process.env.CARD_NUMBER;
  const expMonth = process.env.TOYMATE_CARD_EXP_MONTH || process.env.CARD_EXP_MONTH;
  const expYear = process.env.TOYMATE_CARD_EXP_YEAR || process.env.CARD_EXP_YEAR;
  const cvv = process.env.TOYMATE_CARD_CVV || process.env.CARD_CVV;
  const holder = process.env.TOYMATE_CARD_HOLDER || process.env.CARD_HOLDER || "Test Buyer";
  if (!number || !expMonth || !expYear || !cvv) return syntheticDeclineCard();
  return { number, expMonth, expYear, cvv, holder, synthetic: false };
}

function summarizeCheckout(label, out, wallMs, harvested) {
  const steps = (out.steps || []).map((s) => ({
    step: s.step,
    ok: s.ok,
    status: s.status,
    ms: s.ms ?? null,
    note: String(s.note || "").slice(0, 220),
  }));
  const stepMs = steps
    .filter((s) => typeof s.ms === "number")
    .map((s) => ({ step: s.step, ms: s.ms, ok: s.ok }));
  const byName = Object.fromEntries(stepMs.map((s) => [s.step, s.ms]));
  const cf = steps.find((s) => s.step === "cf_warm");
  const spam = steps.find((s) => s.step === "checkout_spam");
  const pay = steps.find((s) => s.step === "place_order");
  const captchaCriticalMs = (byName.cf_warm || 0) + (byName.checkout_spam || 0);
  const bigpayCode = (() => {
    const m = String(pay?.note || "").match(/"code"\s*:\s*(\d+)/);
    return m ? Number(m[1]) : null;
  })();
  // 30102 on synthetic Visa = gateway refuse (no issuer / Revolut).
  // Real disposable historically returns 30106 insufficient funds (bank ping).
  const issuerLikely =
    bigpayCode === 30106 ||
    /insufficient|fund|3ds|authentication/i.test(String(pay?.note || ""));
  return {
    label,
    harvested: Boolean(harvested),
    wallMs,
    paymentDeclined: Boolean(out.paymentDeclined),
    orderNumber: out.orderNumber || null,
    checkoutStage: out.checkoutStage || null,
    error: out.error || null,
    failedStep: out.failedStep || null,
    placeNote: pay?.note || null,
    bigpayCode,
    bankProofLikely: Boolean(out.orderNumber) || (Boolean(out.paymentDeclined) && issuerLikely),
    cfNote: cf?.note || null,
    cfMs: byName.cf_warm ?? null,
    spamNote: spam?.note || null,
    spamMs: byName.checkout_spam ?? null,
    captchaCriticalMs,
    placeMs: byName.place_order ?? null,
    timing: {
      totalMs: wallMs,
      steps: stepMs,
      slowest: [...stepMs].sort((a, b) => b.ms - a.ms).slice(0, 6),
    },
    steps,
  };
}

async function runCheckout({ proxyUrl, harvestedSession, card, pdpUrl, email, password, label }) {
  const dispatcher = makeDispatcher(proxyUrl, { forceUndici: true });
  const jar = createJar();
  const ctx = { dispatcher, jar, steps: [] };
  const task = {
    taskId: `proof-${label}-${Date.now().toString(36)}`,
    storeUrl: pdpUrl,
    pdpUrl,
    toymateMode: "checkout",
    proxy: proxyUrl,
    placeOrder: true,
    dryRun: false,
    paymentMethod: "credit_card",
    account: { email, password },
    card,
    qty: 1,
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
    return summarizeCheckout(label, out, Date.now() - t0, harvestedSession);
  } finally {
    try {
      await dispatcher.close?.();
    } catch {
      /* ignore */
    }
  }
}

loadKey();
if (!process.env.CAPSOLVER_API_KEY) {
  console.error("CAPSOLVER_API_KEY missing");
  process.exit(1);
}

const card = loadCard();
const email = process.env.ACCOUNT_EMAIL || "proof3+mrv40gx11rzw@bullposted.com";
const password = process.env.ACCOUNT_PASS || "Password1";
const pdpUrl =
  process.argv[2] ||
  process.env.PDP_URL ||
  "https://toymate.com.au/products.php?productId=53116";
const skipBaseline = process.env.SKIP_BASELINE === "1";

const picked = await pickWorkingProxy();
if (!picked?.url) {
  console.error(JSON.stringify({ phase: "fatal", error: "no working proxy" }));
  process.exit(2);
}

console.log(
  JSON.stringify({
    phase: "start",
    pdp: pdpUrl,
    email,
    cardLast4: String(card.number).replace(/\s+/g, "").slice(-4),
    cardSynthetic: Boolean(card.synthetic),
    proxyIndex: picked.index,
    proxyHost: new URL(picked.url).hostname,
    exitIp: picked.probe?.ip || null,
    skipBaseline,
  }),
);

// 1) Harvest CF + spam on the sticky exit
const harvest = await harvestToymateSession({
  proxyRaw: picked.url,
  solveSpam: true,
});
console.log(
  JSON.stringify({
    phase: "harvest",
    ok: harvest.ok,
    ms: harvest.ms,
    error: harvest.error || null,
    hasCf: Boolean(harvest.session?.cookies?.cf_clearance),
    hasSpam: Boolean(harvest.session?.captchaToken),
    cfNote: harvest.session?.cfNote || null,
    spamNote: harvest.session?.spamNote || null,
    spamMs: harvest.session?.spamMs ?? null,
    proxyHost: harvest.session?.proxyHost || null,
  }),
);
if (!harvest.ok || !harvest.session?.cookies?.cf_clearance) {
  process.exit(3);
}

// 2) Checkout immediately with harvested session (critical-path timing)
const harvestedRun = await runCheckout({
  proxyUrl: picked.url,
  harvestedSession: harvest.session,
  card,
  pdpUrl,
  email,
  password,
  label: "harvested",
});
console.log(JSON.stringify({ phase: "checkout_harvested", ...harvestedRun }));

let baselineRun = null;
if (!skipBaseline) {
  // 3) Baseline: same proxy family, on-demand CapSolver on critical path
  baselineRun = await runCheckout({
    proxyUrl: picked.url,
    harvestedSession: null,
    card,
    pdpUrl,
    email,
    password,
    label: "baseline",
  });
  console.log(JSON.stringify({ phase: "checkout_baseline", ...baselineRun }));
}

const harvestMs = harvest.ms || 0;
const harvestedWall = harvestedRun.wallMs;
const baselineWall = baselineRun?.wallMs ?? null;
const savingsVsBaseline =
  baselineWall != null ? Math.max(0, baselineWall - harvestedWall) : null;
const compare = {
  phase: "compare",
  harvestMs,
  harvestedCheckoutMs: harvestedWall,
  harvestedCaptchaCriticalMs: harvestedRun.captchaCriticalMs,
  harvestedCfNote: harvestedRun.cfNote,
  harvestedSpamNote: harvestedRun.spamNote,
  baselineCheckoutMs: baselineWall,
  baselineCaptchaCriticalMs: baselineRun?.captchaCriticalMs ?? null,
  baselineCfMs: baselineRun?.cfMs ?? null,
  baselineSpamMs: baselineRun?.spamMs ?? null,
  checkoutSavingsMs: savingsVsBaseline,
  // End-to-end if you harvest just-in-time for one task (not pre-warmed bank):
  harvestThenCheckoutMs: harvestMs + harvestedWall,
  harvestedPaymentDeclined: harvestedRun.paymentDeclined,
  baselinePaymentDeclined: baselineRun?.paymentDeclined ?? null,
  cardSynthetic: Boolean(card.synthetic),
  cardLast4: String(card.number).replace(/\s+/g, "").slice(-4),
  harvestedBigpayCode: harvestedRun.bigpayCode,
  harvestedBankProofLikely: harvestedRun.bankProofLikely,
  baselineBigpayCode: baselineRun?.bigpayCode ?? null,
  baselineBankProofLikely: baselineRun?.bankProofLikely ?? null,
  note: card.synthetic
    ? "Synthetic Visa → BigPay 30102 is wiring-only; no Revolut/issuer ping expected. Set TOYMATE_CARD_* for bank proof (historically 30106)."
    : "Live card used — score Revolut / bank for issuer proof.",
  speedup:
    baselineWall && harvestedWall
      ? Number((baselineWall / Math.max(1, harvestedWall)).toFixed(2))
      : null,
};

console.log(JSON.stringify(compare));

const outPath =
  process.env.PROOF_OUT ||
  path.join(__dirname, "..", "docs", "toymate-harvest-checkout-proof.json");
fs.writeFileSync(
  outPath,
  JSON.stringify(
    {
      at: new Date().toISOString(),
      start: {
        pdp: pdpUrl,
        proxyHost: new URL(picked.url).hostname,
        exitIp: picked.probe?.ip || null,
        cardSynthetic: Boolean(card.synthetic),
      },
      harvest: {
        ok: harvest.ok,
        ms: harvest.ms,
        hasCf: true,
        hasSpam: Boolean(harvest.session?.captchaToken),
        cfNote: harvest.session?.cfNote,
        spamNote: harvest.session?.spamNote,
        spamMs: harvest.session?.spamMs,
      },
      harvested: harvestedRun,
      baseline: baselineRun,
      compare,
    },
    null,
    2,
  ),
);
console.log(JSON.stringify({ phase: "wrote", path: outPath }));

const harvestedPass =
  Boolean(harvestedRun.paymentDeclined || harvestedRun.orderNumber) &&
  /harvested cf_clearance/i.test(String(harvestedRun.cfNote || ""));
if (card.synthetic) {
  console.log(
    JSON.stringify({
      phase: "bank_proof",
      ok: false,
      reason: "synthetic card — BigPay 30102 does not ping Revolut; set TOYMATE_CARD_* for issuer proof",
      bigpayCode: harvestedRun.bigpayCode,
    }),
  );
}
process.exit(harvestedPass ? 0 : 4);
