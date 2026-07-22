// Lab: Bandai browser GE placeOrder — expect issuer 3DS (do not log PAN).
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

function rotate(raw) {
  const sid = Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
  return String(raw).replace(/-session-[^-]+-/, `-session-${sid}-`);
}

const email = process.env.BANDAI_EMAIL;
const password = process.env.BANDAI_PASSWORD;
const proxy = rotate(process.env.BANDAI_PROXY || "");
const pan = String(process.env.BANDAI_CARD_NUMBER || "").replace(/\s+/g, "");
const mm = String(process.env.BANDAI_CARD_EXP_MONTH || "").padStart(2, "0");
const yy = String(process.env.BANDAI_CARD_EXP_YEAR || "").replace(/^20/, "").slice(-2);
const cvv = String(process.env.BANDAI_CARD_CVV || "");
const holder = String(process.env.BANDAI_CARD_HOLDER || "Cardholder");

if (!email || !password || !proxy || !pan || !mm || !yy || !cvv) {
  console.error("missing BANDAI_EMAIL/PASSWORD/PROXY or BANDAI_CARD_*");
  process.exit(1);
}

console.log(
  JSON.stringify({
    panLast4: pan.slice(-4),
    exp: `${mm}/${yy}`,
    holder,
    email,
    sku: "A2880191001",
  }),
);

const task = {
  taskId: `bandai-charge-${Date.now()}`,
  storeUrl: "https://p-bandai.com/au/item/A2880191001",
  pdpUrl: "https://p-bandai.com/au/item/A2880191001",
  qty: 1,
  proxy,
  dryRun: false,
  placeOrder: true,
  forceUndici: true,
  bandaiMode: "checkout",
  bandaiBrowserCheckout: true,
  wait3dsMs: 180_000,
  account: { email, password },
  card: { number: pan, expMonth: mm, expYear: yy, cvv, holder },
};

const res = await runCheckout(task);
const summary = {
  ok: res.ok,
  via: res.via,
  checkoutStage: res.checkoutStage,
  paymentStatus: res.paymentStatus,
  reached3ds: res.reached3ds,
  threeDsUrl: res.threeDsUrl,
  orderNumber: res.orderNumber,
  checkoutSn: res.checkoutSn,
  cartSn: res.cartSn,
  failedStep: res.failedStep,
  error: res.error,
  note: res.note,
  steps: (res.steps || []).map((s) => ({
    step: s.step,
    ok: s.ok,
    status: s.status,
    note: s.note,
    ms: s.ms,
  })),
};
fs.writeFileSync("/tmp/bandai-charge-lab-result.json", JSON.stringify(summary, null, 2));
console.log(JSON.stringify(summary, null, 2));
process.exit(res.reached3ds || res.orderNumber || res.ok ? 0 : 1);
