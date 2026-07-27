/**
 * Bandai high-traffic drop rehearsal — existing Fast checkout module only.
 *
 * Concurrent lanes with full error dump (the gap from the 13:00 launch test).
 * Harvest mint uses retry-on-transient-proxy. Prefers backend NAI when set.
 *
 *   BANDAI_ACCOUNTS_JSON=/tmp/roster.json \
 *   BANDAI_SKU=N2890904001 BANDAI_AREA_ITEM_NO=NAI0859145AU \
 *   BANDAI_CARD_* BANDAI_PROXY_POOL=… \
 *   node executor/scripts/bandai-drop-rehearsal-lab.mjs
 *
 * Accounts JSON: [{ "id","email","password" }, ...]
 * Or fall back to single BANDAI_EMAIL/PASSWORD (1 lane).
 */
import fs from "node:fs";
import { runCheckout } from "../checkout.js";
import {
  mintHarvestSlotWithRetries,
  clearHarvestSlots,
  harvestSnapshot,
} from "../adapters/bandai-harvest-pool.js";

function loadEnv(p) {
  if (!fs.existsSync(p)) return;
  for (const line of fs.readFileSync(p, "utf8").split("\n")) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
}
loadEnv("/tmp/bandai-lab-creds.env");
loadEnv("/tmp/bandai-card.env");

function aest() {
  return new Date().toLocaleString("en-AU", { timeZone: "Australia/Sydney" });
}

