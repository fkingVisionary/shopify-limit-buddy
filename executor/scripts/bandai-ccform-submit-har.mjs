/**
 * Last-mile Chromium HAR: hydrate via Safe/HTTP GE, then force CreditCardForm
 * submit so HandleCreditCard lands in the HAR even when the Pay button path flakes.
 *
 * Uses desktop DB creds (same as bandai-chrome-har-capture.mjs).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
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

function loadCreds() {
  const db = JSON.parse(fs.readFileSync(desktopDbPath(), "utf8"));
  const taskId = process.env.DESKTOP_E2E_TASK_ID || "task_c13e31bb45ce";
  const task = (db.tasks || []).find((t) => t.id === taskId) || (db.tasks || [])[0];
  const profile = (db.profiles || []).find((p) => p.id === task?.profileId) || (db.profiles || [])[0];
  const account =
    (db.accounts || []).find((a) => a.id === task?.accountId) || (db.accounts || [])[0];
  const group =
    (db.proxyGroups || []).find((g) => g.id === task?.proxyGroupId) || (db.proxyGroups || [])[0];
  const proxies = (group?.entries || group?.proxies || [])
    .map((x) => (typeof x === "string" ? x : x?.url || ""))
    .filter(Boolean);
  return {
    email: process.env.BANDAI_EMAIL || account?.email,
    password: process.env.BANDAI_PASSWORD || account?.password,
    card: {
      number: String(process.env.BANDAI_CARD_NUMBER || profile?.card_number || "").replace(/\s+/g, ""),
      expMonth: String(process.env.BANDAI_CARD_EXP_MONTH || profile?.card_exp_month || ""),
      expYear: String(process.env.BANDAI_CARD_EXP_YEAR || profile?.card_exp_year || ""),
      cvv: process.env.BANDAI_CARD_CVV || profile?.card_cvv || "",
      holder: process.env.BANDAI_CARD_HOLDER || profile?.card_name || "Cardholder",
    },
    proxy: process.env.BANDAI_PROXY || proxies[0] || null,
    sku:
      process.env.BANDAI_SKU ||
      task?.bandaiWatchSku ||
      (String(task?.pdpUrl || "").match(/\/item\/([A-Z0-9]+)/i) || [])[1] ||
      "N2847904001",
  };
}

function parseProxy(raw) {
  if (!raw) return undefined;
  try {
    const u = new URL(raw.includes("://") ? raw : `http://${raw}`);
    return {
      server: `${u.protocol}//${u.hostname}${u.port ? `:${u.port}` : ""}`,
      username: decodeURIComponent(u.username || "") || undefined,
      password: decodeURIComponent(u.password || "") || undefined,
    };
  } catch {
    return undefined;
  }
}

const creds = loadCreds();
const harPath = path.join(artifactsDir, "bandai-ccform-submit.har");
const pdp = `https://p-bandai.com/au/item/${creds.sku}`;
console.log(`CCFORM_SUBMIT_HAR start sku=${creds.sku} card=…${creds.card.number.slice(-4)}`);

// Phase 1: get a live GE checkout as far as CreditCardForm via Safe path (HAR on).
process.env.BANDAI_F5_HAR_PATH = harPath;
process.env.BANDAI_GE_ALLOW_ALL_ISSUERS = "1";
try {
  fs.unlinkSync(harPath);
} catch {
  /* ignore */
}

const res = await runCheckout({
  taskId: `bandai-cc-submit-${Date.now()}`,
  storeUrl: pdp,
  pdpUrl: pdp,
  qty: 1,
  proxy: creds.proxy || undefined,
  dryRun: false,
  placeOrder: true,
  forceUndici: true,
  bandaiMode: "checkout",
  bandaiCheckoutMode: "safe",
  bandaiBrowserCheckout: true,
  wait3dsMs: 20_000,
  account: { email: creds.email, password: creds.password },
  card: creds.card,
});

console.log(
  `phase1 pay=${res.paymentStatus} tx=${res.transactionId || "-"} fail=${res.failedStep || "-"}`,
);

// If Safe already produced HandleCreditCard, we're done.
let issuers = 0;
if (fs.existsSync(harPath)) {
  const har = JSON.parse(fs.readFileSync(harPath, "utf8"));
  issuers = (har.log?.entries || []).filter((e) =>
    /HandleCreditCard/i.test(e.request?.url || ""),
  ).length;
}
if (issuers > 0) {
  console.log(`already have ${issuers} HandleCreditCard in HAR — skip force submit`);
  process.exit(0);
}

