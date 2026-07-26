#!/usr/bin/env node
/**
 * Disney harvest lab — mint Akamai+CapSolver session, optional pay claim.
 *
 *   PROXY='host:port:user:pass' node experiments/disney-harvest-lab.mjs
 *   DISNEY_HARVEST_PAY=1 node experiments/disney-harvest-lab.mjs   # → fake decline
 *
 * Writes /tmp/disney-harvest-* (never commits cookies/tokens).
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createJar, makeDispatcher } from "../http.js";
import { harvestDisneySession } from "../adapters/disney-harvest-session.js";
import { disneyAdapter } from "../adapters/disney.js";
import { DISNEY_FAKE_DECLINE_CARD } from "../adapters/disney-ge-http.js";
import { hyperConfigured } from "../antibot.js";
import {
  DISNEY_ORIGIN,
  DISNEY_DEFAULT_PDP_PATH,
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
  return lines[idx % lines.length] || null;
}

function toProxyUrl(raw) {
  if (!raw) return null;
  if (/^https?:\/\//i.test(raw)) return raw;
  const [host, port, user, ...pass] = raw.split(":");
  return `http://${encodeURIComponent(user)}:${encodeURIComponent(pass.join(":"))}@${host}:${port}`;
}

loadEnvFile("../.env.local");
loadEnvFile(".env.local");
loadEnvFile("/tmp/disney-secrets.env");
if (!process.env.TLS_CLIENT_PATH && fs.existsSync("/tmp/tls-client-x64.so")) {
  process.env.TLS_CLIENT_PATH = "/tmp/tls-client-x64.so";
}

const outDir = process.env.DISNEY_OUT || `/tmp/disney-harvest-${Date.now()}`;
fs.mkdirSync(outDir, { recursive: true });

const proxyRaw = loadProxy();
if (!proxyRaw) {
  console.error("PROXY required");
  process.exit(2);
}
if (!hyperConfigured()) {
  console.error("HYPER_API_KEY missing");
  process.exit(2);
}

console.log(
  JSON.stringify(
    {
      outDir,
      proxyHost: String(proxyRaw).split(":")[0],
      solveCaptcha: process.env.DISNEY_HARVEST_NO_CAPTCHA !== "1",
      pay: process.env.DISNEY_HARVEST_PAY === "1",
    },
    null,
    2,
  ),
);

const mint = await harvestDisneySession({
  proxyRaw,
  solveCaptcha: process.env.DISNEY_HARVEST_NO_CAPTCHA !== "1",
  pdpUrl: process.env.DISNEY_PDP || `${DISNEY_ORIGIN}${DISNEY_DEFAULT_PDP_PATH}`,
});

fs.writeFileSync(
  path.join(outDir, "mint.json"),
  JSON.stringify(
    {
      ok: mint.ok,
      ms: mint.ms,
      error: mint.error || null,
      session: mint.session
        ? {
            id: mint.session.id,
            proxyHost: mint.session.proxyHost,
            abckValid: mint.session.abckValid,
            abckLen: mint.session.abckLen,
            hasCaptcha: Boolean(mint.session.captchaToken),
            captchaMs: mint.session.captchaMs,
            warmNote: mint.session.warmNote,
            captchaNote: mint.session.captchaNote,
            harvestedAt: mint.session.harvestedAt,
            abckExpiresAt: mint.session.abckExpiresAt,
            captchaExpiresAt: mint.session.captchaExpiresAt,
            // cookies omitted from mint.json summary — full in session.json
          }
        : null,
    },
    null,
    2,
  ),
);

if (!mint.ok) {
  console.log(JSON.stringify({ ok: false, mint }, null, 2));
  process.exit(1);
}

fs.writeFileSync(path.join(outDir, "session.json"), JSON.stringify(mint.session, null, 2));
console.log(
  JSON.stringify(
    {
      mintOk: true,
      mintMs: mint.ms,
      id: mint.session.id,
      hasCaptcha: Boolean(mint.session.captchaToken),
      abckLen: mint.session.abckLen,
    },
    null,
    2,
  ),
);

if (process.env.DISNEY_HARVEST_PAY !== "1") {
  console.log(`wrote ${outDir} (mint only)`);
  process.exit(0);
}

const proxyUrl = toProxyUrl(proxyRaw);
const jar = createJar();
const dispatcher = makeDispatcher(proxyUrl, { forceTls: true });
const wall0 = Date.now();
const wallMarks = Object.create(null);
const ctx = {
  jar,
  dispatcher,
  steps: [],
  onProgress(name) {
    if (name && wallMarks[name] == null) wallMarks[name] = Date.now() - wall0;
  },
};

const task = {
  storeUrl: DISNEY_ORIGIN,
  pdpUrl: process.env.DISNEY_PDP || `${DISNEY_ORIGIN}${DISNEY_DEFAULT_PDP_PATH}`,
  disneyMode: "pay",
  disneyGePay: true,
  fakeDecline: true,
  placeOrder: false,
  card: DISNEY_FAKE_DECLINE_CARD,
  proxy: proxyRaw,
  harvestedSession: mint.session,
  preferLastGoodProxy: false,
  proxyRotate: true,
  noPage: true,
};

const result = await disneyAdapter.run(task, ctx);
const totalMs = Date.now() - wall0;
const summary = {
  ok: Boolean(result?.ok),
  decline: Boolean(result?.decline),
  paymentStatus: result?.paymentStatus,
  transactionId: result?.transactionId,
  totalMs,
  totalSec: Math.round((totalMs / 1000) * 10) / 10,
  mintMs: mint.ms,
  harvest: result?.harvest || null,
  wallMarks: {
    harvest_claim: wallMarks.harvest_claim ?? null,
    akamai_warm: wallMarks.akamai_warm ?? null,
    atc: wallMarks.cart_add_product ?? null,
    checkout_v2: wallMarks.ge_checkout_v2 ?? null,
    issuer: wallMarks.ge_issuer_http ?? null,
  },
  note: result?.note,
  failedStep: result?.failedStep,
  steps: (result?.steps || []).map((s) => ({
    step: s.step,
    ok: s.ok,
    ms: s.ms,
    note: String(s.note || "").slice(0, 160),
  })),
};

fs.writeFileSync(path.join(outDir, "pay-summary.json"), JSON.stringify(summary, null, 2));
console.log(JSON.stringify(summary, null, 2));
console.log(`wrote ${outDir}`);
process.exit(summary.decline || summary.ok ? 0 : 1);
