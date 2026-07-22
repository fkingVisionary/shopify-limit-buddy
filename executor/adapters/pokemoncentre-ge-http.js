// Pokémon Centre AU — Global-e pay over HTTP (scale path).
// Mid 1634 (gepi.global-e.com/includes/js/1634). Do not use Bandai mid 1925.
//
// Bandai lesson (corrected): Bandai reached HTTP through storefront `checkoutSn`
// handoff only — GE card/Pay stayed in Playwright. This module is the real
// HTTP GE target for PC (and later Bandai). Playwright (`pokemoncentre-ge.js`)
// is opt-in wire capture only (`pcBrowserCheckout`).
//
// Proven HTTP ahead of this file: Cortex public token → ATC → cartGuid →
// get-globale-m2m-token. Pay = GE Checkout/v2 session + CreditCardForm POST
// HandleCreditCardRequestV2 (form fields captured via browser wire dump).

/** Prod Global-e merchant id (same constant as browser helper — keep in sync). */
export const PC_GLOBALE_MID = 1634;
export const PC_GLOBALE_SCRIPT = "https://gepi.global-e.com/includes/js/1634";

const GE_BASE = "https://gepi.global-e.com";
const GE_WS = "https://webservices.global-e.com";
const GE_SECURE = "https://secure.ges.global-e.com";
/** PC merchant code seen on Checkout/v2 + HandleCreditCardRequestV2 paths. */
export const PC_GE_MERCHANT_CODE = "8u22";

function jarHeader(jar, url) {
  try {
    return jar?.cookieHeader?.(url) || jar?.getCookieHeader?.(url) || "";
  } catch {
    return "";
  }
}

function redact(s) {
  return String(s ?? "")
    .replace(/\b\d{13,19}\b/g, "[REDACTED_PAN]")
    .replace(/(cvv|cvd|cvc|cardNum|cardNumber)=([^&\s]+)/gi, "$1=[REDACTED]");
}

/**
 * Boot GE cart token via GEM-compatible endpoints (JSONP/GET + optional POST).
 * Uses PC cartGuid + Cortex GE m2m access-token when present.
 */
export async function getGeCartTokenHttp(session, ctx, opts = {}) {
  const mid = opts.globaleMid || PC_GLOBALE_MID;
  const cartGuid = opts.cartGuid;
  const m2m =
    opts.m2mAccessToken ||
    opts.geM2m?.json?.["access-token"] ||
    opts.geM2m?.json?.access_token ||
    null;
  if (!cartGuid && !m2m) {
    return { ok: false, note: "cartGuid or m2m access-token required" };
  }

  const ua = session.state.userAgent;
  const referer = `${session.state.base}/intl-checkout`;
  const attempts = [];

  // GEM2: GET /api/v1/checkout/cart-token (relative to GeBaseUrl)
  const gem2Url = new URL(`${GE_BASE}/api/v1/checkout/cart-token`);
  gem2Url.searchParams.set("merchantId", String(mid));
  if (cartGuid) gem2Url.searchParams.set("merchantCartToken", cartGuid);
  if (m2m) gem2Url.searchParams.set("cartToken", m2m);

  // Classic: /Checkout/GetCartToken (often JSONP)
  const classic = new URL(`${GE_BASE}/Checkout/GetCartToken`);
  classic.searchParams.set("merchantUniqueId", String(mid));
  if (cartGuid) classic.searchParams.set("MerchantCartToken", cartGuid);
  if (m2m) classic.searchParams.set("CartToken", m2m);

  for (const url of [gem2Url.toString(), classic.toString()]) {
    try {
      const res = await session.get(url, {
        headers: {
          accept: "application/json, text/javascript, */*;q=0.01",
          referer,
          "user-agent": ua,
          origin: session.state.base,
        },
      });
      const text = await session.readText(res);
      attempts.push({
        url: url.split("?")[0],
        status: res.status,
        body: redact(text).slice(0, 400),
      });
      let json = null;
      try {
        json = JSON.parse(text.replace(/^[^{[]+/, "").replace(/[^}\]]+$/, ""));
      } catch {
        try {
          json = JSON.parse(text);
        } catch {
          /* ignore */
        }
      }
      const token =
        json?.CartToken ||
        json?.cartToken ||
        json?.Token ||
        json?.token ||
        json?.Result?.CartToken ||
        json?.checkoutToken ||
        null;
      if (res.status < 400 && token) {
        return {
          ok: true,
          cartToken: token,
          json,
          attempts,
          note: `GE cart token via ${url.split("?")[0]}`,
        };
      }
    } catch (e) {
      attempts.push({ url: url.split("?")[0], error: String(e?.message || e) });
    }
  }

  return {
    ok: false,
    attempts,
    note: "GE cart-token HTTP boot failed — need wire (pcBrowserCheckout) or m2m mapping",
  };
}

/**
 * HTTP Global-e pay for PC.
 *
 * Until HandleCreditCardRequestV2 form contract is locked from a wire dump
 * (`ge-wire-posts.json`), this returns a structured handoff with cart-token
 * probe results and refuses to spray Playwright or multi-click Pay.
 *
 * @param {object} opts
 * @param {object} opts.session — PC session
 * @param {object} opts.ctx — { jar, dispatcher }
 * @param {string} opts.cartGuid
 * @param {object} [opts.geM2m] — getGlobaleM2mToken result
 * @param {object} [opts.card]
 * @param {boolean} [opts.placeOrder]
 */
