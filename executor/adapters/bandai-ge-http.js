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

/** Read input/select value from Checkout/v2 HTML. */
export function htmlFormValue(html, name) {
  const h = String(html || "");
  const esc = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // <select name="…">…<option selected value="49181"> — state IDs live here.
  const selectRe = new RegExp(
    `<(?:select)[^>]*\\bname=["']${esc}["'][^>]*>([\\s\\S]*?)</select>`,
    "i",
  );
  const selectBody = h.match(selectRe)?.[1];
  if (selectBody != null) {
    const selected =
      selectBody.match(
        /<option[^>]*\bselected\b[^>]*\bvalue=["']([^"']*)["']/i,
      ) ||
      selectBody.match(
        /<option[^>]*\bvalue=["']([^"']*)["'][^>]*\bselected\b/i,
      );
    if (selected) return selected[1];
  }
  const patterns = [
    new RegExp(`name=["']${esc}["'][^>]*value=["']([^"']*)["']`, "i"),
    new RegExp(`value=["']([^"']*)["'][^>]*name=["']${esc}["']`, "i"),
    // radio checked
    new RegExp(
      `name=["']${esc}["'][^>]*\\bchecked\\b[^>]*value=["']([^"']*)["']`,
      "i",
    ),
    new RegExp(
      `value=["']([^"']*)["'][^>]*name=["']${esc}["'][^>]*\\bchecked\\b`,
      "i",
    ),
  ];
  for (const re of patterns) {
    const m = h.match(re);
    if (m) return m[1];
  }
  return "";
}

function geAddressFromForm(v, prefix, countryId) {
  const phoneNational = v(`CheckoutData.${prefix}Address.PhoneNational`);
  const phone = v(`CheckoutData.${prefix}Phone`) || phoneNational;
  const stateRaw = v(`CheckoutData.${prefix}StateID`);
  return {
    Address1: v(`CheckoutData.${prefix}Address1`),
    Address2: v(`CheckoutData.${prefix}Address2`) || "",
    City: v(`CheckoutData.${prefix}City`),
    Zip: v(`CheckoutData.${prefix}ZIP`) || v(`CheckoutData.${prefix}Zip`),
    StateId: stateRaw || null,
    CountryId: countryId,
    Email: v("CheckoutData.Email") || v(`CheckoutData.${prefix}Email`),
    FirstName: v(`CheckoutData.${prefix}FirstName`),
    LastName: v(`CheckoutData.${prefix}LastName`),
    Phone: phone,
    PhonePrefix: v(`CheckoutData.${prefix}PhonePrefix`) || "",
    PhonePrefixCountryId: Number(
      v(`CheckoutData.${prefix}PhonePrefixCountryId`) || countryId || 14,
    ),
  };
}

