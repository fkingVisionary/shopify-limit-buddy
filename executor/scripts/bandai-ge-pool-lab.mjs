// Cycle fresh Noontide sessions until Pay wire or N tries.
// Pool file: /tmp/bandai-proxy-pool.txt (host:port:user:pass per line).
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

const poolPath = process.env.BANDAI_PROXY_POOL || "/tmp/bandai-proxy-pool.txt";
const pool = fs
  .readFileSync(poolPath, "utf8")
  .split("\n")
  .map((l) => l.trim())
  .filter((l) => l && !l.startsWith("#"));
const maxTries = Math.min(pool.length, Number(process.env.BANDAI_POOL_TRIES) || 12);
const startIdx = Number(process.env.BANDAI_POOL_START) || 0;

const email = process.env.BANDAI_EMAIL;
const password = process.env.BANDAI_PASSWORD;
const pan = String(process.env.BANDAI_CARD_NUMBER || "").replace(/\s+/g, "");
const mm = String(process.env.BANDAI_CARD_EXP_MONTH || "").padStart(2, "0");
const yy = String(process.env.BANDAI_CARD_EXP_YEAR || "").replace(/^20/, "").slice(-2);
const cvv = String(process.env.BANDAI_CARD_CVV || "");
const holder = process.env.BANDAI_CARD_HOLDER || "Cardholder";
const sku = process.env.BANDAI_SKU || "A2849039001";
const pdp = `https://p-bandai.com/au/item/${sku}`;

if (!email || !password || !pan || !pool.length) {
  console.error("need BANDAI_EMAIL/PASSWORD/CARD + proxy pool");
  process.exit(1);
}

const aest = () => new Date().toLocaleString("en-AU", { timeZone: "Australia/Sydney" });
const usedPath = "/tmp/bandai-proxy-used.json";
const used = fs.existsSync(usedPath) ? JSON.parse(fs.readFileSync(usedPath, "utf8")) : {};

function sessionTag(raw) {
  const m = String(raw).match(/session-([^-]+)/);
  return m ? m[1] : raw.slice(-12);
}

console.log(`[${aest()} AEST] POOL_LAB start tries=${maxTries}/${pool.length} sku=${sku}`);

let best = null;
for (let i = 0; i < maxTries; i++) {
  const idx = (startIdx + i) % pool.length;
  const proxy = pool[idx];
  const tag = sessionTag(proxy);
  if (used[tag]?.burn) {
    console.log(`\n--- skip burned ${tag} ---`);
    continue;
  }
  const t0 = Date.now();
  console.log(`\n=== TRY ${i + 1}/${maxTries} proxy#${idx} session=${tag} @ ${aest()} AEST ===`);

  let res;
  try {
    res = await runCheckout({
      taskId: `bandai-pool-${tag}-${Date.now()}`,
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
  } catch (e) {
    console.log(`  CRASH ${e?.message || e}`);
    used[tag] = { burn: true, reason: "crash", at: new Date().toISOString() };
    fs.writeFileSync(usedPath, JSON.stringify(used, null, 2));
    continue;
  }

  const steps = (res.steps || []).map((s) => `${s.step}:${s.ok ? "ok" : "FAIL"}`).join(" ");
  const tl = res.timeline || [];
  const postPay = tl.filter((e) => e.event === "post_pay_req" || (e.event === "ge_post" && e.armed));
  const payAt = tl.find((e) => e.event === "pay_clicked")?.elapsedMs;
  const gemAt = tl.find((e) => e.event === "ge_iframe_ready")?.elapsedMs;

  console.log(
    `  result pay=${res.paymentStatus} clicks=${res.payClickCount} sawAuth=${res.sawAuthWire} postPayN=${postPay.length} payAt=${payAt} gemAt=${gemAt} ms=${Date.now() - t0}`,
  );
  console.log(`  steps ${steps}`);
  for (const e of tl) {
    if (/ge_post|post_pay|pay_clicked|charge_guard|ge_iframe|card_filled/.test(e.event || "")) {
      console.log(`  +${e.elapsedMs}ms ${e.event}`, JSON.stringify({ ...e, t: undefined, elapsedMs: undefined, event: undefined }).slice(0, 180));
    }
  }

  const failStep = res.failedStep || "";
  const note = String(res.note || res.error || "");
  const burn =
    /ERR_CONNECTION_CLOSED|ERR_CERT|sensor mint failed|login 501|f5_bridge/.test(note) ||
    failStep === "f5_bridge" ||
    failStep === "login";

  used[tag] = {
    burn,
    paymentStatus: res.paymentStatus,
    failedStep: failStep,
    postPayN: postPay.length,
    at: new Date().toISOString(),
  };
  fs.writeFileSync(usedPath, JSON.stringify(used, null, 2));

  const out = {
    proxyIdx: idx,
    session: tag,
    ...res,
    postPay: postPay.slice(0, 20),
    totalElapsedMs: Date.now() - t0,
  };
  fs.writeFileSync("/tmp/bandai-pool-lab-result.json", JSON.stringify(out, null, 2));
  best = out;

  // Success criteria: Pay clicked AND at least one armed post-Pay GE/payment POST
  if (res.payClickCount >= 1 && (res.sawAuthWire || postPay.length > 0)) {
    console.log(`\n[${aest()} AEST] WIRE_HIT session=${tag} — check Revolut now`);
    process.exit(0);
  }
  // Soft progress: reached GEM + filled — keep going but don't burn
  if (res.paymentStatus === "pay_clicked_no_payment_request") {
    console.log(`  note: Pay clicked but no post-Pay payment POST (UI no-op)`);
  }
}

console.log(`\n[${aest()} AEST] POOL_LAB done — no issuer wire. last=${best?.paymentStatus || best?.failedStep}`);
process.exit(best?.payClickCount ? 2 : 1);
