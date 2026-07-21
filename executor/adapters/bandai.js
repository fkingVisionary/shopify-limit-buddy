// Premium Bandai AU adapter — F5/Volterra + BNID + Global-e (mid 1925).
// Completely separate from Kmart (no Hyper / Akamai / Paydock) and Toymate.
//
// Modes (task.bandaiMode):
//   checkout      — login → ATC → cart detail → (optional GE checkout stub)
//   account_gen   — bandai-agen (IMAP + OnlineSim → registerVerification → vault)
//   monitor       — poll search/PDP for purchaseAvailable / Chance
//   chance        — applyDraw for a campaign

import { request } from "../http.js";
import { createBandaiAccount } from "./bandai-agen.js";
import {
  createBandaiSession,
  profileFromTask,
  parseAreaItemNo,
  extractPreloadSuffix,
  readText,
  readJson,
  BANDAI_BASE,
  BANDAI_ORIGIN,
  GLOBALE_MID,
  bandaiNavHeaders,
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
  // If it already looks like areaItemNo (NAI…), use directly
  if (/^NAI/i.test(code)) {
    return { ok: true, areaItemNo: code, productCode: code };
  }
  const pdp = await tStep("product_get", async () => {
    const { status, json } = await session.apiJson("GET", `/api/products/${encodeURIComponent(code)}`, {
      referer: `${BANDAI_BASE}/item/${code}`,
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

  if (productCode && !/\s/.test(productCode) && /^N/i.test(productCode)) {
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
      finalUrl: `${BANDAI_BASE}/item/${productCode}`,
      cookies: ctx.jar?.dump?.() ?? {},
      note: pdp.note,
    };
  }

  const q = keyword.replace(/^https:\/\/p-bandai\.com\/au\/?/i, "").trim() || "one piece";
  const search = await tStep("search", async () => {
    const { status, json } = await session.apiJson(
      "GET",
      `/api/search?keyword=${encodeURIComponent(q)}&offset=0&limit=20`,
      { referer: `${BANDAI_BASE}/search?keyword=${encodeURIComponent(q)}` },
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
    finalUrl: `${BANDAI_BASE}/search?keyword=${encodeURIComponent(q)}`,
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

  await tStep("warm", () => session.warm());
  const login = await tStep("login", () => session.loginPassword(email, password));
  if (!login.ok) {
    return {
      ok: false,
      steps,
      error: login.note || "login failed",
      failedStep: "login",
      restrictedType: login.restrictedType,
      checkoutStage: "chance",
    };
  }

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
        referer: `${BANDAI_BASE}/hotdeals/`,
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
    finalUrl: `${BANDAI_BASE}/mypage/chancetobuy`,
    cookies: ctx.jar?.dump?.() ?? {},
    note: draw.note,
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

  await tStep("warm", () => session.warm());
  const login = await tStep("login", () => session.loginPassword(email, password));
  if (!login.ok) {
    return {
      ok: false,
      steps,
      error: login.note || "login failed",
      failedStep: "login",
      restrictedType: login.restrictedType,
      checkoutStage: "pre_cart",
      cookies: ctx.jar?.dump?.() ?? {},
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

  const pdp = await resolveAreaItemNo(session, productCode, tStep);
  if (!pdp.ok || !pdp.areaItemNo) {
    return {
      ok: false,
      steps,
      error: pdp.note || "product lookup failed",
      failedStep: "product_get",
      checkoutStage: "pre_cart",
    };
  }

  const qty = Math.max(1, Math.min(5, Number(task.qty) || 1));
  const atc = await tStep("addToCart", async () => {
    const { status, json, res } = await session.apiJson("POST", "/api/cart/addToCart", {
      body: [{ areaItemNo: pdp.areaItemNo, qty }],
      referer: `${BANDAI_BASE}/item/${productCode}`,
    });
    const textHint = !json ? await readText(res).then((t) => t.slice(0, 120)) : "";
    const err = json?.detail || json?.errorCode || json?.message || null;
    const business =
      err ||
      (typeof json === "string" ? json : null) ||
      (/PAGE NOT AVAILABLE|NETWORK CONGESTION/i.test(textHint) ? textHint.slice(0, 40) : null);
    const added = json?.items?.[0]?.addedNewCart ?? json?.totalCartCount != null;
    return {
      ok: status >= 200 && status < 300 && !/CouldNotAddToCart/i.test(String(err || "")),
      status,
      note: business
        ? String(business)
        : added
          ? `ATC ok cart=${json?.totalCartCount ?? "?"}`
          : `ATC ${status}`,
      json,
      totalCartCount: json?.totalCartCount,
    };
  });

  if (!atc.ok) {
    return {
      ok: false,
      steps,
      error: atc.note || "addToCart failed",
      failedStep: "addToCart",
      checkoutStage: "cart",
      areaItemNo: pdp.areaItemNo,
      cookies: ctx.jar?.dump?.() ?? {},
      note:
        /501|PAGE NOT AVAILABLE/i.test(String(atc.note))
          ? "ATC gated — need logged-in AU ISP HAR if this persists"
          : atc.note,
    };
  }

  const cart = await tStep("cart_detail", async () => {
    const { status, json } = await session.apiJson("GET", "/api/cart/detail", {
      referer: `${BANDAI_BASE}/cart`,
    });
    const cartSn = json?.cartSn || json?.cart?.cartSn || json?.sn || null;
    const cartId = json?.cartId || json?.cart?.cartId || cartSn;
    const lines = json?.items || json?.cartItems || json?.lineItems || [];
    const cartItemSn =
      lines?.[0]?.cartItemSn || lines?.[0]?.sn || lines?.[0]?.cartLineItemSn || null;
    return {
      ok: status === 200 && Boolean(json),
      status,
      note: cartSn ? `cartSn ${cartSn}` : `cart ${status}`,
      cartSn,
      cartId,
      cartItemSn,
      json,
    };
  });

  // Phase C exit: stop before GE when placeOrder is false (default dry-run).
  if (!placeOrder) {
    return {
      ok: true,
      steps,
      checkoutStage: "cart",
      dryRun: true,
      areaItemNo: pdp.areaItemNo,
      cartSn: cart.cartSn,
      cartItemSn: cart.cartItemSn,
      title: pdp.title,
      finalUrl: `${BANDAI_BASE}/cart`,
      cookies: ctx.jar?.dump?.() ?? {},
      note: "ATC + cart detail ok — GE checkout skipped (placeOrder:false)",
    };
  }

  // Phase D scaffold: resolve merchantCartToken suffix + checkout POST.
  // Global-e captcha/fingerprint may require browser — surface clearly if blocked.
  let tokenSuffix = task.globaleMerchantCartTokenSuffix || null;
  if (!tokenSuffix) {
    await tStep("cart_page_preload", async () => {
      const res = await request(`${BANDAI_BASE}/cart`, {
        headers: bandaiNavHeaders({
          referer: `${BANDAI_BASE}/`,
          userAgent: session.state.userAgent,
        }),
      }, ctx);
      const html = await readText(res);
      ctx.jar?.ingest?.(res.headers);
      tokenSuffix = extractPreloadSuffix(html);
      return {
        ok: Boolean(tokenSuffix),
        status: res.status,
        note: tokenSuffix
          ? `suffix ${String(tokenSuffix).slice(0, 12)}…`
          : "globaleMerchantCartTokenSuffix missing — need cart HAR",
      };
    });
  }

  if (!tokenSuffix || !cart.cartSn || !cart.cartItemSn) {
    return {
      ok: false,
      steps,
      error: "GE checkout needs cartSn, cartItemSn, and globaleMerchantCartTokenSuffix",
      failedStep: "ge_token",
      checkoutStage: "tokenize",
      dryRun: false,
      cartSn: cart.cartSn,
      cookies: ctx.jar?.dump?.() ?? {},
      note: "Ask owner for cart-page PRELOAD / HAR",
    };
  }

  const merchantCartToken = `${cart.cartId || cart.cartSn}_Checkout_${tokenSuffix}`;
  const shippingAreaCode = task.shippingAreaCode || "au";

  const checkout = await tStep("cart_checkout", async () => {
    const { status, json } = await session.apiJson(
      "POST",
      `/api/cart/${encodeURIComponent(cart.cartSn)}/checkout`,
      {
        body: {
          merchantCartToken,
          shippingAreaCode,
          items: [{ cartItemSn: cart.cartItemSn }],
        },
        referer: `${BANDAI_BASE}/cart`,
      },
    );
    const checkoutSn = json?.checkoutSn || json?.data?.checkoutSn || null;
    const err = json?.detail || json?.message || null;
    return {
      ok: status >= 200 && status < 300 && Boolean(checkoutSn),
      status,
      note: checkoutSn ? `checkoutSn ${checkoutSn}` : String(err || status),
      checkoutSn,
      json,
    };
  });

  if (!checkout.ok) {
    return {
      ok: false,
      steps,
      error: checkout.note || "checkout POST failed",
      failedStep: "cart_checkout",
      checkoutStage: "tokenize",
      cookies: ctx.jar?.dump?.() ?? {},
      note: `GE mid ${GLOBALE_MID} — browser handoff may be required for captcha/fp`,
    };
  }

  // Stop before GE payment widget — HTTP-only path ends here until HAR proves otherwise.
  return {
    ok: true,
    steps,
    checkoutStage: "tokenize",
    dryRun: false,
    checkoutSn: checkout.checkoutSn,
    merchantCartToken,
    globaleMid: GLOBALE_MID,
    areaItemNo: pdp.areaItemNo,
    finalUrl: `${BANDAI_BASE}/orderdetails`,
    cookies: ctx.jar?.dump?.() ?? {},
    note:
      "Bandai checkoutSn minted — complete Global-e (captcha/fp/pay) via browser handoff; preComplete not automated yet",
  };
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
    // Alias bandai-agen task type → account_gen
    const normalized =
      mode === "bandai-agen" || mode === "agen" || mode === "account_gen"
        ? "account_gen"
        : mode;

    const session = createBandaiSession(ctx);

    if (normalized === "account_gen") {
      return createBandaiAccount(task, ctx, { tStep });
    }

    // Warm for monitor / chance / checkout
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
