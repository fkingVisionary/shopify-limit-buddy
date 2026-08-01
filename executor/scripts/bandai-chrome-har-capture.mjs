/**
 * Record a real Chromium (Playwright) Bandai/GE checkout HAR for dual-charge diffs.
 *
 * This is the browser baseline (single Revolut auth when you checkout by hand).
 * Compare issuer POSTs with Autocheckout Fast / autocheckout_test via:
 *   node executor/scripts/bandai-issuer-har-diff.mjs --har <path>
 *
 * Credentials (first match wins):
 *   BANDAI_EMAIL / BANDAI_PASSWORD / BANDAI_CARD_* env
 *   or desktop DB (%APPDATA%/vanta-desktop/j1ms-desktop/db.json)
 *
 * Env:
 *   BANDAI_SKU              default N2847904001
 *   BANDAI_F5_HAR_PATH      HAR out (default artifacts/bandai-chrome-browser.har)
 *   BANDAI_PROXY            optional single proxy URL
 *   DESKTOP_E2E_TASK_ID     which task to pull profile/proxy/account from
 *   BANDAI_GE_ALLOW_ALL_ISSUERS=1  let browser fire all issuer rails (default)
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

function loadEnvFile(p) {
  if (!fs.existsSync(p)) return;
  for (const line of fs.readFileSync(p, "utf8").split("\n")) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}

loadEnvFile("/tmp/bandai-lab-creds.env");
loadEnvFile("/tmp/bandai-card.env");
loadEnvFile(path.join(os.tmpdir(), "bandai-lab-creds.env"));
loadEnvFile(path.join(os.tmpdir(), "bandai-card.env"));

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
  if (!fs.existsSync(dbPath)) return null;
  const db = JSON.parse(fs.readFileSync(dbPath, "utf8"));
  const taskId = process.env.DESKTOP_E2E_TASK_ID || "task_c13e31bb45ce";
  const task = (db.tasks || []).find((t) => t.id === taskId) || (db.tasks || [])[0];
  const profile = (db.profiles || []).find((p) => p.id === task?.profileId) || (db.profiles || [])[0];
  const account =
    (db.accounts || []).find((a) => a.id === task?.accountId) || (db.accounts || [])[0];
  const group = (db.proxyGroups || []).find((g) => g.id === task?.proxyGroupId) || (db.proxyGroups || [])[0];
  const proxies = Array.isArray(group?.proxies)
    ? group.proxies.map((x) => (typeof x === "string" ? x : x?.url || x?.raw || "")).filter(Boolean)
    : Array.isArray(group?.entries)
      ? group.entries.map((x) => (typeof x === "string" ? x : x?.url || x?.raw || "")).filter(Boolean)
      : [];
  const card = profile?.card || profile?.payment || {};
  return {
    dbPath,
    taskId: task?.id || null,
    email: account?.email || account?.username || null,
    password: account?.password || null,
    card: {
      number: card.number || card.pan || profile?.card_number || "",
      expMonth:
        card.expMonth || card.expiryMonth || card.mm || profile?.card_exp_month || "",
      expYear: card.expYear || card.expiryYear || card.yy || profile?.card_exp_year || "",
      cvv: card.cvv || card.cvc || profile?.card_cvv || "",
      holder:
        card.holder ||
        card.name ||
        profile?.card_name ||
        [profile?.first_name, profile?.last_name].filter(Boolean).join(" ") ||
        "Cardholder",
    },
    proxy: proxies[0] || null,
    proxies,
    sku:
      String(task?.bandaiWatchSku || "")
        .trim()
        .toUpperCase() ||
      (String(task?.pdpUrl || "").match(/\/item\/([A-Z0-9]+)/i) || [])[1] ||
      null,
  };
}

const fromDb = loadFromDesktopDb();
const email = process.env.BANDAI_EMAIL || fromDb?.email;
const password = process.env.BANDAI_PASSWORD || fromDb?.password;
const pan = String(process.env.BANDAI_CARD_NUMBER || fromDb?.card?.number || "").replace(/\s+/g, "");
const mm = String(process.env.BANDAI_CARD_EXP_MONTH || fromDb?.card?.expMonth || "").padStart(2, "0");
const yy = String(process.env.BANDAI_CARD_EXP_YEAR || fromDb?.card?.expYear || "")
  .replace(/^20/, "")
  .slice(-2);
const cvv = process.env.BANDAI_CARD_CVV || fromDb?.card?.cvv || "";
const holder = process.env.BANDAI_CARD_HOLDER || fromDb?.card?.holder || "Cardholder";
const sku = process.env.BANDAI_SKU || fromDb?.sku || "N2847904001";
const proxy = process.env.BANDAI_PROXY || fromDb?.proxy || null;

const harPath =
  process.env.BANDAI_F5_HAR_PATH || path.join(artifactsDir, "bandai-chrome-browser.har");
const summaryPath = path.join(artifactsDir, "bandai-chrome-har-summary.json");
process.env.BANDAI_F5_HAR_PATH = harPath;
process.env.BANDAI_GE_ALLOW_ALL_ISSUERS = process.env.BANDAI_GE_ALLOW_ALL_ISSUERS || "1";

if (!email || !password || pan.length < 12) {
  console.error("Missing Bandai account/card (env or desktop DB). Aborting HAR capture.");
  process.exit(1);
}

const pdp = `https://p-bandai.com/au/item/${sku}`;
const aest = () => new Date().toLocaleString("en-AU", { timeZone: "Australia/Sydney" });
console.log(
  `[${aest()} AEST] CHROME_HAR start sku=${sku} card=…${pan.slice(-4)} proxy=${proxy ? "yes" : "direct"} har=${harPath}`,
);

try {
  fs.unlinkSync(harPath);
} catch {
  /* ignore */
}

