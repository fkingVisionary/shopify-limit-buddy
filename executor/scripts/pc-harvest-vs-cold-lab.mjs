#!/usr/bin/env node
/**
 * Pokémon Centre AU — harvest vs cold timing lab.
 *
 * Finds two mintable sticky exits, then:
 *   A) WITH harvestedSession on exit1 (skip edge warm on critical path)
 *   B) WITHOUT harvest on exit2 (cold edge warm on path)
 *
 * Env:
 *   HYPER_API_KEY (required)
 *   PROXY or PROXY_FILE (default executor/resi.proxies)
 *   PC_PDP / PC_SKU
 *   TRANSPORT=tls-worker|undici (default tls-worker)
 *   PC_PLACE_ORDER=1 to attempt GE issuer (needs card env)
 *   PC_MINT_TRIES (default 16) — max exits to scan for 2 mintable
 *   OUT=/opt/cursor/artifacts/pc-harvest-vs-cold.json
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createJar, makeDispatcher, makeRemoteTlsDispatcher } from "../http.js";
import { resolveEgressIp } from "../ip-resolve.js";
import { hyperConfigured } from "../antibot.js";
import { harvestPokemonCentreSession } from "../adapters/pokemoncentre-harvest-session.js";
import pokemoncentreAdapter from "../adapters/pokemoncentre.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");
const OUT =
  process.env.OUT ||
  `/opt/cursor/artifacts/pc-harvest-vs-cold-${Date.now()}.json`;
const TRANSPORT = String(process.env.TRANSPORT || "tls-worker").toLowerCase();
const PLACE_ORDER = process.env.PC_PLACE_ORDER === "1";
const SKU = process.env.PC_SKU || "10-10320-101";
const PDP =
  process.env.PC_PDP ||
  `https://www.pokemoncenter.com/en-au/product/${SKU}/pokemon-tcg-mewtwo-and-mew-dna-premium-zip-binder`;

function loadProxies() {
  if (process.env.PROXY) return [process.env.PROXY.trim()];
  const file =
    process.env.PROXY_FILE || path.join(ROOT, "resi.proxies");
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

function stepTable(steps = []) {
  return (steps || []).map((s) => ({
    step: s.step,
    ok: s.ok,
    ms: s.ms ?? null,
    status: s.status ?? null,
    note: String(s.note || "").slice(0, 160),
  }));
}

function sumMs(steps, names) {
  const set = new Set(names);
  return (steps || [])
    .filter((s) => set.has(s.step))
    .reduce((a, s) => a + (Number(s.ms) || 0), 0);
}

function edgeWarmMs(steps) {
  const list = steps || [];
  const authIdx = list.findIndex(
    (s) => s.step === "cortex_auth" || s.step === "harvest_claim",
  );
  // Harvest path: claim → auth, edge = 0 (off path)
  if (list.some((s) => s.step === "harvest_claim" && s.ok)) return 0;
  if (authIdx > 0) {
    return list.slice(0, authIdx).reduce((a, s) => a + (Number(s.ms) || 0), 0);
  }
  // Failed before auth — sum home/reese/dd warm steps
  const edgeish = /pc_home|incapsula|reese|datadome|edge_warm|warm_/;
  return list
    .filter((s) => edgeish.test(String(s.step || "")))
    .reduce((a, s) => a + (Number(s.ms) || 0), 0);
}

async function makeCtx(proxyRaw) {
  let dispatcher;
  let transport = "undici";
  if (TRANSPORT === "tls-worker") {
    try {
      dispatcher = await makeRemoteTlsDispatcher(proxyRaw);
      transport = dispatcher.transport || "tls-worker";
    } catch (e) {
      dispatcher = makeDispatcher(proxyRaw, { forceUndici: true });
      transport = `undici(fallback:${e?.message || e})`;
    }
  } else {
    dispatcher = makeDispatcher(proxyRaw, { forceUndici: true });
  }
  const jar = createJar();
  const steps = [];
  const ctx = {
    jar,
    dispatcher,
    steps,
    proxyRaw,
    onProgress: () => {},
  };
  // Prefer sticky host as egress seed (avoids ipify burning tls-worker slots)
  const host = String(proxyRaw).split(":")[0];
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) ctx.egressIp = host;
  try {
    if (!ctx.egressIp) ctx.egressIp = await resolveEgressIp(ctx);
  } catch {
    /* keep seeded */
  }
  return { ctx, transport };
}

