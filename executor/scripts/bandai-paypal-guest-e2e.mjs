/**
 * Full Bandai Fast → PayPal guest e2e (billing profile card …3562).
 * Expectation: PayPal auth may show on Revolut for a successful guest Pay Now.
 *
 *   node executor/scripts/bandai-paypal-guest-e2e.mjs
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

// Hard wall so SoftBlock rotate / Playwright cannot hang the agent indefinitely.
const WALL_MS = Math.max(60_000, Number(process.env.BANDAI_E2E_WALL_MS || 8 * 60_000));
const wallTimer = setTimeout(() => {
  console.error(`[e2e] WALL_TIMEOUT after ${WALL_MS}ms — exiting`);
  process.exit(124);
}, WALL_MS);
wallTimer.unref?.();

function desktopDir() {
  return path.join(
    process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"),
    "vanta-desktop",
    "j1ms-desktop",
  );
}

function desktopDbPath() {
  return process.env.DESKTOP_DB_PATH || path.join(desktopDir(), "db.json");
}

/** Pull CapSolver (and friends) from desktop settings when env is bare. */
function loadDesktopSecrets() {
  try {
    const s = JSON.parse(fs.readFileSync(path.join(desktopDir(), "settings.json"), "utf8"));
    if (!process.env.CAPSOLVER_API_KEY && s.capsolverApiKey) {
      process.env.CAPSOLVER_API_KEY = String(s.capsolverApiKey);
    }
    if (!process.env.HYPER_API_KEY && s.hyperApiKey) {
      process.env.HYPER_API_KEY = String(s.hyperApiKey);
    }
  } catch {
    /* optional */
  }
}
loadDesktopSecrets();

/** Only remint sticky session when BANDAI_ROTATE_PROXY_SESSION=1 (fresh lists already have unique sessions). */
function rotateProxy(raw) {
  if (process.env.BANDAI_ROTATE_PROXY_SESSION !== "1") return String(raw || "");
  const sid = Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
  return String(raw || "").replace(/-session-[^-]+-/, `-session-${sid}-`);
}

function sessionTag(raw) {
  return (String(raw || "").match(/-session-([^-]+)/i) || [])[1] || "?";
}

const db = JSON.parse(fs.readFileSync(desktopDbPath(), "utf8"));
const task =
  (db.tasks || []).find((t) => t.id === (process.env.DESKTOP_E2E_TASK_ID || "task_c13e31bb45ce")) ||
  (db.tasks || [])[0];
const profile =
  (db.profiles || []).find((p) => p.id === task?.profileId) || (db.profiles || [])[0];
const pan = String(profile?.card_number || "").replace(/\s+/g, "");
if (pan.slice(-4) !== "3562" && process.env.BANDAI_ALLOW_ANY_CARD !== "1") {
  console.error(`Expected disposable last4 3562, got …${pan.slice(-4) || "none"}`);
  process.exit(2);
}

const account =
  (db.accounts || []).find((a) => a.id === task?.accountId) ||
  (db.accounts || []).find(
    (a) =>
      String(a.store || a.storeId || "").toLowerCase() === "bandai" &&
      String(a.email || "").toLowerCase() === String(profile?.email || "").toLowerCase(),
  ) ||
  (db.accounts || []).find(
    (a) => String(a.email || "").toLowerCase() === String(profile?.email || "").toLowerCase(),
  ) ||
  (db.accounts || [])[0];

function entriesOf(g) {
  return (g?.proxies || g?.entries || [])
    .map((x) => (typeof x === "string" ? x : x?.url || x?.raw || ""))
    .filter(Boolean);
}
// Royal is dead — Noontide sticky AU only (override via BANDAI_PROXY_GROUP).
const preferGroupId =
  process.env.BANDAI_PROXY_GROUP ||
  "px_noontide_resi_dual";
const group =
  (db.proxyGroups || []).find((g) => g.id === preferGroupId) ||
  (db.proxyGroups || []).find((g) => /noontide/i.test(String(g.name || ""))) ||
  (db.proxyGroups || []).find((g) => g.id === task?.proxyGroupId) ||
  (db.proxyGroups || [])[0];
