#!/usr/bin/env node
/**
 * Disney AU — issuer POST with disposable / no-funds card (bank decline confirm).
 *
 * Card MUST come from env (never commit PANs):
 *   DISNEY_CARD_NUMBER  DISNEY_CARD_EXP_MONTH  DISNEY_CARD_EXP_YEAR  DISNEY_CARD_CVV
 *
 *   DISNEY_CARD_NUMBER=… DISNEY_CARD_EXP_MONTH=07 DISNEY_CARD_EXP_YEAR=31 \
 *     DISNEY_CARD_CVV=… node experiments/disney-disposable-decline.mjs
 *
 * placeOrder=true only so the provided PAN is sent; no-funds cards should
 * still land as declined_or_auth_failed / bank refuse — not a paid order.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createJar, makeDispatcher } from "../http.js";
import { disneyAdapter } from "../adapters/disney.js";
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
  if (process.env.PROXY || process.env.PROXY_URL) {
    return String(process.env.PROXY || process.env.PROXY_URL).trim();
  }
  try {
    const last = fs.readFileSync("/tmp/disney-last-good-proxy.txt", "utf8").trim();
    if (/^\d/.test(last)) return last;
  } catch {
    /* ignore */
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

function maskPan(n) {
  const d = String(n || "").replace(/\s+/g, "");
  return d.length >= 4 ? `****${d.slice(-4)}` : "****";
}

loadEnvFile("../.env.local");
loadEnvFile(".env.local");
loadEnvFile("/tmp/disney-secrets.env");
if (!process.env.TLS_CLIENT_PATH && fs.existsSync("/tmp/tls-client-x64.so")) {
  process.env.TLS_CLIENT_PATH = "/tmp/tls-client-x64.so";
}

const number = String(process.env.DISNEY_CARD_NUMBER || "").replace(/\s+/g, "");
const expMonth = String(process.env.DISNEY_CARD_EXP_MONTH || "").replace(/^0/, "") || process.env.DISNEY_CARD_EXP_MONTH;
const expYear = String(process.env.DISNEY_CARD_EXP_YEAR || "");
const cvv = String(process.env.DISNEY_CARD_CVV || "");

if (number.length < 12 || !expMonth || !expYear || !cvv) {
  console.error(
    "Set DISNEY_CARD_NUMBER DISNEY_CARD_EXP_MONTH DISNEY_CARD_EXP_YEAR DISNEY_CARD_CVV",
  );
  process.exit(2);
}

const outDir = process.env.DISNEY_OUT || `/tmp/disney-disposable-${Date.now()}`;
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
const noPage = process.env.DISNEY_NO_PAGE === "1";
const jar = createJar();
const dispatcher = makeDispatcher(proxyUrl, { forceTls: true });
const wall0 = Date.now();
const wallMarks = Object.create(null);
const ctx = {
  jar,
  dispatcher,
  steps: [],
  onProgress(name) {
    const key = String(name || "");
    if (key && wallMarks[key] == null) wallMarks[key] = Date.now() - wall0;
  },
};

const task = {
  storeUrl: DISNEY_ORIGIN,
  pdpUrl,
  disneyMode: "pay",
  disneyGePay: true,
  fakeDecline: false,
  quantity: 1,
  proxy: proxyRaw,
  // placeOrder unlocks the provided PAN on the issuer wire (card has no funds).
  placeOrder: true,
  card: {
    number,
    expMonth,
    expYear: expYear.length === 2 ? `20${expYear}` : expYear,
    cvv,
    name: process.env.DISNEY_CARD_NAME || "TEST DECLINE",
  },
  skipRecaptcha: process.env.SKIP_RECAPTCHA === "1",
  noPage,
  riskHydrate: process.env.DISNEY_RISK_HYDRATE === "1",
  preferLastGoodProxy: process.env.DISNEY_PREFER_LAST !== "0",
};

console.log(
  JSON.stringify(
    {
      outDir,
      mode: "disposable-decline",
      cardLast4: maskPan(number),
      exp: `${expMonth}/${String(expYear).slice(-2)}`,
      riskHydrate: task.riskHydrate,
      proxyHost: String(proxyRaw).split(":")[0],
      geMid: DISNEY_GE_MID,
      capsolver: Boolean(capsolverKey()),
    },
    null,
    2,
  ),
);

let result;
try {
  result = await disneyAdapter.run(task, ctx);
} catch (e) {
  result = { ok: false, note: e?.message || String(e), steps: ctx.steps };
}
const totalMs = Date.now() - wall0;

const redacted = JSON.parse(JSON.stringify(result || {}));
if (redacted.pay) {
  delete redacted.pay.issuer?.txMap?.RedirectMessage;
}
// Never persist full PAN
const summary = {
  ok: Boolean(result?.ok),
  decline: Boolean(result?.decline),
  paymentStatus: result?.paymentStatus || result?.pay?.paymentStatus || null,
  transactionId: result?.transactionId || result?.pay?.transactionId || null,
  transactionStatusType: result?.pay?.transactionStatusType || null,
  fraudFlags: result?.fraudFlags || result?.pay?.fraudFlags || null,
  possibleFraudDetected: result?.possibleFraudDetected ?? null,
  isSameCartToken: result?.isSameCartToken ?? null,
  cardLast4: maskPan(number),
  fakeCard: false,
  disposable: true,
  totalMs,
  totalSec: Math.round((totalMs / 1000) * 10) / 10,
  wallMarks: {
    atc: wallMarks.cart_add_product ?? null,
    checkout_v2: wallMarks.ge_checkout_v2 ?? null,
    issuer: wallMarks.ge_issuer_http ?? null,
  },
  note: result?.note,
  failedStep: result?.failedStep || null,
  steps: (result?.steps || ctx.steps || []).map((s) => ({
    step: s.step,
    ok: s.ok,
    status: s.status ?? null,
    ms: s.ms ?? null,
    note: String(s.note || "").slice(0, 200),
  })),
};

fs.writeFileSync(path.join(outDir, "summary.json"), JSON.stringify(summary, null, 2));
// Full result may include txMap — strip card-shaped fields if any leaked
fs.writeFileSync(
  path.join(outDir, "result.json"),
  JSON.stringify(
    {
      ...redacted,
      card: { last4: maskPan(number) },
      cookies: Object.keys(ctx.jar?.dump?.() || {}),
    },
    null,
    2,
  ),
);

console.log(JSON.stringify(summary, null, 2));
console.log(`wrote ${outDir}`);

const pass =
  summary.decline ||
  /declined_or_auth_failed|ge_fraud_refused/i.test(String(summary.paymentStatus || ""));
process.exit(pass ? 0 : 1);