async function runCheckout({ proxyRaw, harvestedSession, label }) {
  const t0 = Date.now();
  const { ctx, transport } = await makeCtx(proxyRaw);
  const task = {
    storeUrl: PDP,
    pdpUrl: PDP,
    sku: SKU,
    pcMode: "checkout",
    pcLocale: "en-au",
    placeOrder: PLACE_ORDER,
    pcHttpCheckout: PLACE_ORDER,
    stopBeforeIssuer: !PLACE_ORDER,
    dryRun: !PLACE_ORDER,
    proxy: proxyRaw,
    proxyPool: [proxyRaw],
    maxStickyRotates: 0,
    harvestedSession: harvestedSession || null,
    qty: 1,
    card: PLACE_ORDER
      ? {
          number: process.env.PC_CARD_NUMBER || process.env.KMART_CARD_NUMBER,
          expMonth: process.env.PC_CARD_EXP_MONTH || process.env.KMART_CARD_EXP_MONTH,
          expYear: process.env.PC_CARD_EXP_YEAR || process.env.KMART_CARD_EXP_YEAR,
          cvv: process.env.PC_CARD_CVV || process.env.KMART_CARD_CVV,
          holder: process.env.PC_CARD_HOLDER || "TEST USER",
        }
      : null,
  };
  if (task.card && !task.card.number) task.card = null;

  let result;
  try {
    result = await pokemoncentreAdapter.run(task, ctx);
  } catch (e) {
    result = {
      ok: false,
      note: e?.message || String(e),
      steps: ctx.steps,
      failedStep: "exception",
    };
  } finally {
    try {
      await ctx.dispatcher?.close?.();
    } catch {
      /* ignore */
    }
  }

  const wallMs = Date.now() - t0;
  const steps = stepTable(result.steps || ctx.steps);
  const atc = steps.find(
    (s) => s.step === "cortex_atc" || String(s.step || "").startsWith("cortex_atc"),
  );
  const authOk = steps.some(
    (s) =>
      (s.step === "cortex_auth" || s.step === "cortex_auth_retry") && s.ok,
  );
  const atcOk = Boolean(
    atc?.ok ||
      result.cartUri ||
      result.cartGuid ||
      steps.some((s) => String(s.step).startsWith("cortex_atc") && s.ok),
  );
  return {
    label,
    wallMs,
    transport,
    egressIp: ctx.egressIp || null,
    proxyHost: String(proxyRaw).split(":")[0],
    ok: Boolean(result.ok),
    harvestUsed: Boolean(result.harvestUsed),
    harvestId: result.harvestId || harvestedSession?.id || null,
    checkoutStage: result.checkoutStage || null,
    failedStep: result.failedStep || null,
    note: String(result.note || "").slice(0, 240),
    sku: result.sku || SKU,
    epItemId: result.epItemId || null,
    cartGuid: result.cartGuid || null,
    transactionId: result.transactionId || null,
    edgePathMs: edgeWarmMs(result.steps || ctx.steps),
    cortexAuthMs: sumMs(result.steps || ctx.steps, [
      "cortex_auth",
      "cortex_auth_retry",
    ]),
    atcMs: sumMs(
      result.steps || ctx.steps,
      (result.steps || ctx.steps)
        .filter((s) => String(s.step).startsWith("cortex_atc"))
        .map((s) => s.step),
    ),
    pdpMs: sumMs(result.steps || ctx.steps, ["pdp_fetch"]),
    atcOk,
    authOk,
    steps,
  };
}

function compare(cold, harvested) {
  const savedWall = cold.wallMs - harvested.wallMs;
  const savedEdge = cold.edgePathMs - harvested.edgePathMs;
  return {
    wallMs: {
      cold: cold.wallMs,
      harvested: harvested.wallMs,
      savedMs: savedWall,
      savedPct: cold.wallMs
        ? Math.round((savedWall / cold.wallMs) * 1000) / 10
        : null,
    },
    edgePathMs: {
      cold: cold.edgePathMs,
      harvested: harvested.edgePathMs,
      savedMs: savedEdge,
      savedPct: cold.edgePathMs
        ? Math.round((savedEdge / cold.edgePathMs) * 1000) / 10
        : null,
    },
    atcMs: { cold: cold.atcMs, harvested: harvested.atcMs },
    cortexAuthMs: { cold: cold.cortexAuthMs, harvested: harvested.cortexAuthMs },
    bothAtcOk: Boolean(cold.atcOk && harvested.atcOk),
  };
}

