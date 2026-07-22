#!/usr/bin/env node
// ONE Toymate LIVE checkout attempt (placeOrder: true).
// Expectation for this smoke: bank DECLINE (empty balance) — not a charge win.
// CapSolver: CF warm + checkout spam reCAPTCHA. Adyen hosted fields via Playwright.
//
// Required env:
//   CAPSOLVER_API_KEY
//   TOYMATE_CARD_NUMBER TOYMATE_CARD_EXP_MONTH TOYMATE_CARD_EXP_YEAR TOYMATE_CARD_CVV
//   Optional: TOYMATE_CARD_HOLDER, ACCOUNT_EMAIL, ACCOUNT_PASS, PROXY_LINE, PDP_URL
//
// Usage:
//   set -a && . ../.env.local && set +a
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
  if (process.env.PROXY_LINE) return process.env.PROXY_LINE.trim();
  const local = path.join(__dirname, "..", "noontide.proxies.local");
  if (!fs.existsSync(local)) return null;
  const lines = fs
    .readFileSync(local, "utf8")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"));
  const base = lines[0];
  if (!base) return null;
  const stamp = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  return base.replace(/session-[^-]+/, `session-${stamp}`);
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

function loadCard() {
  const number = process.env.TOYMATE_CARD_NUMBER || process.env.CARD_NUMBER;
  const expMonth = process.env.TOYMATE_CARD_EXP_MONTH || process.env.CARD_EXP_MONTH;
  const expYear = process.env.TOYMATE_CARD_EXP_YEAR || process.env.CARD_EXP_YEAR;
  const cvv = process.env.TOYMATE_CARD_CVV || process.env.CARD_CVV;
  const holder = process.env.TOYMATE_CARD_HOLDER || process.env.CARD_HOLDER || "Test Buyer";
  if (!number || !expMonth || !expYear || !cvv) return null;
  return { number, expMonth, expYear, cvv, holder };
}

loadKey();
if (!process.env.CAPSOLVER_API_KEY) {
  console.error("CAPSOLVER_API_KEY missing");
  process.exit(1);
}
const card = loadCard();
if (!card) {
  console.error(
    JSON.stringify({
      error: "card_missing",
      need: [
        "TOYMATE_CARD_NUMBER",
        "TOYMATE_CARD_EXP_MONTH",
        "TOYMATE_CARD_EXP_YEAR",
        "TOYMATE_CARD_CVV",
      ],
      note: "Set in env for this process only — do not commit. Decline smoke expects empty balance.",
    }),
  );
  process.exit(2);
}

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
  const cartOk = steps.some((s) => s.step === "cart_create" && s.ok);
  const payStep = steps.find((s) => s.step === "place_order");
  console.log(
    JSON.stringify({
      phase: "done",
      ok: Boolean(out.ok),
      ms: Date.now() - t0,
      checkoutStage: out.checkoutStage || null,
      dryRun: out.dryRun === true,
      loginOk,
      cartOk,
      paymentStatus: out.paymentStatus || null,
      paymentDeclined: Boolean(out.paymentDeclined),
      orderNumber: out.orderNumber || null,
      error: out.error || null,
      failedStep: out.failedStep || null,
      placeNote: payStep?.note || null,
      steps,
    }),
  );
  // Success for decline smoke = reached gateway decline OR order number.
  const pass = Boolean(out.paymentDeclined || out.orderNumber);
  process.exit(pass ? 0 : 3);
} catch (e) {
  console.log(
    JSON.stringify({ phase: "throw", error: e?.message || String(e), ms: Date.now() - t0 }),
  );
  process.exit(4);
} finally {
  try {
    await dispatcher.close?.();
  } catch {
    /* ignore */
  }
}
