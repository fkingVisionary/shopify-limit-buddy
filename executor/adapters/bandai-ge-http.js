/**
 * Bandai Global-e Pay over HTTP (undici) — drop path to eliminate Playwright GE UI.
 *
 * Wire-proven issuer (Revolut 2026-07-22):
 *   POST https://secure-bandai.global-e.com/1/Payments/HandleCreditCardRequestV2/8urc/{guid}?mode=…
 *
 * GEM boot (from gem-bandai includes/js/1925):
 *   GET gepi.global-e.com/Checkout/GetCartToken?MerchantCartToken=…&MerchantId=1925&…
 *   → CartToken GUID → Checkout/v2 → handleaction/1..3 → CreditCardForm → issuer
 *
 * Remaining hard fields on issuer body: machineId (device blob), UrlStructureTokenEncoded (JWT).
 * Scrape both from Checkout/v2 + CreditCardForm HTML when possible.
 */

import { request } from "../http.js";
import fs from "node:fs";
import { isBandaiGeIssuerPaymentUrl } from "./bandai-ge-pay.js";

const CAPTURE_DEFAULT = "/tmp/bandai-ge-issuer-capture.json";
const BOOT_CAPTURE = "/tmp/bandai-ge-boot-capture.json";

export const BANDAI_GE_MID = "1925";
export const BANDAI_GE_ENCODED_MERCHANT = "8urc";
export const BANDAI_GE_GEPI = "https://gepi.global-e.com";
export const BANDAI_GE_WEBSERVICES = "https://webservices.global-e.com";
export const BANDAI_GE_SECURE = "https://secure-bandai.global-e.com";
export const BANDAI_GE_GEM = "https://gem-bandai.global-e.com";

const DEFAULT_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

/** UUID-ish GUID from Checkout/v2 / handleaction / orderdetails HTML. */
export function extractGeCheckoutGuid(htmlOrUrl) {
  const s = String(htmlOrUrl || "");
  const patterns = [
    /HandleCreditCardRequestV2\/[^/]+\/([0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12})/i,
    /checkoutv2\/handleaction\/\d+\/([0-9a-f-]{36})\//i,
    /Checkout\/v2\/[^"'?\s]*\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i,
    /"CartToken"\s*:\s*"([0-9a-f-]{36})"/i,
    /"checkoutId"\s*:\s*"([0-9a-f-]{36})"/i,
  ];
  for (const re of patterns) {
    const m = s.match(re);
    if (m?.[1]) return m[1];
  }
  return null;
}

export function parseJsonp(text) {
  const s = String(text || "").trim();
  if (!s) return null;
  try {
    return JSON.parse(s);
  } catch {
    /* JSONP / ({...}) */
  }
  const start = s.indexOf("{");
  const end = s.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(s.slice(start, end + 1));
  } catch {
    return null;
  }
}

/** Build GetCartToken query (GEM SerializeQueryParameter — omit null/empty). */
export function buildGetCartTokenParams(opts = {}) {
  const additional =
    opts.additionalCartData != null
      ? opts.additionalCartData
      : encodeURIComponent(JSON.stringify(opts.checkoutParams || []));
  const raw = {
    PreferedCultureCode: opts.preferedCultureCode || opts.cultureCode || "en-GB",
    CountryCode: opts.countryCode || "AU",
    CurrencyCode: opts.currencyCode || "AUD",
    CultureCode: opts.cultureCode || "en-GB",
    MerchantId: String(opts.merchantId || BANDAI_GE_MID),
    IsJSONP: "true",
    WebStoreCode: opts.webStoreCode || "p-bandai.com",
    WebStoreInstanceCode: opts.webStoreInstanceCode || opts.area || "au",
    MerchantCartToken: opts.merchantCartToken || "",
    CartToken: opts.cartToken || "",
    ClientCartContent: opts.clientCartContent || "",
    SiteLocale: opts.siteLocale || "",
    AdditionalCartData: additional,
    CaptchaResponseToken: opts.captchaResponseToken || "",
    CookieConsent: opts.cookieConsent || "",
    CustomerEmail: opts.customerEmail || "",
    CustomerId: opts.customerId || "",
    VoucherCode: opts.voucherCode || "",
  };
  const out = {};
  for (const [k, v] of Object.entries(raw)) {
    if (v == null || v === "") continue;
    out[k] = String(v);
  }
  return out;
}

