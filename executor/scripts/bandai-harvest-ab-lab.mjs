/**
 * A/B: Bandai Fast checkout cold vs F5-harvested (same disposable card).
 *
 * Off-path harvest time is reported separately — critical path is checkout wall.
 *
 *   BANDAI_CARD_* + BANDAI_EMAIL/PASSWORD + proxy pool required.
 *   Does not log full PAN.
 */
import fs from "node:fs";
import { runCheckout } from "../checkout.js";
import {
  mintHarvestSlot,
  takeHarvestSlot,
  clearHarvestSlots,
  harvestSnapshot,
} from "../adapters/bandai-harvest-pool.js";

function loadEnv(path) {
  if (!fs.existsSync(path)) return;
  for (const line of fs.readFileSync(path, "utf8").split("\n")) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
}
loadEnv("/tmp/bandai-lab-creds.env");
loadEnv("/tmp/bandai-card.env");

function pickProxy(offset = 0) {
  const live = fs.existsSync("/tmp/bandai-proxy-live.txt")
    ? fs.readFileSync("/tmp/bandai-proxy-live.txt", "utf8").trim()
    : "";
  if (live && offset === 0) {
    return {
      proxy: live,
      tag: (live.match(/session-([^-]+)/) || [])[1] || "live",
    };
  }
  const poolPath =
    process.env.BANDAI_PROXY_POOL ||
    (fs.existsSync("/tmp/bandai-proxy-pool.txt")
      ? "/tmp/bandai-proxy-pool.txt"
      : "resi.proxies");
  const pool = fs
    .readFileSync(poolPath, "utf8")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"));
  if (!pool.length) throw new Error("empty proxy pool");
  const start = (Number(process.env.BANDAI_POOL_START) || 0) + offset;
  const proxy = pool[start % pool.length];
  const tag = (proxy.match(/session-([^-]+)/) || [])[1] || `i${start % pool.length}`;
  return { proxy, tag };
}

function summarize(label, res, wallMs, extra = {}) {
  const steps = res.steps || [];
  const pick = (name) => steps.find((s) => s.step === name);
  const f5 = pick("f5_bridge");
  const login = pick("login");
  const atc = pick("addToCart");
  const hold = pick("cart_hold") || pick("cart_detail");
  const ge = steps.filter((s) => /ge_|risk|iovation|issuer|handleaction|creditcard/i.test(s.step));
  const geMs = ge.reduce((a, s) => a + (Number(s.ms) || 0), 0);
  return {
    label,
    ok: Boolean(res.ok),
    wallMs,
    checkoutStage: res.checkoutStage || null,
    paymentStatus: res.paymentStatus || null,
    failedStep: res.failedStep || null,
    error: res.error ? String(res.error).slice(0, 160) : null,
    note: res.note ? String(res.note).slice(0, 160) : null,
    atcWallMs: res.atcWallMs ?? null,
    f5_bridge_ms: f5?.ms ?? null,
    f5_note: f5?.note ? String(f5.note).slice(0, 140) : null,
    login_ms: login?.ms ?? null,
    addToCart_ms: atc?.ms ?? null,
    cart_ms: hold?.ms ?? null,
    ge_steps_ms_sum: geMs || null,
    harvested: Boolean(extra.harvested),
    harvestMintMs: extra.harvestMintMs ?? null,
    steps: steps.map((s) => ({
      step: s.step,
      ok: s.ok,
      ms: s.ms,
      note: String(s.note || "").slice(0, 120),
    })),
  };
}

async function runOne({ label, proxy, tag, harvestedBridgeId, harvestMintMs }) {
  const email = process.env.BANDAI_EMAIL;
  const password = process.env.BANDAI_PASSWORD;
  const pan = String(process.env.BANDAI_CARD_NUMBER || "").replace(/\s+/g, "");
  const mm = String(process.env.BANDAI_CARD_EXP_MONTH || "").padStart(2, "0");
  const yy = String(process.env.BANDAI_CARD_EXP_YEAR || "").replace(/^20/, "").slice(-2);
  const cvv = String(process.env.BANDAI_CARD_CVV || "");
  const holder = process.env.BANDAI_CARD_HOLDER || "Cardholder";
  const sku = process.env.BANDAI_SKU || "N2542159011";
  const pdp = `https://p-bandai.com/au/item/${sku}`;

  if (!email || !password || pan.length < 12 || !cvv) {
    throw new Error("missing BANDAI_EMAIL/PASSWORD or BANDAI_CARD_*");
  }

  const t0 = Date.now();
  const res = await runCheckout({
    taskId: `bandai-hv-ab-${label}-${tag}-${Date.now()}`,
    storeUrl: pdp,
    pdpUrl: pdp,
    qty: 1,
    proxy,
    dryRun: false,
    placeOrder: true,
    forceUndici: true,
    bandaiMode: "checkout",
    bandaiCheckoutMode: "fast",
    bandaiGeHttpPay: true,
    bandaiGeNoPage: false,
    bandaiGeRiskHydrate: true,
    bandaiFastAtc: true,
    harvestedBridgeId: harvestedBridgeId || undefined,
    account: { email, password },
    card: { number: pan, expMonth: mm, expYear: yy, cvv, holder },
  });
  return summarize(label, res, Date.now() - t0, {
    harvested: Boolean(harvestedBridgeId),
    harvestMintMs,
  });
}

