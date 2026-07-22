/**
 * Cycle fresh sticky Noontide sessions for HTTP GE (bandaiGeHttpPay).
 * Goal: cart_checkout → GetCartToken → iovation mint → issuer POST.
 * Pool: /tmp/bandai-proxy-pool.txt  Used: /tmp/bandai-proxy-used.json
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

const poolPath = process.env.BANDAI_PROXY_POOL || "/tmp/bandai-proxy-pool.txt";
const usedPath = "/tmp/bandai-proxy-used.json";
const pool = fs
  .readFileSync(poolPath, "utf8")
  .split("\n")
  .map((l) => l.trim())
  .filter((l) => l && !l.startsWith("#"));
const maxTries = Math.min(pool.length, Number(process.env.BANDAI_POOL_TRIES) || 20);
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
const used = fs.existsSync(usedPath) ? JSON.parse(fs.readFileSync(usedPath, "utf8")) : {};

function sessionTag(raw) {
  const m = String(raw).match(/session-([^-]+)/);
  return m ? m[1] : raw.slice(-12);
}

function markUsed(tag, row) {
  used[tag] = { ...row, at: new Date().toISOString() };
  fs.writeFileSync(usedPath, JSON.stringify(used, null, 2));
}

console.log(
  `[${aest()} AEST] HTTP_GE_POOL start tries=${maxTries}/${pool.length} sku=${sku} stopBeforeIssuer=${process.env.BANDAI_GE_STOP_BEFORE_ISSUER === "1"}`,
);

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
  } catch (e) {
    console.log(`  CRASH ${e?.message || e}`);
    markUsed(tag, { burn: true, reason: "crash", error: String(e?.message || e).slice(0, 120) });
    continue;
  }

  const steps = (res.steps || []).map((s) => `${s.step}:${s.ok ? "ok" : "FAIL"}`).join(" ");
  const tl = res.timeline || [];
  console.log(
    `  result via=${res.via} pay=${res.paymentStatus} checkoutSn=${res.checkoutSn} cartToken=${res.cartToken} blockers=${(res.blockers || []).join(",") || "-"} fail=${res.failedStep} ms=${Date.now() - t0}`,
  );
  console.log(`  steps ${steps}`);
  for (const e of tl) {
    if (/ge_|iovation|issuer|gem_/.test(String(e.event || ""))) {
      console.log(
        `  +${e.elapsedMs}ms ${e.event}`,
        JSON.stringify({ ...e, t: undefined, elapsedMs: undefined, event: undefined }).slice(0, 200),
      );
    }
  }
  for (const s of res.steps || []) {
    if (/ge_|cart_checkout|login|f5_/.test(s.step)) {
      console.log(`  ${s.step}: ok=${s.ok} status=${s.status} ${(s.note || "").slice(0, 160)}`);
    }
  }

  const failStep = res.failedStep || "";
  const note = String(res.note || res.error || "");
  const burn =
    /ERR_CONNECTION_CLOSED|ERR_CERT|sensor mint failed|login 501|f5_bridge/.test(note) ||
    failStep === "f5_bridge" ||
    failStep === "login";

  markUsed(tag, {
    burn,
    paymentStatus: res.paymentStatus,
    failedStep: failStep,
    cartToken: res.cartToken || null,
    checkoutSn: res.checkoutSn || null,
    blockers: res.blockers || [],
    via: res.via,
  });

  const hit =
    Boolean(res.cartToken) ||
    res.paymentStatus === "pay_submitted_http" ||
    res.paymentStatus === "declined_or_auth_failed" ||
    res.paymentStatus === "http_ge_hydrated" ||
    res.sawAuthWire ||
    (res.steps || []).some((s) => s.step === "ge_iovation_mint" || s.step === "ge_issuer_http");

  const out = {
    proxyIdx: idx,
    session: tag,
    summary: {
      via: res.via,
      paymentStatus: res.paymentStatus,
      checkoutSn: res.checkoutSn,
      cartToken: res.cartToken,
      blockers: res.blockers,
      failedStep: res.failedStep,
      note: res.note,
      chargeReqCount: res.chargeReqCount,
      sawAuthWire: res.sawAuthWire,
      redirectUrl: res.redirectUrl,
    },
    steps: res.steps,
    timeline: res.timeline,
  };
  fs.writeFileSync("/tmp/bandai-ge-http-pool-result.json", JSON.stringify(out, null, 2));
  if (hit) {
    best = out;
    console.log(`\n[${aest()} AEST] HTTP_GE_HIT session=${tag} — check bank if issuer fired`);
    if (
      res.paymentStatus === "pay_submitted_http" ||
      res.paymentStatus === "declined_or_auth_failed" ||
      res.sawAuthWire
    ) {
      break;
    }
    if (process.env.BANDAI_STOP_ON_HYDRATE === "1") break;
  }
}

console.log(
  `\n[${aest()} AEST] HTTP_GE_POOL done — ${best ? `best=${best.session} pay=${best.summary.paymentStatus}` : "no GE hydrate"}`,
);
if (fs.existsSync("/tmp/bandai-ge-boot-capture.json")) {
  console.log("BOOT", fs.readFileSync("/tmp/bandai-ge-boot-capture.json", "utf8").slice(0, 600));
}
process.exit(best ? 0 : 1);
