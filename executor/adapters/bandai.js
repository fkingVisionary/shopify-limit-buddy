// Premium Bandai (p-bandai.com) adapter — F5/Volterra + BNID + Global-e (mid 1925).
// Regions: au/us/nz/sg/hk/tw/fr via task.bandaiArea or URL path. JP is out of scope.
// Completely separate from Kmart (no Hyper / Akamai / Paydock) and Toymate.
//
// Modes (task.bandaiMode):
//   checkout      — login → ATC → cart → checkoutSn (HTTP + F5 sensor bridge)
//   account_gen   — bandai-agen (IMAP + SMSPool/OnlineSim → registerVerification → vault)
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
//   safe           — bandaiBrowserCheckout: same cart hold, then SPA Proceed +
//                    Playwright GE Pay on the F5 bridge (~30 min pay window)
//   Full browser login/PDP remains lab-only: bandaiBrowserFull:true.

import { createBandaiAccount } from "./bandai-agen.js";
import { browserBandaiCheckout } from "./bandai-browser-checkout.js";
import { browserBandaiGeFromCart } from "./bandai-ge-pay.js";
import { runBandaiGeHttpPay } from "./bandai-ge-http.js";
import { createBandaiF5Bridge, parseBandaiProxy } from "./bandai-f5.js";
import { findCartLine, listCartLines } from "./bandai-cart.js";
import fs from "node:fs";
import {
  createBandaiSession,
  parseAreaItemNo,
  extractPreloadSuffix,
  readText,
  resolveBandaiArea,
  BANDAI_ORIGIN,
  GLOBALE_MID,
} from "./bandai-session.js";