const proxies = entriesOf(group);
// Use provided sticky sessions as-is. SoftBlock rotate picks another pool entry.
const proxyPool = [...proxies];
if (!proxies.length) {
  console.error("No proxies on task proxy group");
  process.exit(2);
}
if (!account?.email || !account?.password) {
  console.error("Bandai vault account missing for billing profile email");
  process.exit(2);
}

const sku = process.env.BANDAI_SKU || String(task?.bandaiWatchSku || "N2847904001").toUpperCase();
// Round-robin via env attempt index so loops don't burn one sticky.
const pickIdx =
  Number(process.env.BANDAI_PROXY_PICK) >= 0
    ? Number(process.env.BANDAI_PROXY_PICK) % proxies.length
    : Math.floor(Math.random() * proxies.length);
const proxy = rotateProxy(proxies[pickIdx]);
const aest = () => new Date().toLocaleString("en-AU", { timeZone: "Australia/Sydney" });
const outPath = path.join(artifactsDir, "bandai-paypal-guest-e2e.json");

console.log(
  `[${aest()} AEST] PAYPAL_GUEST_E2E start sku=${sku} card=…${pan.slice(-4)} email=${profile?.email} account=${account.email} pm=paypal_guest proxyGroup=${group?.name || group?.id} pool=${proxyPool.length} sticky=${sessionTag(proxy)}`,
);

const t0 = Date.now();
const res = await runCheckout({
  taskId: `bandai-paypal-guest-${Date.now()}`,
  storeUrl: `https://p-bandai.com/au/item/${sku}`,
  pdpUrl: `https://p-bandai.com/au/item/${sku}`,
  qty: 1,
  proxy,
  proxyPool,
  dryRun: false,
  placeOrder: true,
  forceUndici: true,
  bandaiMode: "checkout",
  bandaiCheckoutMode: "fast",
  bandaiFastAtc: true,
  bandaiLoginProxyRotate: true,
  paymentMethod: "paypal_guest",
  paymentMethodId: "4",
  gatewayId: "6",
  // Headed PayPal guest form (opt into headless via env).
  paypalHeadless: process.env.PAYPAL_APPROVE_HEADLESS === "1",
  account: { email: account.email, password: account.password, id: account.id },
  profile: {
    email: profile.email,
    first_name: profile.first_name,
    last_name: profile.last_name,
    address1: profile.address1,
    city: profile.city,
    province: profile.province,
    zip: profile.zip,
    phone: profile.phone,
    card_name: profile.card_name,
  },
  card: {
    number: pan,
    expMonth: profile?.card_exp_month,
    expYear: profile?.card_exp_year,
    cvv: profile?.card_cvv,
    holder:
      profile?.card_name ||
      [profile?.first_name, profile?.last_name].filter(Boolean).join(" ") ||
      "Cardholder",
  },
});

const ppSteps = (res.steps || []).filter((s) =>
  /paypal|ge_paypal|ge_payment|ge_save|ge_token|addToCart|login|f5/i.test(String(s.step || "")),
);

const summary = {
  at: new Date().toISOString(),
  aest: aest(),
  wallMs: Date.now() - t0,
  sku,
  cardLast4: pan.slice(-4),
  billingEmail: profile?.email || null,
  result: {
    ok: res.ok,
    via: res.via,
    paymentStatus: res.paymentStatus,
    paymentMethod: res.paymentMethod,
    paypalApproveUrl: res.paypalApproveUrl || null,
    orderNumber: res.orderNumber || null,
    finalUrl: res.finalUrl || null,
    failedStep: res.failedStep || null,
    paypalGuest: res.paypalGuest || null,
    note: String(res.note || "").slice(0, 500),
    steps: ppSteps.map((s) => ({
      step: s.step,
      ok: s.ok,
      ms: s.ms,
      status: s.status,
      note: String(s.note || "").slice(0, 220),
    })),
  },
};
fs.writeFileSync(outPath, JSON.stringify(summary, null, 2));
console.log(`[${aest()} AEST] PAYPAL_GUEST_E2E done`, JSON.stringify(summary.result, null, 2));
console.log(`summary → ${outPath}`);
console.log(
  "Bank/Revolut PayPal auth is ground truth. Bot only reports paypal_approved on merchant return / success page.",
);

clearTimeout(wallTimer);
const approved = String(res.paymentStatus || "") === "paypal_approved";
const minted = Boolean(res.paypalApproveUrl);
process.exit(approved ? 0 : minted ? 3 : 1);
