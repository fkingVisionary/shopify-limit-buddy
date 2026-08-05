// Premium Bandai (p-bandai.com) adapter — F5/Volterra + BNID + Global-e (mid 1925).
// Regions: au/us/nz/sg/hk/tw/fr via task.bandaiArea or URL path. JP is out of scope.
// Completely separate from Kmart (no Hyper / Akamai / Paydock) and Toymate.
//
// Modes (task.bandaiMode):
//   checkout      — login → ATC → cart → checkoutSn (HTTP + F5 sensor bridge)
//   atc           — login → ATC → cart hold only (no checkout / GE pay)
//   account_gen   — bandai-agen (IMAP + SMSPool/OnlineSim → registerVerification → vault)
//   login_check   — F5 + login + member_refresh only (vault same-day proof)
//   monitor       — poll search/PDP for purchaseAvailable / Chance
//   chance        — applyDraw for a campaign
//
// Transport policy:
//   Default = undici HTTP. F5 Shape Defense headers (`p8komysnbc-*`) are minted
//   by a narrow Playwright bridge that aborts probe XHRs — the real POSTs stay
//   on HTTP.
//
// Checkout pay modes (task.bandaiCheckoutMode) — ATC/cart_hold is always HTTP+F5:
//   fast (default) — bandaiGeHttpPay: GetCartToken → hydrate → issuer undici
//   safe           — same HTTP cart_checkout + GetCartToken as Fast, then
//                    Playwright fill/Pay on Checkout/v2 (skip SPA Proceed).
//                    Opt-in legacy: task.bandaiSafeSpaProceed=true
//   Full browser login/PDP remains lab-only: bandaiBrowserFull:true.

import { createBandaiAccount } from "./bandai-agen.js";
import { browserBandaiCheckout } from "./bandai-browser-checkout.js";
import { browserBandaiGeFromCart } from "./bandai-ge-pay.js";
import {
  runBandaiGeHttpPay,
  getBandaiGeCartToken,
  BANDAI_GE_ENCODED_MERCHANT,
  BANDAI_GE_WEBSERVICES,
} from "./bandai-ge-http.js";
import { runBandaiGeHttpPayTest } from "./bandai-ge-http-test.js";
import { createBandaiF5Bridge, parseBandaiProxy } from "./bandai-f5.js";
import { takeHarvestSlot, takeNextHarvestSlot } from "./bandai-harvest-pool.js";
import { findCartLine, findCartLineAny, listCartLines } from "./bandai-cart.js";
import {
  BANDAI_PAY_WINDOW_MS,
  withHeldCartMeta,
} from "./bandai-held-cart.js";
import {
  isBackendAreaItemNo,
  isFrontendProductCode,
  resolveAreaItemNoPublicRetry,
} from "./bandai-nai.js";
import { makeDispatcher, createJar } from "../http.js";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  createBandaiSession,
  parseAreaItemNo,
  parseFrontendProductCode,
  extractPreloadSuffix,
  readText,
  resolveBandaiArea,
  profileFromTask,
  BANDAI_ORIGIN,
  GLOBALE_MID,
} from "./bandai-session.js";

const EXECUTOR_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function isRetryableAtcFailure({ status, err, textHint }) {
  const blob = `${err || ""} ${textHint || ""} ${status || ""}`;
  if (/CouldNotAddToCartBy(MaxPurchaseQty|Preallocation|SoldOut|OutOfStock)/i.test(blob)) {
    return false;
  }
  if (/NETWORK CONGESTION|PAGE NOT AVAILABLE|Service Unavailable|Bad Gateway|Gateway Time-out/i.test(blob)) {
    return true;
  }
  if (/SoftBlock|Access Denied|Request rejected/i.test(blob)) return true;
  const st = Number(status);
  if (st === 429 || st === 501 || st === 502 || st === 503 || st === 504) return true;
  if (!Number.isFinite(st) || st === 0) return true; // network / empty
  return false;
}

/** Login SoftBlock / proxy flake — rotate sticky + remint F5. Not bad password. */
export function isRetryableLoginFailure({ note, status, restrictedType, err } = {}) {
  const blob = `${note || ""} ${err || ""} ${restrictedType || ""} ${status ?? ""}`;
  if (
    /invalid (password|credentials)|wrong password|MemberNotFound|password.*incorrect|BadCredentials/i.test(
      blob,
    )
  ) {
    return false;
  }
  if (/SoftBlock|Access Denied|Request rejected|NETWORK CONGESTION|PAGE NOT AVAILABLE/i.test(blob)) {
    return true;
  }
  if (/sensor mint failed|f5_bridge|ERR_|ECONN|ETIMEDOUT|socket|fetch failed|und_err/i.test(blob)) {
    return true;
  }
  if (/SoftBlock/i.test(String(restrictedType || ""))) return true;
  const st = Number(status);
  if (st === 429 || st === 501 || st === 502 || st === 503 || st === 504) return true;
  if (!Number.isFinite(st) || st === 0) return true;
  return false;
}

export function bandaiProxyHost(raw) {
  const parsed = parseBandaiProxy(raw);
  const server = parsed?.playwright?.server;
  if (server) {
    try {
      return new URL(server).hostname;
    } catch {
      /* fall through */
    }
  }
  if (parsed?.url) {
    try {
      return new URL(parsed.url).hostname;
    } catch {
      /* fall through */
    }
  }
  return (
    String(raw || "")
      .replace(/^https?:\/\//i, "")
      .split("@")
      .pop()
      ?.split(":")[0] || ""
  );
}

/** Proxy pool for login SoftBlock rotate — task list first, then env / resi file. */
export function loadBandaiProxyPool(task = {}) {
  const fromTask = Array.isArray(task.proxyPool)
    ? task.proxyPool
    : Array.isArray(task.bandaiProxyPool)
      ? task.bandaiProxyPool
      : Array.isArray(task.proxyEntries)
        ? task.proxyEntries
        : null;
  if (fromTask?.length) {
    return fromTask.map((l) => String(l || "").trim()).filter(Boolean);
  }
  const candidates = [
    process.env.BANDAI_PROXY_POOL,
    path.join(EXECUTOR_ROOT, "resi.proxies"),
    "/tmp/bandai-proxy-pool.txt",
  ].filter(Boolean);
  for (const p of candidates) {
    try {
      if (!fs.existsSync(p)) continue;
      const lines = fs
        .readFileSync(p, "utf8")
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter((l) => l && !l.startsWith("#"));
      if (lines.length) return lines;
    } catch {
      /* try next */
    }
  }
  return [];
}

function sleepMs(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
/**
 * Resolve Fast vs Safe pay path after HTTP ATC / cart_hold.
 * Explicit bandaiBrowserCheckout / bandaiBrowserFull still win for labs.
 * @param {object} [task]
 * @returns {{ mode: "fast"|"safe"|"full"|"autocheckout_test", placeOrderGeHttp: boolean, placeOrderGe: boolean, browserFull: boolean, useGeHttpTestFork?: boolean }}
 */
export function resolveBandaiCheckoutPayPath(task = {}) {
  const raw = String(task.bandaiCheckoutMode || task.checkoutMode || "")
    .toLowerCase()
    .trim();
  if (task.bandaiBrowserFull === true || raw === "full") {
    return {
      mode: "full",
      placeOrderGeHttp: false,
      placeOrderGe: false,
      browserFull: true,
    };
  }
  // Experimental Fast fork — same HTTP GE shape, separate module file so
  // dual-charge labs cannot regress production Autocheckout (fast).
  if (
    raw === "autocheckout_test" ||
    raw === "test" ||
    raw === "fast_test" ||
    task.bandaiGeHttpPayTest === true
  ) {
    return {
      mode: "autocheckout_test",
      placeOrderGeHttp: true,
      placeOrderGe: false,
      browserFull: false,
      useGeHttpTestFork: true,
    };
  }
  const safe =
    task.bandaiBrowserCheckout === true ||
    raw === "safe" ||
    raw === "browser" ||
    raw === "playwright" ||
    raw === "http+ge";
  if (safe) {
    return {
      mode: "safe",
      placeOrderGeHttp: false,
      placeOrderGe: true,
      browserFull: false,
    };
  }
  // fast default — opt out only with bandaiGeHttpPay:false
  return {
    mode: "fast",
    placeOrderGeHttp: task.bandaiGeHttpPay !== false,
    placeOrderGe: false,
    browserFull: false,
  };
}

function makeStep(steps, ctx) {
  return async (name, fn) => {
    const s0 = Date.now();
    try {
      const out = await fn();
      const row = {
        step: name,
        ok: out?.ok !== false,
        status: out?.status ?? null,
        ms: Date.now() - s0,
        note: out?.note ?? null,
      };
      steps.push(row);
      ctx.onProgress?.(name, out?.note || null);
      return out;
    } catch (e) {
      const row = {
        step: name,
        ok: false,
        status: null,
        ms: Date.now() - s0,
        note: e?.message || String(e),
      };
      steps.push(row);
      throw e;
    }
  };
}

async function resolveAreaItemNo(session, productCode, tStep, opts = {}) {
  const code = String(productCode || "").trim();
  const fallback =
    opts.fallbackAreaItemNo != null && String(opts.fallbackAreaItemNo).trim()
      ? String(opts.fallbackAreaItemNo).trim()
      : null;
  if (!code && !fallback) return { ok: false, note: "product code / areaItemNo required" };
  if (/^NAI/i.test(code) || /^AAI/i.test(code)) {
    return { ok: true, areaItemNo: code, productCode: code };
  }
  if (!code && fallback) {
    return {
      ok: true,
      areaItemNo: fallback,
      productCode: fallback,
      note: `using task backend PID ${fallback} (no frontend code)`,
    };
  }
  // Pre-resolved / task Backend PID: skip PDP product_get on the ATC critical path.
  // Dual-ID keeps frontend N… for referer; NAI… goes straight to addToCart.
  if (
    fallback &&
    (/^NAI/i.test(fallback) || /^AAI/i.test(fallback)) &&
    opts.forceLookup !== true
  ) {
    return {
      ok: true,
      areaItemNo: fallback,
      productCode: code || fallback,
      title: code || fallback,
      note: `pre-resolved backend PID ${fallback} (skipped product_get)`,
      skippedLookup: true,
    };
  }

  const maxAttempts = Math.max(1, Math.min(3, Number(opts.retries) || 2));
  let last = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const pdp = await tStep(attempt === 1 ? "product_get" : `product_get_retry_${attempt}`, async () => {
        const { status, json } = await session.apiJson(
          "GET",
          `/api/products/${encodeURIComponent(code)}`,
          {
            referer: `${session.base}/item/${code}`,
          },
        );
        const areaItemNo =
          json?.areaItemNos?.[0] ||
          (Array.isArray(json?.areaItemNos) ? json.areaItemNos[0] : null) ||
          Object.keys(json?.areaItemInventoryInfoMap || {})[0] ||
          null;
        const purchaseAvailable = Boolean(json?.purchaseAvailable);
        const flags = json?.flags || [];
        const err = json?.detail || json?.error || json?.message || null;
        const retryable =
          status === 429 ||
          status === 501 ||
          status === 502 ||
          status === 503 ||
          status === 504 ||
          /NETWORK CONGESTION|PAGE NOT AVAILABLE|SoftBlock/i.test(String(err || ""));
        return {
          ok: status === 200 && Boolean(json) && Boolean(areaItemNo || fallback),
          status,
          note: areaItemNo
            ? `${areaItemNo} avail=${purchaseAvailable}${attempt > 1 ? ` (attempt ${attempt})` : ""}`
            : err
              ? `${err} product ${status}`
              : `product ${status}`,
          areaItemNo: areaItemNo || fallback || null,
          purchaseAvailable,
          flags,
          json,
          title: json?.productName || json?.name || code,
          retryable,
        };
      });
      last = pdp;
      if (pdp.ok) return pdp;
      if (pdp.status === 404) break;
      if (!pdp.retryable && pdp.status >= 400 && pdp.status < 500) break;
      if (attempt < maxAttempts) await sleepMs(350 * attempt);
    } catch (e) {
      last = {
        ok: false,
        note: e?.message || String(e),
        areaItemNo: null,
      };
      if (attempt < maxAttempts && isRetryableAtcFailure({ err: e?.message, status: 0 })) {
        await sleepMs(400 * attempt);
        continue;
      }
      break;
    }
  }

  if (fallback) {
    return {
      ok: true,
      areaItemNo: fallback,
      productCode: code || fallback,
      title: last?.title || code,
      note: `product_get failed (${last?.note || "n/a"}) → using task backend PID ${fallback}`,
      purchaseAvailable: last?.purchaseAvailable,
      flags: last?.flags,
    };
  }
  return last || { ok: false, note: "product lookup failed" };
}