const t0 = Date.now();
const res = await runCheckout({
  taskId: `bandai-chrome-har-${Date.now()}`,
  storeUrl: pdp,
  pdpUrl: pdp,
  qty: 1,
  proxy: proxy || undefined,
  dryRun: false,
  placeOrder: true,
  forceUndici: true,
  bandaiMode: "checkout",
  // Safe = Playwright GE Pay — real Chromium rails (single-charge baseline).
  bandaiCheckoutMode: "safe",
  bandaiBrowserCheckout: true,
  wait3dsMs: Number(process.env.BANDAI_WAIT_3DS_MS) || 45_000,
  account: { email, password },
  card: { number: pan, expMonth: mm, expYear: yy, cvv, holder },
});

function summarizeHar(file) {
  if (!fs.existsSync(file)) return null;
  const har = JSON.parse(fs.readFileSync(file, "utf8"));
  const entries = har?.log?.entries || [];
  const interesting = entries.filter((e) => {
    const u = e?.request?.url || "";
    return /global-e\.com|HandleCreditCard|CreditCardForm|checkoutv2|CCPayment|ProcessPayment|Authorize/i.test(
      u,
    );
  });
  const issuers = interesting.filter((e) => /HandleCreditCard/i.test(e?.request?.url || ""));
  const redactBodyKeys = (text) =>
    String(text || "")
      .split("&")
      .map((p) => {
        const k = decodeURIComponent(p.split("=")[0] || "");
        if (!k) return null;
        if (/cardNum|cvdNumber|cvv|pan/i.test(k)) return `${k}=<redacted>`;
        const v = decodeURIComponent(p.slice(p.indexOf("=") + 1) || "");
        if (/machineId|recapcha|token|CustomFields/i.test(k)) {
          return `${k}=<len:${v.length}>`;
        }
        return `${k}=${v.slice(0, 80)}`;
      })
      .filter(Boolean);
  return {
    harPath: file,
    totalEntries: entries.length,
    geRelated: interesting.length,
    handleCreditCardCount: issuers.length,
    handleCreditCard: issuers.map((e) => ({
      started: e.startedDateTime,
      method: e.request?.method,
      url: e.request?.url,
      status: e.response?.status,
      bodySize: e.request?.bodySize,
      headers: (e.request?.headers || [])
        .filter((h) =>
          /content-type|origin|referer|cookie|sec-fetch|user-agent|accept/i.test(h.name),
        )
        .map((h) => ({
          name: h.name,
          value: /cookie/i.test(h.name)
            ? `<cookies:${String(h.value || "").split(";").length}>`
            : String(h.value || "").slice(0, 160),
        })),
      postFields: redactBodyKeys(e.request?.postData?.text),
      mode: (String(e.request?.url || "").match(/[?&]mode=([^&]+)/) || [])[1] || null,
    })),
    mutatingGe: interesting
      .filter((e) => !["GET", "HEAD", "OPTIONS"].includes(e.request?.method))
      .map((e) => ({
        t: e.startedDateTime,
        method: e.request?.method,
        status: e.response?.status,
        url: String(e.request?.url || "").slice(0, 200),
      })),
  };
}

const summary = {
  at: new Date().toISOString(),
  aest: aest(),
  sku,
  cardLast4: pan.slice(-4),
  proxyUsed: Boolean(proxy),
  result: {
    via: res.via,
    paymentStatus: res.paymentStatus,
    transactionId: res.transactionId || null,
    chargeReqCount: res.chargeReqCount ?? null,
    browserIssuerBlocked: res.browserIssuerBlocked ?? res.blockedChargeReqCount ?? null,
    failedStep: res.failedStep || null,
    note: String(res.note || "").slice(0, 300),
    wallMs: Date.now() - t0,
  },
  har: summarizeHar(harPath),
};

fs.writeFileSync(summaryPath, JSON.stringify(summary, null, 2));
console.log(
  `[${aest()} AEST] CHROME_HAR done pay=${res.paymentStatus} tx=${res.transactionId || "-"} issuers=${summary.har?.handleCreditCardCount ?? "missing"}`,
);
console.log(`summary → ${summaryPath}`);
if (!summary.har) {
  console.error("HAR missing — context may not have closed");
  process.exit(2);
}
console.log(JSON.stringify(summary.har.handleCreditCard, null, 2));
if ((summary.har.handleCreditCardCount || 0) > 1) {
  console.log("NOTE: browser HAR saw >1 HandleCreditCard — dual-rail exists even in Chromium.");
} else if (summary.har.handleCreditCardCount === 1) {
  console.log("Browser baseline: exactly 1 HandleCreditCard POST (matches manual Safari/Chrome).");
} else {
  console.log(
    "No issuer in Safe-path HAR. Force-submit fallback: node executor/scripts/bandai-ccform-submit-har.mjs",
  );
}
