// Single Bandai GE pay lab — score chargeReqCount / gem timing / bank.
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

const tWall0 = Date.now();
const aest = () => new Date().toLocaleString("en-AU", { timeZone: "Australia/Sydney" });
const log = (msg) => {
  const ms = String(Date.now() - tWall0).padStart(6, " ");
  console.log(`[+${ms}ms | ${aest()} AEST] ${msg}`);
};

const email = process.env.BANDAI_EMAIL;
const password = process.env.BANDAI_PASSWORD;
const proxy = rotate(process.env.BANDAI_PROXY || "");
const pan = String(process.env.BANDAI_CARD_NUMBER || "").replace(/\s+/g, "");
const mm = String(process.env.BANDAI_CARD_EXP_MONTH || "").padStart(2, "0");
const yy = String(process.env.BANDAI_CARD_EXP_YEAR || "").replace(/^20/, "").slice(-2);
const cvv = String(process.env.BANDAI_CARD_CVV || "");
const holder = process.env.BANDAI_CARD_HOLDER || "Cardholder";
const sku = process.env.BANDAI_SKU || "A2849039001";
const pdp = `https://p-bandai.com/au/item/${sku}`;

if (!email || !password || !proxy || !pan || !mm || !yy || !cvv) {
  console.error("missing BANDAI_EMAIL/PASSWORD/PROXY or BANDAI_CARD_*");
  process.exit(1);
}

log(`SINGLE_RUN_START — sku=${sku} expect 1 bank charge max`);

const res = await runCheckout({
  taskId: `bandai-guard-${Date.now()}`,
  storeUrl: pdp,
  pdpUrl: pdp,
  qty: 1,
  proxy,
  dryRun: false,
  placeOrder: true,
  forceUndici: true,
  bandaiMode: "checkout",
  bandaiBrowserCheckout: true,
  wait3dsMs: Number(process.env.BANDAI_WAIT_3DS_MS) || 25_000,
  account: { email, password },
  card: { number: pan, expMonth: mm, expYear: yy, cvv, holder },
});

const tl = res.timeline || [];
const ev = (name) => tl.find((e) => e.event === name);
const payAt = ev("pay_clicked")?.elapsedMs;
const gemVia = ev("ge_iframe_ready")?.via;
const gemAt = ev("ge_iframe_ready")?.elapsedMs;
const proceedAt = ev("proceed_click")?.elapsedMs;
const afterProceedAt = ev("after_proceed")?.elapsedMs;
const allowed = tl.filter((e) => e.event === "charge_req_allowed").length;
const blockedEv = tl.filter((e) => e.event === "charge_req_blocked").length;
const fulfilledLocal = tl.filter((e) => e.event === "charge_req_fulfilled_local").length;

log(
  `ATTEMPT_END — pay=${res.paymentStatus} clicks=${res.payClickCount} chargeReqs=${res.chargeReqCount} blocked=${res.blockedChargeReqCount} localFulfill=${fulfilledLocal} payAt=${payAt} gemAt=${gemAt} gemVia=${gemVia} proceed→gem=${gemAt != null && proceedAt != null ? gemAt - proceedAt : "?"} allowed=${allowed} blockedEv=${blockedEv}`,
);

for (const s of res.steps || []) {
  console.log(`  ${s.step}: ok=${s.ok} ms=${s.ms} ${(s.note || "").slice(0, 160)}`);
}
for (const e of tl) {
  if (
    /proceed|gem|ge_|charge|pay|frame|fill|auth|card_iframe|ge_post/.test(String(e.event || ""))
  ) {
    console.log(`  +${e.elapsedMs}ms ${e.event}`, JSON.stringify({ ...e, t: undefined, elapsedMs: undefined, event: undefined }));
  }
}

const out = {
  ...res,
  gemReady: {
    via: gemVia,
    at: gemAt,
    proceedAt,
    afterProceedAt,
    proceedToGemMs: gemAt != null && proceedAt != null ? gemAt - proceedAt : null,
  },
  payAt,
  totalElapsedMs: Date.now() - tWall0,
};
fs.writeFileSync("/tmp/bandai-single-charge-guard-result.json", JSON.stringify(out, null, 2));
console.log(
  "SUMMARY",
  JSON.stringify(
    {
      paymentStatus: res.paymentStatus,
      payClickCount: res.payClickCount,
      chargeReqCount: res.chargeReqCount,
      blockedChargeReqCount: res.blockedChargeReqCount,
      sawAuthWire: res.sawAuthWire,
      payAt,
      gemVia,
      proceedToGemMs: out.gemReady.proceedToGemMs,
      geNetTail: (res.geNetTail || []).filter((n) => n.kind === "req" && n.method !== "GET").slice(-8),
      note: res.note,
    },
    null,
    2,
  ),
);
process.exit(res.ok ? 0 : 1);