export function buildGetCartTokenUrl(opts = {}) {
  const params = buildGetCartTokenParams(opts);
  const qs = new URLSearchParams(params).toString();
  const base = String(opts.gepiBase || BANDAI_GE_GEPI).replace(/\/$/, "");
  return `${base}/Checkout/GetCartToken?${qs}`;
}

export function loadIssuerCapture(path = CAPTURE_DEFAULT) {
  if (!fs.existsSync(path)) return null;
  try {
    return JSON.parse(fs.readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

function cookieHeaderFromJar(jar) {
  if (!jar) return "";
  if (typeof jar.header === "function") return jar.header() || "";
  const dump = jar.dump?.() || {};
  return Object.entries(dump)
    .map(([k, v]) => `${k}=${v}`)
    .join("; ");
}

async function httpText(url, opts = {}) {
  const ctx = opts.ctx;
  if (!ctx?.jar || !ctx?.dispatcher) {
    throw new Error("httpText requires ctx.jar + ctx.dispatcher (Bandai checkout ctx)");
  }
  const method = opts.method || "GET";
  const headers = {
    "user-agent": opts.userAgent || DEFAULT_UA,
    accept: opts.accept || "*/*",
    "accept-language": "en-AU,en;q=0.9",
    ...(opts.headers || {}),
  };
  if (opts.cookieHeader) headers.cookie = opts.cookieHeader;
  const t0 = Date.now();
  const res = await request(url, { method, headers, body: opts.body }, ctx);
  const text = await res.text();
  return {
    ok: res.status >= 200 && res.status < 300,
    status: res.status,
    ms: Date.now() - t0,
    text,
    url,
    headers: res.headers,
  };
}

/**
 * Mint Checkout/v2 CartToken GUID via GEPI GetCartToken (JSONP).
 */
export async function getBandaiGeCartToken(opts = {}) {
  const url = buildGetCartTokenUrl(opts);
  const res = await httpText(url, {
    ctx: opts.ctx,
    userAgent: opts.userAgent,
    cookieHeader: opts.cookieHeader,
    accept: "application/javascript, application/json, */*",
    headers: {
      referer: opts.referer || "https://p-bandai.com/",
      origin: "https://p-bandai.com",
    },
  });
  const json = parseJsonp(res.text);
  const cartToken =
    json?.CartToken || json?.cartToken || extractGeCheckoutGuid(res.text) || null;
  const isCaptcha = Boolean(json?.IsCaptcha || json?.isCaptcha);
  return {
    ok: Boolean(res.ok && json?.Success !== false && cartToken),
    status: res.status,
    ms: res.ms,
    url: url.slice(0, 260),
    urlFull: url,
    json,
    cartToken,
    isCaptcha,
    bodySnippet: String(res.text || "").replace(/\s+/g, " ").slice(0, 280),
    success: json?.Success,
    message: json?.Message || null,
  };
}

export function extractUrlStructureToken(html) {
  const s = String(html || "");
  const patterns = [
    /UrlStructureTokenEncoded["']?\s*[:=]\s*["']([^"']+)["']/i,
    /name=["']PaymentData\.UrlStructureTokenEncoded["'][^>]*value=["']([^"']+)["']/i,
    /value=["'](eyJ[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+)["'][^>]*UrlStructure/i,
    /(eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9\.[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+)/,
  ];
  for (const re of patterns) {
    const m = s.match(re);
    if (m?.[1]) return m[1];
  }
  return null;
}

export function extractMachineId(html) {
  const s = String(html || "");
  const patterns = [
    /name=["']PaymentData\.machineId["'][^>]*value=["']([^"']+)["']/i,
    /id=["']ioBlackBox["'][^>]*value=["']([^"']+)["']/i,
    /machineId["']?\s*[:=]\s*["']([^"']{20,})["']/i,
    /PaymentData\.machineId=([^&"']+)/i,
  ];
  for (const re of patterns) {
    const m = s.match(re);
    if (m?.[1]) return decodeURIComponent(m[1]);
  }
  return null;
}

/**
 * machineId = iovation RED blackbox (#ioBlackBox) from snare.js on Checkout/v2.
 * Not the GE Pay UI — only fingerprint mint. Prefer reusing the F5 bridge page.
 */
export async function mintIovationBlackbox(opts = {}) {
  const page = opts.page;
  const url = opts.checkoutV2Url;
  if (!page || !url) {
    return { ok: false, error: "page_and_checkoutV2Url_required", machineId: null };
  }
  const timeoutMs = Math.min(45_000, Math.max(5_000, Number(opts.timeoutMs) || 20_000));
  const t0 = Date.now();
  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: timeoutMs });
    const machineId = await page.waitForFunction(
      () => {
        const el =
          document.getElementById("ioBlackBox") ||
          document.querySelector('input[name="ioBlackBox"]') ||
          document.getElementById("machineId");
        const v = el && String(el.value || "").trim();
        return v && v.length > 40 ? v : null;
      },
      { timeout: timeoutMs },
    );
    const value = await machineId.jsonValue();
    return { ok: Boolean(value), machineId: value, ms: Date.now() - t0 };
  } catch (e) {
    let fallback = null;
    try {
      fallback = await page.evaluate(() => {
        const el = document.getElementById("ioBlackBox");
        return el ? String(el.value || "") : "";
      });
    } catch {
      /* ignore */
    }
    return {
      ok: Boolean(fallback && fallback.length > 40),
      machineId: fallback || null,
      ms: Date.now() - t0,
      error: e?.message || "iovation_mint_failed",
    };
  }
}

/** Build issuer form body from card + session fields (wire schema). */
export function buildIssuerFormBody(opts = {}) {
  const card = opts.card || {};
  const pan = String(card.number || "").replace(/\s+/g, "");
  const spaced =
    pan.length === 16 ? pan.replace(/(.{4})/g, "$1 ").trim() : pan;
  const mm = String(card.expMonth || "").replace(/^0/, "") || String(card.expMonth || "");
  let yy = String(card.expYear || "");
  if (yy.length === 2) yy = `20${yy}`;
  const guid = opts.cartToken || opts.guid;
  const params = new URLSearchParams();
  params.set("hiddenInputForCC", "");
  params.set("PaymentData.cardNum", spaced);
  params.set("PaymentData.cardExpiryMonth", mm);
  params.set("PaymentData.cardExpiryYear", yy);
  params.set("PaymentData.cvdNumber", String(card.cvv || ""));
  params.set("PaymentData.checkoutV2", "true");
  params.set("PaymentData.cartToken", String(guid || ""));
  params.set("PaymentData.gatewayId", String(opts.gatewayId || "2"));
  params.set("PaymentData.paymentMethodId", String(opts.paymentMethodId || "2"));
  params.set("PaymentData.machineId", String(opts.machineId || ""));
  params.set("PaymentData.createTransaction", "true");
  params.set("PaymentData.checkoutCDNEnabled", opts.checkoutCDNEnabled || "value");
  params.set("PaymentData.recapchaToken", opts.recapchaToken || "");
  params.set("PaymentData.recapchaTime", opts.recapchaTime || "");
  params.set("PaymentData.customerScreenColorDepth", String(opts.colorDepth || "24"));
  params.set("PaymentData.customerScreenWidth", String(opts.screenWidth || "1280"));
  params.set("PaymentData.customerScreenHeight", String(opts.screenHeight || "800"));
  params.set("PaymentData.customerTimeZoneOffset", String(opts.tzOffset || "0"));
  params.set("PaymentData.customerLanguage", opts.language || "en-AU");
  params.set("PaymentData.UrlStructureTokenEncoded", String(opts.urlStructureToken || ""));
  params.set("PaymentData.IsValidationMessagesV2", "true");
  params.set("PaymentData.CustomFields", opts.customFields || "");
  return params.toString();
}

/**
 * POST HandleCreditCardRequestV2 via undici (optional ctx jar/proxy).
 * Wire often returns 302 → CCPaymentRedirect?Data=JWT (ASP.NET post-redirect).
 * That IS the auth handoff — not a failure.
 */
export async function postBandaiGeIssuerHttp(opts = {}) {
  const url = String(opts.url || "");
  if (!isBandaiGeIssuerPaymentUrl(url)) {
    return {
      ok: false,
      error: "not_issuer_url",
      note: "Expected secure-bandai …/Payments/HandleCreditCard*",
    };
  }
  const body = opts.body != null ? String(opts.body) : "";
  if (!body) {
    return { ok: false, error: "body_required", note: "Need issuer POST body (capture or build)" };
  }

  const headers = {
    accept: "text/html,application/xhtml+xml,application/json,*/ *",
    "content-type":
      opts.contentType || "application/x-www-form-urlencoded; charset=UTF-8",
    origin: BANDAI_GE_SECURE,
    referer: opts.referer || `${BANDAI_GE_SECURE}/payments/CreditCardForm/`,
    "user-agent": opts.userAgent || DEFAULT_UA,
    ...(opts.headers || {}),
  };
  // typo fix accept
  headers.accept = "text/html,application/xhtml+xml,application/json,*/*";
  const cookie = opts.cookieHeader || cookieHeaderFromJar(opts.ctx?.jar);
  if (cookie) headers.cookie = cookie;

  const t0 = Date.now();
  try {
    const res = await request(
      url,
      { method: "POST", headers, body },
      opts.ctx || {},
    );
    try {
      opts.ctx?.jar?.ingest?.(res.headers);
    } catch {
      /* ignore */
    }
    const text = await res.text();
    const ms = Date.now() - t0;
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      /* ignore */
    }
    const locHeader =
      (typeof res.headers?.get === "function" &&
        (res.headers.get("location") || res.headers.get("Location"))) ||
      "";
    const locHtml = (String(text || "").match(
      /href=["']([^"']*CCPaymentRedirect[^"']*)["']/i,
    ) || [])[1];
    const redirectUrl = locHeader || locHtml || null;
    const isPaymentRedirect = /CCPaymentRedirect/i.test(String(redirectUrl || ""));
    // 2xx JSON or 3xx/200 HTML redirect into CCPaymentRedirect = issuer accepted.
    const ok =
      (res.status >= 200 && res.status < 300 && !/Object moved/i.test(text)) ||
      ((res.status === 302 || res.status === 301 || res.status === 303 || res.status === 200) &&
        isPaymentRedirect);

    let redirectSnippet = null;
    if (ok && isPaymentRedirect && redirectUrl && opts.followRedirect !== false) {
      try {
        const abs = /^https?:\/\//i.test(redirectUrl)
          ? redirectUrl
          : new URL(redirectUrl, BANDAI_GE_WEBSERVICES).href;
        const followed = await request(
          abs,
          {
            method: "GET",
            headers: {
              "user-agent": opts.userAgent || DEFAULT_UA,
              accept: "text/html,*/*",
              referer: url,
              ...(cookie ? { cookie } : {}),
            },
          },
          opts.ctx || {},
        );
        const ftext = await followed.text();
        redirectSnippet = String(ftext || "").replace(/\s+/g, " ").slice(0, 280);
      } catch {
        /* ignore follow errors — redirect itself proves wire */
      }
    }

    return {
      ok,
      status: res.status,
      ms,
      bodySnippet: String(text || "").replace(/\s+/g, " ").slice(0, 240),
      redirectUrl: redirectUrl ? String(redirectUrl).slice(0, 220) : null,
      redirectSnippet,
      isPaymentRedirect,
      json,
      sawAuthWire: ok,
      via: "http-ge-issuer",
    };
  } catch (e) {
    return {
      ok: false,
      error: e?.message || "issuer_http_failed",
      ms: Date.now() - t0,
      via: "http-ge-issuer",
    };
  }
}

export async function replayCapturedIssuerHttp(opts = {}) {
  const cap = loadIssuerCapture(opts.capturePath || CAPTURE_DEFAULT);
  if (!cap?.url || !cap?.body) {
    return {
      ok: false,
      error: "no_capture",
      note: `Missing ${opts.capturePath || CAPTURE_DEFAULT} — run browser GE once to capture`,
      blockers: ["checkout_guid", "machineId", "urlStructureToken"],
    };
  }
  return postBandaiGeIssuerHttp({
    url: cap.url,
    body: cap.body,
    contentType: cap.contentType || undefined,
    cookieHeader: opts.cookieHeader,
    headers: opts.headers,
    ctx: opts.ctx,
    timeoutMs: opts.timeoutMs,
  });
}

/**
 * Full HTTP GE attempt after Bandai HTTP checkoutSn + merchantCartToken.
 * Does not use Playwright. Stops with explicit blockers if machineId/JWT missing
 * unless opts.forceIssuer=true.
 */
export async function runBandaiGeHttpPay(opts = {}) {
  const steps = [];
  const timeline = [];
  const t0 = Date.now();
  const mark = (event, extra = {}) => {
    const row = { t: new Date().toISOString(), elapsedMs: Date.now() - t0, event, ...extra };
    timeline.push(row);
    try {
      opts.onProgress?.(event, row);
    } catch {
      /* ignore */
    }
    return row;
  };
  const push = (step, row) => {
    const out = { step, ...row };
    steps.push(out);
    mark(step, { ok: out.ok, note: out.note, ms: out.ms, status: out.status });
    return out;
  };

  const merchantCartToken = opts.merchantCartToken;
  const card = opts.card;
  const ctx = opts.ctx;
  const area = opts.area || "au";
  const encodedMerchant = opts.encodedMerchantId || BANDAI_GE_ENCODED_MERCHANT;
  const mid = opts.merchantId || BANDAI_GE_MID;
  const stopBeforeIssuer = opts.stopBeforeIssuer === true;
  const forceIssuer = opts.forceIssuer === true;

  if (!merchantCartToken) {
    return {
      ok: false,
      error: "merchantCartToken_required",
      steps,
      timeline,
      failedStep: "ge_get_cart_token",
      checkoutStage: "tokenize",
      via: "http-ge",
    };
  }

  // Optional GEM asset warm (cache only).
  mark("gem_warm_start");
  await httpText(`${BANDAI_GE_GEM}/includes/js/${mid}`, {
    ctx,
    userAgent: opts.userAgent,
    referer: "https://p-bandai.com/",
  }).catch(() => null);

  const tokenOut = await getBandaiGeCartToken({
    ctx,
    merchantCartToken,
    merchantId: mid,
    area,
    webStoreInstanceCode: area,
    customerEmail: opts.customerEmail,
    cultureCode: opts.cultureCode || "en-GB",
    preferedCultureCode: opts.preferedCultureCode || "en-GB",
    cookieConsent: opts.cookieConsent,
    captchaResponseToken: opts.captchaResponseToken,
    checkoutParams: opts.checkoutParams,
    userAgent: opts.userAgent,
    referer: opts.referer || `https://p-bandai.com/${area}/orderdetails`,
  });
  push("ge_get_cart_token", {
    ok: tokenOut.ok,
    status: tokenOut.status,
    ms: tokenOut.ms,
    note: tokenOut.ok
      ? `CartToken ${tokenOut.cartToken}${tokenOut.isCaptcha ? " IsCaptcha" : ""}`
      : `GetCartToken fail success=${tokenOut.success} captcha=${tokenOut.isCaptcha} ${tokenOut.bodySnippet || tokenOut.message || ""}`.slice(
          0,
          220,
        ),
  });

  try {
    fs.writeFileSync(
      BOOT_CAPTURE,
      JSON.stringify(
        {
          at: new Date().toISOString(),
          getCartToken: {
            url: tokenOut.urlFull,
            status: tokenOut.status,
            success: tokenOut.success,
            cartToken: tokenOut.cartToken,
            isCaptcha: tokenOut.isCaptcha,
            bodySnippet: tokenOut.bodySnippet,
            json: tokenOut.json,
          },
          merchantCartToken,
        },
        null,
        2,
      ),
    );
  } catch {
    /* ignore */
  }

  if (!tokenOut.ok || !tokenOut.cartToken) {
    return {
      ok: false,
      steps,
      timeline,
      failedStep: "ge_get_cart_token",
      error: tokenOut.isCaptcha ? "ge_cart_token_captcha" : "ge_get_cart_token_failed",
      paymentStatus: tokenOut.isCaptcha ? "ge_captcha_required" : "ge_token_failed",
      checkoutStage: "tokenize",
      checkoutSn: opts.checkoutSn || null,
      cartToken: null,
      isCaptcha: tokenOut.isCaptcha,
      blockers: tokenOut.isCaptcha
        ? ["ge_cart_token_captcha"]
        : ["ge_get_cart_token"],
      via: "http-ge",
      elapsedMs: Date.now() - t0,
    };
  }

  const guid = tokenOut.cartToken;

  const v2Url = `${BANDAI_GE_WEBSERVICES}/Checkout/v2/${encodedMerchant}/${guid}`;
  const v2 = await httpText(v2Url, {
    ctx,
    userAgent: opts.userAgent,
    accept: "text/html,application/xhtml+xml,*/*",
    headers: {
      referer: opts.referer || `https://p-bandai.com/${area}/orderdetails`,
    },
  });
  let urlStructureToken = extractUrlStructureToken(v2.text);
  let machineId = extractMachineId(v2.text);
  push("ge_checkout_v2", {
    ok: v2.ok,
    status: v2.status,
    ms: v2.ms,
    note: `Checkout/v2 ${v2.status}; jwt=${Boolean(urlStructureToken)} machineId=${Boolean(machineId)} bytes=${(v2.text || "").length}`,
  });

  // Hydrate shipping / duties / summary (browser does this before Pay).
  for (const actionId of [1, 2, 3]) {
    const haUrl = `${BANDAI_GE_WEBSERVICES}/checkoutv2/handleaction/${actionId}/${guid}/${encodedMerchant}`;
    const ha = await httpText(haUrl, {
      ctx,
      method: "POST",
      userAgent: opts.userAgent,
      accept: "application/json, text/plain, */*",
      headers: {
        origin: BANDAI_GE_WEBSERVICES,
        referer: v2Url,
        "content-type": "application/json;charset=UTF-8",
        "x-requested-with": "XMLHttpRequest",
      },
      body: opts.handleActionBodies?.[actionId] || "{}",
    });
    if (!urlStructureToken) urlStructureToken = extractUrlStructureToken(ha.text);
    push(`ge_handleaction_${actionId}`, {
      ok: ha.ok,
      status: ha.status,
      ms: ha.ms,
      note: String(ha.text || "").replace(/\s+/g, " ").slice(0, 160),
    });
  }

  const ccUrl = `${BANDAI_GE_SECURE}/payments/CreditCardForm/${guid}/${opts.paymentMethodId || 2}`;
  const cc = await httpText(ccUrl, {
    ctx,
    userAgent: opts.userAgent,
    accept: "text/html,application/xhtml+xml,*/*",
    headers: { referer: v2Url },
  });
  if (!urlStructureToken) urlStructureToken = extractUrlStructureToken(cc.text);
  if (!machineId) machineId = extractMachineId(cc.text);
  // CreditCardForm wire uses paymentMethodId=1 (hidden); issuer capture used 2.
  let paymentMethodId = opts.paymentMethodId || null;
  const pmMatch = String(cc.text || "").match(
    /name=["']PaymentData\.paymentMethodId["'][^>]*value=["'](\d+)["']/i,
  );
  if (!paymentMethodId && pmMatch) paymentMethodId = pmMatch[1];
  if (!paymentMethodId) paymentMethodId = "2";
  push("ge_credit_card_form", {
    ok: cc.ok,
    status: cc.status,
    ms: cc.ms,
    note: `CreditCardForm ${cc.status}; jwt=${Boolean(urlStructureToken)} machineId=${Boolean(machineId)} pm=${paymentMethodId} bytes=${(cc.text || "").length}`,
  });

  // iovation snare.js fills #ioBlackBox on Checkout/v2 — needs a real DOM.
  // Reuse F5 bridge page when provided (not GE Pay UI fill/click).
  if (!machineId && opts.page) {
    const mint = await mintIovationBlackbox({
      page: opts.page,
      checkoutV2Url: v2Url,
      timeoutMs: opts.iovationTimeoutMs,
    });
    push("ge_iovation_mint", {
      ok: mint.ok,
      status: null,
      ms: mint.ms,
      note: mint.ok
        ? `ioBlackBox bytes=${String(mint.machineId || "").length}`
        : `iovation fail ${mint.error || ""}`.slice(0, 160),
    });
    if (mint.machineId) machineId = mint.machineId;
  }

  try {
    const prev = fs.existsSync(BOOT_CAPTURE)
      ? JSON.parse(fs.readFileSync(BOOT_CAPTURE, "utf8"))
      : {};
    fs.writeFileSync(
      BOOT_CAPTURE,
      JSON.stringify(
        {
          ...prev,
          cartToken: guid,
          checkoutV2: { status: v2.status, bytes: (v2.text || "").length },
          creditCardForm: { status: cc.status, bytes: (cc.text || "").length },
          urlStructureToken: urlStructureToken ? `${urlStructureToken.slice(0, 40)}…` : null,
          machineIdPresent: Boolean(machineId),
          machineIdBytes: machineId ? String(machineId).length : 0,
          paymentMethodId,
        },
        null,
        2,
      ),
    );
  } catch {
    /* ignore */
  }

  const blockers = [];
  if (!urlStructureToken) blockers.push("urlStructureToken");
  if (!machineId) blockers.push("machineId");
  if (!card?.number || !card?.cvv) blockers.push("card");

  mark("ge_http_hydrate_done", {
    guid,
    blockers,
    urlStructureToken: Boolean(urlStructureToken),
    machineId: Boolean(machineId),
  });

  if (stopBeforeIssuer || (blockers.length && !forceIssuer)) {
    return {
      ok: false,
      steps,
      timeline,
      failedStep: blockers[0] || "ge_http_stop",
      error: blockers.length ? `http_ge_blockers:${blockers.join(",")}` : "stop_before_issuer",
      paymentStatus: "http_ge_hydrated",
      checkoutStage: "tokenize",
      checkoutSn: opts.checkoutSn || null,
      cartToken: guid,
      blockers,
      urlStructureToken: Boolean(urlStructureToken),
      machineId: Boolean(machineId),
      via: "http-ge",
      elapsedMs: Date.now() - t0,
      note: `HTTP GE hydrated guid=${guid}; blockers=${blockers.join(",") || "none"}`,
    };
  }

  // Optional save / verify (best-effort; browser fires these before issuer).
  await httpText(`${BANDAI_GE_WEBSERVICES}/checkoutv2/save/${encodedMerchant}/${guid}`, {
    ctx,
    method: "POST",
    userAgent: opts.userAgent,
    headers: {
      origin: BANDAI_GE_WEBSERVICES,
      referer: v2Url,
      "content-type": "application/json;charset=UTF-8",
    },
    body: "{}",
  }).catch(() => null);

  const issuerUrl =
    opts.issuerUrl ||
    `${BANDAI_GE_SECURE}/1/Payments/HandleCreditCardRequestV2/${encodedMerchant}/${guid}?mode=${opts.issuerMode || "13534"}`;
  const body = buildIssuerFormBody({
    card,
    cartToken: guid,
    machineId,
    urlStructureToken,
    gatewayId: opts.gatewayId,
    paymentMethodId,
  });
  const issuer = await postBandaiGeIssuerHttp({
    url: issuerUrl,
    body,
    ctx,
    userAgent: opts.userAgent,
    referer: ccUrl,
  });
  const declineOnRedirect =
    issuer.redirectSnippet &&
    /\b(?:declined|decline|insufficient|not authorised|not authorized|failed)\b/i.test(
      issuer.redirectSnippet,
    );
  push("ge_issuer_http", {
    ok: issuer.ok,
    status: issuer.status,
    ms: issuer.ms,
    note: (
      issuer.redirectUrl
        ? `redirect ${issuer.status} ${issuer.redirectUrl}${declineOnRedirect ? " DECLINE?" : ""} ${issuer.redirectSnippet || ""}`
        : issuer.bodySnippet || issuer.error || ""
    ).slice(0, 220),
  });

  const paymentStatus = !issuer.ok
    ? "issuer_http_failed"
    : declineOnRedirect
      ? "declined_or_auth_failed"
      : issuer.isPaymentRedirect
        ? "pay_submitted_http"
        : "pay_submitted_http";
  return {
    ok: Boolean(issuer.ok),
    steps,
    timeline,
    failedStep: issuer.ok ? null : "ge_issuer_http",
    error: issuer.ok ? null : issuer.error || issuer.bodySnippet,
    paymentStatus,
    checkoutStage: declineOnRedirect ? "declined" : "tokenize",
    checkoutSn: opts.checkoutSn || null,
    cartToken: guid,
    chargeReqCount: 1,
    sawAuthWire: Boolean(issuer.ok || issuer.sawAuthWire),
    blockers,
    redirectUrl: issuer.redirectUrl || null,
    via: "http-ge",
    elapsedMs: Date.now() - t0,
    note: issuer.ok
      ? `HTTP issuer ${issuer.status}${issuer.isPaymentRedirect ? "→CCPaymentRedirect" : ""} guid=${guid}`
      : `HTTP issuer failed; ${issuer.bodySnippet || issuer.error}`,
  };
}

export default {
  extractGeCheckoutGuid,
  parseJsonp,
  buildGetCartTokenParams,
  buildGetCartTokenUrl,
  getBandaiGeCartToken,
  buildIssuerFormBody,
  extractUrlStructureToken,
  extractMachineId,
  mintIovationBlackbox,
  loadIssuerCapture,
  postBandaiGeIssuerHttp,
  replayCapturedIssuerHttp,
  runBandaiGeHttpPay,
  BANDAI_GE_MID,
  BANDAI_GE_ENCODED_MERCHANT,
};