async function runMonitor(task, ctx, session, tStep, steps) {
  const keyword = String(task.pdpUrl || task.keyword || task.input || "").trim();
  const productCode = parseAreaItemNo(task);

  if (productCode && !/\s/.test(productCode) && /^[NA]/i.test(productCode)) {
    const pdp = await resolveAreaItemNo(session, productCode, tStep);
    return {
      ok: pdp.ok,
      steps,
      monitor: true,
      dryRun: true,
      purchaseAvailable: pdp.purchaseAvailable,
      areaItemNo: pdp.areaItemNo,
      flags: pdp.flags,
      title: pdp.title,
      checkoutStage: "monitor",
      finalUrl: `${session.base}/item/${productCode}`,
      cookies: ctx.jar?.dump?.() ?? {},
      note: pdp.note,
    };
  }

  const q = keyword.replace(/^https:\/\/p-bandai\.com\/au\/?/i, "").trim() || "one piece";
  const search = await tStep("search", async () => {
    const { status, json } = await session.apiJson(
      "GET",
      `/api/search?keyword=${encodeURIComponent(q)}&offset=0&limit=20`,
      { referer: `${session.base}/search?keyword=${encodeURIComponent(q)}` },
    );
    const products = json?.productResults?.products || json?.products || [];
    const hits = (Array.isArray(products) ? products : []).slice(0, 10).map((p) => ({
      productCode: p.productCode || p.code,
      saleStatus: p.saleStatus,
      productType: p.productType,
      purchaseAvailable: p.purchaseAvailable,
    }));
    return {
      ok: status === 200,
      status,
      note: `${hits.length} products`,
      hits,
      json,
    };
  });

  return {
    ok: search.ok,
    steps,
    monitor: true,
    dryRun: true,
    products: search.hits || [],
    checkoutStage: "monitor",
    finalUrl: `${session.base}/search?keyword=${encodeURIComponent(q)}`,
    cookies: ctx.jar?.dump?.() ?? {},
    note: search.note,
  };
}

async function runChance(task, ctx, session, tStep, steps) {
  const account = task.account || {};
  const email = account.email || task.email;
  const password = account.password || task.password;
  if (!email || !password) {
    return {
      ok: false,
      steps,
      error: "Chance requires vault account email/password",
      failedStep: "login",
      checkoutStage: "chance",
    };
  }

  const httpOut = await runHttpCheckout(task, ctx, session, tStep, steps, {
    email,
    password,
    productCode: null,
    chanceOnly: true,
  });
  if (!httpOut.ok && httpOut.failedStep === "login") return httpOut;

  const campaignSn = task.campaignSn || task.campaignId;
  if (!campaignSn) {
    return {
      ok: false,
      steps,
      error: "campaignSn required for Chance applyDraw",
      failedStep: "chance_config",
      checkoutStage: "chance",
    };
  }

  const applyGroupNo =
    task.applyGroupNo === undefined || task.applyGroupNo === ""
      ? null
      : Number(task.applyGroupNo);

  const draw = await tStep("applyDraw", async () => {
    const { status, json } = await session.apiJson(
      "POST",
      `/api/my/campaign/apply/${encodeURIComponent(campaignSn)}/applyDraw`,
      {
        body: { applyGroupNo },
        referer: `${session.base}/hotdeals/`,
      },
    );
    const err = json?.detail || json?.errorCode || json?.message || null;
    return {
      ok: status >= 200 && status < 300,
      status,
      note: err ? String(err) : `applyDraw ${status}`,
      json,
    };
  });

  return {
    ok: draw.ok,
    steps,
    chance: true,
    dryRun: true,
    checkoutStage: "chance",
    campaignSn,
    finalUrl: `${session.base}/mypage/chancetobuy`,
    cookies: ctx.jar?.dump?.() ?? {},
    note: draw.note,
  };
}

/**
 * HTTP checkout: undici for all API calls; F5 bridge only mints sensor headers.
 */
