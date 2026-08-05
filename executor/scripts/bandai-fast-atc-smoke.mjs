/**
 * Post-trim Fast smoke: wall→ATC timings + one Fast placeOrder (card decline lab).
 *
 *   node executor/scripts/bandai-fast-atc-smoke.mjs
 *
 * ATC runs: BANDAI_ATC_SMOKE_N (default 3)
 * Place-order: BANDAI_FAST_PLACE_ORDER=0 to skip
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runCheckout } from "../checkout.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "../..");
const artifactsDir = path.join(root, "artifacts");
fs.mkdirSync(artifactsDir, { recursive: true });

function desktopDbPath() {
  if (process.env.DESKTOP_DB_PATH) return process.env.DESKTOP_DB_PATH;
  return path.join(
    process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"),
    "vanta-desktop",
    "j1ms-desktop",
    "db.json",
  );
}

function loadLab() {
  const db = JSON.parse(fs.readFileSync(desktopDbPath(), "utf8"));
  const taskId = process.env.DESKTOP_E2E_TASK_ID || "task_c13e31bb45ce";
  const task = (db.tasks || []).find((t) => t.id === taskId) || (db.tasks || [])[0];
  const profile =
    (db.profiles || []).find((p) => p.id === task?.profileId) || (db.profiles || [])[0];
  const account =
    (db.accounts || []).find((a) => a.id === task?.accountId) || (db.accounts || [])[0];
  const group =
    (db.proxyGroups || []).find((g) => g.id === task?.proxyGroupId) ||
    (db.proxyGroups || [])[0];
  const proxies = Array.isArray(group?.proxies)
    ? group.proxies.map((x) => (typeof x === "string" ? x : x?.url || x?.raw || "")).filter(Boolean)
    : Array.isArray(group?.entries)
      ? group.entries.map((x) => (typeof x === "string" ? x : x?.url || x?.raw || "")).filter(Boolean)
      : [];
  const pan = String(profile?.card_number || "").replace(/\s+/g, "");
  return {
    email: account?.email || account?.username,
    password: account?.password,
    card: {
      number: pan,
      expMonth: profile?.card_exp_month || "",
      expYear: profile?.card_exp_year || "",
      cvv: profile?.card_cvv || "",
      holder: profile?.card_name || "Cardholder",
    },
    proxies,
    sku: process.env.BANDAI_SKU || String(task?.bandaiWatchSku || "N2847904001").toUpperCase(),
  };
}

function rotateProxy(raw) {
  const sid = Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
  return String(raw).replace(/-session-[^-]+-/, `-session-${sid}-`);
}

function pickProxy(lab, i) {
  const base = lab.proxies[i % lab.proxies.length];
  return rotateProxy(base);
}

function stepMs(steps, name) {
  const s = (steps || []).find((x) => x.step === name);
  return s?.ms ?? null;
}

function atcWallFrom(res) {
  if (res.atcWallMs != null) return Number(res.atcWallMs);
  const hold = (res.steps || []).find((s) => s.step === "cart_hold");
  const m = String(hold?.note || "").match(/wall→ATC\s+(\d+)ms/);
  return m ? Number(m[1]) : hold?.ms ?? null;
}

const lab = loadLab();
const aest = () => new Date().toLocaleString("en-AU", { timeZone: "Australia/Sydney" });
const n = Math.max(1, Math.min(8, Number(process.env.BANDAI_ATC_SMOKE_N) || 3));
const doPay = process.env.BANDAI_FAST_PLACE_ORDER !== "0";
const outPath = path.join(artifactsDir, "bandai-fast-atc-smoke.json");

if (!lab.email || !lab.password || !lab.proxies.length) {
  console.error("Missing account/proxy in desktop DB");
  process.exit(1);
}

console.log(
  `[${aest()} AEST] FAST_SMOKE atcN=${n} placeOrder=${doPay} sku=${lab.sku} card=…${String(lab.card.number).slice(-4)}`,
);

const atcRuns = [];
for (let i = 0; i < n; i++) {
  const proxy = pickProxy(lab, i);
  const t0 = Date.now();
  const res = await runCheckout({
    taskId: `fast-atc-${i}-${Date.now()}`,
    storeUrl: `https://p-bandai.com/au/item/${lab.sku}`,
    pdpUrl: `https://p-bandai.com/au/item/${lab.sku}`,
    qty: 1,
    proxy,
    dryRun: false,
    placeOrder: false,
    forceUndici: true,
    bandaiMode: "checkout",
    bandaiCheckoutMode: "fast",
    bandaiFastAtc: true,
    bandaiStopAtCart: true,
    account: { email: lab.email, password: lab.password },
  });
  const row = {
    i,
    ok: Boolean(res.ok || (res.steps || []).some((s) => s.step === "cart_hold" && s.ok)),
    atcWallMs: atcWallFrom(res),
    wallMs: Date.now() - t0,
    failedStep: res.failedStep || null,
    loginMs: stepMs(res.steps, "login"),
    atcMs: stepMs(res.steps, "addToCart"),
    note: String(res.note || "").slice(0, 180),
  };
  atcRuns.push(row);
  console.log(
    `[${aest()} AEST] ATC#${i} ok=${row.ok} wall→ATC=${row.atcWallMs}ms total=${row.wallMs}ms fail=${row.failedStep || "-"}`,
  );
}

let payRun = null;
if (doPay) {
  const proxy = pickProxy(lab, n);
  const t0 = Date.now();
  const res = await runCheckout({
    taskId: `fast-pay-${Date.now()}`,
    storeUrl: `https://p-bandai.com/au/item/${lab.sku}`,
    pdpUrl: `https://p-bandai.com/au/item/${lab.sku}`,
    qty: 1,
    proxy,
    dryRun: false,
    placeOrder: true,
    forceUndici: true,
    bandaiMode: "checkout",
    bandaiCheckoutMode: "fast",
    bandaiFastAtc: true,
    account: { email: lab.email, password: lab.password },
    card: lab.card,
  });
  payRun = {
    ok: Boolean(res.ok || res.reached3ds || res.transactionId || res.paymentStatus),
    wallMs: Date.now() - t0,
    atcWallMs: atcWallFrom(res),
    via: res.via || null,
    paymentStatus: res.paymentStatus || null,
    transactionId: res.transactionId || null,
    chargeReqCount: res.chargeReqCount ?? null,
    failedStep: res.failedStep || null,
    note: String(res.note || "").slice(0, 300),
    steps: (res.steps || [])
      .filter((s) =>
        /login|addToCart|cart_hold|ge_|issuer|f5/i.test(String(s.step || "")),
      )
      .map((s) => ({
        step: s.step,
        ok: s.ok,
        ms: s.ms,
        note: String(s.note || "").slice(0, 140),
      })),
  };
  console.log(
    `[${aest()} AEST] FAST_PAY ok=${payRun.ok} via=${payRun.via} pay=${payRun.paymentStatus} tx=${payRun.transactionId || "-"} posts=${payRun.chargeReqCount} wall→ATC=${payRun.atcWallMs}ms total=${payRun.wallMs}ms`,
  );
}

const atcOk = atcRuns.filter((r) => r.ok);
const walls = atcOk.map((r) => r.atcWallMs).filter((n) => Number.isFinite(n));
const summary = {
  at: new Date().toISOString(),
  aest: aest(),
  sku: lab.sku,
  cardLast4: String(lab.card.number).slice(-4),
  productStance:
    "Bandai decline dual treated as rail behaviour — Fast scored for ATC speed + checkout function only",
  atc: {
    n,
    ok: atcOk.length,
    wallMs: walls,
    min: walls.length ? Math.min(...walls) : null,
    max: walls.length ? Math.max(...walls) : null,
    median: walls.length
      ? [...walls].sort((a, b) => a - b)[Math.floor(walls.length / 2)]
      : null,
    runs: atcRuns,
  },
  fastPlaceOrder: payRun,
};

fs.writeFileSync(outPath, JSON.stringify(summary, null, 2));
console.log(`summary → ${outPath}`);
const atcPass = atcOk.length >= Math.ceil(n / 2);
const payPass =
  !doPay ||
  Boolean(
    payRun &&
      (payRun.transactionId ||
        /issuer|bank|3ds|redirect|fraud|decline|reload|pay/i.test(
          `${payRun.paymentStatus} ${payRun.note}`,
        ) ||
        payRun.steps?.some((s) => /ge_issuer|ge_credit|ge_get_cart/i.test(s.step) && s.ok)),
  );
process.exit(atcPass && payPass ? 0 : 1);
