/**
 * Capture Bandai AU Global-E → PayPal guest HAR (lab).
 *
 * Uses desktop DB account + disposable profile card last4 for identity only
 * (PayPal path does not fill PAN). Writes HAR + redacted summary.
 *
 *   node executor/scripts/bandai-paypal-har-capture.mjs
 *
 * Env:
 *   BANDAI_SKU / DESKTOP_E2E_TASK_ID / BANDAI_PROXY / BANDAI_BROWSER_HAR_PATH
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

function loadFromDesktopDb() {
  const dbPath = desktopDbPath();
  const db = JSON.parse(fs.readFileSync(dbPath, "utf8"));
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
  const pan = String(profile?.card_number || profile?.card?.number || "").replace(/\s+/g, "");
  return {
    email: account?.email || account?.username,
    password: account?.password,
    card: {
      number: pan,
      expMonth: profile?.card_exp_month || profile?.card?.expMonth || "",
      expYear: profile?.card_exp_year || profile?.card?.expYear || "",
      cvv: profile?.card_cvv || profile?.card?.cvv || "",
      holder: profile?.card_name || profile?.card?.holder || "Cardholder",
    },
    proxy: process.env.BANDAI_PROXY || proxies[0] || null,
    sku:
      process.env.BANDAI_SKU ||
      String(task?.bandaiWatchSku || "")
        .trim()
        .toUpperCase() ||
      "N2847904001",
  };
}

function rotateProxy(raw) {
  const sid = Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
  return String(raw || "").replace(/-session-[^-]+-/, `-session-${sid}-`);
}

const fromDb = loadFromDesktopDb();
const harPath =
  process.env.BANDAI_BROWSER_HAR_PATH ||
  path.join(artifactsDir, "bandai-paypal-guest.har");
const summaryPath = path.join(artifactsDir, "bandai-paypal-har-summary.json");
const sku = fromDb.sku;
const pan = String(fromDb.card.number || "").replace(/\s+/g, "");
const proxy = rotateProxy(fromDb.proxy);
const aest = () => new Date().toLocaleString("en-AU", { timeZone: "Australia/Sydney" });

if (!fromDb.email || !fromDb.password) {
  console.error("Missing Bandai account in desktop DB");
  process.exit(1);
}
if (pan.slice(-4) !== "3562" && process.env.BANDAI_ALLOW_ANY_CARD !== "1") {
  console.error(`Expected disposable last4 3562, got …${pan.slice(-4) || "none"}`);
  process.exit(1);
}

try {
  fs.unlinkSync(harPath);
} catch {
  /* ignore */
}

console.log(
  `[${aest()} AEST] PAYPAL_HAR start sku=${sku} card=…${pan.slice(-4)} proxy=${proxy ? "yes" : "no"} har=${harPath}`,
);

const t0 = Date.now();
const res = await runCheckout({
  taskId: `bandai-paypal-har-${Date.now()}`,
  storeUrl: `https://p-bandai.com/au/item/${sku}`,
  pdpUrl: `https://p-bandai.com/au/item/${sku}`,
  qty: 1,
  proxy: proxy || undefined,
  dryRun: false,
  placeOrder: true,
  forceUndici: true,
  bandaiMode: "checkout",
  bandaiCheckoutMode: "full",
  bandaiBrowserFull: true,
  paymentMethod: "paypal_guest",
  wait3dsMs: Number(process.env.BANDAI_WAIT_3DS_MS) || 40_000,
  recordHarPath: harPath,
  account: { email: fromDb.email, password: fromDb.password },
  // Identity only — PayPal path must not PAN-submit.
  card: fromDb.card,
});

function summarizeHar(file) {
  if (!fs.existsSync(file)) return null;
  const har = JSON.parse(fs.readFileSync(file, "utf8"));
  const entries = har?.log?.entries || [];
  const pick = (re) =>
    entries.filter((e) => re.test(e?.request?.url || "")).map((e) => ({
      t: e.startedDateTime,
      method: e.request?.method,
      status: e.response?.status,
      url: String(e.request?.url || "").slice(0, 220),
      bodyBytes: e.request?.bodySize ?? null,
    }));
  const formPosts = entries.filter((e) => {
    const u = e?.request?.url || "";
    const m = e?.request?.method || "";
    return (
      /global-e\.com/i.test(u) &&
      /POST|PUT/i.test(m) &&
      /SelectedPaymentMethod|PaymentMethod|paypal|handleaction|save/i.test(
        `${u} ${e.request?.postData?.text || ""}`,
      )
    );
  });
  const pmIds = [];
  for (const e of formPosts) {
    const body = String(e.request?.postData?.text || "");
    for (const m of body.matchAll(/SelectedPaymentMethodID=([^&]*)/gi)) {
      pmIds.push(decodeURIComponent(m[1] || ""));
    }
    for (const m of body.matchAll(/paymentMethodId=([^&]*)/gi)) {
      pmIds.push(decodeURIComponent(m[1] || ""));
    }
  }
  return {
    harPath: file,
    totalEntries: entries.length,
    paypal: pick(/paypal\.com/i).slice(0, 40),
    gePaypalish: pick(/global-e\.com.*paypal|paypal.*global-e|PayPal/i).slice(0, 40),
    geMutating: pick(/global-e\.com/i)
      .filter((e) => /POST|PUT|PATCH|DELETE/i.test(e.method))
      .slice(0, 60),
    selectedPaymentMethodIds: [...new Set(pmIds)].slice(0, 20),
    handleCreditCard: pick(/HandleCreditCard/i).length,
  };
}

const summary = {
  at: new Date().toISOString(),
  aest: aest(),
  sku,
  cardLast4: pan.slice(-4),
  wallMs: Date.now() - t0,
  result: {
    ok: res.ok,
    via: res.via,
    paymentStatus: res.paymentStatus,
    paymentMethod: res.paymentMethod || null,
    paypalApproveUrl: res.paypalApproveUrl || null,
    failedStep: res.failedStep || null,
    note: String(res.note || "").slice(0, 400),
    steps: (res.steps || [])
      .filter((s) =>
        /login|addToCart|cart|checkout|ge_|paypal|f5/i.test(String(s.step || "")),
      )
      .map((s) => ({
        step: s.step,
        ok: s.ok,
        ms: s.ms,
        note: String(s.note || "").slice(0, 160),
      })),
  },
  har: summarizeHar(harPath),
};

fs.writeFileSync(summaryPath, JSON.stringify(summary, null, 2));
console.log(`[${aest()} AEST] PAYPAL_HAR done status=${res.paymentStatus} approve=${Boolean(res.paypalApproveUrl)}`);
console.log(`summary → ${summaryPath}`);
console.log(
  JSON.stringify(
    {
      paypalEntries: summary.har?.paypal?.length ?? 0,
      pmIds: summary.har?.selectedPaymentMethodIds || [],
      handleCreditCard: summary.har?.handleCreditCard ?? null,
      approve: res.paypalApproveUrl ? String(res.paypalApproveUrl).slice(0, 120) : null,
    },
    null,
    2,
  ),
);
process.exit(summary.har ? 0 : 2);
