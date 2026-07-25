#!/usr/bin/env node
// ONE Toymate LIVE checkout attempt (placeOrder: true).
// Goal: reach Adyen/gateway DECLINE (or refuse) — not a charge win.
// CapSolver: CF warm + checkout spam reCAPTCHA. Place-order is HTTP-only (no Playwright).
//
// Env:
//   CAPSOLVER_API_KEY (required)
//   TOYMATE_CARD_* optional — defaults to a synthetic Luhn-valid Visa for decline wiring.
//   Optional: ACCOUNT_EMAIL, ACCOUNT_PASS, PROXY_LINE, PDP_URL
//
// Usage:
//   node scripts/toymate-checkout-live-once.mjs
//   TOYMATE_CARD_NUMBER=... TOYMATE_CARD_EXP_MONTH=.. TOYMATE_CARD_EXP_YEAR=.. TOYMATE_CARD_CVV=... \
//     node scripts/toymate-checkout-live-once.mjs

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { makeDispatcher, createJar } from "../http.js";
import { toymateAdapter } from "../adapters/toymate.js";

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

function pickProxy() {
  const local = path.join(__dirname, "..", "noontide.proxies.local");
  const lines = fs.existsSync(local)
    ? fs
        .readFileSync(local, "utf8")
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter((l) => l && !l.startsWith("#"))
    : [];
  // Explicit sticky line wins only when not rotating.
  if (process.env.PROXY_INDEX != null && process.env.PROXY_INDEX !== "" && lines.length) {
    const i = Math.abs(Number(process.env.PROXY_INDEX)) % lines.length;
    return lines[i];
  }
  if (process.env.PROXY_LINE) return process.env.PROXY_LINE.trim();
  if (!lines.length) return null;
  return lines.find((l) => /proxy-as1\./i.test(l)) || lines[0] || null;
}

function toProxyUrl(raw) {
  if (!raw) return null;
  if (/^https?:\/\//i.test(raw)) return raw;
  const parts = raw.split(":");
  if (parts.length >= 4) {
    const [host, port, user, ...pass] = parts;
    return `http://${encodeURIComponent(user)}:${encodeURIComponent(pass.join(":"))}@${host}:${port}`;
  }
  return raw;
}

/** Synthetic Luhn-valid Visa for wiring declines (not a real PAN). Override via TOYMATE_CARD_*. */
function syntheticDeclineCard() {
  // 4000000000000002 — common “decline” style test PAN; live Adyen usually refuses/declines.
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

loadKey();
if (!process.env.CAPSOLVER_API_KEY) {
  console.error("CAPSOLVER_API_KEY missing");
  process.exit(1);
}
const card = loadCard();

const proxyRaw = toProxyUrl(pickProxy());
const email = process.env.ACCOUNT_EMAIL || "proof3+mrv40gx11rzw@bullposted.com";
const password = process.env.ACCOUNT_PASS || "Password1";
const pdpUrl =
  process.argv[2] ||
  process.env.PDP_URL ||
  "https://toymate.com.au/products.php?productId=53116";

console.log(
  JSON.stringify({
    phase: "start",
    mode: "checkout_live_decline",
    proxyHost: proxyRaw ? new URL(proxyRaw).hostname : null,
    email,
    pdp: pdpUrl,
    cardLast4: String(card.number).replace(/\s+/g, "").slice(-4),
    cardSynthetic: Boolean(card.synthetic),
    placeOrder: true,
  }),
);

const dispatcher = makeDispatcher(proxyRaw, { forceUndici: true });
const jar = createJar();
const ctx = { dispatcher, jar, steps: [] };

const task = {
  taskId: `chk-live-${Date.now().toString(36)}`,
  storeUrl: pdpUrl,
  pdpUrl,
  toymateMode: "checkout",
  proxy: proxyRaw,
  placeOrder: true,
  dryRun: false,
  paymentMethod: "credit_card",
  account: { email, password },
  card,
  qty: 1,
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
    note: String(s.note || "").slice(0, 200),
  }));
  const loginOk = steps.some((s) => s.step === "account_login" && s.ok);
  const cartOk = steps.some((s) => (s.step === "cart_add" || s.step === "cart_create") && s.ok);
  const payStep = steps.find((s) => s.step === "place_order");
  const methodsStep = steps.find((s) => s.step === "payment_methods");
  console.log(
    JSON.stringify({
      phase: "done",
      ok: Boolean(out.ok),
      ms: Date.now() - t0,
      checkoutStage: out.checkoutStage || null,
      dryRun: out.dryRun === true,
      loginOk,
      cartOk,
      atcVia: out.atcVia || null,
      paymentStatus: out.paymentStatus || null,
      paymentDeclined: Boolean(out.paymentDeclined),
      orderNumber: out.orderNumber || null,
      error: out.error || null,
      failedStep: out.failedStep || null,
      methodsNote: methodsStep?.note || null,
      placeNote: payStep?.note || null,
      steps,
    }),
  );
  // Success for decline smoke = reached gateway decline OR order number.
  const pass = Boolean(out.paymentDeclined || out.orderNumber);
  process.exit(pass ? 0 : 3);
} catch (e) {
  console.log(
    JSON.stringify({
      phase: "throw",
      error: e?.message || String(e),
      cause: e?.cause?.message || e?.cause?.code || null,
      ms: Date.now() - t0,
      steps: (ctx.steps || []).map((s) => ({
        step: s.step,
        ok: s.ok,
        status: s.status,
        note: String(s.note || "").slice(0, 180),
      })),
    }),
  );
  process.exit(4);
} finally {
  try {
    await dispatcher.close?.();
  } catch {
    /* ignore */
  }
}
