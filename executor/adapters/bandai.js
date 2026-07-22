// Premium Bandai (p-bandai.com) adapter — F5/Volterra + BNID + Global-e (mid 1925).
// Regions: au/us/nz/sg/hk/tw/fr via task.bandaiArea or URL path. JP is out of scope.
// Completely separate from Kmart (no Hyper / Akamai / Paydock) and Toymate.
//
// Modes (task.bandaiMode):
//   checkout      — login → ATC → cart → checkoutSn (HTTP + F5 sensor bridge)
//   account_gen   — bandai-agen (IMAP + OnlineSim → registerVerification → vault)
//   monitor       — poll search/PDP for purchaseAvailable / Chance
//   chance        — applyDraw for a campaign
//
// Transport policy:
//   Default = undici HTTP. F5 Shape Defense headers (`p8komysnbc-*`) are minted
//   by a narrow Playwright bridge that aborts probe XHRs — the real POSTs stay
//   on HTTP.
//   placeOrder + bandaiBrowserCheckout = HTTP→cart on that same bridge, then
//   SPA Proceed + single GE Pay (drop-speed path). Full browser login/PDP is
//   only `bandaiBrowserFull:true` (slow — do not use for drops).

import { createBandaiAccount } from "./bandai-agen.js";
import { browserBandaiCheckout } from "./bandai-browser-checkout.js";
import { browserBandaiGeFromCart } from "./bandai-ge-pay.js";
import { createBandaiF5Bridge, parseBandaiProxy } from "./bandai-f5.js";
import { findCartLine, listCartLines } from "./bandai-cart.js";
import {
  createBandaiSession,
  parseAreaItemNo,
  extractPreloadSuffix,
  readText,
  resolveBandaiArea,
  BANDAI_ORIGIN,
  GLOBALE_MID,
} from "./bandai-session.js";

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

  if (wantBridge) {
    try {
      const s0 = Date.now();
      bridge = await createBandaiF5Bridge({
        proxy: task.proxy || null,
        area: session.area,
        timeoutMs: Number(task.browserLoginTimeoutMs) || 90_000,
      });
      await bridge.goto(`${session.base}/login`);
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
          ? `bridge ready area=${session.area} csrf=${String(csrf).slice(0, 8)}…`
          : `bridge area=${session.area} cookies=${Object.keys(cookies || {}).join(",")}`,
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
  if (bridge) {
    await bridge.goto(`${session.base}/item/${encodeURIComponent(productCode)}`);
    const csrf = await bridge.csrfToken();
    if (csrf) session.state.csrfToken = csrf;
    const c = await bridge.cookies();
    if (c && ctx.jar?.load) ctx.jar.load({ ...ctx.jar.dump(), ...c });
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

  // Prefer existing cart line (prior dry-runs / preallocation)
  let cartBefore = await session.apiJson("GET", "/api/cart/detail", {
    referer: `${session.base}/cart`,
  });
  let existing = findCartLine(cartBefore.json, pdp.areaItemNo);

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
      const mint = await bridge.mint("POST", "/api/cart/addToCart", {
        body: atcBody,
        contentType: "application/json",
        csrf: session.state.csrfToken,
      });
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
    };
  }

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
  if (task.bandaiStopAtCart === true && !(placeOrder && opts.placeOrderGe)) {
    await closeBridge();
    return {
      ok: true,
      steps,
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
  if (placeOrder && opts.placeOrderGe === true) {
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

      // Re-assert login in the bridge page (same sensors) so /cart SPA sees the member.
      await bridge.goto(`${session.base}/login`, { settleMs: 900 });
      const loginBodyGe = new URLSearchParams({
        grantType: "password",
        memberId: String(email || "").trim(),
        password: String(password || ""),
        saveLoginId: "false",
        autoLogin: "false",
      }).toString();
      let pageLoginOk = false;
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
        pageLoginOk = pageLogin.status >= 200 && pageLogin.status < 300;
        steps.push({
          step: "bridge_login",
          ok: pageLoginOk,
          status: pageLogin.status,
          ms: 0,
          note: pageLoginOk
            ? `bridge page login ok restricted=${pageLogin.restricted || "none"}`
            : `bridge page login ${pageLogin.status}`,
        });
      } catch (e) {
        steps.push({
          step: "bridge_login",
          ok: false,
          status: null,
          ms: 0,
          note: e?.message || "bridge_login_failed",
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
  if (!preloadSuffix && bridge) {
    await bridge.goto(`${session.base}/cart`);
    const html = await bridge.page.content();
    preloadSuffix = extractPreloadSuffix(html);
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
  }

  const merchantCartToken = cartId && preloadSuffix
    ? `${cartId}_Checkout_${preloadSuffix}`
    : cartId
      ? `${cartId}_Checkout_`
      : null;

  const checkoutBody = {
    merchantCartToken,
    shippingAreaCode: task.shippingAreaCode || session.area,
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
    return {
      ok: status >= 200 && status < 300 && Boolean(checkoutSn),
      status,
      note: checkoutSn
        ? `checkoutSn ${checkoutSn}`
        : json?.error || json?.message || `checkout ${status}`,
      checkoutSn,
      json,
    };
  });

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

  // Drop path: HTTP + F5 mint through cart, then GE Pay on the same bridge page.
  if (placeOrder && task.bandaiBrowserCheckout === true) {
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
