#!/usr/bin/env node
/**
 * Pokémon Centre AU — cold (NO harvest) checkout lab.
 * Proves restock / random-drop path can clear edge → auth → ATC without a bank.
 *
 * Env: HYPER_API_KEY, PROXY_FILE|PROXY, TRANSPORT=tls-worker, PC_SKU, OUT=
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createJar, makeDispatcher, makeRemoteTlsDispatcher } from "../http.js";
import { hyperConfigured } from "../antibot.js";
import pokemoncentreAdapter from "../adapters/pokemoncentre.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");
const OUT =
  process.env.OUT || `/opt/cursor/artifacts/pc-cold-checkout-${Date.now()}.json`;
const TRANSPORT = String(process.env.TRANSPORT || "tls-worker").toLowerCase();
const SKU = process.env.PC_SKU || "10-10320-101";
const PDP =
  process.env.PC_PDP ||
  `https://www.pokemoncenter.com/en-au/product/${SKU}/pokemon-tcg-mewtwo-and-mew-dna-premium-zip-binder`;

function loadProxies() {
  if (process.env.PROXY) return [process.env.PROXY.trim()];
  const file = process.env.PROXY_FILE || path.join(ROOT, "resi.proxies");
  return fs
    .readFileSync(file, "utf8")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"));
}

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

async function runCold(proxyRaw, proxyPool) {
  let dispatcher;
  try {
    dispatcher =
      TRANSPORT === "tls-worker"
        ? await makeRemoteTlsDispatcher(proxyRaw)
        : makeDispatcher(proxyRaw, { forceUndici: true });
  } catch {
    dispatcher = makeDispatcher(proxyRaw, { forceUndici: true });
  }
  const host = String(proxyRaw).split(":")[0];
  const ctx = {
    jar: createJar(),
    dispatcher,
    steps: [],
    proxyRaw,
    onProgress: () => {},
    egressIp: /^\d+\.\d+\.\d+\.\d+$/.test(host) ? host : null,
  };
  const t0 = Date.now();
  let result;
  try {
    result = await pokemoncentreAdapter.run(
      {
        storeUrl: PDP,
        pdpUrl: PDP,
        sku: SKU,
        pcMode: "checkout",
        pcLocale: "en-au",
        placeOrder: false,
        stopBeforeIssuer: true,
        dryRun: true,
        proxy: proxyRaw,
        proxyPool: proxyPool?.length ? proxyPool : [proxyRaw],
        maxStickyRotates: Math.min(2, Math.max(0, (proxyPool?.length || 1) - 1)),
        harvestedSession: null,
        transport: TRANSPORT,
        tlsWorker: TRANSPORT === "tls-worker",
        forceUndici: TRANSPORT === "undici",
        qty: 1,
      },
      ctx,
    );
  } catch (e) {
    result = {
      ok: false,
      note: e?.message || String(e),
      steps: ctx.steps,
      failedStep: "exception",
    };
  } finally {
    try {
      await dispatcher?.close?.();
    } catch {
      /* ignore */
    }
  }
  const steps = (result.steps || ctx.steps || []).map((s) => ({
    step: s.step,
    ok: s.ok,
    ms: s.ms ?? null,
    status: s.status ?? null,
    note: String(s.note || "").slice(0, 160),
  }));
  const authOk = steps.some(
    (s) => (s.step === "cortex_auth" || s.step === "cortex_auth_retry") && s.ok,
  );
  const atcOk = Boolean(
    result.cartGuid ||
      steps.some((s) => String(s.step).startsWith("cortex_atc") && s.ok),
  );
  return {
    wallMs: Date.now() - t0,
    proxyHost: host,
    ok: Boolean(result.ok),
    harvestUsed: Boolean(result.harvestUsed),
    stickyRotates: result.stickyRotates ?? 0,
    checkoutStage: result.checkoutStage || null,
    failedStep: result.failedStep || null,
    note: String(result.note || "").slice(0, 240),
    cartGuid: result.cartGuid || null,
    authOk,
    atcOk,
    steps,
  };
}

async function main() {
  if (!hyperConfigured()) {
    console.error("HYPER_API_KEY missing");
    process.exit(2);
  }
  const proxies = shuffle(loadProxies());
  const maxTries = Math.min(Number(process.env.PC_COLD_TRIES) || 10, proxies.length);
  const tries = [];
  let winner = null;
  console.log(
    JSON.stringify({
      phase: "start",
      transport: TRANSPORT,
      sku: SKU,
      maxTries,
      proxyCount: proxies.length,
    }),
  );
  for (let i = 0; i < maxTries; i++) {
    // Give SoftBlock rotate a small pool (current + next few).
    const pool = proxies.slice(i, i + 3);
    const proxyRaw = pool[0];
    const run = await runCold(proxyRaw, pool);
    const row = {
      host: run.proxyHost,
      wallMs: run.wallMs,
      authOk: run.authOk,
      atcOk: run.atcOk,
      stickyRotates: run.stickyRotates,
      failedStep: run.failedStep,
      stage: run.checkoutStage,
      harvestUsed: run.harvestUsed,
      note: run.note.slice(0, 100),
    };
    tries.push(row);
    console.log(JSON.stringify({ phase: "cold_try", ...row }));
    if (run.authOk || run.atcOk) {
      winner = run;
      break;
    }
  }
  const report = {
    at: new Date().toISOString(),
    sku: SKU,
    transport: TRANSPORT,
    harvestUsed: false,
    tries,
    winner,
    ok: Boolean(winner?.authOk || winner?.atcOk),
    interpretation:
      "Cold path (no harvestedSession) must clear edge for restock/random drops. Success = auth and/or ATC without harvestUsed.",
  };
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ phase: "done", out: OUT, ok: report.ok, winner: winner ? {
    wallMs: winner.wallMs,
    authOk: winner.authOk,
    atcOk: winner.atcOk,
    stage: winner.checkoutStage,
    stickyRotates: winner.stickyRotates,
    fail: winner.failedStep,
  } : null }, null, 2));
  process.exit(report.ok ? 0 : 3);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