async function runHttpCheckout(task, ctx, sessionIn, tStep, steps, opts = {}) {
  let session = sessionIn;
  const email = opts.email;
  const password = opts.password;
  const productCode = opts.frontendCode || opts.productCode;
  let backendAreaItemNo = opts.backendAreaItemNo || null;
  const chanceOnly = opts.chanceOnly === true;
  const placeOrder = task.placeOrder === true && task.dryRun !== true;
  const wantBridge = task.bandaiF5Bridge !== false;

  let bridge = null;
  let usedHarvestedBridge = false;
  const closeBridge = async () => {
    try {
      await bridge?.close?.();
    } catch {
      /* ignore */
    }
    bridge = null;
  };

  // Drop win-con: wall→ATC. Cart holds ~30 min; pay can follow. Prefer tight
  // F5 settle + skip optional cart peek (bandaiFastAtc, default on for checkout).
  const fastAtc =
    task.bandaiFastAtc !== false &&
    String(process.env.BANDAI_FAST_ATC || "1") !== "0";
  // common.js needs ~1.2–1.8s after goto before p8komysnbc-* mint works.
  // 900ms broke ATC mint in lab; floor at 1200 for fast path.
  // Cap raised — SoftBlock labs needed >3s settle on fresh Noontide (2026-08-05).
  const f5SettleMs = Math.max(
    1_200,
    Math.min(
      8_000,
      Number(task.bandaiF5SettleMs || process.env.BANDAI_F5_SETTLE_MS) ||
        (fastAtc ? 1_400 : 1_800),
    ),
  );
  const atcT0 = Date.now();

  // Public bot: auto-resolve N…→NAI… in parallel with F5/login so ATC skips product_get
  // without requiring users to paste Backend PID.
  let naiResolvePromise = null;
  if (
    !backendAreaItemNo &&
    !task.bandaiAreaItemNo &&
    !task.heldCart?.areaItemNo &&
    productCode &&
    isFrontendProductCode(productCode) &&
    task.bandaiAutoResolveNai !== false &&
    String(process.env.BANDAI_AUTO_RESOLVE_NAI || "1") !== "0"
  ) {
    naiResolvePromise = resolveAreaItemNoPublicRetry({
      productCode,
      area: session.area,
      proxy: task.proxy || null,
      retries: 2,
    }).catch((e) => ({ ok: false, error: e?.message || String(e) }));
  }

  async function seedColdF5Bridge(proxyLine, { noteSuffix = "" } = {}) {
    const s0 = Date.now();
    // Opt-in only — forcing headed Chrome for every Autocheckout test burnt
    // Bandai login (HTTP 501) across the proxy pool. Headless form-nav still
    // scores settleMs=0; set BANDAI_GE_TEST_HEADED_CHROME=1 when needed.
    const headedChrome =
      process.env.BANDAI_GE_TEST_HEADED_CHROME === "1" ||
      task.bandaiGeTestHeadedChrome === true;
    bridge = await createBandaiF5Bridge({
      proxy: proxyLine || null,
      area: session.area,
      timeoutMs: Number(task.browserLoginTimeoutMs) || 90_000,
      ...(headedChrome ? { channel: "chrome", headless: false } : {}),
    });
    await bridge.goto(`${session.base}/login`, { settleMs: f5SettleMs });
    const csrf = await bridge.csrfToken();
    const cookies = await bridge.cookies();
    if (cookies && ctx.jar?.load) ctx.jar.load(cookies);
    if (csrf) session.state.csrfToken = csrf;
    steps.push({
      step: "f5_bridge",
      ok: Boolean(csrf) || Object.keys(cookies || {}).length > 0,
      status: null,
      ms: Date.now() - s0,
      note: csrf
        ? `bridge ready area=${session.area} csrf=${String(csrf).slice(0, 8)}… settle=${f5SettleMs}ms fastAtc=${fastAtc}${headedChrome ? " chrome:headed" : ""}${noteSuffix}`
        : `bridge area=${session.area} cookies=${Object.keys(cookies || {}).join(",")} settle=${f5SettleMs}ms${headedChrome ? " chrome:headed" : ""}${noteSuffix}`,
    });
    ctx.onProgress?.("f5_bridge", steps[steps.length - 1].note);
    return Boolean(csrf) || Object.keys(cookies || {}).length > 0;
  }

  if (wantBridge) {
    try {
      const s0 = Date.now();
      // Opt-in harvest: claim a pre-warmed F5 bridge. Dead/missing id → try next
      // bank slot (same area) before cold Chromium — drop consistency under load.
      const harvestId =
        typeof task.harvestedBridgeId === "string" && task.harvestedBridgeId.trim()
          ? task.harvestedBridgeId.trim()
          : null;
      let harvestedMeta = null;
      let claimedId = harvestId;
      const triedIds = [];

      async function tryClaim(id, { via = "id" } = {}) {
        if (!id) return false;
        triedIds.push(String(id));
        const claimed = takeHarvestSlot(id);
        if (!claimed?.bridge) return false;
        try {
          const csrfCheck = await claimed.bridge.csrfToken();
          const cookiesCheck = (await claimed.bridge.cookies()) || {};
          const alive =
            Boolean(csrfCheck) ||
            Object.keys(cookiesCheck).some((k) => /^TS/i.test(k) || k === "SESSION");
          if (!alive) {
            await claimed.bridge.close?.();
            return false;
          }
          // Rebind sticky if reclaim used a different exit than task.proxy.
          if (claimed.proxy && claimed.proxy !== task.proxy) {
            try {
              await ctx.dispatcher?.close?.();
            } catch {
              /* ignore */
            }
            ctx.dispatcher = makeDispatcher(claimed.proxy, { forceUndici: true });
            ctx.jar = createJar();
            task.proxy = claimed.proxy;
            session = createBandaiSession(ctx, { area: session.area });
          }
          bridge = claimed.bridge;
          harvestedMeta = claimed.meta;
          claimedId = id;
          usedHarvestedBridge = true;
          if (csrfCheck) session.state.csrfToken = csrfCheck;
          if (cookiesCheck && ctx.jar?.load) ctx.jar.load(cookiesCheck);
          if (via === "next") {
            steps.push({
              step: "harvest_reclaim",
              ok: true,
              ms: Date.now() - s0,
              note: `dead/miss → next bank slot id=${id} host=${bandaiProxyHost(claimed.proxy)}`,
            });
          }
          return true;
        } catch {
          try {
            await claimed.bridge.close?.();
          } catch {
            /* ignore */
          }
          return false;
        }
      }

      if (harvestId) {
        const ok = await tryClaim(harvestId, { via: "id" });
        if (!ok) {
          // Prefer another warm bridge over cold mint while the bank still has stock.
          for (let i = 0; i < 2 && !bridge; i++) {
            const next = takeNextHarvestSlot({
              area: session.area,
              excludeIds: triedIds,
            });
            if (!next?.meta?.id && !next?.bridge) break;
            // takeNextHarvestSlot already claimed — bridge is ours.
            const nextId = next.meta?.id || `next_${i}`;
            triedIds.push(String(nextId));
            try {
              const csrfCheck = await next.bridge.csrfToken();
              const cookiesCheck = (await next.bridge.cookies()) || {};
              const alive =
                Boolean(csrfCheck) ||
                Object.keys(cookiesCheck).some((k) => /^TS/i.test(k) || k === "SESSION");
              if (!alive) {
                await next.bridge.close?.();
                continue;
              }
              if (next.proxy && next.proxy !== task.proxy) {
                try {
                  await ctx.dispatcher?.close?.();
                } catch {
                  /* ignore */
                }
                ctx.dispatcher = makeDispatcher(next.proxy, { forceUndici: true });
                ctx.jar = createJar();
                task.proxy = next.proxy;
                session = createBandaiSession(ctx, { area: session.area });
              }
              bridge = next.bridge;
              harvestedMeta = next.meta;
              claimedId = nextId;
              usedHarvestedBridge = true;
              if (csrfCheck) session.state.csrfToken = csrfCheck;
              if (cookiesCheck && ctx.jar?.load) ctx.jar.load(cookiesCheck);
              steps.push({
                step: "harvest_reclaim",
                ok: true,
                ms: Date.now() - s0,
                note: `miss ${harvestId} → reclaimed id=${nextId} host=${bandaiProxyHost(next.proxy)}`,
              });
            } catch {
              try {
                await next.bridge.close?.();
              } catch {
                /* ignore */
              }
            }
          }
        }
      } else if (task.bandaiClaimHarvest !== false) {
        // No pre-bound id (late claim miss) — still try bank before cold.
        const next = takeNextHarvestSlot({ area: session.area });
        if (next?.bridge) {
          try {
            const csrfCheck = await next.bridge.csrfToken();
            const cookiesCheck = (await next.bridge.cookies()) || {};
            const alive =
              Boolean(csrfCheck) ||
              Object.keys(cookiesCheck).some((k) => /^TS/i.test(k) || k === "SESSION");
            if (alive) {
              if (next.proxy && next.proxy !== task.proxy) {
                try {
                  await ctx.dispatcher?.close?.();
                } catch {
                  /* ignore */
                }
                ctx.dispatcher = makeDispatcher(next.proxy, { forceUndici: true });
                ctx.jar = createJar();
                task.proxy = next.proxy;
                session = createBandaiSession(ctx, { area: session.area });
              }
              bridge = next.bridge;
              harvestedMeta = next.meta;
              claimedId = next.meta?.id || "bank";
              usedHarvestedBridge = true;
              if (csrfCheck) session.state.csrfToken = csrfCheck;
              if (cookiesCheck && ctx.jar?.load) ctx.jar.load(cookiesCheck);
              steps.push({
                step: "harvest_reclaim",
                ok: true,
                ms: Date.now() - s0,
                note: `no harvest id → bank claim id=${claimedId}`,
              });
            } else {
              await next.bridge.close?.();
            }
          } catch {
            try {
              await next.bridge.close?.();
            } catch {
              /* ignore */
            }
          }
        }
      }

      if (!bridge) {
        await seedColdF5Bridge(task.proxy || null, {
          noteSuffix: harvestId ? " (harvest miss→cold)" : "",
        });
      } else {
        const csrf = session.state.csrfToken || (await bridge.csrfToken());
        const cookies = await bridge.cookies();
        if (cookies && ctx.jar?.load) ctx.jar.load(cookies);
        if (csrf) session.state.csrfToken = csrf;
        const ageSec = harvestedMeta?.ageSec;
        steps.push({
          step: "f5_bridge",
          ok: Boolean(csrf) || Object.keys(cookies || {}).length > 0,
          status: null,
          ms: Date.now() - s0,
          note: csrf
            ? `harvested bridge area=${session.area} csrf=${String(csrf).slice(0, 8)}… age=${ageSec ?? "?"}s id=${claimedId}`
            : `harvested bridge area=${session.area} cookies=${Object.keys(cookies || {}).join(",")} age=${ageSec ?? "?"}s`,
        });
        ctx.onProgress?.("f5_bridge", steps[steps.length - 1].note);
      }
    } catch (e) {
      steps.push({
        step: "f5_bridge",
        ok: false,
        status: null,
        ms: 0,
        note: e?.message || "f5_bridge_failed",
      });
      return {
        ok: false,
        steps,
        error: e?.message || "f5_bridge_failed",
        failedStep: "f5_bridge",
        checkoutStage: "pre_cart",
      };
    }
  } else {
    await tStep("warm", () => session.warm());
  }

  // ── Login (HTTP) ───────────────────────────────────────────────────────
  const loginBody = new URLSearchParams({
    grantType: "password",
    memberId: String(email || "").trim(),
    password: String(password || ""),
    saveLoginId: "false",
    autoLogin: "false",
  }).toString();

  async function attemptLogin() {
    let sensors = {};
    if (bridge) {
      const mint = await bridge.mint("POST", "/login", {
        body: loginBody,
        contentType: "application/x-www-form-urlencoded;charset=UTF-8",
        csrf: session.state.csrfToken || (await bridge.csrfToken()),
      });
      sensors = mint.sensors || {};
      // Sync any cookie the probe set (ktlv…)
      const c = await bridge.cookies();
      if (c && ctx.jar?.load) ctx.jar.load({ ...ctx.jar.dump(), ...c });
      if (!mint.ok) {
        return { ok: false, status: null, note: `sensor mint failed: ${mint.note}` };
      }
    }
    // Do NOT warm after seeding F5 cookies — it rotates the session and 501s login.
    if (!session.state.csrfToken && bridge) {
      session.state.csrfToken = await bridge.csrfToken();
    }
    if (!session.state.csrfToken) {
      const w = await session.warm();
      if (!w.ok) return { ok: false, status: w.status, note: w.note };
    }
    const out = await session.loginPassword(email, password, { extraHeaders: sensors });
    if (bridge && ctx.jar?.dump) await bridge.syncCookies(ctx.jar.dump());
    return {
      ...out,
      note: out.ok
        ? `login ok via=http sensors=${Object.keys(sensors).length}`
        : out.note || `login ${out.status}`,
    };
  }

  // SoftBlock recovery: mint+abort then undici /login often 501s (TLS ≠ Chromium
  // F5 session) while the same account works in a real browser. Complete login
  // inside the existing F5 bridge (not Playwright pay) and sync cookies to jar.
  async function attemptLoginViaBridge() {
    // Never throw — makeStep rethrows and desktop maps that to adapter_error,
    // which aborts SoftBlock outer climb (failedStep must stay "login").
    try {
      if (!bridge?.page || bridge.page.isClosed?.()) {
        return { ok: false, status: null, note: "bridge login skipped: no page" };
      }
      // Warm F5 sensor cookies in-page before login fetch (mint-only used to
      // leave bridge fetch SoftBlocked while undici also 501'd).
      try {
        const mint = await bridge.mint("POST", "/login", {
          body: loginBody,
          contentType: "application/x-www-form-urlencoded;charset=UTF-8",
          csrf: session.state.csrfToken || (await bridge.csrfToken()),
        });
        const c = await bridge.cookies();
        if (c && ctx.jar?.load) ctx.jar.load({ ...ctx.jar.dump(), ...c });
        if (!mint.ok) {
          return { ok: false, status: null, note: `bridge sensor mint failed: ${mint.note}` };
        }
      } catch (e) {
        return {
          ok: false,
          status: null,
          note: `bridge sensor mint throw: ${e?.message || e}`,
        };
      }
      const csrf = session.state.csrfToken || (await bridge.csrfToken());
      const result = await bridge.page.evaluate(
        async ({ body, csrf: tok, areaCode }) => {
          const res = await fetch("/login", {
            method: "POST",
            headers: {
              accept: "application/json, text/plain, */*",
              "content-type": "application/x-www-form-urlencoded;charset=UTF-8",
              "x-g1-area-code": areaCode,
              "x-requested-with": "XMLHttpRequest",
              ...(tok ? { "x-csrf-token": tok } : {}),
            },
            body,
            credentials: "include",
          });
          const text = await res.text();
          return {
            status: res.status,
            restrictedType: res.headers.get("x-restricted-type"),
            csrf: res.headers.get("x-csrf-token"),
            text: text.slice(0, 240),
          };
        },
        { body: loginBody, csrf, areaCode: session.area },
      );
      try {
        await bridge.page.waitForTimeout(800);
      } catch {
        /* ignore */
      }
      const cookies = await bridge.cookies().catch(() => null);
      if (cookies && ctx.jar?.load) {
        ctx.jar.load({ ...(ctx.jar.dump?.() || {}), ...cookies });
      }
      if (result?.csrf) session.state.csrfToken = result.csrf;
      const restricted = result?.restrictedType || null;
      const blocking =
        restricted &&
        !/^NoRestriction$/i.test(restricted) &&
        restricted !== "null" &&
        restricted !== "";
      const status = Number(result?.status) || null;
      const ok = status >= 200 && status < 300 && !blocking;
      return {
        ok,
        status,
        restrictedType: restricted,
        blocking: Boolean(blocking),
        note: blocking
          ? `bridge restricted:${restricted}`
          : ok
            ? "login ok via=bridge"
            : `bridge login ${status}`,
      };
    } catch (e) {
      return {
        ok: false,
        status: null,
        note: `bridge login throw: ${e?.message || e}`,
      };
    }
  }

  let login = await tStep("login", attemptLogin);
  if (!login.ok && bridge && isRetryableLoginFailure(login)) {
    login = await tStep("login_bridge", attemptLoginViaBridge);
  }

  // SoftBlock / proxy flake: rotate sticky session, remint cold F5, retry login.
  // Prefer distinct session lines (not just host as1↔as2) so reminted Noontide
  // stickies actually get used. Do not spray on bad password.
  // Default 2 rotates; disable via bandaiLoginProxyRotate:false.
  if (
    !login.ok &&
    task.bandaiLoginProxyRotate !== false &&
    isRetryableLoginFailure(login)
  ) {
    const pool = loadBandaiProxyPool(task);
    const curLine = String(task.proxy || "").trim().toLowerCase();
    const maxRot = Math.max(
      0,
      Math.min(
        8,
        // Default 6 — pool labs have many Noontide lines; 2 was too thin for SoftBlock.
        Number(task.bandaiLoginProxyRotates ?? process.env.BANDAI_LOGIN_PROXY_ROTATES) || 6,
      ),
    );
    const seen = new Set(curLine ? [curLine] : []);
    const candidates = [];
    for (const raw of pool) {
      const line = String(raw || "").trim();
      const key = line.toLowerCase();
      if (!line || !bandaiProxyHost(line) || seen.has(key)) continue;
      seen.add(key);
      candidates.push(line);
      if (candidates.length >= maxRot) break;
    }
    for (let i = 0; i < candidates.length; i++) {
      const line = candidates[i];
      const tRot = Date.now();
      await closeBridge();
      try {
        await ctx.dispatcher?.close?.();
      } catch {
        /* ignore */
      }
      ctx.dispatcher = makeDispatcher(line, { forceUndici: true });
      ctx.jar = createJar();
      task.proxy = line;
      // Harvest was bound to the burned exit — do not reclaim it.
      delete task.harvestedBridgeId;
      session = createBandaiSession(ctx, { area: session.area });
      let seeded = false;
      try {
        if (wantBridge) {
          seeded = await seedColdF5Bridge(line, {
            noteSuffix: ` (login rotate ${i + 1}/${candidates.length})`,
          });
        } else {
          const w = await session.warm();
          seeded = Boolean(w.ok);
        }
      } catch (e) {
        const sessHint = (() => {
          const m = String(line).match(/session-([^-:]+)/i);
          return m ? `session-${m[1]}` : bandaiProxyHost(line);
        })();
        // Seed threw mid-boot — drop stale bridge so login_bridge_final cannot
        // page.evaluate on a destroyed context (was adapter_error).
        bridge = null;
        steps.push({
          step: "login_proxy_rotate",
          ok: false,
          status: null,
          ms: Date.now() - tRot,
          note: `rotate→${sessHint} seed fail: ${e?.message || e}`,
        });
        continue;
      }
      const sessHint = (() => {
        const m = String(line).match(/session-([^-:]+)/i);
        return m ? `session-${m[1]}` : bandaiProxyHost(line);
      })();
      steps.push({
        step: "login_proxy_rotate",
        ok: seeded,
        status: null,
        ms: Date.now() - tRot,
        note: seeded
          ? `rotated→${sessHint} remint F5 (attempt ${i + 1}/${candidates.length})`
          : `rotate→${sessHint} seed incomplete`,
      });
      if (!seeded) continue;
      login = await tStep(`login_retry_${i + 1}`, attemptLogin);
      if (!login.ok && bridge && isRetryableLoginFailure(login)) {
        login = await tStep(`login_bridge_retry_${i + 1}`, attemptLoginViaBridge);
      }
      if (login.ok) {
        login = {
          ...login,
          note: `${login.note} after proxy rotate→${sessHint}`,
        };
        break;
      }
      if (!isRetryableLoginFailure(login)) break;
    }
  }

  if (
    !login.ok &&
    bridge?.page &&
    !bridge.page.isClosed?.() &&
    isRetryableLoginFailure(login)
  ) {
    login = await tStep("login_bridge_final", attemptLoginViaBridge);
  }

  if (!login.ok) {
    await closeBridge();
    return {
      ok: false,
      steps,
      error: login.note || "login failed",
      failedStep: "login",
      restrictedType: login.restrictedType,
      checkoutStage: "pre_cart",
      cookies: ctx.jar?.dump?.() ?? {},
      via: "http",
    };
  }

  // Confirm auth
  const member = await tStep("member_refresh", async () => {
    const { status, json } = await session.apiJson("GET", "/api/context/member/refresh", {
      referer: `${session.base}/`,
    });
    const memberNo = json?.memberNo || null;
    if (json?.csrfToken) session.state.csrfToken = json.csrfToken;
    return {
      ok: status === 200 && Boolean(memberNo),
      status,
      note: memberNo ? `member ${memberNo}` : `refresh ${status}`,
      memberNo,
    };
  });

  if (!member.ok) {
    await closeBridge();
    return {
      ok: false,
      steps,
      error: member.note || "member refresh failed",
      failedStep: "member_refresh",
      checkoutStage: "pre_cart",
      via: "http",
    };
  }

  // Vault / drop prep: prove login same day without ATC.
  if (opts.loginCheckOnly === true) {
    await closeBridge();
    return {
      ok: true,
      steps,
      loginCheck: true,
      dryRun: true,
      checkoutStage: "login_ok",
      note: `login proven ${email}`,
      account: { email, status: "ready" },
      cookies: ctx.jar?.dump?.() ?? {},
      via: "http",
    };
  }

  // Ensure a shipping address exists for GE (fresh agen often has none → checkout_address).
  // Soft: continue even if this fails — GE can still fill from the desktop profile.
  const shipProfile = profileFromTask(task);
  await tStep("shipping_ensure", async () => {
    try {
      const list = await session.apiJson("GET", "/api/my/shippingAddresses", {
        referer: `${session.base}/mypage`,
      });
      const rows = Array.isArray(list.json)
        ? list.json
        : list.json?.shippingAddresses || list.json?.items || [];
      if (Array.isArray(rows) && rows.length > 0) {
        return { ok: true, status: list.status, note: `shipping already ${rows.length}` };
      }
      const phoneDigits = String(shipProfile.phone || "")
        .replace(/\D/g, "")
        .replace(/^61/, "")
        .replace(/^0/, "")
        .slice(-9);
      // API wants nested ShippingAddressInfo (see BANDAI_AU_MODULE.md) — flat
      // countryCode/address1 at root returns HTTP 400 Invalid request content
      // and then GetCartToken fails even when login/cart succeed.
      const address = {
        countryCode: "AU",
        zipCode: String(shipProfile.zip || shipProfile.postcode || "4160")
          .replace(/\D/g, "")
          .slice(0, 4),
        address1: String(shipProfile.address1 || "").trim() || "133 Allenby Road",
        address2: "",
        address3: String(shipProfile.city || "").trim() || "Alexandra Hills",
        address4: "",
        address5: String(shipProfile.province || shipProfile.state || "QLD")
          .trim()
          .toUpperCase()
          .slice(0, 3) || "QLD",
      };
      const body = {
        name: {
          name1: String(shipProfile.first_name || shipProfile.firstName || "Alex").trim(),
          name2: String(shipProfile.last_name || shipProfile.lastName || "Buyer").trim(),
        },
        address,
        areaCode: "AU",
        defaultFlag: true,
      };
      // Bandai rejects phone1 with wrong shape (HTTP 400 Invalid request content).
      if (phoneDigits.length === 9) {
        body.phone1 = { countryNo: "61", phoneNo: phoneDigits };
      }
      const { status, json } = await session.apiJson("POST", "/api/my/shippingAddresses", {
        body,
        referer: `${session.base}/mypage`,
      });
      const err =
        json?.detail ||
        json?.title ||
        json?.error ||
        json?.message ||
        (typeof json === "string" ? json : null);
      return {
        ok: status >= 200 && status < 300,
        status,
        note: err || `shipping ${status}`,
      };
    } catch (e) {
      return { ok: false, status: null, note: e?.message || String(e) };
    }
  });

  if (chanceOnly) {
    await closeBridge();
    return { ok: true, steps, via: "http" };
  }

  // Pay-from-held-cart: skip ATC race; verify live cart line, then checkout → GE.
  const payFromCart =
    task.bandaiPayFromCart === true ||
    String(task.bandaiMode || "").toLowerCase() === "pay_cart";

  // ── Product ────────────────────────────────────────────────────────────
  // Lab 2026-07-23: p8komysnbc-* mint for addToCart works on /login and /cart
  // but NOT on /item/* (avail=false PDP). Fast path skips item nudge and keeps
  // the bridge on login for ATC mint (~3–4s saved + mint reliability).
  if (bridge && !fastAtc && !payFromCart) {
    const pdpNavT0 = Date.now();
    await bridge.goto(`${session.base}/item/${encodeURIComponent(productCode)}`, {
      settleMs: f5SettleMs,
    });
    const csrf = await bridge.csrfToken();
    if (csrf) session.state.csrfToken = csrf;
    const c = await bridge.cookies();
    if (c && ctx.jar?.load) ctx.jar.load({ ...ctx.jar.dump(), ...c });
    steps.push({
      step: "f5_pdp_nudge",
      ok: true,
      status: null,
      ms: Date.now() - pdpNavT0,
      note: `goto item/${productCode} settle=${f5SettleMs}ms`,
    });
  } else if (bridge && (fastAtc || payFromCart)) {
    steps.push({
      step: "f5_pdp_nudge",
      ok: true,
      status: null,
      ms: 0,
      note: payFromCart
        ? "skipped item goto (payFromCart — verify live cart)"
        : "skipped item goto (fastAtc; mint ATC from login/cart context)",
    });
  }

  // Await parallel public NAI resolve (started with F5) before product_get gate.
  if (naiResolvePromise && !backendAreaItemNo) {
    const resolved = await naiResolvePromise;
    if (resolved?.ok && resolved.areaItemNo) {
      backendAreaItemNo = resolved.areaItemNo;
      steps.push({
        step: "nai_resolve",
        ok: true,
        status: 200,
        ms: resolved.ms ?? null,
        note: `${resolved.note || resolved.areaItemNo} attempts=${resolved.attempts || 1} (parallel; skip product_get)`,
      });
    } else {
      steps.push({
        step: "nai_resolve",
        ok: false,
        status: resolved?.status ?? null,
        ms: resolved?.ms ?? null,
        note: `public resolve failed: ${resolved?.error || "n/a"} → product_get fallback`,
      });
    }
  }

  // Reuse held-cart / task NAI only when it belongs to THIS product.
  // upsertTaskRow clears heldCart when the task SKU changes, so on payFromCart
  // a task-scoped hold is trusted even if productCode was never stamped.
  const heldMatchesProduct = (() => {
    const held = task.heldCart;
    if (!held || typeof held !== "object") return false;
    const want = String(productCode || "").toUpperCase();
    if (!want) return false;
    const heldCodes = [held.productCode, held.sku]
      .filter(Boolean)
      .map((x) => String(x).toUpperCase());
    // Explicit conflicting SKU on the hold → never reuse (cross-SKU hijack).
    if (heldCodes.length && !heldCodes.includes(want)) return false;
    if (heldCodes.includes(want)) return true;
    const heldNai = String(held.areaItemNo || "").toUpperCase();
    const resolvedNai = String(backendAreaItemNo || "").toUpperCase();
    if (heldNai && resolvedNai && heldNai === resolvedNai) return true;
    // Retry pay: hold lives on this task; resolve may be skipped when NAI already set.
    if (payFromCart && heldNai) return true;
    return false;
  })();
  // Trust task NAI when watch SKU matches, or watch SKU is empty (PDP-only tasks).
  const taskSku = String(task.bandaiWatchSku || "").toUpperCase();
  const wantSku = String(productCode || "").toUpperCase();
  const taskNaiMatches =
    Boolean(task.bandaiAreaItemNo) &&
    (/^NAI/i.test(String(task.bandaiAreaItemNo)) || /^AAI/i.test(String(task.bandaiAreaItemNo))) &&
    Boolean(wantSku) &&
    (!taskSku || taskSku === wantSku);

  const pdpLookup = await resolveAreaItemNo(session, productCode, tStep, {
    fallbackAreaItemNo:
      backendAreaItemNo ||
      (taskNaiMatches ? task.bandaiAreaItemNo : null) ||
      (heldMatchesProduct ? task.heldCart?.areaItemNo : null),
  });
  if ((!pdpLookup.ok || !pdpLookup.areaItemNo) && !payFromCart) {
    await closeBridge();
    return {
      ok: false,
      steps,
      error: pdpLookup.note || "product lookup failed",
      failedStep: "product_get",
      checkoutStage: "pre_cart",
      via: "http",
    };
  }
  const pdp = {
    ok: true,
    areaItemNo:
      // Prefer explicit / auto-resolved backend NAI for ATC; else product_get / frontend.
      backendAreaItemNo ||
      pdpLookup.areaItemNo ||
      (taskNaiMatches ? task.bandaiAreaItemNo : null) ||
      task.areaItemNo ||
      (heldMatchesProduct ? task.heldCart?.areaItemNo : null) ||
      productCode,
    title: pdpLookup.title || productCode,
    productCode,
    frontendCode: productCode,
  };

  const qty = Math.max(1, Math.min(5, Number(task.qty) || 1));
  const atcBodyObj = [{ areaItemNo: pdp.areaItemNo, qty }];
  const atcBody = JSON.stringify(atcBodyObj);

  let atc;
  let cartHoldAt = Date.now();
  let atcWallMs = 0;

  if (payFromCart) {
    // Only verify THIS product's line. Including a foreign held NAI here made
    // verify succeed on a stale cart from another SKU, then hang on pay retry.
    const cartIds = [
      pdp.areaItemNo,
      productCode,
      ...(taskNaiMatches ? [task.bandaiAreaItemNo] : []),
      ...(heldMatchesProduct
        ? [task.heldCart?.areaItemNo, task.heldCart?.productCode].filter(Boolean)
        : []),
    ].filter(Boolean);
    atc = await tStep("held_cart_verify", async () => {
      let again = await session.apiJson("GET", "/api/cart/detail", {
        referer: `${session.base}/cart`,
      });
      let line = findCartLineAny(again.json, cartIds);
      if (!line?.cartItemSn) {
        await sleepMs(500);
        again = await session.apiJson("GET", "/api/cart/detail", {
          referer: `${session.base}/cart`,
        });
        line = findCartLineAny(again.json, cartIds);
      }
      const lines = listCartLines(again.json);
      if (!line?.cartItemSn) {
        return {
          ok: false,
          status: again.status,
          note: `held cart empty for [${cartIds.join(",")}] cart=[${lines
            .map((l) => l.areaItemNo || l.productCode || "?")
            .join(",")}]`,
          json: again.json,
          cartLines: lines,
          heldCartGone: true,
        };
      }
      return {
        ok: true,
        status: again.status,
        note: `held cart line=${line.cartItemSn} aino=${line.areaItemNo} cartSn=${line.cartSn}`,
        json: { items: [{ cartLineItemSn: line.cartItemSn, addedNewCart: false }] },
        hit: line,
        cartLines: lines,
      };
    });
    if (!atc.ok) {
      await closeBridge();
      return withHeldCartMeta({
        ok: false,
        steps,
        failedStep: "held_cart_verify",
        error: atc.note,
        checkoutStage: "held_cart_gone",
        heldCartGone: true,
        heldPayRetry: false,
        areaItemNo: pdp.areaItemNo,
        title: pdp.title,
        productCode,
        cookies: ctx.jar?.dump?.() ?? {},
        via: "http",
      });
    }
    if (atc.hit?.areaItemNo) pdp.areaItemNo = atc.hit.areaItemNo;
    cartHoldAt = Number(task.heldCart?.cartHoldAt) || Date.now();
    steps.push({
      step: "cart_hold",
      ok: true,
      status: 200,
      ms: 0,
      note: `payFromCart — live line held (pay window ~${Math.round(BANDAI_PAY_WINDOW_MS / 60_000)}min)`,
    });
    ctx.onProgress?.("cart_hold", steps[steps.length - 1].note);
  } else {
  // Pre-ATC cart peek costs a RTT; skip on fast path (drop race) — except
  // placeOrder, where a stuck PreOrder line SoftBlocks /checkout → GetCartToken.
  let existing = null;
  if (!fastAtc || placeOrder) {
    const cartBefore = await session.apiJson("GET", "/api/cart/detail", {
      referer: `${session.base}/cart`,
    });
    const cartIds = [pdp.areaItemNo, productCode].filter(Boolean);
    existing =
      findCartLine(cartBefore.json, pdp.areaItemNo) ||
      (placeOrder && cartIds.length ? findCartLineAny(cartBefore.json, cartIds) : null);
  }

  atc = await tStep("addToCart", async () => {
    if (existing?.cartItemSn && !placeOrder) {
      return {
        ok: true,
        status: 200,
        note: `already in cart line=${existing.cartItemSn} qty=${existing.qty}`,
        json: { items: [{ cartLineItemSn: existing.cartItemSn, addedNewCart: false }] },
      };
    }
    // placeOrder + stale line: drop it so the ATC loop can mint a fresh cart
    // (stuck PreOrder lines SoftBlock /checkout → GetCartToken fail).
    if (existing?.cartItemSn && placeOrder) {
      try {
        const remPath = `/api/cart/removeCartLineItems?cartLineItemSns=${encodeURIComponent(existing.cartItemSn)}`;
        await session.apiJson("DELETE", remPath, { referer: `${session.base}/cart` });
      } catch {
        /* continue into ATC */
      }
      existing = null;
    }
    // Undici login/shipping/cart DELETE update the jar — resync into the F5
    // bridge before minting ATC sensors or the probe runs on a stale SESSION.
    if (bridge && ctx.jar?.dump) {
      try {
        await bridge.syncCookies(ctx.jar.dump());
      } catch {
        /* ignore */
      }
    }
    const maxAttempts = Math.max(
      1,
      Math.min(5, Number(task.bandaiAtcRetries ?? process.env.BANDAI_ATC_RETRIES) || 3),
    );
    const attempts = [];
    let last = null;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      let sensors = {};
      if (bridge) {
        let mint = await bridge.mint("POST", "/api/cart/addToCart", {
          body: atcBody,
          contentType: "application/json",
          csrf: session.state.csrfToken,
        });
        if (!mint.ok) {
          try {
            await bridge.page.waitForTimeout(800);
          } catch {
            /* ignore */
          }
          mint = await bridge.mint("POST", "/api/cart/addToCart", {
            body: atcBody,
            contentType: "application/json",
            csrf: session.state.csrfToken || (await bridge.csrfToken()),
          });
        }
        sensors = mint.sensors || {};
        const c = await bridge.cookies();
        if (c && ctx.jar?.load) ctx.jar.load({ ...ctx.jar.dump(), ...c });
        if (!mint.ok) {
          last = { ok: false, status: null, note: `ATC sensor mint failed: ${mint.note}` };
          attempts.push({ attempt, ...last });
          if (attempt < maxAttempts) await sleepMs(400 * attempt);
          continue;
        }
      }
      let status;
      let json;
      let res;
      try {
        ({ status, json, res } = await session.apiJson("POST", "/api/cart/addToCart", {
          body: atcBodyObj,
          referer: `${session.base}/item/${productCode}`,
          extraHeaders: sensors,
        }));
      } catch (e) {
        last = {
          ok: false,
          status: null,
          note: `ATC throw: ${e?.message || e}`,
        };
        attempts.push({ attempt, ...last });
        if (attempt < maxAttempts) await sleepMs(500 * attempt);
        continue;
      }
      const err = json?.detail || json?.errorCode || json?.error || json?.message || null;
      const textHint = !json ? await readText(res).then((t) => t.slice(0, 80)) : "";
      // Preallocation / MaxPurchaseQty: reuse THIS SKU's line if present.
      // EndOfSale / SoldOut: reuse only — do not delete other lines (true OOS).
      const cartIds = [pdp.areaItemNo, productCode].filter(Boolean);
      const errStr = String(err || "");
      if (
        /CouldNotAddToCartBy(MaxPurchaseQty|Preallocation|EndOfSale|SoldOut|OutOfStock)/i.test(
          errStr,
        )
      ) {
        let again = await session.apiJson("GET", "/api/cart/detail", {
          referer: `${session.base}/cart`,
        });
        let line = findCartLineAny(again.json, cartIds);
        if (!line?.cartItemSn) {
          await sleepMs(600);
          again = await session.apiJson("GET", "/api/cart/detail", {
            referer: `${session.base}/cart`,
          });
          line = findCartLineAny(again.json, cartIds);
        }
        if (line?.cartItemSn) {
          // Stale PreOrder lines SoftBlock cart_checkout (501) → GetCartToken fail.
          // On placeOrder, drop the line once and re-ATC for a fresh checkout session.
          const alreadyRefreshed = attempts.some((a) =>
            /refreshed stale cart line/i.test(String(a?.note || "")),
          );
          if (placeOrder && !alreadyRefreshed && attempt < maxAttempts) {
            const remPath = `/api/cart/removeCartLineItems?cartLineItemSns=${encodeURIComponent(line.cartItemSn)}`;
            const rem = await session.apiJson("DELETE", remPath, {
              referer: `${session.base}/cart`,
            });
            attempts.push({
              attempt,
              ok: false,
              status,
              note: `refreshed stale cart line=${line.cartItemSn} rem=${rem.status}`,
            });
            await sleepMs(400);
            continue;
          }
          return {
            ok: true,
            status,
            note: `${err} → using cart line=${line.cartItemSn} aino=${line.areaItemNo}`,
            json: { items: [{ cartLineItemSn: line.cartItemSn, addedNewCart: false }] },
            attempts,
            cartLines: listCartLines(again.json),
          };
        }
        // Clear foreign leftovers only on hold/qty conflicts — never on true OOS.
        const mayClearForeign = /CouldNotAddToCartBy(MaxPurchaseQty|Preallocation)/i.test(errStr);
        const wantSet = new Set(cartIds.map((x) => String(x).toUpperCase()));
        const foreign = listCartLines(again.json).filter((l) => {
          if (!l.cartItemSn) return false;
          const ids = [l.areaItemNo, l.productCode].filter(Boolean).map((x) => String(x).toUpperCase());
          return !ids.some((id) => wantSet.has(id));
        });
        const alreadyCleared = attempts.some((a) =>
          /cleared foreign cart/i.test(String(a?.note || "")),
        );
        if (mayClearForeign && foreign.length && !alreadyCleared && attempt < maxAttempts) {
          const sns = foreign.map((l) => l.cartItemSn).filter(Boolean);
          const remPath = `/api/cart/removeCartLineItems?cartLineItemSns=${encodeURIComponent(sns.join(","))}`;
          const rem = await session.apiJson("DELETE", remPath, {
            referer: `${session.base}/cart`,
          });
          last = {
            ok: false,
            status,
            note: `${err} → cleared foreign cart=[${foreign
              .map((l) => l.areaItemNo || l.productCode || "?")
              .join(",")}] rem=${rem.status}`,
            json,
            cartLines: foreign,
          };
          attempts.push({
            attempt,
            ok: false,
            status,
            note: String(last.note || "").slice(0, 160),
          });
          await sleepMs(350);
          continue;
        }
        last = {
          ok: false,
          status,
          note: `${err} cart=[${listCartLines(again.json)
            .map((l) => l.areaItemNo || l.productCode || "?")
            .join(",")}]`,
          json,
          cartLines: listCartLines(again.json),
        };
        attempts.push({
          attempt,
          ok: false,
          status,
          note: String(last.note || "").slice(0, 140),
        });
        break; // empty cart + Preallocation ⇒ true hold/OOS, don't spray retries
      }
      const business =
        err ||
        (/PAGE NOT AVAILABLE|NETWORK CONGESTION/i.test(textHint) ? textHint.slice(0, 40) : null);
      last = {
        ok: status >= 200 && status < 300 && !/CouldNotAddToCart/i.test(String(err || "")),
        status,
        note: business || `ATC ${status}`,
        json,
      };
      attempts.push({
        attempt,
        ok: last.ok,
        status: last.status,
        note: String(last.note || "").slice(0, 120),
      });
      if (last.ok) {
        return {
          ...last,
          note:
            attempts.length > 1
              ? `${last.note} (ok attempt ${attempt}/${maxAttempts})`
              : last.note,
          attempts,
        };
      }
      // Last-chance: only proceed if THIS SKU/NAI is already in cart — never a foreign line.
      {
        const peek = await session.apiJson("GET", "/api/cart/detail", {
          referer: `${session.base}/cart`,
        });
        const held = cartIds.length ? findCartLineAny(peek.json, cartIds) : null;
        if (held?.cartItemSn) {
          const alreadyRefreshed = attempts.some((a) =>
            /refreshed stale cart line/i.test(String(a?.note || "")),
          );
          if (placeOrder && !alreadyRefreshed && attempt < maxAttempts) {
            const remPath = `/api/cart/removeCartLineItems?cartLineItemSns=${encodeURIComponent(held.cartItemSn)}`;
            const rem = await session.apiJson("DELETE", remPath, {
              referer: `${session.base}/cart`,
            });
            attempts.push({
              attempt,
              ok: false,
              status: last.status,
              note: `refreshed stale cart line=${held.cartItemSn} rem=${rem.status}`,
            });
            await sleepMs(400);
            continue;
          }
          return {
            ok: true,
            status: last.status,
            note: `${last.note} → cart already has line=${held.cartItemSn} aino=${held.areaItemNo || "?"}`,
            json: { items: [{ cartLineItemSn: held.cartItemSn, addedNewCart: false }] },
            attempts,
            cartLines: listCartLines(peek.json),
          };
        }
      }
      if (
        attempt < maxAttempts &&
        isRetryableAtcFailure({ status, err, textHint })
      ) {
        await sleepMs(450 * attempt + Math.floor(Math.random() * 200));
        continue;
      }
      break;
    }
    return {
      ...(last || { ok: false, note: "ATC failed" }),
      note: `${last?.note || "ATC failed"} (attempts=${attempts.length})`,
      attempts,
    };
  });

  // SoftBlock recovery: mint+abort → undici ATC can 501 after a good login when
  // the bridge session drifted. Complete ATC inside the F5 bridge (not pay).
  if (
    !atc.ok &&
    bridge?.page &&
    placeOrder &&
    isRetryableAtcFailure({ status: atc.status, err: atc.note, textHint: atc.note })
  ) {
    atc = await tStep("addToCart_bridge", async () => {
      if (ctx.jar?.dump) {
        try {
          await bridge.syncCookies(ctx.jar.dump());
        } catch {
          /* ignore */
        }
      }
      try {
        await bridge.goto(`${session.base}/cart`, { settleMs: Math.min(f5SettleMs, 2000) });
      } catch {
        /* continue — login context may still mint */
      }
      const csrf = session.state.csrfToken || (await bridge.csrfToken());
      let result;
      try {
        result = await bridge.page.evaluate(
          async ({ body, csrf: tok, areaCode }) => {
            const res = await fetch("/api/cart/addToCart", {
              method: "POST",
              headers: {
                accept: "application/json, text/plain, */*",
                "content-type": "application/json",
                "x-g1-area-code": areaCode,
                "x-requested-with": "XMLHttpRequest",
                ...(tok ? { "x-csrf-token": tok } : {}),
              },
              body,
              credentials: "include",
            });
            const text = await res.text();
            let json = null;
            try {
              json = JSON.parse(text);
            } catch {
              /* ignore */
            }
            return {
              status: res.status,
              json,
              text: text.slice(0, 200),
              restrictedType: res.headers.get("x-restricted-type"),
            };
          },
          { body: atcBody, csrf, areaCode: session.area },
        );
      } catch (e) {
        return {
          ok: false,
          status: null,
          note: `bridge ATC throw: ${e?.message || e}`,
        };
      }
      const cookies = await bridge.cookies();
      if (cookies && ctx.jar?.load) {
        ctx.jar.load({ ...(ctx.jar.dump?.() || {}), ...cookies });
      }
      const cartIds = [pdp.areaItemNo, productCode].filter(Boolean);
      const detail = await session.apiJson("GET", "/api/cart/detail", {
        referer: `${session.base}/cart`,
      });
      const line = cartIds.length ? findCartLineAny(detail.json, cartIds) : null;
      const err =
        result?.json?.detail ||
        result?.json?.errorCode ||
        result?.json?.error ||
        result?.json?.message ||
        null;
      const status = Number(result?.status) || null;
      const ok =
        Boolean(line?.cartItemSn) ||
        (status >= 200 &&
          status < 300 &&
          !/CouldNotAddToCart/i.test(String(err || "")));
      return {
        ok,
        status,
        note: ok
          ? `ATC ok via=bridge line=${line?.cartItemSn || "?"}`
          : `bridge ATC ${status}${err ? ` ${err}` : ""}`,
        json: line?.cartItemSn
          ? { items: [{ cartLineItemSn: line.cartItemSn, addedNewCart: true }] }
          : result?.json,
        cartLines: listCartLines(detail.json),
      };
    });
  }

  if (!atc.ok) {
    await closeBridge();
    return {
      ok: false,
      steps,
      failedStep: "addToCart",
      error: atc.note,
      checkoutStage: "cart",
      areaItemNo: pdp.areaItemNo,
      title: pdp.title,
      productCode,
      cookies: ctx.jar?.dump?.() ?? {},
      via: "http",
      atcWallMs: Date.now() - atcT0,
    };
  }

  atcWallMs = Date.now() - atcT0;
  cartHoldAt = Date.now();
  steps.push({
    step: "cart_hold",
    ok: true,
    status: 200,
    ms: atcWallMs,
    note: `wall→ATC ${atcWallMs}ms fastAtc=${fastAtc} settle=${f5SettleMs}ms (pay window ~30min)`,
  });
  ctx.onProgress?.("cart_hold", steps[steps.length - 1].note);
  }

  // ── Cart detail + qty normalize ────────────────────────────────────────
  let cart = await tStep("cart_detail", async () => {
    if (payFromCart && atc.hit?.cartSn && atc.hit?.cartItemSn) {
      return {
        ok: true,
        status: 200,
        note: `cartSn ${atc.hit.cartSn} line=${atc.hit.cartItemSn} type=${atc.hit.cartType} (payFromCart)`,
        hit: atc.hit,
        json: atc.json,
      };
    }
    const { status, json } = await session.apiJson("GET", "/api/cart/detail", {
      referer: `${session.base}/cart`,
    });
    let hit = findCartLineAny(json, [pdp.areaItemNo, productCode].filter(Boolean));
    if (hit?.cartItemSn && Number(hit.qty) > qty) {
      let sensors = {};
      const modPath = `/api/cart/modifyCartItem?cartItemSn=${encodeURIComponent(hit.cartItemSn)}&qty=${qty}`;
      if (bridge) {
        // Bridge page should be on cart for path context
        await bridge.goto(`${session.base}/cart`);
        const mint = await bridge.mint("PUT", modPath, {
          csrf: session.state.csrfToken,
        });
        sensors = mint.sensors || {};
      }
      const mod = await session.apiJson("PUT", modPath, {
        referer: `${session.base}/cart`,
        extraHeaders: sensors,
      });
      steps.push({
        step: "cart_qty_normalize",
        ok: mod.status >= 200 && mod.status < 300,
        status: mod.status,
        ms: 0,
        note: `qty ${hit.qty}→${qty}`,
      });
      const again = await session.apiJson("GET", "/api/cart/detail", {
        referer: `${session.base}/cart`,
      });
      hit = findCartLine(again.json, pdp.areaItemNo);
      return {
        ok: again.status === 200 && Boolean(hit?.cartSn) && Boolean(hit?.cartItemSn),
        status: again.status,
        note: hit
          ? `cartSn ${hit.cartSn} line=${hit.cartItemSn} type=${hit.cartType}`
          : `cart ${again.status}`,
        hit,
        json: again.json,
      };
    }
    return {
      ok: status === 200 && Boolean(hit?.cartSn) && Boolean(hit?.cartItemSn),
      status,
      note: hit
        ? `cartSn ${hit.cartSn} line=${hit.cartItemSn} type=${hit.cartType} lines=${listCartLines(json).length}`
        : `cart ${status}`,
      hit,
      json,
    };
  });

  const cartSn = cart.hit?.cartSn || null;
  const cartId = cart.hit?.cartId || null;
  const cartItemSn = cart.hit?.cartItemSn || atc.json?.items?.[0]?.cartLineItemSn || null;

  if (!cart.ok || !cartSn || !cartItemSn) {
    await closeBridge();
    return {
      ok: false,
      steps,
      failedStep: "cart_detail",
      error: cart.note || "cart line missing",
      checkoutStage: "cart",
      areaItemNo: pdp.areaItemNo,
      title: pdp.title,
      cookies: ctx.jar?.dump?.() ?? {},
      via: "http",
    };
  }

  // Optional early stop before checkout POST (default continues to checkoutSn).
  // Modes: bandaiMode=atc|atc_only, or explicit bandaiStopAtCart.
  const modeLc = String(task.bandaiMode || task.mode || "").toLowerCase();
  const atcOnly =
    modeLc === "atc" || modeLc === "atc_only" || task.bandaiStopAtCart === true;
  if (atcOnly && !(placeOrder && (opts.placeOrderGe || opts.placeOrderGeHttp))) {
    await closeBridge();
    return {
      ok: true,
      steps,
      atcWallMs,
      atcOnly: true,
      checkoutStage: "cart_hold",
      dryRun: true,
      areaItemNo: pdp.areaItemNo,
      productCode,
      cartSn,
      cartId,
      cartItemSn,
      title: pdp.title,
      finalUrl: `${session.base}/cart`,
      cookies: ctx.jar?.dump?.() ?? {},
      note:
        modeLc === "atc" || modeLc === "atc_only"
          ? "HTTP ATC + cart ok — ATC-only mode (no checkout)"
          : "HTTP ATC + cart ok — stopped before checkout (bandaiStopAtCart)",
      via: "http",
      globaleMid: GLOBALE_MID,
      cartHoldAt,
      payWindowMs: BANDAI_PAY_WINDOW_MS,
      // ok:true + heldPayRetry → desktop persists cart + shows pay-window countdown / Retry pay.
      heldPayRetry: true,
      heldCart: {
        cartSn,
        cartId,
        cartItemSn,
        areaItemNo: pdp.areaItemNo,
        productCode,
        title: pdp.title,
        cartHoldAt,
        payWindowMs: BANDAI_PAY_WINDOW_MS,
      },
    };
  }

  // ── Legacy Safe: SPA Proceed + GE (opt-in only) ─────────────────────────
  // Default Safe is hybrid: HTTP cart_checkout + GetCartToken, then PW Pay.
  // bandaiSafeSpaProceed=true restores the old cart→Proceed GEM boot path.
  if (
    placeOrder &&
    opts.placeOrderGe === true &&
    !opts.placeOrderGeHttp &&
    task.bandaiSafeSpaProceed === true
  ) {
    const card = opts.card;
    if (!bridge) {
      return {
        ok: false,
        steps,
        failedStep: "f5_bridge",
        error: "placeOrder GE requires F5 bridge (bandaiF5Bridge)",
        checkoutStage: "cart",
        areaItemNo: pdp.areaItemNo,
        cartSn,
        cartItemSn,
        via: "http",
      };
    }
    try {
      const jarDump = ctx.jar?.dump?.() || {};
      await bridge.syncCookies(jarDump);
      try {
        await bridge.context.addCookies(
          Object.entries(jarDump).map(([name, value]) => ({
            name,
            value: String(value),
            domain: ".p-bandai.com",
            path: "/",
          })),
        );
      } catch {
        /* ignore */
      }
      steps.push({
        step: "bridge_cookie_sync",
        ok: Object.keys(jarDump).length > 0,
        status: null,
        ms: 0,
        note: `legacy SPA Proceed path cookies=${Object.keys(jarDump).length}`,
      });

      const geOut = await browserBandaiGeFromCart({
        page: bridge.page,
        context: bridge.context,
        base: session.base,
        card,
        entry: "cart",
        wait3dsMs: Number(task.wait3dsMs) || 45_000,
        desktopTaskId: task.desktopTaskId || task.taskId || task.id || null,
        desktopRunId: task.desktopRunId || task.runId || null,
        desktopAttempt: task.desktopAttempt || task.attempt || null,
        executorTaskId: task.executorTaskId || ctx?.taskId || null,
        onProgress: (event, row) => {
          try {
            ctx.onProgress?.(event, row?.note || row?.paymentStatus || event, row);
          } catch {
            /* ignore */
          }
        },
        meta: {
          areaItemNo: pdp.areaItemNo,
          cartSn,
          cartId,
          cartItemSn,
          title: pdp.title,
        },
      });
      if (Array.isArray(geOut.steps)) {
        for (const s of geOut.steps) steps.push(s);
      }
      if (geOut.cookies && ctx.jar?.load) ctx.jar.load(geOut.cookies);
      await closeBridge();
      return withHeldCartMeta({
        ok: Boolean(geOut.ok),
        steps,
        timeline: geOut.timeline || [],
        failedStep: geOut.failedStep || null,
        error: geOut.ok ? null : geOut.error || geOut.note || null,
        checkoutStage: geOut.checkoutStage || "tokenize",
        dryRun: false,
        areaItemNo: pdp.areaItemNo,
        cartSn,
        cartId,
        cartItemSn,
        checkoutSn: geOut.checkoutSn || null,
        title: pdp.title,
        paymentStatus: geOut.paymentStatus,
        declineSnippet: geOut.declineSnippet || null,
        reached3ds: geOut.reached3ds ?? null,
        threeDsUrl: geOut.threeDsUrl || null,
        payClickCount: geOut.payClickCount,
        sawAuthWire: geOut.sawAuthWire,
        chargeReqCount: geOut.chargeReqCount ?? null,
        transactionId: geOut.transactionId ?? null,
        issuerRedirectUrl: geOut.issuerRedirectUrl ?? null,
        undiciAttempts: geOut.undiciAttempts ?? null,
        responseLost: Boolean(geOut.responseLost),
        paymentAttempted: Boolean(
          geOut.paymentAttempted ||
            geOut.responseLost ||
            Number(geOut.chargeReqCount ?? geOut.undiciAttempts ?? 0) >= 1,
        ),
        blockedChargeReqCount: geOut.blockedChargeReqCount ?? null,
        geNetTail: geOut.geNetTail ?? null,
        finalUrl: geOut.finalUrl || `${session.base}/orderdetails`,
        cookies: geOut.cookies || ctx.jar?.dump?.() || {},
        note: geOut.note,
        via: "http+ge",
        globaleMid: GLOBALE_MID,
        orderNumber: geOut.orderNumber ?? null,
        elapsedMs: geOut.elapsedMs,
        productCode,
        cartHoldAt,
        payWindowMs: BANDAI_PAY_WINDOW_MS,
        payFromCart: Boolean(payFromCart),
      });
    } catch (e) {
      await closeBridge();
      return withHeldCartMeta({
        ok: false,
        steps,
        failedStep: "ge_payment",
        error: e?.message || String(e),
        checkoutStage: "tokenize",
        areaItemNo: pdp.areaItemNo,
        productCode,
        cartSn,
        cartId,
        cartItemSn,
        via: "http+ge",
        cartHoldAt,
        payWindowMs: BANDAI_PAY_WINDOW_MS,
        payFromCart: Boolean(payFromCart),
      });
    }
  }

  // ── Cart checkout → checkoutSn (still HTTP; GE iframe separate) ────────
  let preloadSuffix = task.globaleMerchantCartTokenSuffix || null;
  let preloadSource = preloadSuffix ? "task" : null;
  if (!preloadSuffix && bridge) {
    await bridge.goto(`${session.base}/cart`);
    try {
      // SPA may paint before PRELOAD_DATA is hydrated — wait briefly.
      await bridge.page.waitForFunction(
        () => {
          const p = window.PRELOAD_DATA || window.__PRELOAD_DATA__ || {};
          return Boolean(
            p.globaleMerchantCartTokenSuffix ||
              window.globaleMerchantCartTokenSuffix ||
              document.documentElement.innerHTML.includes("globaleMerchantCartTokenSuffix"),
          );
        },
        { timeout: 12_000 },
      );
    } catch {
      /* fall through to HTML scrape */
    }
    try {
      preloadSuffix = await bridge.page.evaluate(() => {
        const p = window.PRELOAD_DATA || window.__PRELOAD_DATA__ || {};
        return (
          p.globaleMerchantCartTokenSuffix ||
          window.globaleMerchantCartTokenSuffix ||
          null
        );
      });
      if (preloadSuffix) preloadSource = "bridge_eval";
    } catch {
      /* ignore */
    }
    if (!preloadSuffix) {
      const html = await bridge.page.content();
      preloadSuffix = extractPreloadSuffix(html);
      if (preloadSuffix) preloadSource = "bridge_html";
      if (!preloadSuffix) {
        try {
          fs.writeFileSync("/tmp/bandai-cart-preload-miss.html", html.slice(0, 400_000));
        } catch {
          /* ignore */
        }
      }
    }
  }
  if (!preloadSuffix) {
    // Guest cart HTML via undici
    const { request } = await import("../http.js");
    const nav = await request(
      `${session.base}/cart`,
      {
        headers: {
          "user-agent": session.state.userAgent,
          accept: "text/html,*/*",
          "accept-language": "en-AU,en;q=0.9",
        },
      },
      ctx,
    );
    const html = await readText(nav);
    preloadSuffix = extractPreloadSuffix(html);
    if (preloadSuffix) preloadSource = "undici_html";
    if (!preloadSuffix) {
      try {
        fs.writeFileSync("/tmp/bandai-cart-preload-miss-undici.html", html.slice(0, 400_000));
      } catch {
        /* ignore */
      }
    }
  }

  steps.push({
    step: "cart_preload_suffix",
    ok: Boolean(preloadSuffix),
    status: null,
    ms: 0,
    note: preloadSuffix
      ? `suffix ${String(preloadSuffix).slice(0, 24)}… via=${preloadSource}`
      : `EMPTY via=${preloadSource || "none"} (see /tmp/bandai-cart-preload-miss*.html)`,
  });

  const merchantCartToken = cartId && preloadSuffix
    ? `${cartId}_Checkout_${preloadSuffix}`
    : cartId
      ? `${cartId}_Checkout_`
      : null;

  const checkoutBody = {
    merchantCartToken,
    shippingAreaCode: task.shippingAreaCode || session.area,
    defaultAreaCode: task.defaultAreaCode || session.area,
    items: [{ cartItemSn }],
  };

  const checkoutPath = `/api/cart/${encodeURIComponent(cartSn)}/checkout`;
  const checkoutBodyJson = JSON.stringify(checkoutBody);

  async function attemptCheckoutUndici() {
    if (!merchantCartToken) {
      return { ok: false, status: null, note: "missing merchantCartToken / preload suffix" };
    }
    let sensors = {};
    if (bridge) {
      // Keep bridge SESSION aligned with undici jar (login/ATC may have mutated it).
      if (ctx.jar?.dump) {
        try {
          await bridge.syncCookies(ctx.jar.dump());
        } catch {
          /* ignore */
        }
      }
      await bridge.goto(`${session.base}/cart`);
      const mint = await bridge.mint("POST", checkoutPath, {
        body: checkoutBodyJson,
        contentType: "application/json",
        csrf: session.state.csrfToken,
      });
      sensors = mint.sensors || {};
      const c = await bridge.cookies();
      if (c && ctx.jar?.load) ctx.jar.load({ ...ctx.jar.dump(), ...c });
    }
    const { status, json } = await session.apiJson("POST", checkoutPath, {
      body: checkoutBody,
      referer: `${session.base}/cart`,
      extraHeaders: sensors,
    });
    const checkoutSn = json?.checkoutSn || json?.checkoutSN || null;
    const errBits = [
      json?.error,
      json?.message,
      json?.detail,
      json?.errorCode,
      json?.title,
    ]
      .filter(Boolean)
      .map(String)
      .join(" | ");
    return {
      ok: status >= 200 && status < 300 && Boolean(checkoutSn),
      status,
      note: checkoutSn
        ? `checkoutSn ${checkoutSn} mct=${String(merchantCartToken || "").slice(0, 48)}`
        : `${errBits || `checkout ${status}`} mctSuffix=${preloadSuffix ? "yes" : "EMPTY"}`.slice(0, 220),
      checkoutSn,
      json,
      preloadSuffix,
    };
  }

  async function attemptCheckoutViaBridge() {
    if (!bridge?.page || !merchantCartToken) {
      return { ok: false, status: null, note: "bridge checkout skipped" };
    }
    if (ctx.jar?.dump) {
      try {
        await bridge.syncCookies(ctx.jar.dump());
      } catch {
        /* ignore */
      }
    }
    try {
      await bridge.goto(`${session.base}/cart`, {
        settleMs: Math.min(f5SettleMs, 2000),
      });
    } catch {
      /* continue */
    }
    const csrf = session.state.csrfToken || (await bridge.csrfToken());
    let result;
    try {
      result = await bridge.page.evaluate(
        async ({ path, body, csrf: tok, areaCode }) => {
          const res = await fetch(path, {
            method: "POST",
            headers: {
              accept: "application/json, text/plain, */*",
              "content-type": "application/json",
              "x-g1-area-code": areaCode,
              "x-requested-with": "XMLHttpRequest",
              ...(tok ? { "x-csrf-token": tok } : {}),
            },
            body,
            credentials: "include",
          });
          const text = await res.text();
          let json = null;
          try {
            json = JSON.parse(text);
          } catch {
            /* ignore */
          }
          return {
            status: res.status,
            json,
            text: text.slice(0, 220),
            restrictedType: res.headers.get("x-restricted-type"),
          };
        },
        {
          path: checkoutPath,
          body: checkoutBodyJson,
          csrf,
          areaCode: session.area,
        },
      );
    } catch (e) {
      return {
        ok: false,
        status: null,
        note: `bridge checkout throw: ${e?.message || e}`,
      };
    }
    const cookies = await bridge.cookies();
    if (cookies && ctx.jar?.load) {
      ctx.jar.load({ ...(ctx.jar.dump?.() || {}), ...cookies });
    }
    const checkoutSn = result?.json?.checkoutSn || result?.json?.checkoutSN || null;
    const status = Number(result?.status) || null;
    const errBits = [
      result?.json?.error,
      result?.json?.message,
      result?.json?.detail,
      result?.json?.errorCode,
      result?.json?.title,
    ]
      .filter(Boolean)
      .map(String)
      .join(" | ");
    return {
      ok: status >= 200 && status < 300 && Boolean(checkoutSn),
      status,
      note: checkoutSn
        ? `checkoutSn ${checkoutSn} via=bridge mct=${String(merchantCartToken || "").slice(0, 40)}`
        : `bridge checkout ${status}${errBits ? ` ${errBits}` : ""} mctSuffix=${preloadSuffix ? "yes" : "EMPTY"}`.slice(
            0,
            220,
          ),
      checkoutSn,
      json: result?.json,
      preloadSuffix,
    };
  }

  let chk = await tStep("cart_checkout", attemptCheckoutUndici);
  if (
    !chk.ok &&
    bridge?.page &&
    placeOrder &&
    isRetryableAtcFailure({ status: chk.status, err: chk.note, textHint: chk.note })
  ) {
    chk = await tStep("cart_checkout_bridge", attemptCheckoutViaBridge);
  }

  // ── HTTP GE Pay (no Playwright Pay UI): GetCartToken → hydrate → issuer ─
  // F5 bridge page kept only to mint iovation #ioBlackBox (snare.js) — not Pay.
  // GetCartToken needs merchantCartToken (cartId_Checkout_*), not checkoutSn —
  // continue even when Bandai cart_checkout 500s (stuck open checkout).
  if (placeOrder && opts.placeOrderGeHttp === true && merchantCartToken) {
    if (!chk.ok) {
      steps.push({
        step: "cart_checkout_soft",
        ok: false,
        status: chk.status,
        ms: 0,
        note: `continuing to GetCartToken despite checkout fail: ${chk.note}`,
      });
    }
    // Re-sync F5 bridge cookies → undici jar after checkout mutations (harvest gap).
    if (bridge && ctx.jar?.load) {
      try {
        const cookies = await bridge.cookies();
        if (cookies && Object.keys(cookies).length) {
          ctx.jar.load({ ...ctx.jar.dump(), ...cookies });
        }
      } catch {
        /* ignore */
      }
    }
    // Fast anti-fraud default: riskHydrate = fresh snare/Forter on a THROWAWAY
    // CartToken (never Playwright-open the pay guid — liveHtml dualed Revolut).
    // Stale noPage blackbox scored PossibleFraudDetected=True; opt-in only.
    const geNoPage =
      task.bandaiGeNoPage === true || process.env.BANDAI_GE_NO_PAGE === "1";
    let geMachineId =
      task.bandaiGeMachineId || process.env.BANDAI_GE_MACHINE_ID || null;
    if (geNoPage && !geMachineId) {
      try {
        const p = "/tmp/bandai-ge-machineId.txt";
        if (fs.existsSync(p)) {
          const raw = fs.readFileSync(p, "utf8").trim();
          if (raw.length >= 40) geMachineId = raw;
        }
      } catch {
        /* ignore */
      }
    }
    const riskHydrate =
      !geNoPage &&
      task.bandaiGeRiskHydrate !== false &&
      process.env.BANDAI_GE_RISK_HYDRATE !== "0";
    const runGeHttpPay =
      opts.useGeHttpTestFork === true ? runBandaiGeHttpPayTest : runBandaiGeHttpPay;
    if (opts.useGeHttpTestFork === true) {
      steps.push({
        step: "bandai_ge_http_fork",
        ok: true,
        note: "autocheckout_test → bandai-ge-http-test.js (prod fast untouched)",
      });
    }
    const geOut = await runGeHttpPay({
      ctx,
      page: geNoPage ? null : bridge?.page || null,
      // Force fresh mint when risk-hydrating (ignore stale file/opts mid).
      machineId: geNoPage ? geMachineId : riskHydrate ? null : geMachineId,
      riskHydrate,
      forceFreshMint: riskHydrate,
      // Forensics correlation only (desktop → /run → issuer POST).
      desktopTaskId: task.desktopTaskId || null,
      desktopRunId: task.desktopRunId || null,
      desktopAttempt: task.desktopAttempt || null,
      executorTaskId: task.taskId || null,
      merchantCartToken,
      checkoutSn: chk.checkoutSn,
      card: opts.card,
      // Desktop/imported vaults: GE form often lacks BillingFirstName — fill from profile.
      profile: shipProfile || profileFromTask(task),
      area: session.area,
      customerEmail: email,
      userAgent: session.state.userAgent,
      referer: `${session.base}/orderdetails`,
      stopBeforeIssuer: task.bandaiGeStopBeforeIssuer === true,
      forceIssuer: task.bandaiGeForceIssuer === true,
      paymentMethod: task.paymentMethod || null,
      paymentMethodId: task.paymentMethodId || null,
      gatewayId: task.gatewayId || null,
      // PayPal guest uses billing profile email/card (passed as profile + card).
      paypalHeadless: task.paypalHeadless === true,
      skipCreditCardForm:
        task.bandaiGeSkipCreditCardForm === true ||
        /^paypal/i.test(String(task.paymentMethod || "")),
      keepPageAfterIovation: task.bandaiGeKeepPage === true,
      // Fast = undici issuer (hard no Playwright pay). Page issuer is Safe/opt-in only.
      preferPageIssuer: task.bandaiGePreferPageIssuer === true,
      forceUndiciIssuer:
        task.bandaiGeUndiciIssuer === true || task.bandaiGePreferPageIssuer !== true,
      scrapeCardFormViaPage: task.bandaiGeScrapeCardFormViaPage === true,
      harvestedBridge: Boolean(
        usedHarvestedBridge || task.harvestedBridgeId || task._harvestedBridge,
      ),
      allowThinRisk:
        task.bandaiGeAllowThinRisk === true || process.env.BANDAI_GE_ALLOW_THIN_RISK === "1",
      // Throwaway mint attaches forterToken only; full GE jar merge duals.
      mergeIovationCookies: task.bandaiGeMergeIovationCookies === true,
      allowLiveCartIovation:
        task.bandaiGeAllowLiveCartIovation === true ||
        process.env.BANDAI_GE_ALLOW_LIVE_CART_IOVATION === "1",
      iovationSettleMs:
        Number(task.bandaiGeIovationSettleMs) ||
        Number(process.env.BANDAI_GE_IOVATION_SETTLE_MS) ||
        undefined,
      createTransaction:
        task.bandaiGeCreateTransaction === false
          ? false
          : task.bandaiGeCreateTransaction === true
            ? true
            : process.env.BANDAI_GE_CREATE_TRANSACTION === "0"
              ? false
              : undefined,
      issuerMode: task.bandaiGeIssuerMode || process.env.BANDAI_GE_ISSUER_MODE || undefined,
      onProgress: (event, row) => {
        try {
          ctx.onProgress?.(event, row?.note || event, row);
        } catch {
          /* ignore */
        }
      },
    });
    await closeBridge();
    if (Array.isArray(geOut.steps)) {
      for (const s of geOut.steps) steps.push(s);
    }
    return withHeldCartMeta({
      ok: Boolean(geOut.ok),
      steps,
      timeline: geOut.timeline || [],
      failedStep: geOut.failedStep || null,
      error: geOut.ok ? null : geOut.error || geOut.note || null,
      checkoutStage: geOut.checkoutStage || "tokenize",
      dryRun: geOut.dryRun ?? false,
      areaItemNo: pdp.areaItemNo,
      cartSn,
      cartId,
      cartItemSn,
      checkoutSn: chk.checkoutSn || null,
      cartToken: geOut.cartToken || null,
      title: pdp.title,
      paymentStatus: geOut.paymentStatus,
      paymentMethod: geOut.paymentMethod || task.paymentMethod || null,
      paypalApproveUrl: geOut.paypalApproveUrl || null,
      paypalGuest: geOut.paypalGuest || null,
      blockers: geOut.blockers || [],
      chargeReqCount: geOut.chargeReqCount ?? null,
      undiciAttempts: geOut.undiciAttempts ?? null,
      responseLost: Boolean(geOut.responseLost),
      paymentAttempted: Boolean(
        geOut.paymentAttempted ||
          geOut.responseLost ||
          Number(geOut.chargeReqCount ?? geOut.undiciAttempts ?? 0) >= 1 ||
          Boolean(geOut.paypalApproveUrl),
      ),
      browserIssuerBlocked: geOut.browserIssuerBlocked ?? null,
      framesNeutralized: geOut.framesNeutralized ?? null,
      isSameCartToken: geOut.isSameCartToken ?? null,
      sawAuthWire: geOut.sawAuthWire ?? null,
      transactionId: geOut.transactionId ?? null,
      timing: geOut.timing || null,
      finalUrl: geOut.finalUrl || geOut.paypalApproveUrl || `${session.base}/orderdetails`,
      cookies: ctx.jar?.dump?.() ?? {},
      note: geOut.note || null,
      via: geOut.via || "http-ge",
      globaleMid: GLOBALE_MID,
      merchantCartToken,
      orderNumber: geOut.orderNumber ?? null,
      elapsedMs: geOut.elapsedMs,
      productCode,
      cartHoldAt,
      payWindowMs: BANDAI_PAY_WINDOW_MS,
      payFromCart: Boolean(payFromCart),
});
  }

  // ── Safe hybrid: HTTP cart_checkout + GetCartToken → Playwright fill/Pay ─
  // Same mint as Fast; PW only for card UI + Pay (no SPA Proceed / GEM reboot).
  if (placeOrder && opts.placeOrderGe === true && !opts.placeOrderGeHttp && merchantCartToken) {
    const card = opts.card;
    if (!bridge) {
      await closeBridge();
      return {
        ok: false,
        steps,
        failedStep: "f5_bridge",
        error: "Safe hybrid GE requires F5 bridge (bandaiF5Bridge)",
        checkoutStage: "cart",
        areaItemNo: pdp.areaItemNo,
        cartSn,
        cartItemSn,
        via: "http",
      };
    }
    if (!chk.ok) {
      steps.push({
        step: "cart_checkout_soft",
        ok: false,
        status: chk.status,
        ms: 0,
        note: `Safe hybrid continuing to GetCartToken despite checkout fail: ${chk.note}`,
      });
    }
    if (bridge && ctx.jar?.load) {
      try {
        const cookies = await bridge.cookies();
        if (cookies && Object.keys(cookies).length) {
          ctx.jar.load({ ...ctx.jar.dump(), ...cookies });
        }
      } catch {
        /* ignore */
      }
    }

    const tokenOut = await getBandaiGeCartToken({
      ctx,
      merchantCartToken,
      merchantId: GLOBALE_MID,
      area: session.area,
      webStoreInstanceCode: session.area,
      customerEmail: email,
      cultureCode: "en-GB",
      preferedCultureCode: "en-GB",
      userAgent: session.state.userAgent,
      referer: `${session.base}/orderdetails`,
    }).catch((e) => ({
      ok: false,
      status: 0,
      ms: 0,
      bodySnippet: String(e?.message || e).slice(0, 160),
    }));
    steps.push({
      step: "ge_get_cart_token",
      ok: Boolean(tokenOut.ok && tokenOut.cartToken),
      status: tokenOut.status ?? null,
      ms: tokenOut.ms ?? 0,
      note: tokenOut.ok
        ? `Safe CartToken ${tokenOut.cartToken}`
        : `Safe GetCartToken fail ${tokenOut.bodySnippet || tokenOut.message || ""}`.slice(0, 220),
    });

    if (!tokenOut.ok || !tokenOut.cartToken) {
      await closeBridge();
      return withHeldCartMeta({
        ok: false,
        steps,
        failedStep: "ge_get_cart_token",
        error: tokenOut.isCaptcha ? "ge_cart_token_captcha" : "ge_get_cart_token_failed",
        checkoutStage: "tokenize",
        areaItemNo: pdp.areaItemNo,
        productCode,
        cartSn,
        cartId,
        cartItemSn,
        checkoutSn: chk.checkoutSn || null,
        via: "http+ge",
        cartHoldAt,
        payWindowMs: BANDAI_PAY_WINDOW_MS,
        payFromCart: Boolean(payFromCart),
      });
    }

    const checkoutV2Url = `${BANDAI_GE_WEBSERVICES}/Checkout/v2/${BANDAI_GE_ENCODED_MERCHANT}/${tokenOut.cartToken}`;
    try {
      const jarDump = ctx.jar?.dump?.() || {};
      await bridge.syncCookies(jarDump);
      try {
        await bridge.context.addCookies(
          Object.entries(jarDump).map(([name, value]) => ({
            name,
            value: String(value),
            domain: ".p-bandai.com",
            path: "/",
          })),
        );
      } catch {
        /* ignore */
      }
      steps.push({
        step: "bridge_cookie_sync",
        ok: Object.keys(jarDump).length > 0,
        status: null,
        ms: 0,
        note: `Safe hybrid HTTP→PW cookies=${Object.keys(jarDump).length} entry=checkoutV2`,
      });

      const geOut = await browserBandaiGeFromCart({
        page: bridge.page,
        context: bridge.context,
        base: session.base,
        card,
        entry: "checkoutV2",
        checkoutV2Url,
        checkoutSn: chk.checkoutSn || null,
        cartToken: tokenOut.cartToken,
        wait3dsMs: Number(task.wait3dsMs) || 45_000,
        desktopTaskId: task.desktopTaskId || task.taskId || task.id || null,
        desktopRunId: task.desktopRunId || task.runId || null,
        desktopAttempt: task.desktopAttempt || task.attempt || null,
        executorTaskId: task.executorTaskId || ctx?.taskId || null,
        onProgress: (event, row) => {
          try {
            ctx.onProgress?.(event, row?.note || row?.paymentStatus || event, row);
          } catch {
            /* ignore */
          }
        },
        meta: {
          areaItemNo: pdp.areaItemNo,
          cartSn,
          cartId,
          cartItemSn,
          title: pdp.title,
        },
      });
      if (Array.isArray(geOut.steps)) {
        for (const s of geOut.steps) steps.push(s);
      }
      if (geOut.cookies && ctx.jar?.load) ctx.jar.load(geOut.cookies);
      await closeBridge();
      return withHeldCartMeta({
        ok: Boolean(geOut.ok),
        steps,
        timeline: geOut.timeline || [],
        failedStep: geOut.failedStep || null,
        error: geOut.ok ? null : geOut.error || geOut.note || null,
        checkoutStage: geOut.checkoutStage || "tokenize",
        dryRun: false,
        areaItemNo: pdp.areaItemNo,
        cartSn,
        cartId,
        cartItemSn,
        checkoutSn: geOut.checkoutSn || chk.checkoutSn || null,
        cartToken: tokenOut.cartToken,
        title: pdp.title,
        paymentStatus: geOut.paymentStatus,
        declineSnippet: geOut.declineSnippet || null,
        reached3ds: geOut.reached3ds ?? null,
        threeDsUrl: geOut.threeDsUrl || null,
        payClickCount: geOut.payClickCount,
        sawAuthWire: geOut.sawAuthWire,
        chargeReqCount: geOut.chargeReqCount ?? null,
        transactionId: geOut.transactionId ?? null,
        issuerRedirectUrl: geOut.issuerRedirectUrl ?? null,
        undiciAttempts: geOut.undiciAttempts ?? null,
        responseLost: Boolean(geOut.responseLost),
        paymentAttempted: Boolean(
          geOut.paymentAttempted ||
            geOut.responseLost ||
            Number(geOut.chargeReqCount ?? geOut.undiciAttempts ?? 0) >= 1,
        ),
        blockedChargeReqCount: geOut.blockedChargeReqCount ?? null,
        geNetTail: geOut.geNetTail ?? null,
        finalUrl: geOut.finalUrl || checkoutV2Url,
        cookies: geOut.cookies || ctx.jar?.dump?.() || {},
        note: geOut.note,
        via: "http+ge",
        globaleMid: GLOBALE_MID,
        merchantCartToken,
        orderNumber: geOut.orderNumber ?? null,
        elapsedMs: geOut.elapsedMs,
        productCode,
        cartHoldAt,
        payWindowMs: BANDAI_PAY_WINDOW_MS,
        payFromCart: Boolean(payFromCart),
      });
    } catch (e) {
      await closeBridge();
      return withHeldCartMeta({
        ok: false,
        steps,
        failedStep: "ge_payment",
        error: e?.message || String(e),
        checkoutStage: "tokenize",
        areaItemNo: pdp.areaItemNo,
        productCode,
        cartSn,
        cartId,
        cartItemSn,
        checkoutSn: chk.checkoutSn || null,
        via: "http+ge",
        cartHoldAt,
        payWindowMs: BANDAI_PAY_WINDOW_MS,
        payFromCart: Boolean(payFromCart),
      });
    }
  }

  await closeBridge();

  return {
    ok: Boolean(chk.ok),
    steps,
    failedStep: chk.ok ? null : "cart_checkout",
    error: chk.ok ? null : chk.note,
    checkoutStage: chk.ok ? "tokenize" : "cart",
    dryRun: !placeOrder,
    areaItemNo: pdp.areaItemNo,
    cartSn,
    cartId,
    cartItemSn,
    checkoutSn: chk.checkoutSn || null,
    title: pdp.title,
    finalUrl: chk.checkoutSn
      ? `${session.base}/orderdetails`
      : `${session.base}/cart`,
    cookies: ctx.jar?.dump?.() ?? {},
    note: chk.ok
      ? placeOrder
        ? "HTTP checkoutSn ok — GE payment still requires browser/lab handoff"
        : "HTTP checkoutSn ok (dry-run)"
      : chk.note,
    via: "http",
    globaleMid: GLOBALE_MID,
    merchantCartToken,
    orderNumber: null,
  };
}