export async function runGlobalEPayHttp(opts = {}) {
  const steps = [];
  const push = (step, extra = {}) => {
    const row = { step, ok: extra.ok !== false, ...extra };
    steps.push(row);
    opts.onProgress?.(step, extra.note || null);
    return row;
  };

  const session = opts.session;
  const ctx = opts.ctx;
  if (!session) {
    return { ok: false, steps, error: "session required", checkoutStage: "tokenize", engine: "http" };
  }

  const placeOrder = opts.placeOrder === true;
  const mid = opts.globaleMid || PC_GLOBALE_MID;
  const cartGuid = opts.cartGuid;
  push("ge_http_start", {
    ok: true,
    note: `mid=${mid} cartGuid=${cartGuid ? "yes" : "no"} placeOrder=${placeOrder}`,
  });

  const tokenRes = await getGeCartTokenHttp(session, ctx, {
    cartGuid,
    geM2m: opts.geM2m,
    m2mAccessToken: opts.m2mAccessToken,
    globaleMid: mid,
  });
  push("ge_cart_token", {
    ok: tokenRes.ok,
    note: tokenRes.note,
    attempts: tokenRes.attempts?.slice?.(0, 4),
    cartToken: tokenRes.cartToken ? String(tokenRes.cartToken).slice(0, 8) + "…" : null,
  });

  if (!placeOrder) {
    return {
      ok: Boolean(tokenRes.ok || opts.geM2m?.ok),
      steps,
      dryRun: true,
      checkoutStage: "tokenize",
      paymentStatus: "dry_run",
      engine: "http",
      globaleMid: mid,
      geCartToken: tokenRes.cartToken || null,
      note: tokenRes.ok
        ? "HTTP GE cart-token ok — placeOrder=false"
        : `HTTP GE dry-run handoff (m2m=${Boolean(opts.geM2m?.ok)}); cart-token: ${tokenRes.note}`,
    };
  }

  // Pay requires HandleCreditCardRequestV2 form body from wire capture.
  // Do not fall back to Playwright here — caller may opt into pcBrowserCheckout.
  if (!opts.gePayForm) {
    return {
      ok: false,
      steps,
      checkoutStage: "tokenize",
      paymentStatus: "needs_wire",
      engine: "http",
      globaleMid: mid,
      geCartToken: tokenRes.cartToken || null,
      merchantCode: PC_GE_MERCHANT_CODE,
      secureHost: GE_SECURE,
      webservicesHost: GE_WS,
      failedStep: "ge_http_pay_contract",
      error:
        "HTTP GE Pay needs HandleCreditCardRequestV2 form contract — run once with pcBrowserCheckout + debugDir (ge-wire-posts.json), then pass gePayForm or land the mapper",
      note: "HTTP path refused blind Playwright; capture wire once",
    };
  }

  const form = opts.gePayForm;
  const cartToken = form.cartToken || tokenRes.cartToken;
  const merchantCode = form.merchantCode || PC_GE_MERCHANT_CODE;
  const mode = form.mode || "13534";
  const payUrl =
    form.action ||
    `${GE_SECURE}/1/Payments/HandleCreditCardRequestV2/${merchantCode}/${cartToken}?mode=${mode}`;

  const body = new URLSearchParams();
  for (const [k, v] of Object.entries(form.fields || {})) {
    if (v == null) continue;
    body.set(k, String(v));
  }
  // Overlay live card (never log)
  const card = opts.card || {};
  if (card.number) {
    for (const k of ["cardNum", "cardNumber", "CardNumber", "pan"]) {
      if (body.has(k) || form.panField === k) body.set(form.panField || "cardNum", String(card.number));
    }
    if (form.panField) body.set(form.panField, String(card.number));
    else if (![...body.keys()].some((k) => /card|pan/i.test(k))) body.set("cardNum", String(card.number));
  }
  if (card.cvv) {
    const cvk = form.cvvField || "cvdNumber";
    body.set(cvk, String(card.cvv));
  }

  const res = await session.post(payUrl, {
    body: body.toString(),
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      origin: GE_SECURE,
      referer: form.referer || `${GE_SECURE}/payments/CreditCardForm/${cartToken}/2`,
      "user-agent": session.state.userAgent,
      cookie: jarHeader(ctx?.jar, payUrl),
    },
  });
  const text = await session.readText(res);
  push("ge_http_pay", {
    ok: res.status < 500,
    status: res.status,
    note: redact(`HandleCreditCard ${res.status} ${text.slice(0, 120).replace(/\s+/g, " ")}`),
  });

  let paymentStatus = "unknown";
  if (/declin|insufficient|weren.?t charged|couldn.?t be completed|do not honour/i.test(text)) {
    paymentStatus = "declined";
  } else if (/acs|3ds|pareq|challenge/i.test(text)) {
    paymentStatus = "reached_3ds";
  } else if (res.status >= 300 && res.status < 400) {
    // 302 → CCPaymentRedirect often precedes decline modal body on follow
    paymentStatus = "submitted";
  }

  return {
    ok: paymentStatus === "declined" || paymentStatus === "reached_3ds" || paymentStatus === "submitted",
    steps,
    checkoutStage: paymentStatus === "reached_3ds" ? "three_ds" : "payment",
    paymentStatus,
    engine: "http",
    globaleMid: mid,
    note: `HTTP GE payStatus=${paymentStatus}`,
  };
}
