#!/usr/bin/env node
/**
 * Disney AU — ATC (TLS) → GE Checkout/v2 → issuer POST with fake PAN.
 *
 * Pass signal: paymentStatus declined_or_auth_failed | ge_fraud_refused
 * Default card: 4000000000000002 (never a live charge path).
 *
 * Requires HYPER_API_KEY (+ CAPSOLVER_API_KEY recommended) and PROXY / resi.proxies.
 *
 *   node experiments/disney-ge-fake-decline.mjs
 *   DISNEY_NO_PAGE=1 node experiments/disney-ge-fake-decline.mjs   # skip iovation
 *   PROXY_LINE=3 node experiments/disney-ge-fake-decline.mjs       # rotate sticky
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createJar, makeDispatcher } from "../http.js";
import { disneyAdapter } from "../adapters/disney.js";
import { DISNEY_FAKE_DECLINE_CARD } from "../adapters/disney-ge-http.js";
import { hyperConfigured } from "../antibot.js";
import { capsolverKey } from "../adapters/disney-recaptcha.js";
import {
  DISNEY_ORIGIN,
  DISNEY_DEFAULT_PDP_PATH,
  DISNEY_GE_MID,
} from "../adapters/disney-session.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

function loadEnvFile(relOrAbs) {
  try {
    const file = path.isAbsolute(relOrAbs) ? relOrAbs : path.join(ROOT, relOrAbs);
    const raw = fs.readFileSync(file, "utf8");
    for (const line of raw.split(/\r?\n/)) {
      const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
      if (!m) continue;
      if (!process.env[m[1]]) {
        process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
      }
    }
  } catch {
    /* ignore */
  }
}

function loadProxy() {
  if (process.env.PROXY || process.env.PROXY_URL || process.env.PROXY_LINE_RAW) {
    return String(
      process.env.PROXY || process.env.PROXY_URL || process.env.PROXY_LINE_RAW,
    ).trim();
  }
  const lines = fs
    .readFileSync(path.join(ROOT, "resi.proxies"), "utf8")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#") && /^\d/.test(l));
  const idx = Math.max(0, Number(process.env.PROXY_LINE || 0) | 0);
  return lines[idx % lines.length] || lines[0] || null;
}

function toProxyUrl(raw) {
  if (!raw) return null;
  if (/^https?:\/\//i.test(raw)) return raw;
  const [host, port, user, ...pass] = raw.split(":");
  return `http://${encodeURIComponent(user)}:${encodeURIComponent(pass.join(":"))}@${host}:${port}`;
}

loadEnvFile("../.env.local");
loadEnvFile(".env.local");
try {
  loadEnvFile("/tmp/disney-secrets.env");
} catch {
  /* ignore */
}
if (!process.env.TLS_CLIENT_PATH && fs.existsSync("/tmp/tls-client-x64.so")) {
  process.env.TLS_CLIENT_PATH = "/tmp/tls-client-x64.so";
}

const outDir = process.env.DISNEY_OUT || `/tmp/disney-fake-decline-${Date.now()}`;
fs.mkdirSync(outDir, { recursive: true });

const proxyRaw = loadProxy();
const proxyUrl = toProxyUrl(proxyRaw);
if (!proxyUrl) {
  console.error("PROXY required");
  process.exit(2);
}
if (!hyperConfigured()) {
  console.error("HYPER_API_KEY missing");
  process.exit(2);
}

const pdpUrl = process.env.DISNEY_PDP || `${DISNEY_ORIGIN}${DISNEY_DEFAULT_PDP_PATH}`;
const jar = createJar();
const dispatcher = makeDispatcher(proxyUrl, { forceTls: true });
const ctx = { jar, dispatcher, steps: [] };

const task = {
  storeUrl: DISNEY_ORIGIN,
  pdpUrl,
  disneyMode: "pay",
  disneyGePay: true,
  fakeDecline: true,
  quantity: 1,
  proxy: proxyRaw,
  placeOrder: false,
  card: DISNEY_FAKE_DECLINE_CARD,
  skipRecaptcha: process.env.SKIP_RECAPTCHA === "1",
  noPage: process.env.DISNEY_NO_PAGE === "1",
  riskHydrate: process.env.DISNEY_NO_PAGE !== "1",
  acceptAtcWithoutMini: process.env.ACCEPT_ATC_NO_MINI === "1",
};

console.log(
  JSON.stringify(
    {
      outDir,
      mode: "pay/fake_decline",
      cardLast4: DISNEY_FAKE_DECLINE_CARD.number.slice(-4),
      hyper: true,
      capsolver: Boolean(capsolverKey()),
      transport: dispatcher.transport,
      proxyHost: proxyRaw.split(":")[0],
      noPage: task.noPage,
      pdpUrl,
      geMid: DISNEY_GE_MID,
    },
    null,
    2,
  ),
);

const t0 = Date.now();
let result;
try {
  result = await disneyAdapter.run(task, ctx);
} catch (e) {
  result = { ok: false, note: e?.message || String(e), steps: ctx.steps };
}
const ms = Date.now() - t0;

const paySteps = (result?.steps || ctx.steps || []).filter((s) =>
  /^ge_|akamai|cart_|recaptcha|transport|resolve|disney/i.test(s.step),
);

const summary = {
  ok: Boolean(result?.ok),
  decline: Boolean(result?.decline),
  paymentStatus: result?.paymentStatus || result?.pay?.paymentStatus || null,
  transactionId: result?.transactionId || result?.pay?.transactionId || null,
  ms,
  note: result?.note,
  failedStep: result?.failedStep || null,
  checkoutStage: result?.checkoutStage || null,
  cartToken: result?.cartToken || result?.ge?.checkoutGuid || null,
  fakeCard: result?.fakeCard ?? true,
  cardLast4: result?.pay?.cardLast4 || "0002",
  atc: result?.atc?.note || null,
  ge: result?.ge?.note || null,
  pay: result?.pay?.note || null,
  steps: paySteps.map((s) => ({
    step: s.step,
    ok: s.ok,
    status: s.status ?? null,
    ms: s.ms ?? null,
    note: String(s.note || "").slice(0, 220),
  })),
};

fs.writeFileSync(path.join(outDir, "summary.json"), JSON.stringify(summary, null, 2));
fs.writeFileSync(path.join(outDir, "result.json"), JSON.stringify(result, null, 2));
console.log(JSON.stringify(summary, null, 2));
console.log(`wrote ${outDir}`);

const pass =
  summary.decline ||
  /declined_or_auth_failed|ge_fraud_refused/i.test(String(summary.paymentStatus || ""));
process.exit(pass ? 0 : 1);
