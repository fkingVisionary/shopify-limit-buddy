/**
 * Full HTTP Bandai checkout + GE Pay (no Playwright GE UI).
 * Flag: bandaiGeHttpPay. Stops before issuer if machineId/JWT missing
 * unless BANDAI_GE_FORCE_ISSUER=1.
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

function pickProxy() {
  const poolPath = process.env.BANDAI_PROXY_POOL || "/tmp/bandai-proxy-pool.txt";
  const usedPath = "/tmp/bandai-proxy-used.json";
  const used = fs.existsSync(usedPath) ? JSON.parse(fs.readFileSync(usedPath, "utf8")) : {};
  const pool = fs
    .readFileSync(poolPath, "utf8")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"));
  const start = Number(process.env.BANDAI_POOL_START) || 0;
  for (let i = 0; i < pool.length; i++) {
    const idx = (start + i) % pool.length;
    const proxy = pool[idx];
    const tag = (proxy.match(/session-([^-]+)/) || [])[1] || String(idx);
    if (used[tag]?.burn) continue;
    return { proxy, tag, idx };
  }
  throw new Error("no unused proxy in pool");
}

const email = process.env.BANDAI_EMAIL;
const password = process.env.BANDAI_PASSWORD;
const pan = String(process.env.BANDAI_CARD_NUMBER || "").replace(/\s+/g, "");
const mm = String(process.env.BANDAI_CARD_EXP_MONTH || "").padStart(2, "0");
const yy = String(process.env.BANDAI_CARD_EXP_YEAR || "").replace(/^20/, "").slice(-2);
const cvv = String(process.env.BANDAI_CARD_CVV || "");
const holder = process.env.BANDAI_CARD_HOLDER || "Cardholder";
const sku = process.env.BANDAI_SKU || "A2849039001";
const pdp = `https://p-bandai.com/au/item/${sku}`;
const { proxy, tag, idx } = pickProxy();

const aest = () => new Date().toLocaleString("en-AU", { timeZone: "Australia/Sydney" });
console.log(`[${aest()} AEST] HTTP_GE_LAB start session=${tag} proxy#${idx} sku=${sku}`);

const res = await runCheckout({
  taskId: `bandai-http-ge-${tag}-${Date.now()}`,
  storeUrl: pdp,
  pdpUrl: pdp,
  qty: 1,
  proxy,
  dryRun: false,
  placeOrder: true,
  forceUndici: true,
  bandaiMode: "checkout",
  bandaiGeHttpPay: true,
  bandaiGeStopBeforeIssuer: process.env.BANDAI_GE_STOP_BEFORE_ISSUER === "1",
  bandaiGeForceIssuer: process.env.BANDAI_GE_FORCE_ISSUER === "1",
  account: { email, password },
  card: { number: pan, expMonth: mm, expYear: yy, cvv, holder },
});

for (const s of res.steps || []) {
  console.log(`  ${s.step}: ok=${s.ok} status=${s.status} ms=${s.ms} ${(s.note || "").slice(0, 180)}`);
}
for (const e of res.timeline || []) {
  console.log(`  +${e.elapsedMs}ms ${e.event}`, JSON.stringify({ ...e, t: undefined, elapsedMs: undefined, event: undefined }).slice(0, 160));
}

const summary = {
  via: res.via,
  paymentStatus: res.paymentStatus,
  checkoutSn: res.checkoutSn,
  cartToken: res.cartToken,
  blockers: res.blockers,
  failedStep: res.failedStep,
  error: res.error,
  note: res.note,
  merchantCartToken: res.merchantCartToken,
  session: tag,
};
fs.writeFileSync("/tmp/bandai-ge-http-lab-result.json", JSON.stringify({ ...res, summary }, null, 2));
console.log("SUMMARY", JSON.stringify(summary, null, 2));
if (fs.existsSync("/tmp/bandai-ge-boot-capture.json")) {
  console.log("BOOT", fs.readFileSync("/tmp/bandai-ge-boot-capture.json", "utf8").slice(0, 800));
}
process.exit(res.ok || res.cartToken || res.checkoutSn ? 0 : 1);
