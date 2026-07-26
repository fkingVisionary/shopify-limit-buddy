/**
 * Lab: Bandai monitor → checkout handoff (inject hit, optional live pay).
 *
 * Dry (default): proves monitor inject + payload switch + harvest claim shape.
 * Live: BANDAI_MONITOR_CHECKOUT_LIVE=1 + card/account/proxy (uses disposable card).
 *
 *   BANDAI_MONITOR_INJECT_HIT=1 node executor/scripts/bandai-monitor-checkout-lab.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

function loadEnv(p) {
  if (!fs.existsSync(p)) return;
  for (const line of fs.readFileSync(p, "utf8").split("\n")) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
}
loadEnv("/tmp/bandai-lab-creds.env");
loadEnv("/tmp/bandai-card.env");

const {
  shouldCheckoutOnMonitorHit,
  taskForMonitorCheckout,
} = require("../../desktop/bandai-monitor-checkout.cjs");

const live = /^(1|true|yes)$/i.test(String(process.env.BANDAI_MONITOR_CHECKOUT_LIVE || ""));
const sku = process.env.BANDAI_SKU || process.env.BANDAI_WATCH_SKU || "N2542159011";
const area = process.env.BANDAI_AREA || "au";

const task = {
  id: "lab-mon-1",
  store: "bandai",
  bandaiMode: "monitor",
  bandaiMonitorMode: "local",
  bandaiWatchSku: sku,
  bandaiCheckoutOnHit: true,
  bandaiArea: area,
  placeOrder: live,
  monitorInjectHit: true,
  monitorMaxPolls: 2,
};

console.log(
  JSON.stringify(
    {
      live,
      sku,
      checkoutOnHit: shouldCheckoutOnMonitorHit(task, task.placeOrder),
    },
    null,
    2,
  ),
);

const hit = {
  productId: sku,
  title: "lab-inject",
  inStock: true,
  reason: "inject",
  timestamp: Date.now(),
};
const switched = taskForMonitorCheckout(task, hit, area);
if (!switched.ok) {
  console.error(switched.error);
  process.exit(1);
}
console.log("switched", {
  mode: switched.task.bandaiMode,
  pdpUrl: switched.task.pdpUrl,
  productId: switched.target.productId,
});

// Prove hub inject path (global) without Electron.
const hubMod = await import(
  pathToFileURL(path.join(__dirname, "../monitor/global-monitor-hub.js")).href
);
const hits = [];
const hub = hubMod.createGlobalMonitorHub({
  attachBridge: false,
  monitorOpts: { intervalMs: 60_000, keywords: ["ONE PIECE"] },
  log: (l) => console.log("[hub]", l),
});
const sub = hub.subscribeTask(
  {
    taskId: "lab-global",
    bandaiMonitorMode: "global",
    productId: sku,
  },
  { onHit: (ev) => hits.push(ev) },
);
console.log("subscribe", sub);
hub._injectStockChanged(hit);
console.log("injected hits", hits.length, hits[0]?.productId);
hub.detach();

if (!live) {
  console.log("dry lab ok — set BANDAI_MONITOR_CHECKOUT_LIVE=1 for full Autocheckout");
  process.exit(hits.length === 1 && switched.ok ? 0 : 1);
}

// Live path: mint harvest + runCheckout via executor adapter (pass bridge id; adapter takes).
const { mintHarvestSlot, clearHarvestSlots } = await import("../adapters/bandai-harvest-pool.js");
const { runCheckout } = await import("../checkout.js");

function pickProxy() {
  const poolPath = process.env.BANDAI_PROXY_POOL || "/tmp/bandai-proxy-pool.txt";
  const pool = fs
    .readFileSync(poolPath, "utf8")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"));
  const i = Number(process.env.BANDAI_POOL_START) || 0;
  return pool[i % pool.length];
}

const proxy = pickProxy();
await clearHarvestSlots();
const minted = await mintHarvestSlot({ proxy, area });
console.log("harvest", { ok: minted.ok, ms: minted.ms, id: minted.session?.id, error: minted.error });
if (!minted.ok) process.exit(1);

const email = process.env.BANDAI_EMAIL;
const password = process.env.BANDAI_PASSWORD;
const pan = String(process.env.BANDAI_CARD_NUMBER || "").replace(/\s+/g, "");
const res = await runCheckout({
  taskId: `mon-co-${Date.now()}`,
  storeUrl: switched.target.pdpUrl,
  pdpUrl: switched.target.pdpUrl,
  qty: 1,
  proxy,
  dryRun: false,
  placeOrder: true,
  forceUndici: true,
  bandaiMode: "checkout",
  bandaiCheckoutMode: "fast",
  bandaiGeHttpPay: true,
  bandaiGeRiskHydrate: true,
  harvestedBridgeId: minted.session.id,
  account: { email, password },
  card: {
    number: pan,
    expMonth: String(process.env.BANDAI_CARD_EXP_MONTH || "").padStart(2, "0"),
    expYear: String(process.env.BANDAI_CARD_EXP_YEAR || "").slice(-2),
    cvv: process.env.BANDAI_CARD_CVV,
    holder: process.env.BANDAI_CARD_HOLDER || "Cardholder",
  },
});

for (const s of (res.steps || []).filter((x) =>
  /f5_bridge|login|addToCart|cart_hold|ge_issuer|cart_checkout/.test(x.step),
)) {
  console.log(`  ${s.step}: ok=${s.ok} ms=${s.ms} ${(s.note || "").slice(0, 120)}`);
}
console.log({
  ok: res.ok,
  paymentStatus: res.paymentStatus,
  checkoutStage: res.checkoutStage,
  failedStep: res.failedStep,
  note: res.note,
  f5: (res.steps || []).find((s) => s.step === "f5_bridge")?.note,
});
await clearHarvestSlots().catch(() => {});
process.exit(res.paymentStatus === "declined_or_auth_failed" || res.ok ? 0 : 1);