const aest = () => new Date().toLocaleString("en-AU", { timeZone: "Australia/Sydney" });
const only = String(process.env.BANDAI_AB_ONLY || "").toLowerCase(); // cold|harvest|both
const outPath =
  process.env.BANDAI_AB_OUT ||
  `/tmp/bandai-harvest-ab-${Date.now()}.json`;

const panLast4 = String(process.env.BANDAI_CARD_NUMBER || "").replace(/\s+/g, "").slice(-4);
console.log(
  `[${aest()} AEST] harvest A/B start last4=${panLast4} sku=${process.env.BANDAI_SKU || "N2542159011"} only=${only || "both"}`,
);

const results = [];

try {
  if (only !== "harvest") {
    const coldPx = pickProxy(0);
    console.log(`\n=== COLD checkout session=${coldPx.tag} ===`);
    const cold = await runOne({ label: "cold", proxy: coldPx.proxy, tag: coldPx.tag });
    results.push(cold);
    console.log(
      JSON.stringify(
        {
          label: cold.label,
          wallMs: cold.wallMs,
          f5_bridge_ms: cold.f5_bridge_ms,
          atcWallMs: cold.atcWallMs,
          paymentStatus: cold.paymentStatus,
          checkoutStage: cold.checkoutStage,
          failedStep: cold.failedStep,
          f5_note: cold.f5_note,
        },
        null,
        2,
      ),
    );
  }

  if (only !== "cold") {
    await clearHarvestSlots();
    const hvPx = pickProxy(only === "harvest" ? 0 : 1);
    console.log(`\n=== HARVEST mint session=${hvPx.tag} ===`);
    const mintT0 = Date.now();
    const minted = await mintHarvestSlot({ proxy: hvPx.proxy, area: "au" });
    const harvestMintMs = Date.now() - mintT0;
    console.log(
      JSON.stringify(
        {
          ok: minted.ok,
          ms: minted.ms || harvestMintMs,
          error: minted.error || null,
          id: minted.session?.id,
          snapshot: harvestSnapshot(),
        },
        null,
        2,
      ),
    );
    if (!minted.ok) {
      results.push({ label: "harvest_mint_failed", error: minted.error, harvestMintMs });
    } else {
      // Claim id stays in pool until checkout takeHarvestSlot — pass id through.
      console.log(`\n=== HARVESTED checkout session=${hvPx.tag} id=${minted.session.id} ===`);
      const hot = await runOne({
        label: "harvested",
        proxy: hvPx.proxy,
        tag: hvPx.tag,
        harvestedBridgeId: minted.session.id,
        harvestMintMs: minted.ms || harvestMintMs,
      });
      results.push(hot);
      console.log(
        JSON.stringify(
          {
            label: hot.label,
            wallMs: hot.wallMs,
            f5_bridge_ms: hot.f5_bridge_ms,
            harvestMintMs: hot.harvestMintMs,
            atcWallMs: hot.atcWallMs,
            paymentStatus: hot.paymentStatus,
            checkoutStage: hot.checkoutStage,
            failedStep: hot.failedStep,
            f5_note: hot.f5_note,
          },
          null,
          2,
        ),
      );
    }
  }
} finally {
  await clearHarvestSlots().catch(() => {});
}

const cold = results.find((r) => r.label === "cold");
const hot = results.find((r) => r.label === "harvested");
const comparison =
  cold && hot
    ? {
        wallSavedMs: cold.wallMs - hot.wallMs,
        f5SavedMs: (cold.f5_bridge_ms || 0) - (hot.f5_bridge_ms || 0),
        atcWallSavedMs:
          cold.atcWallMs != null && hot.atcWallMs != null
            ? cold.atcWallMs - hot.atcWallMs
            : null,
        harvestOffPathMs: hot.harvestMintMs,
        note: "Harvest mint is off critical path when armed ahead of drop",
      }
    : null;

const report = {
  at: new Date().toISOString(),
  aest: aest(),
  panLast4,
  sku: process.env.BANDAI_SKU || "N2542159011",
  comparison,
  results,
};
fs.writeFileSync(outPath, JSON.stringify(report, null, 2));
console.log(`\n=== COMPARISON ===`);
console.log(JSON.stringify(comparison || { results: results.map((r) => r.label) }, null, 2));
console.log(`wrote ${outPath}`);
