#!/usr/bin/env node
/**
 * Disney AU — timed start → ATC → Checkout/v2 → issuer (fake PAN decline).
 *
 * Prints a milestone ladder with cumulative + step ms. Surfaces GE fraud flags
 * from the CCPaymentRedirect JWT (PossibleFraudDetected, IsTheSameCartToken, …).
 *
 *   node experiments/disney-timed-checkout.mjs
 *   DISNEY_NO_PAGE=1 node experiments/disney-timed-checkout.mjs   # skip iovation
 *   PROXY_LINE=3 node experiments/disney-timed-checkout.mjs
 *
 * Does not place a live order. Default card is 4000000000000002.
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

const MILESTONE_DEFS = [
  { key: "resolve_ip", match: /^resolve_ip$/ },
  { key: "akamai_warm", match: /^akamai_warm$|^akamai$/ },
  { key: "pdp", match: /^pdp$|^disney_pdp$/ },
  { key: "recaptcha", match: /^recaptcha/ },
  { key: "atc", match: /^cart_add_product$/ },
  { key: "ge_guid", match: /^ge_sfcc_cart_token$/ },
  { key: "checkout_v2", match: /^ge_checkout_v2$/ },
  { key: "shipping", match: /^ge_handleaction_1$/ },
  { key: "checkout_save", match: /^ge_checkout_save$/ },
  { key: "credit_card_form", match: /^ge_credit_card_form$/ },
  { key: "issuer", match: /^ge_issuer_http$/ },
];

/** Wall-clock milestones from onProgress + step notes. */
function buildTiming(steps = [], wallMarks = {}, wall0 = 0, totalMs = 0) {
  const ladder = [];
  const seen = new Set();
  for (const s of steps) {
    for (const m of MILESTONE_DEFS) {
      if (seen.has(m.key)) continue;
      if (!m.match.test(String(s.step || ""))) continue;
      seen.add(m.key);
      const wallMs =
        wallMarks[s.step] != null
          ? wallMarks[s.step]
          : wallMarks[m.key] != null
            ? wallMarks[m.key]
            : null;
      ladder.push({
        milestone: m.key,
        step: s.step,
        ok: s.ok !== false,
        stepMs: Number(s.ms || 0),
        wallMs,
        note: String(s.note || "").slice(0, 140),
      });
    }
  }
  const byKey = Object.fromEntries(ladder.map((r) => [r.milestone, r]));
  const wallOf = (k) => byKey[k]?.wallMs ?? null;
  return {
    ladder,
    wall0,
    toAtcMs: wallOf("atc"),
    toCheckoutV2Ms: wallOf("checkout_v2"),
    toCheckoutSaveMs: wallOf("checkout_save"),
    toIssuerMs: wallOf("issuer"),
    wallTotalMs: totalMs,
  };
}

loadEnvFile("../.env.local");
loadEnvFile(".env.local");
loadEnvFile("/tmp/disney-secrets.env");
if (!process.env.TLS_CLIENT_PATH && fs.existsSync("/tmp/tls-client-x64.so")) {
  process.env.TLS_CLIENT_PATH = "/tmp/tls-client-x64.so";
}

const outDir = process.env.DISNEY_OUT || `/tmp/disney-timed-${Date.now()}`;
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
const wallMarks = Object.create(null);
const wall0 = Date.now();
const ctx = {
  jar,
  dispatcher,
  steps: [],
  onProgress(name) {
    const key = String(name || "");
    if (!key || wallMarks[key] != null) return;
    wallMarks[key] = Date.now() - wall0;
    for (const m of MILESTONE_DEFS) {
      if (m.match.test(key) && wallMarks[m.key] == null) {
        wallMarks[m.key] = wallMarks[key];
      }
    }
  },
};

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
  noPage,
  riskHydrate: !noPage,
  acceptAtcWithoutMini: process.env.ACCEPT_ATC_NO_MINI === "1",
};

