/**
 * Fast Bandai credit-card checkout smoke (same desktop task/card as PayPal lab).
 * Confirms the proven card rail still reaches issuer / payment after PayPal work.
 *
 *   node executor/scripts/bandai-cc-fast-e2e.mjs
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

const WALL_MS = Math.max(60_000, Number(process.env.BANDAI_E2E_WALL_MS || 10 * 60_000));
const wallTimer = setTimeout(() => {
  console.error(`[cc-e2e] WALL_TIMEOUT after ${WALL_MS}ms — exiting`);
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

function rotateProxy(raw) {
  if (process.env.BANDAI_ROTATE_PROXY_SESSION !== "1") return String(raw || "");
  const sid = Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
  return String(raw || "").replace(/-session-[^-]+-/, `-session-${sid}-`);
}

function sessionTag(raw) {
  return (String(raw || "").match(/-session-([^-]+)/i) || [])[1] || "?";
}

function loadProxyFile(filePath) {
  try {
    return fs
      .readFileSync(filePath, "utf8")
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith("#"));
  } catch {
    return [];
  }
}

const db = JSON.parse(fs.readFileSync(path.join(desktopDir(), "db.json"), "utf8"));
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

const proxyFile =
  process.env.BANDAI_PROXY_FILE || path.join(artifactsDir, "noontide-fresh.proxies.txt");
const fromFile = loadProxyFile(proxyFile);
const group =
  (db.proxyGroups || []).find((g) => g.id === "px_noontide_resi_dual") ||
  (db.proxyGroups || []).find((g) => /noontide/i.test(String(g.name || ""))) ||
  (db.proxyGroups || [])[0];
const proxies = fromFile.length
  ? fromFile
  : (group?.proxies || group?.entries || [])
      .map((x) => (typeof x === "string" ? x : x?.url || x?.raw || ""))
      .filter(Boolean);
if (!proxies.length || !account?.email || !account?.password) {
  console.error("Missing proxies or Bandai account");
  process.exit(2);
}

const sku = process.env.BANDAI_SKU || String(task?.bandaiWatchSku || "N2847904001").toUpperCase();
const pickIdx =
  Number(process.env.BANDAI_PROXY_PICK) >= 0
    ? Number(process.env.BANDAI_PROXY_PICK) % proxies.length
    : Math.floor(Math.random() * proxies.length);
const proxy = rotateProxy(proxies[pickIdx]);
const proxyPool = [proxy, ...proxies.filter((_, i) => i !== pickIdx).map(rotateProxy)];
const aest = () => new Date().toLocaleString("en-AU", { timeZone: "Australia/Sydney" });
const outPath = path.join(artifactsDir, "bandai-cc-fast-e2e.json");

console.log(
  `[${aest()} AEST] CC_FAST_E2E start sku=${sku} card=…${pan.slice(-4)} email=${profile?.email} account=${account.email} pm=credit_card proxySrc=${fromFile.length ? "file" : "db"} pick=${pickIdx} sticky=${sessionTag(proxy)}`,
);

const t0 = Date.now();
const res = await runCheckout({
  taskId: `bandai-cc-fast-${Date.now()}`,
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
  paymentMethod: "credit_card",
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

const paySteps = (res.steps || []).filter((s) =>
  /login|addToCart|cart_hold|ge_|issuer|f5|payment|3ds/i.test(String(s.step || "")),
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
    reached3ds: res.reached3ds || null,
    threeDsUrl: res.threeDsUrl || null,
    transactionId: res.transactionId || null,
    orderNumber: res.orderNumber || null,
    chargeReqCount: res.chargeReqCount ?? null,
    failedStep: res.failedStep || null,
    note: String(res.note || "").slice(0, 500),
    steps: paySteps.map((s) => ({
      step: s.step,
      ok: s.ok,
      ms: s.ms,
      status: s.status,
      note: String(s.note || "").slice(0, 220),
    })),
  },
};
fs.writeFileSync(outPath, JSON.stringify(summary, null, 2));
console.log(`[${aest()} AEST] CC_FAST_E2E done`, JSON.stringify(summary.result, null, 2));
console.log(`summary → ${outPath}`);

clearTimeout(wallTimer);
const pass = Boolean(
  res.ok ||
    res.reached3ds ||
    res.transactionId ||
    res.orderNumber ||
    /issuer|bank|3ds|redirect|fraud|decline|reload|pay|authorized/i.test(
      `${res.paymentStatus || ""} ${res.note || ""}`,
    ) ||
    paySteps.some((s) => /ge_issuer|ge_credit_card|ge_get_cart|ge_payment/i.test(s.step) && s.ok),
);
process.exit(pass ? 0 : 1);