async function runCheckout(task, ctx, session, tStep, steps) {
  const placeOrder = task.placeOrder === true && task.dryRun !== true;
  const account = task.account || {};
  const email = account.email || task.email || task.profile?.email;
  const password = account.password || task.password || task.accountPassword;

  if (!email || !password) {
    return {
      ok: false,
      steps,
      error: "Bandai checkout requires login account (vault or task.account)",
      failedStep: "login",
      checkoutStage: "pre_cart",
    };
  }

  // Dual-ID: frontend N… for PDP referer/path; backend NAI… for ATC body.
  const frontendCode = parseFrontendProductCode(task);
  const backendHint =
    (task.bandaiAreaItemNo && String(task.bandaiAreaItemNo).trim()) ||
    (task.bandaiBackendPid && String(task.bandaiBackendPid).trim()) ||
    (task.areaItemNo && String(task.areaItemNo).trim()) ||
    null;
  const productCode = frontendCode || parseAreaItemNo(task);
  if (!productCode && !backendHint) {
    return {
      ok: false,
      steps,
      error: "Bandai product URL / areaItemNo / product code required",
      failedStep: "product",
      checkoutStage: "pre_cart",
    };
  }

  const taskCard = task.card || null;
  const envCard =
    process.env.BANDAI_CARD_NUMBER
      ? {
          number: String(process.env.BANDAI_CARD_NUMBER).replace(/\s+/g, ""),
          expMonth: String(process.env.BANDAI_CARD_EXP_MONTH || "").padStart(2, "0"),
          expYear: String(process.env.BANDAI_CARD_EXP_YEAR || "").replace(/^20/, ""),
          cvv: String(process.env.BANDAI_CARD_CVV || ""),
          holder: String(process.env.BANDAI_CARD_HOLDER || "Cardholder"),
        }
      : null;
  const card =
    placeOrder && taskCard?.number
      ? {
          number: String(taskCard.number).replace(/\s+/g, ""),
          expMonth: String(taskCard.expMonth || taskCard.exp_month || "").padStart(2, "0"),
          expYear: String(taskCard.expYear || taskCard.exp_year || "")
            .replace(/^20/, "")
            .slice(-2),
          cvv: String(taskCard.cvv || taskCard.cvc || ""),
          holder: String(taskCard.holder || taskCard.name || "Cardholder"),
        }
      : placeOrder && envCard?.number
        ? envCard
        : placeOrder
          ? {
              // Lab fallback — issuer decline; never a real PAN in source.
              number: "4000000000000002",
              expMonth: "12",
              expYear: "30",
              cvv: "999",
              holder: "DECLINE TEST",
            }
          : null;

  // Slow path: full Playwright login→PDP→ATC→GE (labs only).
  // Honor checkoutMode=full even if bandaiBrowserFull flag was dropped in transit.
  if (
    task.bandaiBrowserFull === true ||
    String(task.bandaiCheckoutMode || "").toLowerCase() === "full"
  ) {
    const s0 = Date.now();
    const out = await browserBandaiCheckout({
      email,
      password,
      productCode,
      area: session.area,
      qty: Number(task.qty) || 1,
      proxy: parseBandaiProxy(task.proxy).url || task.proxy || null,
      placeOrder,
      card,
      paymentMethod: task.paymentMethod || null,
      headless: task.headless !== false && process.env.BANDAI_HEADED !== "1",
      shippingAreaCode: task.shippingAreaCode || session.area,
      globaleMerchantCartTokenSuffix: task.globaleMerchantCartTokenSuffix || null,
      timeoutMs: Number(task.browserLoginTimeoutMs) || 90_000,
      wait3dsMs: Number(task.wait3dsMs) || 45_000,
      desktopTaskId: task.desktopTaskId || task.taskId || task.id || null,
      desktopRunId: task.desktopRunId || task.runId || null,
      desktopAttempt: task.desktopAttempt || task.attempt || null,
      executorTaskId: task.executorTaskId || ctx?.taskId || null,
      recordHarPath: task.recordHarPath || null,
    });
    if (Array.isArray(out.steps)) {
      for (const s of out.steps) steps.push(s);
    } else {
      steps.push({
        step: "browser_checkout",
        ok: out.ok !== false,
        status: null,
        ms: Date.now() - s0,
        note: out.note || out.error || null,
      });
    }
    if (out.cookies && ctx.jar?.load) ctx.jar.load(out.cookies);
    return {
      ok: Boolean(out.ok),
      steps,
      failedStep: out.failedStep || null,
      error: out.ok ? null : out.error || out.note || null,
      checkoutStage: out.checkoutStage || (out.ok ? "cart" : "pre_cart"),
      dryRun: out.dryRun ?? !placeOrder,
      areaItemNo: out.areaItemNo,
      cartSn: out.cartSn,
      cartId: out.cartId,
      cartItemSn: out.cartItemSn,
      checkoutSn: out.checkoutSn,
      title: out.title,
      paymentStatus: out.paymentStatus,
      paymentMethod: out.paymentMethod ?? task.paymentMethod ?? null,
      paypalApproveUrl: out.paypalApproveUrl ?? null,
      declineTarget: out.declineTarget,
      reached3ds: out.reached3ds ?? null,
      payClickCount: out.payClickCount ?? null,
      chargeReqCount: out.chargeReqCount ?? null,
      sawAuthWire: out.sawAuthWire ?? null,
      transactionId: out.transactionId ?? null,
      issuerRedirectUrl: out.issuerRedirectUrl ?? null,
      chromePayStealth: out.chromePayStealth ?? null,
      stealthProbe: out.stealthProbe ?? null,
      recordHarPath: out.recordHarPath ?? null,
      postPayWire: out.postPayWire ?? null,
      finalUrl: out.finalUrl || `${session.base}/cart`,
      cookies: out.cookies || ctx.jar?.dump?.() || {},
      note: out.note,
      via: out.via || "browser",
      globaleMid: GLOBALE_MID,
      orderNumber: out.orderNumber ?? null,
    };
  }

  // Pay path after shared HTTP ATC / cart_hold (see resolveBandaiCheckoutPayPath).
  const payPath = resolveBandaiCheckoutPayPath(task);
  steps.push({
    step: "bandai_checkout_mode",
    ok: true,
    note: `pay=${payPath.mode} (ATC always HTTP+F5; safe=HTTP checkout+GetCartToken then PW Pay, fast=HTTP GE)`,
  });

  if (placeOrder && payPath.placeOrderGeHttp) {
    return runHttpCheckout(task, ctx, session, tStep, steps, {
      email,
      password,
      productCode: productCode || backendHint,
      frontendCode: frontendCode || productCode || null,
      backendAreaItemNo: backendHint,
      placeOrderGeHttp: true,
      useGeHttpTestFork: payPath.useGeHttpTestFork === true,
      card,
    });
  }

  // Safe: HTTP + F5 through cart, then GE Pay on the bridge page.
  if (placeOrder && payPath.placeOrderGe) {
    return runHttpCheckout(task, ctx, session, tStep, steps, {
      email,
      password,
      productCode: productCode || backendHint,
      frontendCode: frontendCode || productCode || null,
      backendAreaItemNo: backendHint,
      placeOrderGe: true,
      card,
    });
  }

  return runHttpCheckout(task, ctx, session, tStep, steps, {
    email,
    password,
    productCode: productCode || backendHint,
    frontendCode: frontendCode || productCode || null,
    backendAreaItemNo: backendHint,
  });
}