function aestHms() {
  // en-GB + hour12:false → reliable 24h clock (en-AU can still emit 1–12).
  const s = new Date().toLocaleString("en-GB", {
    timeZone: "Australia/Sydney",
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  // e.g. "27/07/2026, 13:27:01"
  const m = String(s).match(/(\d{1,2}):(\d{2}):(\d{2})/);
  if (!m) return { h: 0, m: 0, s: 0 };
  return { h: Number(m[1]), m: Number(m[2]), s: Number(m[3]) };
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitUntilAest(hhmm, label) {
  if (/^(1|true)$/i.test(String(process.env.DROP_FORCE_NOW || ""))) return;
  if (!hhmm) return;
  const [hh, mm] = String(hhmm).split(":").map((x) => Number(x));
  if (!Number.isFinite(hh) || !Number.isFinite(mm)) return;
  const target = hh * 3600 + mm * 60;
  for (;;) {
    const { h, m, s } = aestHms();
    const now = h * 3600 + m * 60 + s;
    if (now >= target) return;
    const left = target - now;
    if (left % 15 === 0 || left < 20) console.log(`[${aest()}] wait ${label || hhmm} ${left}s`);
    await sleep(Math.min(3000, Math.max(500, left * 1000)));
  }
}

function loadAccounts() {
  const p = process.env.BANDAI_ACCOUNTS_JSON || "/tmp/bandai-drop-1300/roster.json";
  if (fs.existsSync(p)) {
    const j = JSON.parse(fs.readFileSync(p, "utf8"));
    const list = Array.isArray(j) ? j : j.accounts || [];
    return list
      .filter((a) => a?.email && a?.password)
      .map((a, i) => ({
        id: a.id || `acc${i + 1}`,
        email: a.email,
        password: a.password,
      }));
  }
  const email = process.env.BANDAI_EMAIL;
  const password = process.env.BANDAI_PASSWORD;
  if (email && password) return [{ id: "lab", email, password }];
  throw new Error("need BANDAI_ACCOUNTS_JSON or BANDAI_EMAIL/PASSWORD");
}

function loadProxies() {
  const poolPath =
    process.env.BANDAI_PROXY_POOL ||
    (fs.existsSync("/tmp/bandai-proxy-pool.txt")
      ? "/tmp/bandai-proxy-pool.txt"
      : "resi.proxies");
  return fs
    .readFileSync(poolPath, "utf8")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"));
}

function summarize(label, res, wallMs, extra = {}) {
  const steps = res.steps || [];
  const pick = (name) => steps.find((s) => s.step === name);
  const fail = [...steps].reverse().find((s) => s && s.ok === false);
  return {
    label,
    ok: Boolean(res.ok),
    wallMs,
    paymentStatus: res.paymentStatus || null,
    checkoutStage: res.checkoutStage || null,
    failedStep: res.failedStep || fail?.step || null,
    error: res.error ? String(res.error).slice(0, 240) : null,
    note: res.note ? String(res.note).slice(0, 240) : null,
    f5_ms: pick("f5_bridge")?.ms ?? null,
    f5_note: pick("f5_bridge")?.note ? String(pick("f5_bridge").note).slice(0, 140) : null,
    login_ms: pick("login")?.ms ?? null,
    login_note: pick("login")?.note ? String(pick("login").note).slice(0, 140) : null,
    addToCart_ms: pick("addToCart")?.ms ?? null,
    addToCart_note: pick("addToCart")?.note
      ? String(pick("addToCart").note).slice(0, 160)
      : null,
    wallToAtcMs:
      (String(pick("cart_hold")?.note || "").match(/wall→ATC\s+(\d+)ms/) || [])[1] ||
      pick("cart_hold")?.ms ||
      null,
    tx: (String(res.note || "").match(/tx=(\d+)/) || [])[1] || null,
    harvested: Boolean(extra.harvested),
    harvestMintMs: extra.harvestMintMs ?? null,
    areaItemNo: extra.areaItemNo || null,
  };
}

const accounts = loadAccounts().slice(0, Math.max(1, Number(process.env.BANDAI_LANES) || 2));
const proxies = loadProxies();
const sku = process.env.BANDAI_SKU || "N2542159011";
function resolveAreaItemNoEnv() {
  // Explicit empty BANDAI_AREA_ITEM_NO= means "no backend override" (frontend SKU only).
  if (Object.prototype.hasOwnProperty.call(process.env, "BANDAI_AREA_ITEM_NO")) {
    return String(process.env.BANDAI_AREA_ITEM_NO || "").trim();
  }
  if (process.env.BANDAI_BACKEND_PID) return String(process.env.BANDAI_BACKEND_PID).trim();
  return "";
}
const areaItemNo = resolveAreaItemNoEnv();
const pdp = `https://p-bandai.com/au/item/${sku}`;
const concurrency = Math.max(1, Math.min(4, Number(process.env.BANDAI_CONCURRENCY) || accounts.length));
const harvestAt = process.env.BANDAI_HARVEST_AT || ""; // e.g. 13:27
const fireAt = process.env.BANDAI_FIRE_AT || ""; // e.g. 13:30
const outPath =
  process.env.BANDAI_REHEARSAL_OUT ||
  `/tmp/bandai-drop-rehearsal-${Date.now()}.json`;

const pan = String(process.env.BANDAI_CARD_NUMBER || "").replace(/\s+/g, "");
const card = {
  number: pan,
  expMonth: String(process.env.BANDAI_CARD_EXP_MONTH || "").padStart(2, "0"),
  expYear: String(process.env.BANDAI_CARD_EXP_YEAR || "").slice(-2),
  cvv: process.env.BANDAI_CARD_CVV,
  holder: process.env.BANDAI_CARD_HOLDER || "Cardholder",
};

console.log(
  JSON.stringify(
    {
      at: aest(),
      sku,
      areaItemNo: areaItemNo || null,
      lanes: accounts.map((a) => a.id),
      concurrency,
      harvestAt: harvestAt || null,
      fireAt: fireAt || null,
      cardLast4: pan.slice(-4),
    },
    null,
    2,
  ),
);

process.env.BANDAI_HARVEST_TTL_MS =
  process.env.BANDAI_HARVEST_TTL_MS || String(15 * 60_000);

await waitUntilAest(harvestAt, "harvest-arm");
await clearHarvestSlots().catch(() => {});
const start = Number(process.env.BANDAI_POOL_START) || 21;
const mintProxies = proxies.slice(start, start + Math.max(accounts.length * 3, 6));
console.log(`[${aest()}] harvest mint x${accounts.length} (retry on transient)`);

const bridges = [];
for (let i = 0; i < accounts.length; i++) {
  const slice = mintProxies.slice(i * 2);
  const minted = await mintHarvestSlotWithRetries({
    proxies: slice.length ? slice : proxies,
    area: "au",
    maxAttempts: 3,
    ttlMs: Number(process.env.BANDAI_HARVEST_TTL_MS) || 15 * 60_000,
  });
  console.log(
    JSON.stringify({
      lane: accounts[i].id,
      ok: minted.ok,
      ms: minted.ms,
      id: minted.session?.id,
      retried: minted.retried,
      attempts: minted.attempts,
      error: minted.error ? String(minted.error).slice(0, 140) : null,
    }),
  );
  bridges.push(
    minted.ok
      ? { ...minted.session, harvestMintMs: minted.ms, proxy: minted.session.proxy }
      : { ok: false, error: minted.error, proxy: slice[0] || proxies[start % proxies.length] },
  );
}
console.log(`[${aest()}] harvest ready=${harvestSnapshot().ready}`);

await waitUntilAest(fireAt, "fire");
console.log(`[${aest()}] FIRE Fast checkout x${accounts.length}`);

async function runLane(i) {
  const acc = accounts[i];
  const b = bridges[i];
  const proxy = b?.proxy || proxies[(start + i) % proxies.length];
  const harvestedBridgeId = b?.id || undefined;
  const t0 = Date.now();
  const res = await runCheckout({
    taskId: `rehearsal-${acc.id}-${Date.now()}`,
    storeUrl: pdp,
    pdpUrl: pdp,
    qty: 1,
    proxy,
    dryRun: false,
    placeOrder: Boolean(pan) && process.env.BANDAI_STOP_AT_CART !== "1",
    forceUndici: true,
    bandaiMode: "checkout",
    bandaiCheckoutMode: "fast",
    bandaiGeHttpPay: true,
    bandaiGeRiskHydrate: true,
    bandaiFastAtc: true,
    bandaiStopAtCart: process.env.BANDAI_STOP_AT_CART === "1",
    areaItemNo: areaItemNo || undefined,
    bandaiAreaItemNo: areaItemNo || undefined,
    harvestedBridgeId,
    proxyPool: proxies,
    bandaiLoginProxyRotate: true,
    account: { email: acc.email, password: acc.password },
    card: pan ? card : undefined,
    profile: {
      first_name: process.env.BANDAI_SHIP_FIRST || "Alex",
      last_name: process.env.BANDAI_SHIP_LAST || "Buyer",
      address1: process.env.BANDAI_SHIP_ADDRESS1 || "133 Allenby Road",
      city: process.env.BANDAI_SHIP_CITY || "Alexandra Hills",
      province: process.env.BANDAI_SHIP_PROVINCE || "QLD",
      zip: process.env.BANDAI_SHIP_ZIP || "4160",
      phone: process.env.BANDAI_SHIP_PHONE || null,
      country: "AU",
    },
  });
  return summarize(acc.id, res, Date.now() - t0, {
    harvested: Boolean(harvestedBridgeId),
    harvestMintMs: b?.harvestMintMs,
    areaItemNo: areaItemNo || null,
  });
}

const results = [];
for (let i = 0; i < accounts.length; i += concurrency) {
  const wave = [];
  for (let j = i; j < Math.min(i + concurrency, accounts.length); j++) wave.push(runLane(j));
  const part = await Promise.all(wave);
  for (const row of part) {
    console.log(JSON.stringify(row));
    results.push(row);
  }
}

await clearHarvestSlots().catch(() => {});
const report = {
  at: new Date().toISOString(),
  aest: aest(),
  sku,
  areaItemNo: areaItemNo || null,
  concurrency,
  results,
};
fs.writeFileSync(outPath, JSON.stringify(report, null, 2));
console.log(`wrote ${outPath}`);
const okN = results.filter((r) => r.ok || r.paymentStatus === "declined_or_auth_failed").length;
process.exit(okN > 0 ? 0 : 1);