async function main() {
  if (!hyperConfigured()) {
    console.error("HYPER_API_KEY missing");
    process.exit(2);
  }
  const proxies = loadProxies();
  if (!proxies.length) {
    console.error("No proxies");
    process.exit(2);
  }

  const preferredHost = process.env.PC_PROXY_HOST || "";
  const ordered = preferredHost
    ? [
        ...proxies.filter((p) => p.startsWith(preferredHost + ":")),
        ...shuffle(proxies.filter((p) => !p.startsWith(preferredHost + ":"))),
      ]
    : shuffle(proxies);

  const needGoods = Math.max(1, Math.min(2, Number(process.env.PC_NEED_EXITS) || 2));
  const maxTries = Math.min(
    Number(process.env.PC_MINT_TRIES) || 16,
    ordered.length,
  );

  console.log(
    JSON.stringify({
      phase: "start",
      transport: TRANSPORT,
      placeOrder: PLACE_ORDER,
      sku: SKU,
      proxyCount: ordered.length,
      preferredHost: preferredHost || null,
      needGoods,
      maxTries,
    }),
  );

  // 1) Find up to 2 mintable exits (proves edge can clear)
  const mintTries = [];
  const goods = [];
  for (let i = 0; i < maxTries && goods.length < needGoods; i++) {
    const proxyRaw = ordered[i];
    const mintT0 = Date.now();
    const out = await harvestPokemonCentreSession({
      proxyRaw,
      solveCaptcha: false,
      locale: "en-au",
      transport: TRANSPORT,
    });
    const tryRow = {
      host: proxyRaw.split(":")[0],
      ok: Boolean(out.ok),
      ms: Date.now() - mintT0,
      error: out.error || null,
      isIpBanned: Boolean(out.isIpBanned),
      egressIp: out.session?.egressIp || null,
    };
    mintTries.push(tryRow);
    console.log(JSON.stringify({ phase: "harvest_mint_try", ...tryRow }));
    if (out.ok && out.session) {
      goods.push({
        proxyRaw,
        session: out.session,
        ms: out.ms || tryRow.ms,
      });
    }
  }

  const mintMs = mintTries.reduce((a, t) => a + (t.ms || 0), 0);
  console.log(
    JSON.stringify({
      phase: "harvest_mint",
      ok: goods.length > 0,
      goods: goods.length,
      scanMs: mintMs,
      tries: mintTries.length,
      hosts: goods.map((g) => g.proxyRaw.split(":")[0]),
    }),
  );

  // 2) Harvested checkout on exit A (critical path — skip warm)
  let harvestedRun = null;
  if (goods[0]) {
    harvestedRun = await runCheckout({
      proxyRaw: goods[0].proxyRaw,
      harvestedSession: goods[0].session,
      label: "with_harvest",
    });
    // One remint+retry if tls-worker auth 0 flake after fresh harvest
    if (
      !harvestedRun.atcOk &&
      harvestedRun.failedStep === "cortex_auth"
    ) {
      console.log(
        JSON.stringify({
          phase: "harvest_remint_for_auth_flake",
          host: goods[0].proxyRaw.split(":")[0],
        }),
      );
      const remint = await harvestPokemonCentreSession({
        proxyRaw: goods[0].proxyRaw,
        solveCaptcha: false,
        locale: "en-au",
        transport: TRANSPORT,
      });
      if (remint.ok && remint.session) {
        goods[0].session = remint.session;
        goods[0].ms = remint.ms;
        harvestedRun = await runCheckout({
          proxyRaw: goods[0].proxyRaw,
          harvestedSession: remint.session,
          label: "with_harvest",
        });
      }
    }
    console.log(
      JSON.stringify({
        phase: "checkout_harvested",
        wallMs: harvestedRun.wallMs,
        edgePathMs: harvestedRun.edgePathMs,
        harvestUsed: harvestedRun.harvestUsed,
        authOk: harvestedRun.authOk,
        atcOk: harvestedRun.atcOk,
        checkoutStage: harvestedRun.checkoutStage,
        failedStep: harvestedRun.failedStep,
      }),
    );
  } else {
    harvestedRun = {
      label: "with_harvest",
      ok: false,
      wallMs: null,
      edgePathMs: null,
      note: "no mintable exit",
      steps: [],
    };
  }

  // 3) Cold checkout on exit B (warm ON path). Prefer a second mintable exit.
  // Discard B's mint jar — cold must pay edge cost on the Autocheckout clock.
  let coldRun = null;
  if (goods[1]) {
    coldRun = await runCheckout({
      proxyRaw: goods[1].proxyRaw,
      harvestedSession: null,
      label: "cold",
    });
  } else if (goods[0]) {
    // Only one mintable — cold on a different host if possible, else same host fresh
    const harvestHost = goods[0].proxyRaw.split(":")[0];
    const alt =
      ordered.find((p) => !p.startsWith(harvestHost + ":")) || goods[0].proxyRaw;
    coldRun = await runCheckout({
      proxyRaw: alt,
      harvestedSession: null,
      label: "cold",
    });
  } else {
    coldRun = {
      label: "cold",
      ok: false,
      wallMs: null,
      edgePathMs: null,
      note: "no mintable exit",
      steps: [],
    };
  }
  console.log(
    JSON.stringify({
      phase: "checkout_cold",
      wallMs: coldRun.wallMs,
      edgePathMs: coldRun.edgePathMs,
      harvestUsed: coldRun.harvestUsed,
      authOk: coldRun.authOk,
      atcOk: coldRun.atcOk,
      checkoutStage: coldRun.checkoutStage,
      failedStep: coldRun.failedStep,
      proxyHost: coldRun.proxyHost,
    }),
  );

  const fair = Boolean(
    harvestedRun?.authOk &&
      coldRun?.authOk &&
      harvestedRun?.failedStep !== "edge_warm" &&
      coldRun?.failedStep !== "edge_warm",
  );

  const report = {
    at: new Date().toISOString(),
    sku: SKU,
    pdp: PDP,
    transport: TRANSPORT,
    placeOrder: PLACE_ORDER,
    mint: {
      ok: goods.length > 0,
      ms: goods[0]?.ms || null,
      msExitB: goods[1]?.ms || null,
      scanMs: mintMs,
      tries: mintTries,
      goods: goods.length,
      sessionId: goods[0]?.session?.id || null,
      proxyHost: goods[0]?.proxyRaw?.split(":")[0] || null,
      coldProxyHost: goods[1]?.proxyRaw?.split(":")[0] || coldRun.proxyHost || null,
      egressIp: goods[0]?.session?.egressIp || null,
      note: "Mint is OFF the Autocheckout critical path (pre-armed before T0). Exit B mint proves cold can clear edge; cold checkout still warms on path.",
    },
    withHarvest: harvestedRun,
    cold: coldRun,
    comparison:
      harvestedRun.wallMs != null && coldRun.wallMs != null
        ? {
            ...compare(coldRun, harvestedRun),
            fairBothClearedEdge: fair,
            bothAtcOk: Boolean(harvestedRun.atcOk && coldRun.atcOk),
            harvestUsedOnCheckout: Boolean(harvestedRun.harvestUsed),
            reachedAuth: {
              cold: Boolean(coldRun.authOk),
              harvested: Boolean(harvestedRun.authOk),
            },
            reachedAtc: {
              cold: Boolean(coldRun.atcOk),
              harvested: Boolean(harvestedRun.atcOk),
            },
            mintOffPathMs: goods[0]?.ms || null,
          }
        : null,
    interpretation: {
      criticalPathSavings:
        "Harvest moves Incapsula+DataDome warm off Autocheckout. Compare withHarvest.edgePathMs vs cold.edgePathMs and wallMs when both clear edge.",
      dropWinCon:
        "PC carts do not hold — harvest buys edge-clear time so T0 starts at Cortex auth/ATC.",
      fairNote: fair
        ? "Both lanes cleared edge — wall/edge deltas are apples-to-apples."
        : "One lane died before auth — prefer edgePathMs + reachedAtc over raw wallMs.",
    },
  };

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(report, null, 2));
  console.log(
    JSON.stringify(
      { phase: "done", out: OUT, comparison: report.comparison, interpretation: report.interpretation },
      null,
      2,
    ),
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