/** Address + culture scraped from Checkout/v2 HTML for handleaction bodies. */
export function parseCheckoutV2Form(html) {
  const v = (name) => htmlFormValue(html, name);
  const countryId = Number(v("CheckoutData.ShippingCountryID") || v("ShippingCountryID") || 14);
  const shipping = geAddressFromForm(v, "Shipping", countryId);
  const billingCountryId = Number(v("CheckoutData.BillingCountryID") || countryId);
  const billing = geAddressFromForm(v, "Billing", billingCountryId);
  // ShippingSameAsBilling → billing fields may mirror shipping.
  for (const k of Object.keys(shipping)) {
    if (billing[k] == null || billing[k] === "") billing[k] = shipping[k];
  }
  const cultureFromInput = v("CheckoutData.CultureID");
  const cultureMatch = String(html || "").match(/cultureID\s*:\s*["']?(\d+)/i);
  const shippingType =
    v("CheckoutData.ShippingType") ||
    (String(html || "").match(
      /name=["']CheckoutData\.ShippingType["'][^>]*value=["']([^"']+)["'][^>]*checked/i,
    ) ||
      String(html || "").match(
        /value=["'](ShippingSameAsBilling|ShippingDifferent)["'][^>]*name=["']CheckoutData\.ShippingType["'][^>]*checked/i,
      ) ||
      [])[1] ||
    "ShippingSameAsBilling";
  return {
    countryId,
    cultureId: Number(cultureFromInput || cultureMatch?.[1] || 2057),
    merchantId: BANDAI_GE_MID,
    shipping,
    billing,
    email: shipping.Email || billing.Email,
    shippingType,
    selectedShippingOptionId: v("CheckoutData.SelectedShippingOptionID") || "",
    selectedPaymentMethodId: v("CheckoutData.SelectedPaymentMethodID") || "1",
    selectedTaxOption: v("CheckoutData.SelectedTaxOption") || "",
    gatewayId: v("CheckoutData.CurrentPaymentGayewayID") || v("PaymentData.gatewayId") || "2",
    hasAddress: Boolean(shipping.Address1 && shipping.City && shipping.Zip),
  };
}

/**
 * GEM CheckoutManagerV2 HandleAction bodies (cv2bot.js).
 * Action enum: ShippingOptions=1, TaxOptions=2, Totals=3.
 */
export function buildHandleActionBodies(form, opts = {}) {
  const merchantId = Number(opts.merchantId || form.merchantId || BANDAI_GE_MID);
  const countryId = Number(opts.countryId || form.countryId || 14);
  const cultureId = Number(opts.cultureId || form.cultureId || 2057);
  const token = String(opts.cartToken || opts.token || "");
  const shippingMethodId =
    opts.shippingMethodId != null && opts.shippingMethodId !== ""
      ? opts.shippingMethodId
      : form.selectedShippingOptionId || "";
  const shipping = form.shipping || {};
  const billing = form.billing || shipping;
  const billingSame =
    opts.billingSameAsShipping != null
      ? Boolean(opts.billingSameAsShipping)
      : /SameAsBilling/i.test(String(form.shippingType || ""));

  const shippingOptions = {
    Action: 1,
    Token: token,
    MerchantId: merchantId,
    ShippingCountryID: countryId,
    ShippingMethodID: shippingMethodId || null,
    CultureID: cultureId,
    BillingData: billing,
    ShippingData: shipping,
    StoreID: 0,
    IsCollectionPoints: false,
    IsStoreCollection: false,
    BillingSameAsShipping: billingSame,
    ShippingType: form.shippingType || "ShippingSameAsBilling",
  };
  const taxOptions = {
    Action: 2,
    Token: token,
    MerchantId: merchantId,
    ShippingCountryID: countryId,
    CountryID: countryId,
    ShippingMethodID: shippingMethodId || 0,
    ForceDDPType: opts.forceDDPType ?? null,
    StateID: shipping.StateId || null,
    IsSameDayDispatchChecked: false,
    SelectedPaymentMethodID: String(
      opts.paymentMethodId || form.selectedPaymentMethodId || "1",
    ),
    TaxCalculationAddress: shipping,
  };
  const totals = {
    Action: 3,
    Token: token,
    MerchantId: merchantId,
    ShippingMethodID: shippingMethodId || null,
    TaxOption: opts.taxOption || form.selectedTaxOption || null,
    IsSameDayDispatchChecked: false,
    SelectedPaymentMethodID: String(
      opts.paymentMethodId || form.selectedPaymentMethodId || "1",
    ),
    ShippingCountryID: countryId,
  };
  return { 1: shippingOptions, 2: taxOptions, 3: totals };
}

/** Pick cheapest / default shipping option id from ShippingOptions JSON. */
export function pickShippingMethodId(shippingJson) {
  const options =
    shippingJson?.shippingOptions ||
    shippingJson?.ShippingOptions ||
    (Array.isArray(shippingJson?.Data) ? shippingJson.Data : null) ||
    [];
  if (!Array.isArray(options) || !options.length) return "";
  const withId = options.filter((o) => o && (o.ID != null || o.Id != null || o.id != null));
  if (!withId.length) return "";
  const cheapest = withId.reduce((acc, curr) => {
    const a = Number(acc.RegularPrice ?? acc.Price ?? Infinity);
    const b = Number(curr.RegularPrice ?? curr.Price ?? Infinity);
    return b < a ? curr : acc;
  });
  const preferred =
    withId.find((o) => o.IsDefault || o.isDefault) ||
    withId.find((o) => /express/i.test(String(o.Description || o.Name || ""))) ||
    cheapest;
  return String(preferred.ID ?? preferred.Id ?? preferred.id ?? "");
}

export function decodeCcPaymentRedirectData(urlOrJwt) {
  const s = String(urlOrJwt || "");
  const m = s.match(/(?:Data=)?(eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)/);
  if (!m) return null;
  try {
    const payload = m[1].split(".")[1];
    const pad = payload + "=".repeat((4 - (payload.length % 4)) % 4);
    const json = JSON.parse(Buffer.from(pad.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"));
    return json;
  } catch {
    return null;
  }
}

/**
 * Revolut-silent 302s were ReloadBehaviour (+ DataCorruption) — NOT a bank hit.
 * Require a stronger payment signal in the redirect JWT / HTML.
 */
export function isBandaiGePaymentRedirectSignal(redirectUrl, redirectSnippet = "") {
  const data = decodeCcPaymentRedirectData(redirectUrl);
  const map = {};
  if (Array.isArray(data)) {
    for (const row of data) {
      const k = String(row?.Key || row?.key || "");
      if (k) map[k] = String(row?.Value ?? row?.value ?? "");
    }
  }
  if (/DataCorruption/i.test(map.RedirectErrorType || "")) return false;
  if (/^false$/i.test(map.Success || "") && /ReloadBehaviour/i.test(map.ReloadBehaviour || "Redirect")) {
    return false;
  }
  const keys = Object.keys(map);
  const weakOnly =
    keys.length > 0 &&
    keys.every((k) => /^(ReloadBehaviour|finalizeProcess)$/i.test(k));
  if (weakOnly) return false;

  const blob = `${JSON.stringify(data || {})} ${redirectSnippet}`;
  if (
    /ReloadBehaviour/i.test(blob) &&
    !/\b(TransactionStatus|PaymentId|ThreeDS|3DS|CReq|ACS|Decline|Declined|OrderId|AuthResult|IsSuccess)\b/i.test(
      blob,
    )
  ) {
    return false;
  }
  // Exact bank keys only — do not match TransactionStatusType=Undefined.
  return /\b(TransactionStatus|PaymentId|ThreeDS|3DS|CReq|ACS|Decline|Declined|OrderId|AuthResult|IsSuccess)\b/i.test(
    blob,
  ) && !/\bTransactionStatusType["']?\s*:\s*["']?Undefined/i.test(blob);
}

/**
 * machineId = iovation RED blackbox (#ioBlackBox) from snare.js on Checkout/v2.
 * Not the GE Pay UI — only fingerprint mint. Prefer reusing the F5 bridge page.
 */
async function cookiesFromPage(page) {
  if (!page?.context) return {};
  try {
    const arr = await page.context().cookies();
    const out = {};
    for (const c of arr || []) {
      if (!c?.name) continue;
      const host = String(c.domain || "");
      if (/global-e\.com|p-bandai\.com|bandai/i.test(host)) {
        out[c.name] = c.value;
      }
    }
    return out;
  } catch {
    return {};
  }
}

/** Push undici jar cookies into Playwright so iovation mint shares GE session. */
async function syncJarToPage(page, jar) {
  if (!page?.context || !jar?.dump) return 0;
  const dump = jar.dump() || {};
  const list = [];
  for (const [name, value] of Object.entries(dump)) {
    if (!name || value == null) continue;
    // GE hosts — cookie domain must match URL we navigate.
    for (const url of [
      `${BANDAI_GE_WEBSERVICES}/`,
      `${BANDAI_GE_SECURE}/`,
      `${BANDAI_GE_GEPI}/`,
      "https://p-bandai.com/",
    ]) {
      list.push({ name, value: String(value), url });
    }
  }
  if (!list.length) return 0;
  try {
    await page.context().addCookies(list);
    return Object.keys(dump).length;
  } catch {
    return 0;
  }
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
  if (opts.jar) {
    await syncJarToPage(page, opts.jar);
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
    const cookies = await cookiesFromPage(page);
    return {
      ok: Boolean(value),
      machineId: value,
      ms: Date.now() - t0,
      cookies,
    };
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
    const cookies = await cookiesFromPage(page);
    return {
      ok: Boolean(fallback && fallback.length > 40),
      machineId: fallback || null,
      ms: Date.now() - t0,
      error: e?.message || "iovation_mint_failed",
      cookies,
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
 * POST issuer from the Playwright page that minted iovation — same cookies/TLS
 * as #ioBlackBox. Undici POST after cross-context mint often returns
 * DataCorruption / IsTheSameCartToken=False (Revolut silent).
 */
export async function postBandaiGeIssuerViaPage(opts = {}) {
  const page = opts.page;
  const url = String(opts.url || "");
  const body = String(opts.body || "");
  if (!page) return { ok: false, error: "page_required", via: "page-ge-issuer" };
  if (!isBandaiGeIssuerPaymentUrl(url)) {
    return { ok: false, error: "not_issuer_url", via: "page-ge-issuer" };
  }
  if (!body) return { ok: false, error: "body_required", via: "page-ge-issuer" };
  const t0 = Date.now();
  try {
    // Prefer Playwright APIRequestContext — page.evaluate(fetch) often hides
    // 302 Location (opaqueredirect), which forced undici fallback.
    const api = page.context()?.request || page.request;
    let status = 0;
    let location = "";
    let text = "";
    if (api?.post) {
      const res = await api.post(url, {
        data: body,
        headers: {
          accept: "text/html,application/xhtml+xml,application/json,*/*",
          "content-type":
            opts.contentType || "application/x-www-form-urlencoded; charset=UTF-8",
          origin: BANDAI_GE_SECURE,
          referer: opts.referer || `${BANDAI_GE_SECURE}/payments/CreditCardForm/`,
        },
        maxRedirects: 0,
        timeout: Math.min(60_000, Number(opts.timeoutMs) || 45_000),
      });
      status = res.status();
      location =
        res.headers()?.location ||
        res.headers()?.Location ||
        (typeof res.headerValue === "function"
          ? (await res.headerValue("location").catch(() => null)) || ""
          : "") ||
        "";
      text = await res.text().catch(() => "");
      // Some Playwright builds follow anyway — scrape Object moved / body.
      if (!location) {
        const m = String(text || "").match(
          /href=["']([^"']*CCPaymentRedirect[^"']*)["']/i,
        );
        if (m) location = m[1];
      }
    } else {
      const result = await page.evaluate(
        async ({ url: u, body: b, referer, contentType }) => {
          const res = await fetch(u, {
            method: "POST",
            headers: {
              accept: "text/html,application/xhtml+xml,application/json,*/*",
              "content-type":
                contentType || "application/x-www-form-urlencoded; charset=UTF-8",
              origin: "https://secure-bandai.global-e.com",
              referer:
                referer || "https://secure-bandai.global-e.com/payments/CreditCardForm/",
            },
            body: b,
            redirect: "manual",
            credentials: "include",
          });
          const t = await res.text().catch(() => "");
          return {
            status: res.status,
            location: res.headers.get("location") || "",
            bodySnippet: String(t || "").replace(/\s+/g, " ").slice(0, 240),
            body: t,
          };
        },
        {
          url,
          body,
          referer: opts.referer || null,
          contentType: opts.contentType || null,
        },
      );
      status = result.status;
      location = result.location || "";
      text = result.body || result.bodySnippet || "";
      if (!location) {
        const m = String(text || "").match(
          /href=["']([^"']*CCPaymentRedirect[^"']*)["']/i,
        );
        if (m) location = m[1];
      }
    }

    const redirectUrl = location || null;
    const isPaymentRedirect = /CCPaymentRedirect/i.test(String(redirectUrl || ""));
    const redirectPayload = isPaymentRedirect
      ? decodeCcPaymentRedirectData(redirectUrl)
      : null;
    const bankSignal = isBandaiGePaymentRedirectSignal(redirectUrl || "", "");
    const ok = Boolean(isPaymentRedirect && bankSignal);
    return {
      ok,
      status,
      ms: Date.now() - t0,
      bodySnippet: String(text || "").replace(/\s+/g, " ").slice(0, 240),
      redirectUrl: redirectUrl ? String(redirectUrl).slice(0, 320) : null,
      redirectUrlFull: redirectUrl,
      redirectSnippet: null,
      redirectPayload,
      isPaymentRedirect,
      reloadOnly: Boolean(isPaymentRedirect && !bankSignal),
      bankSignal,
      declineOnRedirect: false,
      sawAuthWire: Boolean(ok),
      via: "page-ge-issuer",
      error: ok
        ? null
        : isPaymentRedirect
          ? "ge_reload_only_no_bank"
          : status
            ? "issuer_page_no_redirect"
            : "issuer_page_failed",
    };
  } catch (e) {
    return {
      ok: false,
      error: e?.message || "issuer_page_failed",
      ms: Date.now() - t0,
      via: "page-ge-issuer",
    };
  }
}

/**
 * POST HandleCreditCardRequestV2 via undici (optional ctx jar/proxy).
 * Wire often returns 302 → CCPaymentRedirect?Data=JWT.
 * ReloadBehaviour-only JWTs are NOT bank hits (Revolut silent) — fail closed.
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
    accept: "text/html,application/xhtml+xml,application/json,*/*",
    "content-type":
      opts.contentType || "application/x-www-form-urlencoded; charset=UTF-8",
    origin: BANDAI_GE_SECURE,
    referer: opts.referer || `${BANDAI_GE_SECURE}/payments/CreditCardForm/`,
    "user-agent": opts.userAgent || DEFAULT_UA,
    ...(opts.headers || {}),
  };
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
    const redirectUrlFull = redirectUrl ? String(redirectUrl) : null;
    const isPaymentRedirect = /CCPaymentRedirect/i.test(String(redirectUrl || ""));
    const redirectPayload = isPaymentRedirect
      ? decodeCcPaymentRedirectData(redirectUrlFull)
      : null;

    let redirectSnippet = null;
    if (isPaymentRedirect && redirectUrl && opts.followRedirect !== false) {
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
        /* ignore follow errors */
      }
    }

    const bankSignal = isBandaiGePaymentRedirectSignal(
      redirectUrlFull || "",
      redirectSnippet || "",
    );
    const declineOnRedirect =
      redirectSnippet &&
      /\b(?:declined|decline|insufficient|not authorised|not authorized|failed)\b/i.test(
        redirectSnippet,
      );
    // Direct 2xx JSON with payment fields also counts; bare ReloadBehaviour does not.
    const jsonOk =
      res.status >= 200 &&
      res.status < 300 &&
      !/Object moved/i.test(text) &&
      Boolean(json) &&
      /\b(Transaction|Payment|Order|Auth|3ds|Decline)\b/i.test(JSON.stringify(json));
    const ok =
      jsonOk ||
      (isPaymentRedirect && (bankSignal || declineOnRedirect));

    return {
      ok,
      status: res.status,
      ms,
      bodySnippet: String(text || "").replace(/\s+/g, " ").slice(0, 240),
      redirectUrl: redirectUrlFull ? redirectUrlFull.slice(0, 320) : null,
      redirectUrlFull,
      redirectSnippet,
      redirectPayload,
      isPaymentRedirect,
      reloadOnly: Boolean(isPaymentRedirect && !bankSignal && !declineOnRedirect),
      bankSignal: Boolean(bankSignal || declineOnRedirect),
      declineOnRedirect: Boolean(declineOnRedirect),
      json,
      sawAuthWire: Boolean(ok && (bankSignal || declineOnRedirect || jsonOk)),
      via: "http-ge-issuer",
      error: ok
        ? null
        : isPaymentRedirect
          ? "ge_reload_only_no_bank"
          : "issuer_http_failed",
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

  let guid = tokenOut.cartToken;

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

  // Hydrate shipping / tax / totals with real GEM Action+Token bodies.
  // Empty `{}` → 500 HandleAction_WithMerchantIdAndCartTokenInUrl (labs).
  const form = parseCheckoutV2Form(v2.text);
  let shippingMethodId = form.selectedShippingOptionId || "";
  let hydrateShippingOk = false;
  for (const actionId of [1, 2, 3]) {
    const bodies = buildHandleActionBodies(form, {
      cartToken: guid,
      shippingMethodId,
      // Totals/Tax use UI payment method; issuer POST still uses wire-proven ids.
      paymentMethodId: form.selectedPaymentMethodId || "1",
    });
    const haUrl = `${BANDAI_GE_WEBSERVICES}/checkoutv2/handleaction/${actionId}/${guid}/${encodedMerchant}`;
    const ha = await httpText(haUrl, {
      ctx,
      method: "POST",
      userAgent: opts.userAgent,
      accept: "application/json, text/plain, */*",
      headers: {
        origin: BANDAI_GE_WEBSERVICES,
        referer: v2Url,
        "content-type": "application/json",
        "x-requested-with": "XMLHttpRequest",
        "X-merchantId": String(mid),
      },
      body: JSON.stringify(opts.handleActionBodies?.[actionId] || bodies[actionId]),
    });
    let haJson = null;
    try {
      haJson = JSON.parse(String(ha.text || ""));
    } catch {
      haJson = null;
    }
    if (actionId === 1) {
      const picked = pickShippingMethodId(haJson);
      if (picked) shippingMethodId = picked;
      hydrateShippingOk = Boolean(
        ha.ok &&
          (haJson?.success === true ||
            haJson?.Success === true ||
            haJson?.exists === true ||
            (Array.isArray(haJson?.shippingOptions) && haJson.shippingOptions.length > 0)),
      );
    }
    if (!urlStructureToken) urlStructureToken = extractUrlStructureToken(ha.text);
    push(`ge_handleaction_${actionId}`, {
      ok: ha.ok && (actionId !== 1 || hydrateShippingOk || haJson?.success !== false),
      status: ha.status,
      ms: ha.ms,
      note: (
        actionId === 1
          ? `shipOk=${hydrateShippingOk} method=${shippingMethodId || "none"} addr=${form.hasAddress} state=${form.shipping?.StateId || "none"} ${String(ha.text || "").replace(/\s+/g, " ")}`
          : String(ha.text || "").replace(/\s+/g, " ")
      ).slice(0, 200),
    });
  }

  // Mint iovation BEFORE CreditCardForm JWT. page.goto(Checkout/v2) refreshes
  // GE cookies — scraping JWT first then minting caused DataCorruption /
  // IsTheSameCartToken=False on issuer (Revolut silent).
  let issuerPage = null;
  if (!machineId && opts.page) {
    const mint = await mintIovationBlackbox({
      page: opts.page,
      checkoutV2Url: v2Url,
      timeoutMs: opts.iovationTimeoutMs,
      jar: ctx?.jar,
    });
    push("ge_iovation_mint", {
      ok: mint.ok,
      status: null,
      ms: mint.ms,
      note: mint.ok
        ? `ioBlackBox bytes=${String(mint.machineId || "").length} cookies=${Object.keys(mint.cookies || {}).length}`
        : `iovation fail ${mint.error || ""}`.slice(0, 160),
    });
    if (mint.machineId) machineId = mint.machineId;
    if (mint.cookies && ctx?.jar?.load) {
      try {
        ctx.jar.load({ ...ctx.jar.dump(), ...mint.cookies });
      } catch {
        /* ignore */
      }
    }
    issuerPage = opts.page;
    // Re-bind guid if Playwright landed on a different CartToken.
    try {
      const pageGuid =
        extractGeCheckoutGuid(opts.page.url()) ||
        extractGeCheckoutGuid(await opts.page.content());
      if (pageGuid && pageGuid !== guid) {
        push("ge_cart_token_rebind", {
          ok: true,
          status: null,
          ms: 0,
          note: `page guid ${pageGuid} (was ${guid})`,
        });
        guid = pageGuid;
      }
    } catch {
      /* ignore */
    }
  }

  // Keep Playwright on Checkout/v2 after iovation. Top-level goto(CreditCardForm)
  // replaces the GE parent session → IsTheSameCartToken=False / DataCorruption.
  // Browser keeps Checkout/v2 with a secure-bandai iframe for the card form.
  let paymentMethodId = String(
    opts.paymentMethodId || form.selectedPaymentMethodId || "1",
  );
  let gatewayId = String(opts.gatewayId || form.gatewayId || "2");
  let ccUrl = `${BANDAI_GE_SECURE}/payments/CreditCardForm/${guid}/${paymentMethodId}`;
  let cc = { ok: false, status: 0, ms: 0, text: "" };

  if (issuerPage) {
    const tCc = Date.now();
    try {
      await syncJarToPage(issuerPage, ctx?.jar);
      let frame = null;
      try {
        frame =
          issuerPage.frames().find((f) =>
            /CreditCardForm|secure-bandai\.global-e\.com\/payments/i.test(f.url()),
          ) || null;
      } catch {
        frame = null;
      }
      if (!frame) {
        await issuerPage
          .evaluate((pm) => {
            const radio = document.querySelector(
              `input[name="CheckoutData.SelectedPaymentMethodID"][value="${pm}"]`,
            );
            if (radio) {
              radio.checked = true;
              radio.click();
            }
            const sel = document.querySelector("#SelectedPaymentMethodID");
            if (sel) {
              sel.value = String(pm);
              sel.dispatchEvent(new Event("change", { bubbles: true }));
            }
          }, paymentMethodId)
          .catch(() => null);
        await issuerPage.waitForTimeout(2500);
        try {
          frame =
            issuerPage.frames().find((f) =>
              /CreditCardForm|secure-bandai\.global-e\.com\/payments/i.test(f.url()),
            ) || null;
        } catch {
          frame = null;
        }
      }
      if (frame) {
        try {
          await frame.waitForSelector(
            'input[name="PaymentData.UrlStructureTokenEncoded"], input[name="PaymentData.machineId"]',
            { timeout: 10_000 },
          );
        } catch {
          /* scrape anyway */
        }
        const fromDom = await frame.evaluate(() => {
          const jwt =
            document.querySelector('input[name="PaymentData.UrlStructureTokenEncoded"]')
              ?.value || "";
          const mid =
            document.querySelector('input[name="PaymentData.machineId"]')?.value ||
            document.getElementById("ioBlackBox")?.value ||
            "";
          const pm =
            document.querySelector('input[name="PaymentData.paymentMethodId"]')?.value ||
            "";
          const gw =
            document.querySelector('input[name="PaymentData.gatewayId"]')?.value || "";
          return {
            jwt,
            mid,
            pm,
            gw,
            html: document.documentElement.outerHTML,
            url: location.href,
          };
        });
        cc = {
          ok: Boolean(fromDom.jwt),
          status: 200,
          ms: Date.now() - tCc,
          text: fromDom.html || "",
          domJwt: fromDom.jwt,
          domMachineId: fromDom.mid,
          domPm: fromDom.pm,
          domGw: fromDom.gw,
          frameUrl: fromDom.url,
        };
        if (fromDom.url) ccUrl = fromDom.url.split("?")[0];
      }
      const pageCookies = await cookiesFromPage(issuerPage);
      if (pageCookies && ctx?.jar?.load) {
        ctx.jar.load({ ...ctx.jar.dump(), ...pageCookies });
      }
      if (!cc.ms) cc.ms = Date.now() - tCc;
    } catch (e) {
      cc = {
        ok: false,
        status: 0,
        ms: Date.now() - tCc,
        text: "",
        error: e?.message || "cc_form_frame_failed",
      };
    }
  }

  if (!cc.ok || !(cc.domJwt || extractUrlStructureToken(cc.text))) {
    const httpCc = await httpText(ccUrl, {
      ctx,
      userAgent: opts.userAgent,
      accept: "text/html,application/xhtml+xml,*/*",
      headers: { referer: v2Url },
    });
    cc = {
      ...httpCc,
      domJwt: extractUrlStructureToken(httpCc.text),
      domMachineId: extractMachineId(httpCc.text),
      viaHttp: true,
    };
  }

  paymentMethodId = String(
    opts.paymentMethodId || cc.domPm || form.selectedPaymentMethodId || paymentMethodId || "1",
  );
  gatewayId = String(opts.gatewayId || cc.domGw || form.gatewayId || gatewayId || "2");
  urlStructureToken =
    cc.domJwt || extractUrlStructureToken(cc.text) || urlStructureToken;
  const formMachineId = cc.domMachineId || extractMachineId(cc.text);
  if (formMachineId) machineId = formMachineId;
  if (machineId && issuerPage && !formMachineId) {
    try {
      await issuerPage.evaluate((mid) => {
        const el =
          document.querySelector('input[name="PaymentData.machineId"]') ||
          document.getElementById("ioBlackBox");
        if (el) el.value = mid;
      }, machineId);
      for (const f of issuerPage.frames()) {
        if (!/secure-bandai|CreditCardForm/i.test(f.url())) continue;
        await f
          .evaluate((mid) => {
            const el =
              document.querySelector('input[name="PaymentData.machineId"]') ||
              document.getElementById("ioBlackBox");
            if (el) el.value = mid;
          }, machineId)
          .catch(() => null);
      }
    } catch {
      /* ignore */
    }
  }

  const jwtCart = (() => {
    try {
      const payload = decodeCcPaymentRedirectData(urlStructureToken);
      // UrlStructureToken payload is object, not Key/Value list.
      if (payload && typeof payload === "object" && !Array.isArray(payload)) {
        return payload.CartToken || payload.cartToken || null;
      }
    } catch {
      /* ignore */
    }
    try {
      const parts = String(urlStructureToken || "").split(".");
      if (parts.length < 2) return null;
      const pad = parts[1] + "=".repeat((4 - (parts[1].length % 4)) % 4);
      const json = JSON.parse(
        Buffer.from(pad.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"),
      );
      return json.CartToken || json.cartToken || null;
    } catch {
      return null;
    }
  })();
  if (jwtCart && jwtCart !== guid) {
    push("ge_cart_token_rebind", {
      ok: true,
      status: null,
      ms: 0,
      note: `jwt guid ${jwtCart} (was ${guid})`,
    });
    guid = jwtCart;
  }
  push("ge_credit_card_form", {
    ok: cc.ok,
    status: cc.status,
    ms: cc.ms,
    note: `CreditCardForm ${cc.status}; jwt=${Boolean(urlStructureToken)} machineId=${Boolean(machineId)} midSrc=${formMachineId ? "form" : machineId ? "iovation" : "none"} via=${issuerPage && cc.ok ? "page" : "http"} pm=${paymentMethodId} gw=${gatewayId} domPm=${cc.domPm || "-"} bytes=${(cc.text || "").length}`,
  });

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
          gatewayId,
          shippingMethodId: shippingMethodId || null,
          hydrateShippingOk,
          form: {
            hasAddress: form.hasAddress,
            countryId: form.countryId,
            stateId: form.shipping?.StateId || null,
            zip: form.shipping?.Zip || null,
            shippingType: form.shippingType,
          },
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
  if (!hydrateShippingOk) blockers.push("hydrate_shipping");
  if (!form.hasAddress) blockers.push("checkout_address");

  mark("ge_http_hydrate_done", {
    guid,
    blockers,
    urlStructureToken: Boolean(urlStructureToken),
    machineId: Boolean(machineId),
    hydrateShippingOk,
    shippingMethodId: shippingMethodId || null,
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
      "content-type": "application/json",
      "X-merchantId": String(mid),
    },
    body: JSON.stringify({
      Action: "Save",
      Token: guid,
      MerchantId: Number(mid),
    }),
  }).catch(() => null);

  const issuerUrl =
    opts.issuerUrl ||
    `${BANDAI_GE_SECURE}/1/Payments/HandleCreditCardRequestV2/${encodedMerchant}/${guid}?mode=${opts.issuerMode || "13534"}`;
  const body = buildIssuerFormBody({
    card,
    cartToken: guid,
    machineId,
    urlStructureToken,
    gatewayId,
    paymentMethodId,
  });
  // Prefer Playwright request (same cookie jar as CreditCardForm page).
  // Do not discard a page ReloadBehaviour result in favor of undici — both fail
  // the same way; keeping via=page makes the session path honest in logs.
  let issuer =
    issuerPage && opts.preferHttpIssuer !== true
      ? await postBandaiGeIssuerViaPage({
          page: issuerPage,
          url: issuerUrl,
          body,
          referer: ccUrl,
        })
      : null;
  if (
    !issuer ||
    (!issuer.isPaymentRedirect &&
      (issuer.error === "issuer_page_failed" ||
        issuer.error === "issuer_page_no_redirect"))
  ) {
    const httpIssuer = await postBandaiGeIssuerHttp({
      url: issuerUrl,
      body,
      ctx,
      userAgent: opts.userAgent,
      referer: ccUrl,
    });
    if (!issuer || (!issuer.isPaymentRedirect && httpIssuer.isPaymentRedirect)) {
      issuer = httpIssuer;
    }
  }
  if (!issuer) {
    issuer = await postBandaiGeIssuerHttp({
      url: issuerUrl,
      body,
      ctx,
      userAgent: opts.userAgent,
      referer: ccUrl,
    });
  }

  try {
    fs.writeFileSync(
      "/tmp/bandai-ge-issuer-last.json",
      JSON.stringify(
        {
          at: new Date().toISOString(),
          issuerUrl,
          status: issuer.status,
          ok: issuer.ok,
          reloadOnly: issuer.reloadOnly,
          bankSignal: issuer.bankSignal,
          redirectUrl: issuer.redirectUrlFull || issuer.redirectUrl,
          redirectPayload: issuer.redirectPayload,
          redirectSnippet: issuer.redirectSnippet,
          bodySnippet: issuer.bodySnippet,
          error: issuer.error,
          gatewayId,
          paymentMethodId,
          shippingMethodId,
          hydrateShippingOk,
        },
        null,
        2,
      ),
    );
  } catch {
    /* ignore */
  }

  const declineOnRedirect = Boolean(issuer.declineOnRedirect);
  push("ge_issuer_http", {
    ok: issuer.ok,
    status: issuer.status,
    ms: issuer.ms,
    note: (
      issuer.reloadOnly
        ? `RELOAD_ONLY ${issuer.status} err=${
            Array.isArray(issuer.redirectPayload)
              ? issuer.redirectPayload
                  .filter((x) =>
                    /RedirectErrorType|ErrorMessage|Success|IsTheSameCartToken|TransactionId/i.test(
                      String(x?.Key || ""),
                    ),
                  )
                  .map((x) => `${x.Key}=${x.Value}`)
                  .join(";")
              : ""
          }`
        : issuer.redirectUrl
          ? `redirect ${issuer.status} via=${issuer.via || "http"} bank=${issuer.bankSignal} ${issuer.redirectUrl}${declineOnRedirect ? " DECLINE?" : ""} ${issuer.redirectSnippet || ""}`
          : issuer.bodySnippet || issuer.error || ""
    ).slice(0, 280),
  });

  const paymentStatus = !issuer.ok
    ? issuer.reloadOnly
      ? "ge_reload_only_no_bank"
      : "issuer_http_failed"
    : declineOnRedirect
      ? "declined_or_auth_failed"
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
    sawAuthWire: Boolean(issuer.sawAuthWire),
    blockers,
    redirectUrl: issuer.redirectUrl || null,
    redirectPayload: issuer.redirectPayload || null,
    via: issuer.via === "page-ge-issuer" ? "http-ge+page-issuer" : "http-ge",
    elapsedMs: Date.now() - t0,
    note: issuer.ok
      ? `HTTP issuer ${issuer.status}${issuer.isPaymentRedirect ? "→CCPaymentRedirect" : ""} bank=${issuer.bankSignal} via=${issuer.via} guid=${guid}`
      : issuer.reloadOnly
        ? `HTTP issuer ReloadBehaviour only (no Revolut) via=${issuer.via} guid=${guid}`
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
  htmlFormValue,
  parseCheckoutV2Form,
  buildHandleActionBodies,
  pickShippingMethodId,
  decodeCcPaymentRedirectData,
  isBandaiGePaymentRedirectSignal,
  mintIovationBlackbox,
  loadIssuerCapture,
  postBandaiGeIssuerHttp,
  postBandaiGeIssuerViaPage,
  replayCapturedIssuerHttp,
  runBandaiGeHttpPay,
  BANDAI_GE_MID,
  BANDAI_GE_ENCODED_MERCHANT,
};