console.log(
  JSON.stringify(
    {
      outDir,
      mode: "timed pay/fake_decline",
      cardLast4: DISNEY_FAKE_DECLINE_CARD.number.slice(-4),
      riskHydrate: task.riskHydrate,
      proxyHost: proxyRaw.split(":")[0],
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
const steps = result?.steps || ctx.steps || [];
const timing = buildTiming(steps, wallMarks, wall0, totalMs);
const sec = (ms) => (ms == null ? null : Math.round((ms / 1000) * 10) / 10);

const fraudFlags = result?.fraudFlags || result?.pay?.fraudFlags || null;
const summary = {
  ok: Boolean(result?.ok),
  decline: Boolean(result?.decline),
  paymentStatus: result?.paymentStatus || result?.pay?.paymentStatus || null,
  transactionId: result?.transactionId || result?.pay?.transactionId || null,
  transactionStatusType:
    result?.pay?.transactionStatusType || fraudFlags?.transactionStatusType || null,
  totalMs,
  totalSec: sec(totalMs),
  timing: {
    wallTotalMs: totalMs,
    ladder: timing.ladder,
    startToAtcMs: timing.toAtcMs,
    startToCheckoutV2Ms: timing.toCheckoutV2Ms,
    startToCheckoutSaveMs: timing.toCheckoutSaveMs,
    startToIssuerMs: timing.toIssuerMs,
    startToAtcSec: sec(timing.toAtcMs),
    startToCheckoutV2Sec: sec(timing.toCheckoutV2Ms),
    startToCheckoutSaveSec: sec(timing.toCheckoutSaveMs),
    startToIssuerSec: sec(timing.toIssuerMs),
    startToDoneSec: sec(totalMs),
  },
  fraudFlags,
  possibleFraudDetected: result?.possibleFraudDetected ?? fraudFlags?.possibleFraudDetected ?? null,
  isSameCartToken: result?.isSameCartToken ?? fraudFlags?.isSameCartToken ?? null,
  note: result?.note,
  failedStep: result?.failedStep || null,
  checkoutStage: result?.checkoutStage || null,
  cartToken: result?.cartToken || null,
  fakeCard: result?.fakeCard ?? true,
  steps: steps.map((s) => ({
    step: s.step,
    ok: s.ok,
    status: s.status ?? null,
    ms: s.ms ?? null,
    note: String(s.note || "").slice(0, 180),
  })),
};

fs.writeFileSync(path.join(outDir, "summary.json"), JSON.stringify(summary, null, 2));
fs.writeFileSync(path.join(outDir, "result.json"), JSON.stringify(result, null, 2));

console.log("\n=== TIMING (wall clock from start) ===");
console.log(`wall total: ${summary.totalSec}s (${totalMs}ms)`);
for (const row of timing.ladder) {
  const w = row.wallMs != null ? String(row.wallMs).padStart(6) : "     ?";
  console.log(
    `${w}ms  step+${String(row.stepMs).padStart(5)}ms  ${row.ok ? "✓" : "✗"} ${row.milestone.padEnd(18)} ${row.note}`,
  );
}
console.log("\n=== FRAUD FLAGS ===");
console.log(JSON.stringify(fraudFlags, null, 2));
console.log("\n=== RESULT ===");
console.log(
  JSON.stringify(
    {
      ok: summary.ok,
      decline: summary.decline,
      paymentStatus: summary.paymentStatus,
      transactionId: summary.transactionId,
      transactionStatusType: summary.transactionStatusType,
      totalSec: summary.totalSec,
      startToCheckoutV2Sec: summary.timing.startToCheckoutV2Sec,
      startToCheckoutSaveSec: summary.timing.startToCheckoutSaveSec,
      startToIssuerSec: summary.timing.startToIssuerSec,
      possibleFraudDetected: summary.possibleFraudDetected,
      isSameCartToken: summary.isSameCartToken,
    },
    null,
    2,
  ),
);
console.log(`wrote ${outDir}`);

const pass =
  summary.decline ||
  /declined_or_auth_failed|ge_fraud_refused/i.test(String(summary.paymentStatus || ""));
process.exit(pass ? 0 : 1);
