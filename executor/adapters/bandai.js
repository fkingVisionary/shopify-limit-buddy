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
import { browserLoginBandai } from "./bandai-login-browser.js";
import { browserBandaiCheckout } from "./bandai-browser-checkout.js";
import {
  createBandaiSession,
  parseAreaItemNo,
  extractPreloadSuffix,
  readText,
  BANDAI_BASE,
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

  const authed = await ensureBandaiLogin(task, ctx, session, tStep, email, password);
  if (!authed.ok) {
    return {
      ok: false,
      steps,
      error: authed.login?.note || "login failed",
      failedStep: authed.via === "browser" ? "login_browser" : "login",
      restrictedType: authed.login?.restrictedType,
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

async function ensureBandaiLogin(task, ctx, session, tStep, email, password) {
  await tStep("warm", () => session.warm());
  const login = await tStep("login", () => session.loginPassword(email, password));
  if (login.ok) return { ok: true, login, via: "http" };

  // F5 often returns 501 HTML PAGE NOT AVAILABLE for POST /login from raw HTTP.
  // Narrow Playwright login harvests SESSION, then ATC stays on HTTP.
  const wantBrowser =
    task.bandaiBrowserLogin !== false &&
    (login.status === 501 ||
      /PAGE NOT AVAILABLE|login 501/i.test(String(login.note || "")) ||
      task.bandaiBrowserLogin === true);

  if (!wantBrowser) {
    return { ok: false, login, via: "http" };
  }

  const browser = await tStep("login_browser", async () => {
    const out = await browserLoginBandai({
      email,
      password,
      proxy: task.proxy || null,
      timeoutMs: Number(task.browserLoginTimeoutMs) || 90_000,
    });
    if (out.cookies && ctx.jar?.load) ctx.jar.load(out.cookies);
    // Refresh CSRF after cookie handoff
    if (out.ok) {
      const w = await session.warm();
      return {
        ok: out.ok && w.ok,
        status: out.loginStatus,
        note: out.note || (out.ok ? "browser login ok" : out.error),
        restrictedType: out.restrictedType,
        memberRefreshOk: out.memberRefreshOk,
      };
    }
    return {
      ok: false,
      status: out.loginStatus ?? null,
      note: out.detail || out.error || out.note || "browser_login_failed",
      restrictedType: out.restrictedType,
    };
  });

  return { ok: browser.ok, login: browser, via: "browser" };
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

  // F5 binds login + ATC to browser TLS. Prefer one Playwright session for the
  // whole cart path (HTTP POST /login and ATC return 501/503 outside the browser).
  const forceHttp = task.bandaiHttpOnly === true;
  if (!forceHttp && task.bandaiBrowserCheckout !== false) {
    const s0 = Date.now();
    const out = await browserBandaiCheckout({
      email,
      password,
      productCode,
      qty: Number(task.qty) || 1,
      proxy: task.proxy || null,
      placeOrder,
      // Decline-only fake card — never charge the owner's real card.
      card: placeOrder
        ? {
            number: "4000000000000002",
            expMonth: "12",
            expYear: "30",
            cvv: "999",
            holder: "DECLINE TEST",
          }
        : null,
      shippingAreaCode: task.shippingAreaCode || "au",
      globaleMerchantCartTokenSuffix: task.globaleMerchantCartTokenSuffix || null,
      timeoutMs: Number(task.browserLoginTimeoutMs) || 90_000,
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
      finalUrl: out.finalUrl || `${BANDAI_BASE}/cart`,
      cookies: out.cookies || ctx.jar?.dump?.() || {},
      note: out.note,
      via: "browser",
      globaleMid: GLOBALE_MID,
      orderNumber: out.orderNumber ?? null,
    };
  }

  // Legacy HTTP-only path (usually F5-blocked for login/ATC — kept for labs).
  const authed = await ensureBandaiLogin(task, ctx, session, tStep, email, password);
  if (!authed.ok) {
    return {
      ok: false,
      steps,
      error: authed.login?.note || "login failed",
      failedStep: authed.via === "browser" ? "login_browser" : "login",
      restrictedType: authed.login?.restrictedType,
      checkoutStage: "pre_cart",
      cookies: ctx.jar?.dump?.() ?? {},
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
      (/PAGE NOT AVAILABLE|NETWORK CONGESTION/i.test(textHint) ? textHint.slice(0, 40) : null);
    return {
      ok: status >= 200 && status < 300 && !/CouldNotAddToCart/i.test(String(err || "")),
      status,
      note: business || `ATC ${status}`,
      json,
    };
  });

  return {
    ok: Boolean(atc.ok),
    steps,
    failedStep: atc.ok ? null : "addToCart",
    error: atc.ok ? null : atc.note,
    checkoutStage: "cart",
    dryRun: true,
    areaItemNo: pdp.areaItemNo,
    title: pdp.title,
    cookies: ctx.jar?.dump?.() ?? {},
    note: atc.ok
      ? "HTTP ATC ok (unusual — F5 usually requires browser)"
      : "HTTP ATC blocked — use default browser checkout path",
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