// Phase 2: open CreditCardForm URL from phase1 HAR (or reconstructed) and force submit.
if (!fs.existsSync(harPath)) {
  console.error("phase1 HAR missing");
  process.exit(2);
}
const har1 = JSON.parse(fs.readFileSync(harPath, "utf8"));
const ccEntry = (har1.log?.entries || []).find((e) =>
  /CreditCardForm\/[0-9a-f-]+\/\d+/i.test(e.request?.url || ""),
);
if (!ccEntry) {
  console.error("No CreditCardForm URL in phase1 HAR");
  process.exit(3);
}
const ccUrl = ccEntry.request.url;
console.log(`phase2 force-submit ${ccUrl}`);

const har2 = path.join(artifactsDir, "bandai-ccform-force-submit.har");
try {
  fs.unlinkSync(har2);
} catch {
  /* ignore */
}

const pwProxy = parseProxy(creds.proxy);
const browser = await chromium.launch({
  headless: true,
  proxy: pwProxy,
  args: ["--disable-blink-features=AutomationControlled"],
});
const context = await browser.newContext({
  locale: "en-AU",
  viewport: { width: 1280, height: 800 },
  userAgent:
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  recordHar: { path: har2, mode: "full", content: "embed" },
  serviceWorkers: "block",
});

// Seed cookies from phase1 HAR where possible.
const cookieHeader = (ccEntry.request.headers || []).find((h) => /cookie/i.test(h.name))?.value;
if (cookieHeader) {
  const cookies = cookieHeader.split(";").map((p) => {
    const [name, ...rest] = p.trim().split("=");
    return {
      name,
      value: rest.join("="),
      domain: ".global-e.com",
      path: "/",
    };
  });
  await context.addCookies(cookies).catch(() => {});
}

const page = await context.newPage();
await page.goto(ccUrl, { waitUntil: "domcontentloaded", timeout: 60_000 });
const pan = creds.card.number;
const spaced = pan.length === 16 ? pan.replace(/(.{4})/g, "$1 ").trim() : pan;
const mm = String(creds.card.expMonth || "").replace(/^0/, "");
let yy = String(creds.card.expYear || "");
if (yy.length === 4) yy = yy.slice(-2);

await page.evaluate(
  ({ spaced, mm, yy, cvv }) => {
    const set = (name, val) => {
      const el = document.querySelector(`[name="${name}"]`);
      if (!el) return;
      el.value = val;
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
    };
    set("PaymentData.cardNum", spaced);
    set("PaymentData.cvdNumber", cvv);
    // expiry may be selects
    for (const sel of document.querySelectorAll("select")) {
      const n = sel.name || "";
      if (/ExpiryMonth|cardExpiryMonth|month/i.test(n)) sel.value = mm;
      if (/ExpiryYear|cardExpiryYear|year/i.test(n)) {
        const opts = [...sel.options].map((o) => o.value);
        sel.value = opts.includes(yy) ? yy : opts.includes(`20${yy}`) ? `20${yy}` : yy;
      }
    }
    set("PaymentData.cardExpiryMonth", mm);
    set("PaymentData.cardExpiryYear", yy.length === 2 ? `20${yy}` : yy);
    // Fill client screen fields the way GEM JS usually does on submit.
    set("PaymentData.customerScreenColorDepth", String(window.screen.colorDepth || 24));
    set("PaymentData.customerScreenWidth", String(window.screen.width || 1280));
    set("PaymentData.customerScreenHeight", String(window.screen.height || 800));
    set("PaymentData.customerTimeZoneOffset", String(new Date().getTimezoneOffset()));
    set("PaymentData.customerLanguage", navigator.language || "en-AU");
    const form = document.querySelector("form");
    if (form?.requestSubmit) form.requestSubmit();
    else form?.submit();
  },
  { spaced, mm, yy, cvv: creds.card.cvv },
);

await page.waitForTimeout(12_000);
await context.close();
await browser.close();

const har = JSON.parse(fs.readFileSync(har2, "utf8"));
const issuerEntries = (har.log?.entries || []).filter((e) =>
  /HandleCreditCard/i.test(e.request?.url || ""),
);
const summary = {
  ccUrl,
  issuers: issuerEntries.length,
  posts: issuerEntries.map((e) => ({
    method: e.request.method,
    status: e.response.status,
    url: e.request.url,
    bodyBytes: e.request.bodySize,
    keys: String(e.request.postData?.text || "")
      .split("&")
      .map((p) => p.split("=")[0])
      .filter(Boolean),
  })),
};
fs.writeFileSync(
  path.join(artifactsDir, "bandai-ccform-force-submit-summary.json"),
  JSON.stringify(summary, null, 2),
);
console.log(JSON.stringify(summary, null, 2));
process.exit(issuerEntries.length ? 0 : 4);
