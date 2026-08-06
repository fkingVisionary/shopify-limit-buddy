/**
 * Fast HTTP PayPal probe (pm=4 / gw=6 from Checkout/v2 HAR).
 *   node executor/scripts/bandai-paypal-http-probe.mjs
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
  return (
    process.env.DESKTOP_DB_PATH ||
    path.join(
      process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"),
      "vanta-desktop",
      "j1ms-desktop",
      "db.json",
    )
  );
}

function rotateProxy(raw) {
  const sid = Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
  return String(raw || "").replace(/-session-[^-]+-/, `-session-${sid}-`);
}

const db = JSON.parse(fs.readFileSync(desktopDbPath(), "utf8"));
const task = (db.tasks || []).find((t) => t.id === "task_c13e31bb45ce") || (db.tasks || [])[0];
const profile = (db.profiles || []).find((p) => p.id === task?.profileId) || (db.profiles || [])[0];
const account = (db.accounts || []).find((a) => a.id === task?.accountId) || (db.accounts || [])[0];
const group =
  (db.proxyGroups || []).find((g) => g.id === task?.proxyGroupId) || (db.proxyGroups || [])[0];
const proxies = (group?.proxies || group?.entries || [])
  .map((x) => (typeof x === "string" ? x : x?.url || x?.raw || ""))
  .filter(Boolean);
const sku = process.env.BANDAI_SKU || String(task?.bandaiWatchSku || "N2847904001").toUpperCase();
const pan = String(profile?.card_number || "").replace(/\s+/g, "");
const proxy = rotateProxy(proxies[Math.floor(Math.random() * proxies.length)]);
const aest = () => new Date().toLocaleString("en-AU", { timeZone: "Australia/Sydney" });
const outPath = path.join(artifactsDir, "bandai-paypal-http-probe.json");

console.log(`[${aest()} AEST] PAYPAL_HTTP start sku=${sku} card=…${pan.slice(-4)} pm=4 gw=6`);

const t0 = Date.now();
const res = await runCheckout({
  taskId: `bandai-paypal-http-${Date.now()}`,
  storeUrl: `https://p-bandai.com/au/item/${sku}`,
  pdpUrl: `https://p-bandai.com/au/item/${sku}`,
  qty: 1,
  proxy,
  dryRun: false,
  placeOrder: true,
  forceUndici: true,
  bandaiMode: "checkout",
  bandaiCheckoutMode: "fast",
  bandaiFastAtc: true,
  paymentMethod: "paypal_guest",
  paymentMethodId: "4",
  gatewayId: "6",
  account: { email: account?.email || account?.username, password: account?.password },
  card: {
    number: pan,
    expMonth: profile?.card_exp_month,
    expYear: profile?.card_exp_year,
    cvv: profile?.card_cvv,
    holder: profile?.card_name || "Cardholder",
  },
});

const summary = {
  at: new Date().toISOString(),
  aest: aest(),
  wallMs: Date.now() - t0,
  sku,
  cardLast4: pan.slice(-4),
  wireFromHar: { paymentMethodId: "4", gatewayId: "6", mode: "fullredirect" },
  result: {
    ok: res.ok,
    via: res.via,
    paymentStatus: res.paymentStatus,
    paymentMethod: res.paymentMethod,
    paypalApproveUrl: res.paypalApproveUrl || null,
    failedStep: res.failedStep || null,
    note: String(res.note || "").slice(0, 400),
    steps: (res.steps || [])
      .filter((s) => /login|addToCart|cart|ge_|paypal|f5/i.test(String(s.step || "")))
      .map((s) => ({
        step: s.step,
        ok: s.ok,
        ms: s.ms,
        status: s.status,
        note: String(s.note || "").slice(0, 180),
      })),
  },
};
fs.writeFileSync(outPath, JSON.stringify(summary, null, 2));
console.log(`[${aest()} AEST] PAYPAL_HTTP done`, JSON.stringify(summary.result, null, 2));
console.log(`summary → ${outPath}`);
process.exit(res.paypalApproveUrl || /paypal/i.test(String(res.paymentStatus || "")) ? 0 : 1);
