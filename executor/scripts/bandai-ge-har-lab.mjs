/**
 * Browser GE checkout with Playwright HAR capture.
 * Goal: diff real GEM Pay wire vs HTTP no-page issuer (dual Revolut forensics).
 *
 * Env:
 *   BANDAI_F5_HAR_PATH — HAR output (default /tmp/bandai-ge-browser.har)
 *   BANDAI_GE_ALLOW_ALL_ISSUERS=1 — do not suppress 2nd HandleCreditCard*
 *   BANDAI_POOL_START — proxy index into /tmp/bandai-proxy-pool.txt
 */
import fs from "node:fs";
import { runCheckout } from "../checkout.js";

function loadEnv(path) {
  if (!fs.existsSync(path)) return;
  for (const line of fs.readFileSync(path, "utf8").split("\n")) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
}
loadEnv("/tmp/bandai-lab-creds.env");
loadEnv("/tmp/bandai-card.env");

const harPath = process.env.BANDAI_F5_HAR_PATH || "/tmp/bandai-ge-browser.har";
process.env.BANDAI_F5_HAR_PATH = harPath;
process.env.BANDAI_GE_ALLOW_ALL_ISSUERS =
  process.env.BANDAI_GE_ALLOW_ALL_ISSUERS || "1";

const poolPath = process.env.BANDAI_PROXY_POOL || "/tmp/bandai-proxy-pool.txt";
const usedPath = "/tmp/bandai-proxy-used.json";
const pool = fs
  .readFileSync(poolPath, "utf8")
  .split("\n")
  .map((l) => l.trim())
  .filter((l) => l && !l.startsWith("#"));
const used = fs.existsSync(usedPath) ? JSON.parse(fs.readFileSync(usedPath, "utf8")) : {};
const startIdx = Number(process.env.BANDAI_POOL_START) || 0;

function sessionTag(raw) {
  const m = String(raw).match(/session-([^-]+)/);
  return m ? m[1] : raw.slice(-12);
}

let proxy = null;
let tag = null;
let idx = startIdx;
for (let i = 0; i < pool.length; i++) {
  const j = (startIdx + i) % pool.length;
  const t = sessionTag(pool[j]);
  if (!used[t]?.burn) {
    proxy = pool[j];
    tag = t;
    idx = j;
    break;
  }
}
if (!proxy) {
  console.error("no proxy");
  process.exit(1);
}

const email = process.env.BANDAI_EMAIL;
const password = process.env.BANDAI_PASSWORD;
const pan = String(process.env.BANDAI_CARD_NUMBER || "").replace(/\s+/g, "");
const mm = String(process.env.BANDAI_CARD_EXP_MONTH || "").padStart(2, "0");
const yy = String(process.env.BANDAI_CARD_EXP_YEAR || "").replace(/^20/, "").slice(-2);
const cvv = process.env.BANDAI_CARD_CVV || "";
const holder = process.env.BANDAI_CARD_HOLDER || "Cardholder";
const sku = process.env.BANDAI_SKU || "A2849039001";
const pdp = `https://p-bandai.com/au/item/${sku}`;

const aest = () => new Date().toLocaleString("en-AU", { timeZone: "Australia/Sydney" });
console.log(
  `[${aest()} AEST] HAR_LAB start proxy#${idx} session=${tag} har=${harPath} allowAllIssuers=${process.env.BANDAI_GE_ALLOW_ALL_ISSUERS} sku=${sku} card=…${pan.slice(-4)}`,
);

try {
  fs.unlinkSync(harPath);
} catch {
  /* ignore */
}

const t0 = Date.now();
const res = await runCheckout({
  taskId: `bandai-har-${tag}-${Date.now()}`,
  storeUrl: pdp,
  pdpUrl: pdp,
  qty: 1,
  proxy,
  dryRun: false,
  placeOrder: true,
  forceUndici: true,
  bandaiMode: "checkout",
  bandaiBrowserCheckout: true,
  wait3dsMs: Number(process.env.BANDAI_WAIT_3DS_MS) || 45_000,
  account: { email, password },
  card: { number: pan, expMonth: mm, expYear: yy, cvv, holder },
});

used[tag] = {
  har: true,
  pay: res.paymentStatus,
  tx: res.transactionId || null,
  at: new Date().toISOString(),
};
fs.writeFileSync(usedPath, JSON.stringify(used, null, 2));

console.log(
  `  result via=${res.via} pay=${res.paymentStatus} tx=${res.transactionId || "-"} posts=${res.chargeReqCount ?? "-"} blocked=${res.browserIssuerBlocked ?? res.blockedChargeReqCount ?? "-"} fail=${res.failedStep} wallMs=${Date.now() - t0}`,
);
console.log(`  note ${(res.note || "").slice(0, 220)}`);
for (const s of res.steps || []) {
  if (/ge_|pay|issuer|cart_checkout|login|f5_|bridge/i.test(s.step)) {
    console.log(`  ${s.step}: ok=${s.ok} ${(s.note || "").slice(0, 160)}`);
  }
}

if (!fs.existsSync(harPath)) {
  console.error("HAR missing — context may not have closed");
  process.exit(2);
}

// Summarize GE-relevant entries (no PAN dump).
const har = JSON.parse(fs.readFileSync(harPath, "utf8"));
const entries = har?.log?.entries || [];
const interesting = entries.filter((e) => {
  const u = e?.request?.url || "";
  return /global-e\.com|HandleCreditCard|CreditCardForm|checkoutv2|CCPayment|ProcessPayment|Authorize/i.test(
    u,
  );
});
const issuers = interesting.filter((e) =>
  /HandleCreditCard/i.test(e?.request?.url || ""),
);
const summary = {
  harPath,
  totalEntries: entries.length,
  geRelated: interesting.length,
  handleCreditCard: issuers.map((e) => ({
    started: e.startedDateTime,
    method: e.request?.method,
    url: e.request?.url,
    status: e.response?.status,
    bodySize: e.request?.bodySize,
    postKeys: String(e.request?.postData?.text || "")
      .split("&")
      .map((p) => p.split("=")[0])
      .filter(Boolean)
      .slice(0, 40),
    mode: (String(e.request?.url || "").match(/[?&]mode=([^&]+)/) || [])[1] || null,
  })),
  mutates: interesting
    .filter((e) => !["GET", "HEAD", "OPTIONS"].includes(e.request?.method))
    .map((e) => ({
      t: e.startedDateTime,
      method: e.request?.method,
      status: e.response?.status,
      url: String(e.request?.url || "").slice(0, 180),
    })),
};
fs.writeFileSync("/tmp/bandai-ge-har-summary.json", JSON.stringify(summary, null, 2));
console.log(
  `[${aest()} AEST] HAR_LAB done entries=${entries.length} geRelated=${interesting.length} issuers=${issuers.length}`,
);
console.log(JSON.stringify(summary.handleCreditCard, null, 2));
console.log("summary → /tmp/bandai-ge-har-summary.json");

if (/declined|auth|3ds|order/i.test(String(res.paymentStatus || ""))) {
  console.log(`[${aest()} AEST] HAR_LAB bank-ish pay=${res.paymentStatus} — check Revolut`);
}