export const bandaiAdapter = {
  id: "bandai",
  matches(host) {
    const h = String(host || "").toLowerCase();
    return h === "p-bandai.com" || h.endsWith(".p-bandai.com");
  },

  async run(task, ctx) {
    const steps = ctx.steps || (ctx.steps = []);
    const tStep = makeStep(steps, ctx);
    const mode = String(task.bandaiMode || task.mode || "checkout").toLowerCase();
    const normalized =
      mode === "bandai-agen" || mode === "agen" || mode === "account_gen"
        ? "account_gen"
        : mode === "atc_only"
          ? "atc"
          : mode;

    const area = resolveBandaiArea(task);
    task.bandaiArea = area;
    const session = createBandaiSession(ctx, { area });
    steps.push({
      step: "bandai_region",
      ok: true,
      note: `area=${area} regions=au,us,nz,sg,hk,tw,fr (not jp)`,
    });

    if (normalized === "account_gen") {
      return createBandaiAccount(task, ctx, { tStep, area });
    }

    if (normalized === "atc") {
      // Login → ATC → cart hold only. Never place order / GE.
      task.bandaiMode = "atc";
      task.bandaiStopAtCart = true;
      task.placeOrder = false;
      task.dryRun = true;
      return runCheckout(task, ctx, session, tStep, steps);
    }

    if (normalized === "login_check") {
      const account = task.account || {};
      const email = account.email || task.email || task.profile?.email;
      const password = account.password || task.password || task.accountPassword;
      if (!email || !password) {
        return {
          ok: false,
          steps,
          error: "login_check requires account email + password",
          failedStep: "login",
          checkoutStage: "pre_cart",
        };
      }
      return runHttpCheckout(task, ctx, session, tStep, steps, {
        email,
        password,
        productCode: null,
        frontendCode: null,
        loginCheckOnly: true,
      });
    }

    if (normalized === "monitor") {
      await tStep("warm", () => session.warm());
      return runMonitor(task, ctx, session, tStep, steps);
    }
    if (normalized === "chance") {
      return runChance(task, ctx, session, tStep, steps);
    }

    return runCheckout(task, ctx, session, tStep, steps);
  },
};

export default bandaiAdapter;