/**
 * Resolve Fast vs Safe pay path after HTTP ATC / cart_hold.
 * Explicit bandaiBrowserCheckout / bandaiBrowserFull still win for labs.
 * @param {object} [task]
 * @returns {{ mode: "fast"|"safe"|"full", placeOrderGeHttp: boolean, placeOrderGe: boolean, browserFull: boolean }}
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

async function resolveAreaItemNo(session, productCode, tStep) {
  const code = String(productCode || "").trim();
  if (!code) return { ok: false, note: "product code / areaItemNo required" };
  if (/^NAI/i.test(code) || /^AAI/i.test(code)) {
    return { ok: true, areaItemNo: code, productCode: code };
  }
  const pdp = await tStep("product_get", async () => {
    const { status, json } = await session.apiJson("GET", `/api/products/${encodeURIComponent(code)}`, {
      referer: `${session.base}/item/${code}`,
    });
    const areaItemNo =
      json?.areaItemNos?.[0] ||
      (Array.isArray(json?.areaItemNos) ? json.areaItemNos[0] : null) ||
      Object.keys(json?.areaItemInventoryInfoMap || {})[0] ||
      null;
    const purchaseAvailable = Boolean(json?.purchaseAvailable);
    const flags = json?.flags || [];
    return {
      ok: status === 200 && Boolean(json),
      status,
      note: areaItemNo
        ? `${areaItemNo} avail=${purchaseAvailable}`
        : `product ${status}`,
      areaItemNo,
      purchaseAvailable,
      flags,
      json,
      title: json?.productName || json?.name || code,
    };
  });
  return pdp;
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
async function runHttpCheckout(task, ctx, session, tStep, steps, opts = {}) {
  const email = opts.email;
  const password = opts.password;
  const productCode = opts.productCode;
  const chanceOnly = opts.chanceOnly === true;
  const placeOrder = task.placeOrder === true && task.dryRun !== true;
  const wantBridge = task.bandaiF5Bridge !== false;

  let bridge = null;
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
  const f5SettleMs = Math.max(
    1_200,
    Math.min(
      3_000,
      Number(task.bandaiF5SettleMs || process.env.BANDAI_F5_SETTLE_MS) ||
        (fastAtc ? 1_400 : 1_800),
    ),
  );
  const atcT0 = Date.now();

  if (wantBridge) {
    try {
      const s0 = Date.now();
      bridge = await createBandaiF5Bridge({
        proxy: task.proxy || null,
        area: session.area,
        timeoutMs: Number(task.browserLoginTimeoutMs) || 90_000,
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
          ? `bridge ready area=${session.area} csrf=${String(csrf).slice(0, 8)}… settle=${f5SettleMs}ms fastAtc=${fastAtc}`
          : `bridge area=${session.area} cookies=${Object.keys(cookies || {}).join(",")} settle=${f5SettleMs}ms`,
      });
      ctx.onProgress?.("f5_bridge", steps[steps.length - 1].note);
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

  const login = await tStep("login", async () => {
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
  });

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

  if (chanceOnly) {
    await closeBridge();
    return { ok: true, steps, via: "http" };
  }

  // ── Product ────────────────────────────────────────────────────────────
  // Lab 2026-07-23: p8komysnbc-* mint for addToCart works on /login and /cart
  // but NOT on /item/* (avail=false PDP). Fast path skips item nudge and keeps
  // the bridge on login for ATC mint (~3–4s saved + mint reliability).
  if (bridge && !fastAtc) {
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
  } else if (bridge && fastAtc) {
    steps.push({
      step: "f5_pdp_nudge",
      ok: true,
      status: null,
      ms: 0,
      note: "skipped item goto (fastAtc; mint ATC from login/cart context)",
    });
  }

  const pdp = await resolveAreaItemNo(session, productCode, tStep);
  if (!pdp.ok || !pdp.areaItemNo) {
    await closeBridge();
    return {
      ok: false,
      steps,
      error: pdp.note || "product lookup failed",
      failedStep: "product_get",
      checkoutStage: "pre_cart",
      via: "http",
    };
  }

  const qty = Math.max(1, Math.min(5, Number(task.qty) || 1));
  const atcBodyObj = [{ areaItemNo: pdp.areaItemNo, qty }];
  const atcBody = JSON.stringify(atcBodyObj);

  // Pre-ATC cart peek costs a RTT; skip on fast path (drop race). Still OK to
  // POST addToCart when a line already exists (soft business / qty paths).
  let existing = null;
  if (!fastAtc) {
    const cartBefore = await session.apiJson("GET", "/api/cart/detail", {
      referer: `${session.base}/cart`,
    });
    existing = findCartLine(cartBefore.json, pdp.areaItemNo);
  }

  const atc = await tStep("addToCart", async () => {
    if (existing?.cartItemSn) {
      return {
        ok: true,
        status: 200,
        note: `already in cart line=${existing.cartItemSn} qty=${existing.qty}`,
        json: { items: [{ cartLineItemSn: existing.cartItemSn, addedNewCart: false }] },
      };
    }
    let sensors = {};
    if (bridge) {
      let mint = await bridge.mint("POST", "/api/cart/addToCart", {
        body: atcBody,
        contentType: "application/json",
        csrf: session.state.csrfToken,
      });
      // One settle bump if common.js was not hooked yet (fast settle race).
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
        return { ok: false, status: null, note: `ATC sensor mint failed: ${mint.note}` };
      }
    }
    const { status, json, res } = await session.apiJson("POST", "/api/cart/addToCart", {
      body: atcBodyObj,
      referer: `${session.base}/item/${productCode}`,
      extraHeaders: sensors,
    });
    const err = json?.detail || json?.errorCode || json?.error || json?.message || null;
    const textHint = !json ? await readText(res).then((t) => t.slice(0, 80)) : "";
    // Treat MaxPurchaseQty / Preallocation as soft-ok if line already present
    if (/CouldNotAddToCartBy(MaxPurchaseQty|Preallocation)/i.test(String(err || ""))) {
      const again = await session.apiJson("GET", "/api/cart/detail", {
        referer: `${session.base}/cart`,
      });
      const line = findCartLine(again.json, pdp.areaItemNo);
      if (line?.cartItemSn) {
        return {
          ok: true,
          status,
          note: `${err} → using cart line=${line.cartItemSn}`,
          json: { items: [{ cartLineItemSn: line.cartItemSn, addedNewCart: false }] },
        };
      }
    }
    const business =
      err ||
      (/PAGE NOT AVAILABLE|NETWORK CONGESTION/i.test(textHint) ? textHint.slice(0, 40) : null);
    return {
      ok: status >= 200 && status < 300 && !/CouldNotAddToCart/i.test(String(err || "")),
      status,
      note: business || `ATC ${status}`,
      json,
    };
  });

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
      cookies: ctx.jar?.dump?.() ?? {},
      via: "http",
      atcWallMs: Date.now() - atcT0,
    };
  }

  const atcWallMs = Date.now() - atcT0;
  steps.push({
    step: "cart_hold",
    ok: true,
    status: 200,
    ms: atcWallMs,
    note: `wall→ATC ${atcWallMs}ms fastAtc=${fastAtc} settle=${f5SettleMs}ms (pay window ~30min)`,
  });
  ctx.onProgress?.("cart_hold", steps[steps.length - 1].note);

  // ── Cart detail + qty normalize ────────────────────────────────────────
  let cart = await tStep("cart_detail", async () => {
    const { status, json } = await session.apiJson("GET", "/api/cart/detail", {
      referer: `${session.base}/cart`,
    });
    let hit = findCartLine(json, pdp.areaItemNo);
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
  if (
    task.bandaiStopAtCart === true &&
    !(placeOrder && (opts.placeOrderGe || opts.placeOrderGeHttp))
  ) {
    await closeBridge();
    return {
      ok: true,
      steps,
      atcWallMs,
      checkoutStage: "cart",
      dryRun: true,
      areaItemNo: pdp.areaItemNo,
      cartSn,
      cartId,
      cartItemSn,
      title: pdp.title,
      finalUrl: `${session.base}/cart`,
      cookies: ctx.jar?.dump?.() ?? {},
      note: "HTTP ATC + cart ok — stopped before checkout (bandaiStopAtCart)",
      via: "http",
      globaleMid: GLOBALE_MID,
    };
  }

  // ── Drop-speed placeOrder: SPA Proceed + GE on the SAME F5 bridge browser ─
  // Avoids a second Chromium login/PDP/ATC (that path was ~5min to issuer).
  // Skipped when bandaiGeHttpPay — that path uses HTTP cart_checkout + GEPI.
  if (placeOrder && opts.placeOrderGe === true && !opts.placeOrderGeHttp) {
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
      // Playwright needs Domain=.p-bandai.com — url-scoped sync alone can leave cart SPA logged out.
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

      // HTTP already logged in — sync jar into Playwright and go straight to GE cart UI.
      // Do NOT browser-POST /login again (burns F5, 501s, and violates "HTTP after warm").
      // Opt-in escape: task.bandaiBridgeRelogin=true
      if (task.bandaiBridgeRelogin) {
        await bridge.goto(`${session.base}/login`, { settleMs: 900 });
        const loginBodyGe = new URLSearchParams({
          grantType: "password",
          memberId: String(email || "").trim(),
          password: String(password || ""),
          saveLoginId: "false",
          autoLogin: "false",
        }).toString();
        let pageLoginOk = false;
        let pageLoginStatus = null;
        let pageLoginNote = "";
        for (let loginAttempt = 1; loginAttempt <= 2 && !pageLoginOk; loginAttempt++) {
          try {
            const mintGe = await bridge.mint("POST", "/login", {
              body: loginBodyGe,
              contentType: "application/x-www-form-urlencoded;charset=UTF-8",
              csrf: session.state.csrfToken || (await bridge.csrfToken()),
            });
            const pageLogin = await bridge.page.evaluate(
              async ({ body, csrf, areaCode, sensors }) => {
                const headers = {
                  accept: "application/json, text/plain, */*",
                  "content-type": "application/x-www-form-urlencoded;charset=UTF-8",
                  "x-g1-area-code": areaCode,
                  "x-requested-with": "XMLHttpRequest",
                  ...(csrf ? { "x-csrf-token": csrf } : {}),
                  ...(sensors || {}),
                };
                const res = await fetch("/login", {
                  method: "POST",
                  headers,
                  body,
                  credentials: "include",
                });
                const next = res.headers.get("x-csrf-token");
                if (next) {
                  window.__bandaiCsrf = next;
                  if (window.USER_DATA) window.USER_DATA.csrfToken = next;
                }
                return { status: res.status, restricted: res.headers.get("x-restricted-type") };
              },
              {
                body: loginBodyGe,
                csrf: session.state.csrfToken || (await bridge.csrfToken()),
                areaCode: session.area,
                sensors: mintGe.sensors || {},
              },
            );
            pageLoginStatus = pageLogin.status;
            pageLoginOk = pageLogin.status >= 200 && pageLogin.status < 300;
            pageLoginNote = pageLoginOk
              ? `bridge page login ok restricted=${pageLogin.restricted || "none"} attempt=${loginAttempt}`
              : `bridge page login ${pageLogin.status} attempt=${loginAttempt}`;
            if (!pageLoginOk && loginAttempt < 2) {
              await bridge.goto(`${session.base}/login`, { settleMs: 1200 });
            }
          } catch (e) {
            pageLoginNote = e?.message || "bridge_login_failed";
          }
        }
        steps.push({
          step: "bridge_login",
          ok: pageLoginOk,
          status: pageLoginStatus,
          ms: 0,
          note: pageLoginNote,
        });
      } else {
        steps.push({
          step: "bridge_cookie_sync",
          ok: Object.keys(jarDump).length > 0,
          status: null,
          ms: 0,
          note: `HTTP jar → Playwright cookies=${Object.keys(jarDump).length} (no browser re-login)`,
        });
      }

      const geOut = await browserBandaiGeFromCart({
        page: bridge.page,
        context: bridge.context,
        base: session.base,
        card,
        wait3dsMs: Number(task.wait3dsMs) || 45_000,
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
      return {
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
        blockedChargeReqCount: geOut.blockedChargeReqCount ?? null,
        geNetTail: geOut.geNetTail ?? null,
        finalUrl: geOut.finalUrl || `${session.base}/orderdetails`,
        cookies: geOut.cookies || ctx.jar?.dump?.() || {},
        note: geOut.note,
        via: "http+ge",
        globaleMid: GLOBALE_MID,
        orderNumber: geOut.orderNumber ?? null,
        elapsedMs: geOut.elapsedMs,
      };
    } catch (e) {
      await closeBridge();
      return {
        ok: false,
        steps,
        failedStep: "ge_payment",
        error: e?.message || String(e),
        checkoutStage: "tokenize",
        areaItemNo: pdp.areaItemNo,
        cartSn,
        cartItemSn,
        via: "http+ge",
      };
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

  const chk = await tStep("cart_checkout", async () => {
    if (!merchantCartToken) {
      return { ok: false, status: null, note: "missing merchantCartToken / preload suffix" };
    }
    const path = `/api/cart/${encodeURIComponent(cartSn)}/checkout`;
    let sensors = {};
    if (bridge) {
      await bridge.goto(`${session.base}/cart`);
      const mint = await bridge.mint("POST", path, {
        body: JSON.stringify(checkoutBody),
        contentType: "application/json",
        csrf: session.state.csrfToken,
      });
      sensors = mint.sensors || {};
      const c = await bridge.cookies();
      if (c && ctx.jar?.load) ctx.jar.load({ ...ctx.jar.dump(), ...c });
    }
    const { status, json } = await session.apiJson("POST", path, {
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
  });

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
    let geMachineId =
      task.bandaiGeMachineId || process.env.BANDAI_GE_MACHINE_ID || null;
    // Lab / drop default: reuse last iovation blackbox (no Playwright on GE).
    if (!geMachineId) {
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
    // Prefer zero Playwright on GE when a blackbox is already available.
    // Faster (~10s iovation off the critical path). Revolut pairs persist
    // even with noPage (GE/PSP dual-rail) — still the product angle.
    const geNoPage =
      task.bandaiGeNoPage === true ||
      (task.bandaiGeNoPage !== false && Boolean(geMachineId));
    const geOut = await runBandaiGeHttpPay({
      ctx,
      page: geNoPage ? null : bridge?.page || null,
      machineId: geMachineId,
      merchantCartToken,
      checkoutSn: chk.checkoutSn,
      card: opts.card,
      area: session.area,
      customerEmail: email,
      userAgent: session.state.userAgent,
      referer: `${session.base}/orderdetails`,
      stopBeforeIssuer: task.bandaiGeStopBeforeIssuer === true,
      forceIssuer: task.bandaiGeForceIssuer === true,
      keepPageAfterIovation: task.bandaiGeKeepPage === true,
      preferPageIssuer: task.bandaiGePreferPageIssuer === true,
      scrapeCardFormViaPage: task.bandaiGeScrapeCardFormViaPage === true,
      mergeIovationCookies: task.bandaiGeMergeIovationCookies === true,
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
    return {
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
      checkoutSn: chk.checkoutSn || null,
      cartToken: geOut.cartToken || null,
      title: pdp.title,
      paymentStatus: geOut.paymentStatus,
      blockers: geOut.blockers || [],
      chargeReqCount: geOut.chargeReqCount ?? null,
      undiciAttempts: geOut.undiciAttempts ?? null,
      browserIssuerBlocked: geOut.browserIssuerBlocked ?? null,
      framesNeutralized: geOut.framesNeutralized ?? null,
      isSameCartToken: geOut.isSameCartToken ?? null,
      sawAuthWire: geOut.sawAuthWire ?? null,
      transactionId: geOut.transactionId ?? null,
      timing: geOut.timing || null,
      finalUrl: `${session.base}/orderdetails`,
      cookies: ctx.jar?.dump?.() ?? {},
      note: geOut.note || null,
      via: geOut.via || "http-ge",
      globaleMid: GLOBALE_MID,
      merchantCartToken,
      orderNumber: geOut.orderNumber ?? null,
      elapsedMs: geOut.elapsedMs,
    };
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

  const productCode = parseAreaItemNo(task);
  if (!productCode) {
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
  if (task.bandaiBrowserFull === true) {
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
      shippingAreaCode: task.shippingAreaCode || session.area,
      globaleMerchantCartTokenSuffix: task.globaleMerchantCartTokenSuffix || null,
      timeoutMs: Number(task.browserLoginTimeoutMs) || 90_000,
      wait3dsMs: Number(task.wait3dsMs) || 45_000,
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
      declineTarget: out.declineTarget,
      reached3ds: out.reached3ds ?? null,
      finalUrl: out.finalUrl || `${session.base}/cart`,
      cookies: out.cookies || ctx.jar?.dump?.() || {},
      note: out.note,
      via: "browser",
      globaleMid: GLOBALE_MID,
      orderNumber: out.orderNumber ?? null,
    };
  }

  // Pay path after shared HTTP ATC / cart_hold (see resolveBandaiCheckoutPayPath).
  const payPath = resolveBandaiCheckoutPayPath(task);
  steps.push({
    step: "bandai_checkout_mode",
    ok: true,
    note: `pay=${payPath.mode} (ATC always HTTP+F5; safe=Playwright GE, fast=HTTP GE)`,
  });

  if (placeOrder && payPath.placeOrderGeHttp) {
    return runHttpCheckout(task, ctx, session, tStep, steps, {
      email,
      password,
      productCode,
      placeOrderGeHttp: true,
      card,
    });
  }

  // Safe: HTTP + F5 through cart, then GE Pay on the bridge page.
  if (placeOrder && payPath.placeOrderGe) {
    return runHttpCheckout(task, ctx, session, tStep, steps, {
      email,
      password,
      productCode,
      placeOrderGe: true,
      card,
    });
  }

  return runHttpCheckout(task, ctx, session, tStep, steps, {
    email,
    password,
    productCode,
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
