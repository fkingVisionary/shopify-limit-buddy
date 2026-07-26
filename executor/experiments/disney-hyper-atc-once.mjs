#!/usr/bin/env node
/**
 * Disney AU — one-shot Hyper Akamai warm → CapSolver → CSRF → ATC → minibag → GE probe.
 *
 * Requires:
 *   HYPER_API_KEY          (Disney allowlisted)
 *   CAPSOLVER_API_KEY      (optional but recommended for AddToCart)
 *   PROXY=host:port:user:pass  (or first line of resi.proxies)
 *
 * Usage:
 *   HYPER_API_KEY=... CAPSOLVER_API_KEY=... \
 *     PROXY='…' node experiments/disney-hyper-atc-once.mjs
 *
 * Never commits secrets. Writes JSON summary under /tmp/disney-hyper-*.
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

function loadEnvFile(rel) {
  try {
    const raw = fs.readFileSync(path.join(ROOT, rel), "utf8");
    for (const line of raw.split(/\r?\n/)) {
      const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
      if (!m) continue;
      if (!process.env[m[1]]) {
        process.env[m[1]] = m[1] === m[1] ? m[2].trim().replace(/^["']|["']$/g, "") : m[2];
      }
    }
  } catch {
    /* ignore */
  }
}

function loadProxy() {
  if (process.env.PROXY || process.env.PROXY_URL || process.env.PROXY_LINE) {
    return String(process.env.PROXY || process.env.PROXY_URL || process.env.PROXY_LINE).trim();
  }
  const lines = fs
    .readFileSync(path.join(ROOT, "resi.proxies"), "utf8")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#") && /^\d/.test(l));
  return lines[0] || null;
}

function toProxyUrl(raw) {
  if (!raw) return null;
  if (/^https?:\/\//i.test(raw)) return raw;
  const [host, port, user, ...pass] = raw.split(":");
  return `http://${encodeURIComponent(user)}:${encodeURIComponent(pass.join(":"))}@${host}:${port}`;
}

loadEnvFile("../.env.local");
loadEnvFile(".env.local");

const outDir = process.env.DISNEY_OUT || `/tmp/disney-hyper-${Date.now()}`;
fs.mkdirSync(outDir, { recursive: true });

const proxyRaw = loadProxy();
const proxyUrl = toProxyUrl(proxyRaw);
if (!proxyUrl) {
  console.error("PROXY required");
  process.exit(2);
}
if (!hyperConfigured()) {
  console.error("HYPER_API_KEY missing — set env or .env.local");
  process.exit(2);
}

const pdpUrl = process.env.DISNEY_PDP || `${DISNEY_ORIGIN}${DISNEY_DEFAULT_PDP_PATH}`;
const placeOrder = process.env.PLACE_ORDER === "1";
const jar = createJar();
const dispatcher = makeDispatcher(proxyUrl);
const ctx = { jar, dispatcher, steps: [] };

const task = {
  storeUrl: DISNEY_ORIGIN,
  pdpUrl,
  disneyMode: "checkout",
  quantity: 1,
  proxy: proxyRaw,
  placeOrder,
  disneyGe: true,
  skipRecaptcha: process.env.SKIP_RECAPTCHA === "1",
  acceptAtcWithoutMini: process.env.ACCEPT_ATC_NO_MINI === "1",
};

console.log(
  JSON.stringify(
    {
      outDir,
      hyper: true,
      capsolver: Boolean(capsolverKey()),
      proxyHost: proxyRaw.split(":")[0],
      pdpUrl,
      geMid: DISNEY_GE_MID,
      placeOrder,
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

const summary = {
  ok: Boolean(result?.ok),
  ms,
  note: result?.note,
  failedStep: result?.failedStep || null,
  checkoutStage: result?.checkoutStage || null,
  pid: result?.pid || null,
  merchantId: result?.merchantId || DISNEY_GE_MID,
  needsRecaptcha: result?.needsRecaptcha || false,
  capsolverConfigured: Boolean(capsolverKey()),
  warm: result?.warm?.note || null,
  atc: result?.atc?.note || result?.atc?.atc?.note || null,
  mini: result?.atc?.mini?.note || null,
  ge: result?.ge?.note || null,
  steps: (result?.steps || ctx.steps || []).map((s) => ({
    step: s.step,
    ok: s.ok,
    status: s.status ?? null,
    ms: s.ms ?? null,
    note: s.note ?? null,
  })),
  cookies: Object.keys(ctx.jar?.dump?.() || {}),
};

fs.writeFileSync(path.join(outDir, "summary.json"), JSON.stringify(summary, null, 2));
fs.writeFileSync(path.join(outDir, "result.json"), JSON.stringify(result, null, 2));
console.log(JSON.stringify(summary, null, 2));

await dispatcher.close?.();
process.exit(summary.ok ? 0 : 1);
