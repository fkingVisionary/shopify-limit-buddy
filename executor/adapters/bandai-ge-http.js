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
 * Single Revolut (2026-07-22 07:24 AEST): never open the LIVE pay cart in Playwright.
 * Iovation mints on a throwaway Checkout/v2 guid; pay stays undici-only.
 * Remaining hard fields: machineId (iovation blackbox), UrlStructureTokenEncoded (JWT).
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

/**
 * GEM SaveForm posts MainForm.serialize() (urlencoded), not JSON.
 * Minimal fields that bind shipping + payment method before issuer.
 */
export function buildCheckoutSaveBody(form, opts = {}) {
  const shipping = form.shipping || {};
  const billing = form.billing || shipping;
  const params = new URLSearchParams();
  const set = (k, v) => {
    if (v == null || v === "") return;
    params.set(k, String(v));
  };
  set("CheckoutData.CartToken", opts.cartToken || "");
  set("CheckoutData.MerchantID", form.merchantId || BANDAI_GE_MID);
  set("CheckoutData.CultureID", form.cultureId || 2057);
  set("CheckoutData.Email", form.email || shipping.Email || "");
  set("CheckoutData.ShippingType", form.shippingType || "ShippingSameAsBilling");
  set("CheckoutData.ShippingCountryID", form.countryId || 14);
  set("CheckoutData.ShippingAddress1", shipping.Address1);
  set("CheckoutData.ShippingAddress2", shipping.Address2 || "");
  set("CheckoutData.ShippingCity", shipping.City);
  set("CheckoutData.ShippingZIP", shipping.Zip);
  set("CheckoutData.ShippingStateID", shipping.StateId);
  set("CheckoutData.ShippingFirstName", shipping.FirstName);
  set("CheckoutData.ShippingLastName", shipping.LastName);
  set("CheckoutData.ShippingPhone", shipping.Phone);
  set("CheckoutData.ShippingAddress.PhoneNational", shipping.Phone?.replace?.(/^\+61/, "") || "");
  set("CheckoutData.BillingCountryID", billing.CountryId || form.countryId || 14);
  set("CheckoutData.BillingAddress1", billing.Address1 || shipping.Address1);
  set("CheckoutData.BillingAddress2", billing.Address2 || "");
  set("CheckoutData.BillingCity", billing.City || shipping.City);
  set("CheckoutData.BillingZIP", billing.Zip || shipping.Zip);
  set("CheckoutData.BillingStateID", billing.StateId || shipping.StateId);
  set("CheckoutData.BillingFirstName", billing.FirstName || shipping.FirstName);
  set("CheckoutData.BillingLastName", billing.LastName || shipping.LastName);
  set("CheckoutData.BillingPhone", billing.Phone || shipping.Phone);
  set(
    "CheckoutData.SelectedShippingOptionID",
    opts.shippingMethodId || form.selectedShippingOptionId || "",
  );
  set(
    "CheckoutData.SelectedPaymentMethodID",
    opts.paymentMethodId || form.selectedPaymentMethodId || "1",
  );
  set(
    "CheckoutData.CurrentPaymentGayewayID",
    opts.gatewayId || form.gatewayId || "2",
  );
  set("CheckoutData.ExternalData.CurrentGatewayId", opts.gatewayId || form.gatewayId || "2");
  // Browser MainForm includes ioBlackBox + tax option; thin save was a fraud gap.
  set("ioBlackBox", opts.machineId || opts.ioBlackBox || "");
  // HTML sometimes scrapes Angular placeholders like "{{:value}}" — never send those.
  const taxRaw = String(opts.selectedTaxOption || form.selectedTaxOption || "").trim();
  if (/^\d+$/.test(taxRaw)) set("CheckoutData.SelectedTaxOption", taxRaw);
  set("CheckoutData.ForterToken", opts.forterToken || "");
  set("CheckoutData.AddressVerified", "true");
  set("CheckoutData.TnCConsent", "true");
  set("CheckoutData.TnCConsent0", "true");
  set("CheckoutData.IsValidationMessagesV2", "true");
  return params.toString();
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

/** Key/Value list from CCPaymentRedirect JWT → flat map. */
export function mapCcPaymentRedirect(redirectUrlOrData) {
  const data =
    typeof redirectUrlOrData === "string"
      ? decodeCcPaymentRedirectData(redirectUrlOrData)
      : redirectUrlOrData;
  const map = {};
  if (Array.isArray(data)) {
    for (const row of data) {
      const k = String(row?.Key || row?.key || "");
      if (k) map[k] = String(row?.Value ?? row?.value ?? "");
    }
  }
  return map;
}

/**
 * Bank/PSP touched the card: non-zero TransactionId or a real auth status.
 * DataCorruption with TransactionId=0 is NOT a bank hit (Revolut silent).
 * AutherizationFailed (GE spelling) IS a bank hit (decline).
 */
export function isBandaiGePaymentRedirectSignal(redirectUrl, redirectSnippet = "") {
  const map = mapCcPaymentRedirect(redirectUrl);
  const txId = String(map.TransactionId || map.MerchantReference || "0");
  const status = String(map.TransactionStatusType || "");
  const errType = String(map.RedirectErrorType || "");
  if (/DataCorruption/i.test(errType) && (!txId || txId === "0")) return false;
  if (txId && txId !== "0") return true;
  if (
    status &&
    !/^Undefined$/i.test(status) &&
    /Auth|Decline|Fail|Success|Pending|3ds|Challenge/i.test(status)
  ) {
    return true;
  }
  const blob = `${JSON.stringify(map)} ${redirectSnippet}`;
  return /\b(ThreeDS|3DS|CReq|ACS|Decline|Declined|OrderId|AuthResult)\b/i.test(blob);
}

/** GE decline / auth-failed popup (card reached PSP). */
export function isBandaiGeRedirectDecline(redirectUrl, redirectSnippet = "") {
  const map = mapCcPaymentRedirect(redirectUrl);
  const status = String(map.TransactionStatusType || "");
  const errBody = `${map.PaymentErrorBody || ""} ${map.ErrorMessage || ""} ${redirectSnippet}`;
  if (/AutherizationFailed|AuthorizationFailed|Declined|Failed/i.test(status)) return true;
  if (/weren.?t charged|couldn.?t be completed|declined|not authorised|not authorized/i.test(errBody)) {
    return String(map.TransactionId || "0") !== "0";
  }
  return false;
}

/** Step/timeline → human timing for drop ops (seconds + ms). */
export function buildBandaiGeTiming(timeline = [], steps = [], totalMs = 0) {
  const at = (event) => {
    const row = timeline.find((e) => e.event === event);
    return row?.elapsedMs != null ? Number(row.elapsedMs) : null;
  };
  const stepMs = (name) => {
    const row = steps.find((s) => s.step === name);
    return row?.ms != null ? Number(row.ms) : null;
  };
  const sec = (ms) => (ms == null ? null : Math.round(ms / 100) / 10);
  const issuerAt = at("ge_issuer_http");
  const hydrateAt = at("ge_http_hydrate_done");
  const cardAt = at("ge_credit_card_form");
  const tokenAt = at("ge_get_cart_token");
  return {
    totalMs,
    totalSec: sec(totalMs),
    getCartTokenAtMs: tokenAt,
    checkoutV2AtMs: at("ge_checkout_v2"),
    hydrateDoneAtMs: hydrateAt,
    creditCardFormAtMs: cardAt,
    issuerAtMs: issuerAt,
    getCartTokenMs: stepMs("ge_get_cart_token"),
    checkoutV2Ms: stepMs("ge_checkout_v2"),
    handleActionMs:
      (stepMs("ge_handleaction_1") || 0) +
      (stepMs("ge_handleaction_2") || 0) +
      (stepMs("ge_handleaction_3") || 0) || null,
    iovationMs: stepMs("ge_iovation_mint"),
    saveMs: stepMs("ge_checkout_save"),
    creditCardFormMs: stepMs("ge_credit_card_form"),
    issuerMs: stepMs("ge_issuer_http"),
    /** Full HTTP GE orchestrator wall (GetCartToken → issuer). */
    gePathMs: totalMs || null,
    gePathSec: null,
    /** Login/ATC are outside this helper — lab reports wallMs separately. */
    toIssuerFromTokenMs:
      tokenAt != null && issuerAt != null
        ? Math.max(0, issuerAt - (tokenAt - (stepMs("ge_get_cart_token") || 0)))
        : null,
  };
}

/**
 * Block browser/iframe HandleCreditCard* so only our intentional undici/page
 * issuer POST can hit the PSP (stops Revolut doubles from live GEM iframe).
 */
async function installBrowserIssuerBlock(page) {
  const context = page?.context?.();
  if (!context?.route) {
    return { blocked: 0, seen: [], unroute: async () => {} };
  }
  let blocked = 0;
  const seen = [];
  const logPath = "/tmp/bandai-ge-browser-wire.json";
  const logBrowser = (row) => {
    seen.push(row);
    try {
      let arr = [];
      try {
        arr = JSON.parse(fs.readFileSync(logPath, "utf8"));
      } catch {
        /* ignore */
      }
      arr.push(row);
      fs.writeFileSync(logPath, JSON.stringify(arr, null, 2));
    } catch {
      /* ignore */
    }
  };
  // Catch ALL GE mutating browser traffic (not only HandleCreditCard*).
  const match = (url) => /global-e\.com/i.test(url.href || String(url));
  const handler = async (route) => {
    const req = route.request();
    const method = String(req.method() || "GET").toUpperCase();
    const url = req.url();
    if (method === "GET" || method === "HEAD" || method === "OPTIONS") {
      await route.continue();
      return;
    }
    const issuer = isBandaiGeIssuerPaymentUrl(url);
    logBrowser({
      t: new Date().toISOString(),
      method,
      url: String(url).slice(0, 320),
      issuer,
      resourceType: req.resourceType?.() || null,
    });
    // Hard-block issuer family from browser/iframe — undici owns the one POST.
    if (issuer) {
      blocked += 1;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          j1m: "browser_issuer_blocked",
          suppressed: true,
          n: blocked,
        }),
      });
      return;
    }
    await route.continue();
  };
  await context.route(match, handler);
  return {
    get blocked() {
      return blocked;
    },
    get seen() {
      return seen;
    },
    unroute: async () => {
      try {
        await context.unroute(match, handler);
      } catch {
        /* ignore */
      }
    },
  };
}

/** Kill live CreditCardForm iframes so GEM JS cannot race our issuer POST. */
async function neutralizeGePaymentFrames(page) {
  if (!page?.evaluate) return 0;
  try {
    return await page.evaluate(() => {
      let n = 0;
      for (const f of Array.from(document.querySelectorAll("iframe"))) {
        const src = String(f.src || f.getAttribute("src") || "");
        if (/CreditCardForm|secure-bandai|HandleCreditCard|global-e\.com\/payments/i.test(src)) {
          try {
            f.src = "about:blank";
            n += 1;
          } catch {
            /* ignore */
          }
        }
      }
      return n;
    });
  } catch {
    return 0;
  }
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
    let forterToken = null;
    for (const c of arr || []) {
      if (!c?.name) continue;
      const host = String(c.domain || "");
      const name = String(c.name);
      // First-party GE/Bandai cookies for undici jar.
      if (/global-e\.com|p-bandai\.com|bandai/i.test(host)) {
        out[name] = c.value;
      }
      // Forter often lands on cdn4.forter.com — keep token for save body / logging.
      if (/^forterToken$/i.test(name) && c.value) forterToken = String(c.value);
    }
    if (forterToken && !out.forterToken) out.forterToken = forterToken;
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
  // Extra settle so Forter / snare finish after ioBlackBox appears (fraud gap).
  const settleMs = Math.min(15_000, Math.max(0, Number(opts.settleMs) || 4_000));
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
    if (settleMs > 0) {
      try {
        await page.waitForTimeout(settleMs);
      } catch {
        /* ignore */
      }
    }
    // Prefer waiting briefly for forterToken if scripts are still running.
    try {
      await page.waitForFunction(
        () => {
          const jar = document.cookie || "";
          if (/forterToken=/i.test(jar)) return true;
          const inputs = document.querySelectorAll(
            'input[name*="forter" i], input[id*="forter" i]',
          );
          for (const el of inputs) {
            if (String(el.value || "").length > 8) return true;
          }
          return false;
        },
        { timeout: Math.min(8_000, settleMs || 4_000) },
      );
    } catch {
      /* forter optional — still proceed with iovation */
    }
    const cookies = await cookiesFromPage(page);
    let forterToken = cookies.forterToken || null;
    if (!forterToken) {
      try {
        forterToken = await page.evaluate(() => {
          const m = String(document.cookie || "").match(/forterToken=([^;]+)/i);
          if (m) return decodeURIComponent(m[1]);
          const el = document.querySelector(
            'input[name="CheckoutData.ForterToken"], input[name*="ForterToken" i]',
          );
          return el ? String(el.value || "") : "";
        });
      } catch {
        forterToken = null;
      }
    }
    if (forterToken) cookies.forterToken = forterToken;
    return {
      ok: Boolean(value),
      machineId: value,
      forterToken: forterToken || null,
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
      forterToken: cookies.forterToken || null,
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
  // Gateway id ≠ payment method id. Card form is usually pm=1 on gateway=2.
  // CreditCardForm URL path uses gatewayId (GEM secureFrameURL+"/"+gateway).
  params.set("PaymentData.gatewayId", String(opts.gatewayId || "2"));
  params.set("PaymentData.paymentMethodId", String(opts.paymentMethodId || "1"));
  params.set("PaymentData.machineId", String(opts.machineId || ""));
  // Form default is "true". Opt false to probe GE soft-decline dual-rail.
  const createTxn =
    opts.createTransaction === false || opts.createTransaction === "false"
      ? "false"
      : "true";
  params.set("PaymentData.createTransaction", createTxn);
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
    const declineOnRedirect = isBandaiGeRedirectDecline(redirectUrl || "", "");
    const ok = Boolean(isPaymentRedirect && (bankSignal || declineOnRedirect));
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
      reloadOnly: Boolean(isPaymentRedirect && !bankSignal && !declineOnRedirect),
      bankSignal: Boolean(bankSignal || declineOnRedirect),
      declineOnRedirect,
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
function writeIssuerLast(row) {
  try {
    fs.writeFileSync("/tmp/bandai-ge-issuer-last.json", JSON.stringify(row, null, 2));
  } catch {
    /* ignore */
  }
}

function networkErrorMeta(e) {
  const cause = e?.cause && typeof e.cause === "object" ? e.cause : null;
  const code =
    e?.causeCode ||
    cause?.code ||
    e?.code ||
    (e?.name === "TimeoutError" || e?.code === "ABORT_ERR" ? "TIMEOUT" : null);
  const message = String(e?.causeMessage || cause?.message || e?.message || "issuer_http_failed");
  const timedOut = Boolean(
    e?.timedOut ||
      code === "TIMEOUT" ||
      code === "ABORT_ERR" ||
      code === "UND_ERR_HEADERS_TIMEOUT" ||
      code === "UND_ERR_BODY_TIMEOUT" ||
      /timeout|aborted/i.test(message),
  );
  return { code, message, timedOut };
}

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

  // GE often holds the TCP stream while the bank auth completes (60–120s+).
  // Default was effectively ~60s proxy/idle flake → "fetch failed" after Revolut
  // already moved. Wait longer and always persist attempt + response/error.
  const timeoutMs = Math.max(
    60_000,
    Math.min(300_000, Number(opts.timeoutMs) || 180_000),
  );

  const t0 = Date.now();
  let undiciAttempts = 0;
  writeIssuerLast({
    at: new Date().toISOString(),
    phase: "posting",
    issuerUrl: url.slice(0, 320),
    bodyBytes: body.length,
    timeoutMs,
    undiciAttempts: 0,
  });

  try {
    // CRITICAL: retry:false — undici used to retry POST on proxy RST after GE
    // already authorized → paired Revolut lines with app-level posts=1.
    const res = await request(
      url,
      {
        method: "POST",
        headers,
        body,
        retry: false,
        timeoutMs,
        headersTimeout: timeoutMs,
        bodyTimeout: timeoutMs,
      },
      opts.ctx || {},
    );
    undiciAttempts = Number(res.undiciAttempts || 1);
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

    // Do NOT follow CCPaymentRedirect by default — landing the JWT page is
    // not required for bank scoring and must never risk a second PSP touch.
    let redirectSnippet = null;
    if (isPaymentRedirect && redirectUrl && opts.followRedirect === true) {
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
            retry: false,
            timeoutMs: Math.min(60_000, timeoutMs),
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
    const declineOnRedirect = isBandaiGeRedirectDecline(
      redirectUrlFull || "",
      redirectSnippet || "",
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

    const out = {
      ok,
      status: res.status,
      ms,
      bodySnippet: String(text || "").replace(/\s+/g, " ").slice(0, 240),
      bodyText: String(text || "").slice(0, 8000),
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
      undiciAttempts,
      via: "http-ge-issuer",
      responseLost: false,
      error: ok
        ? null
        : isPaymentRedirect
          ? "ge_reload_only_no_bank"
          : "issuer_http_failed",
    };
    writeIssuerLast({
      at: new Date().toISOString(),
      phase: "response",
      issuerUrl: url.slice(0, 320),
      status: out.status,
      ok: out.ok,
      ms: out.ms,
      undiciAttempts: out.undiciAttempts,
      isPaymentRedirect: out.isPaymentRedirect,
      bankSignal: out.bankSignal,
      declineOnRedirect: out.declineOnRedirect,
      reloadOnly: out.reloadOnly,
      redirectUrl: out.redirectUrl,
      redirectPayload: out.redirectPayload,
      bodySnippet: out.bodySnippet,
      error: out.error,
      via: out.via,
    });
    return out;
  } catch (e) {
    const ms = Date.now() - t0;
    undiciAttempts = Number(e?.undiciAttempts || undiciAttempts || 1);
    const net = networkErrorMeta(e);
    // POST almost certainly left the client (GE/bank may still settle).
    // Do not score this as a clean miss — capture cause and check Revolut.
    const responseLost = undiciAttempts >= 1;
    const out = {
      ok: false,
      error: responseLost ? "issuer_response_lost" : net.message || "issuer_http_failed",
      errorCode: net.code,
      errorMessage: net.message,
      timedOut: net.timedOut,
      responseLost,
      ms,
      undiciAttempts,
      via: "http-ge-issuer",
      bodySnippet: null,
      status: null,
    };
    writeIssuerLast({
      at: new Date().toISOString(),
      phase: "error",
      issuerUrl: url.slice(0, 320),
      ok: false,
      ms: out.ms,
      undiciAttempts: out.undiciAttempts,
      error: out.error,
      errorCode: out.errorCode,
      errorMessage: out.errorMessage,
      timedOut: out.timedOut,
      responseLost: out.responseLost,
      via: out.via,
      note: "Issuer POST sent or in-flight; HTTP response not captured — score bank",
    });
    return out;
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
  // Caller-supplied blackbox wins (no-page labs / BANDAI_GE_MACHINE_ID). HTML
  // scrape is fallback only — a false-positive extract previously skipped mint
  // and still paired Revolut (07:43).
  const htmlMachineId = extractMachineId(v2.text);
  let machineId = opts.machineId || htmlMachineId || null;
  push("ge_checkout_v2", {
    ok: v2.ok,
    status: v2.status,
    ms: v2.ms,
    note: `Checkout/v2 ${v2.status}; jwt=${Boolean(urlStructureToken)} machineId=${Boolean(machineId)} midSrc=${opts.machineId ? "opts" : htmlMachineId ? "html" : "none"} bytes=${(v2.text || "").length}`,
  });

  const form = parseCheckoutV2Form(v2.text);
  let shippingMethodId = form.selectedShippingOptionId || "";
  let hydrateShippingOk = false;

  // Iovation FIRST (before handleaction), then undici-only hydrate→pay.
  //
  // Fraud labs (2026-07-23): stale noPage machineId + thin jar →
  // PossibleFraudDetected=True / Refused. Fast default is riskHydrate:
  // liveHtml+geMute mint + cookie merge, then drop page (undici still pays).
  // Explicit noPage (BANDAI_GE_NO_PAGE=1) keeps pure undici + reused blackbox.
  const riskHydrate =
    opts.riskHydrate === true ||
    opts.forceFreshMint === true ||
    (opts.mergeIovationCookies === true && Boolean(opts.page));
  if (machineId && !opts.page) {
    push("ge_iovation_mint", {
      ok: true,
      status: null,
      ms: 0,
      note: `reused machineId bytes=${String(machineId).length} via=noPage (no Playwright on GE)`,
    });
  }
  let issuerPage = null;
  let forterToken = opts.forterToken || null;
  const browserReqLog = [];
  const logPageRequests = (page) => {
    try {
      const pctx = page?.context?.();
      if (!pctx?.on) return;
      const onReq = (req) => {
        const method = String(req.method() || "GET").toUpperCase();
        const url = String(req.url() || "");
        if (method === "GET" || method === "HEAD" || method === "OPTIONS") return;
        if (!/global-e\.com/i.test(url)) return;
        const row = {
          t: new Date().toISOString(),
          method,
          url: url.slice(0, 320),
          issuer: isBandaiGeIssuerPaymentUrl(url),
          phase: "iovation-mint",
        };
        browserReqLog.push(row);
        try {
          let arr = [];
          try {
            arr = JSON.parse(fs.readFileSync("/tmp/bandai-ge-browser-wire.json", "utf8"));
          } catch {
            /* ignore */
          }
          arr.push(row);
          fs.writeFileSync("/tmp/bandai-ge-browser-wire.json", JSON.stringify(arr, null, 2));
        } catch {
          /* ignore */
        }
      };
      pctx.on("request", onReq);
    } catch {
      /* ignore */
    }
  };

  const shouldMint = Boolean(opts.page) && (!machineId || riskHydrate);
  if (shouldMint) {
    logPageRequests(opts.page);
    // Risk hydrate: load Checkout/v2 for snare/Forter with GE POSTs muted,
    // merge cookies into undici jar, then drop page before hydrate/issuer.
    const pctx = opts.page.context?.();
    const geMuteMatch = (url) => /global-e\.com/i.test(url.href || String(url));
    const geMuteRoute = async (route) => {
      const req = route.request();
      const method = String(req.method() || "GET").toUpperCase();
      if (method === "GET" || method === "HEAD" || method === "OPTIONS") {
        await route.continue();
        return;
      }
      await route.fulfill({
        status: 204,
        contentType: "text/plain",
        body: "",
      });
    };
    if (pctx?.route) {
      await pctx.route(geMuteMatch, geMuteRoute);
    }
    let mint;
    try {
      mint = await mintIovationBlackbox({
        page: opts.page,
        checkoutV2Url: v2Url,
        timeoutMs: opts.iovationTimeoutMs,
        settleMs: opts.iovationSettleMs,
        jar: ctx?.jar || null,
      });
    } finally {
      if (pctx?.unroute) {
        try {
          await pctx.unroute(geMuteMatch, geMuteRoute);
        } catch {
          /* ignore */
        }
      }
    }
    const blockedMutates = browserReqLog.length;
    const jarNames = mint.cookies ? Object.keys(mint.cookies) : [];
    push("ge_iovation_mint", {
      ok: mint.ok,
      status: null,
      ms: mint.ms,
      note: mint.ok
        ? `ioBlackBox bytes=${String(mint.machineId || "").length} via=liveHtml+geMute(riskHydrate) forter=${Boolean(mint.forterToken || mint.cookies?.forterToken)} cookieKeys=${jarNames.length} browserMutatesSeen=${blockedMutates}`
        : `iovation fail ${mint.error || ""}`.slice(0, 160),
    });
    if (mint.machineId) {
      machineId = mint.machineId;
      try {
        fs.writeFileSync("/tmp/bandai-ge-machineId.txt", String(mint.machineId));
      } catch {
        /* ignore */
      }
    }
    if (mint.forterToken) forterToken = mint.forterToken;
    else if (mint.cookies?.forterToken) forterToken = mint.cookies.forterToken;
    // Always merge mint cookies into undici jar on risk hydrate (GE + forterToken).
    if (mint.cookies && ctx?.jar?.load) {
      try {
        const merged = { ...ctx.jar.dump(), ...mint.cookies };
        // forterToken from cdn host: still attach so save/issuer jar has it.
        if (forterToken) merged.forterToken = forterToken;
        ctx.jar.load(merged);
      } catch {
        /* ignore */
      }
    }
    mark("ge_risk_cookies", {
      forterToken: Boolean(forterToken),
      forterBytes: forterToken ? String(forterToken).length : 0,
      cookieKeys: jarNames.slice(0, 40),
    });
    const keepPage =
      opts.keepPageAfterIovation === true ||
      opts.preferPageIssuer === true ||
      opts.scrapeCardFormViaPage === true;
    try {
      await opts.page.goto("about:blank", { waitUntil: "commit", timeout: 5_000 });
    } catch {
      /* ignore */
    }
    if (keepPage) {
      issuerPage = opts.page;
      mark("ge_page_kept_after_iovation", {
        ok: true,
        warn: "live_cart_browser_may_pair_revolut",
      });
    } else {
      mark("ge_page_dropped_after_iovation", {
        ok: true,
        liveGuid: guid,
        geMuted: true,
        beforeHydrate: true,
        riskHydrate: true,
        browserMutatesDuringMint: blockedMutates,
        issuerPostsDuringMint: browserReqLog.filter((r) => r.issuer).length,
      });
      issuerPage = null;
    }
  }

  // Hydrate shipping / tax / totals over undici only (no Playwright on cart).
  // Empty `{}` → 500 HandleAction_WithMerchantIdAndCartTokenInUrl (labs).
  for (const actionId of [1, 2, 3]) {
    const bodies = buildHandleActionBodies(form, {
      cartToken: guid,
      shippingMethodId,
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

  // Block browser/iframe issuer if page was explicitly kept (labs only).
  let browserIssuerBlock = { blocked: 0, unroute: async () => {} };
  if (issuerPage) {
    browserIssuerBlock = await installBrowserIssuerBlock(issuerPage);
    mark("ge_browser_issuer_block_on", { ok: true });
  }

  // Keep Playwright on Checkout/v2 after iovation. Top-level goto(CreditCardForm)
  // replaces the GE parent session → IsTheSameCartToken=False / DataCorruption.
  // Browser keeps Checkout/v2 with a secure-bandai iframe for the card form.
  //
  // CRITICAL: CreditCardForm URL path is GATEWAY id (secureFrameURL+"/"+currentGatewayID),
  // NOT paymentMethodId. Card UI is usually pm=1 with gateway=2.
  let paymentMethodId = String(
    opts.paymentMethodId || form.selectedPaymentMethodId || "1",
  );
  let gatewayId = String(opts.gatewayId || form.gatewayId || "2");

  // GEM SaveForm before Pay (urlencoded MainForm + X-merchantId).
  const saveBody = buildCheckoutSaveBody(form, {
    cartToken: guid,
    shippingMethodId,
    paymentMethodId,
    gatewayId,
    machineId,
    forterToken,
    selectedTaxOption: /^\d+$/.test(String(form.selectedTaxOption || ""))
      ? form.selectedTaxOption
      : "",
  });
  const saveRes = await httpText(
    `${BANDAI_GE_WEBSERVICES}/checkoutv2/save/${encodedMerchant}/${guid}`,
    {
      ctx,
      method: "POST",
      userAgent: opts.userAgent,
      accept: "application/json, text/plain, */*",
      headers: {
        origin: BANDAI_GE_WEBSERVICES,
        referer: v2Url,
        "content-type": "application/x-www-form-urlencoded; charset=UTF-8",
        "x-requested-with": "XMLHttpRequest",
        "X-merchantId": String(mid),
      },
      body: saveBody,
    },
  ).catch((e) => ({ ok: false, status: 0, ms: 0, text: "", error: e?.message }));
  let saveOk = false;
  try {
    const sj = JSON.parse(String(saveRes?.text || ""));
    saveOk = Boolean(saveRes?.ok && (sj?.Success === true || sj?.success === true));
  } catch {
    saveOk = Boolean(saveRes?.ok);
  }
  push("ge_checkout_save", {
    ok: saveOk,
    status: saveRes?.status,
    ms: saveRes?.ms,
    note: (
      saveOk
        ? `save ok gw=${gatewayId} pm=${paymentMethodId} ship=${shippingMethodId || "none"}`
        : `save fail ${String(saveRes?.text || saveRes?.error || "").replace(/\s+/g, " ")}`
    ).slice(0, 200),
  });

  // Path segment = gatewayId (GEM ShowCCForm / secureFrameURL+"/"+currentGatewayID).
  let ccUrl = `${BANDAI_GE_SECURE}/payments/CreditCardForm/${guid}/${gatewayId}`;
  let cc = { ok: false, status: 0, ms: 0, text: "" };

  // Default: undici CreditCardForm only. Live iframe + radio click can race GEM
  // pay JS (and costs ~10s). Opt-in scrapeCardFormViaPage=true for iframe scrape.
  // Do not pull Playwright cookies into undici here (keeps cart-token session pure).
  if (issuerPage) {
    await neutralizeGePaymentFrames(issuerPage).catch(() => 0);
  }

  const tCc = Date.now();
  const httpCc = await httpText(ccUrl, {
    ctx,
    userAgent: opts.userAgent,
    accept: "text/html,application/xhtml+xml,*/*",
    headers: { referer: v2Url },
  });
  cc = {
    ...httpCc,
    ms: Date.now() - tCc,
    domJwt: extractUrlStructureToken(httpCc.text),
    domMachineId: extractMachineId(httpCc.text),
    viaHttp: true,
  };

  if (
    (!cc.ok || !cc.domJwt) &&
    issuerPage &&
    opts.scrapeCardFormViaPage === true
  ) {
    const tFrame = Date.now();
    try {
      await syncJarToPage(issuerPage, ctx?.jar);
      await issuerPage
        .evaluate((pm) => {
          const radio = document.querySelector(
            `input[name="CheckoutData.SelectedPaymentMethodID"][value="${pm}"]`,
          );
          if (radio) {
            radio.checked = true;
            radio.click();
          }
        }, paymentMethodId)
        .catch(() => null);
      await issuerPage.waitForTimeout(2500);
      const frame =
        issuerPage.frames().find((f) =>
          /CreditCardForm|secure-bandai\.global-e\.com\/payments/i.test(f.url()),
        ) || null;
      if (frame) {
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
        if (fromDom.jwt) {
          cc = {
            ok: true,
            status: 200,
            ms: Date.now() - tFrame,
            text: fromDom.html || "",
            domJwt: fromDom.jwt,
            domMachineId: fromDom.mid,
            domPm: fromDom.pm,
            domGw: fromDom.gw,
            frameUrl: fromDom.url,
            viaHttp: false,
          };
          if (fromDom.url) ccUrl = fromDom.url.split("?")[0];
        }
      }
    } catch (e) {
      push("ge_credit_card_form_frame", {
        ok: false,
        status: 0,
        ms: Date.now() - tFrame,
        note: String(e?.message || "cc_form_frame_failed").slice(0, 160),
      });
    }
  }

  paymentMethodId = String(
    opts.paymentMethodId || cc.domPm || form.selectedPaymentMethodId || paymentMethodId || "1",
  );
  gatewayId = String(opts.gatewayId || cc.domGw || form.gatewayId || gatewayId || "2");
  urlStructureToken =
    cc.domJwt || extractUrlStructureToken(cc.text) || urlStructureToken;
  const formMachineId = cc.domMachineId || extractMachineId(cc.text);
  if (formMachineId) machineId = formMachineId;

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
    note: `CreditCardForm ${cc.status}; jwt=${Boolean(urlStructureToken)} machineId=${Boolean(machineId)} midSrc=${formMachineId ? "form" : machineId ? "iovation" : "none"} via=${cc.frameUrl ? "iframe" : cc.viaHttp ? "http" : issuerPage ? "page" : "http"} pm=${paymentMethodId} gw=${gatewayId} domPm=${cc.domPm || "-"} bytes=${(cc.text || "").length}`,
  });
  try {
    const html = String(cc.text || "");
    if (html.length > 200) {
      fs.writeFileSync("/tmp/bandai-cc-form.html", html);
      const action = (html.match(/<form[^>]*action=["']([^"']+)["']/i) || [])[1] || "";
      const modeAttr = (html.match(/<form[^>]*\smode=["']([^"']+)["']/i) || [])[1] || "";
      const names = [...html.matchAll(/name=["']([^"']+)["']/gi)].map((m) => m[1]);
      fs.writeFileSync(
        "/tmp/bandai-cc-form-meta.json",
        JSON.stringify(
          {
            at: new Date().toISOString(),
            ccUrl,
            action,
            modeAttr,
            gatewayId,
            paymentMethodId,
            fieldNames: [...new Set(names)].slice(0, 80),
            hasPreEnroll: /preEnroll/i.test(html),
            hasDdc: /ddc|DeviceData|collection/i.test(html),
            formSnippet: html.replace(/\s+/g, " ").slice(0, 1200),
          },
          null,
          2,
        ),
      );
    }
  } catch {
    /* ignore */
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
    const elapsedMs = Date.now() - t0;
    const timing = buildBandaiGeTiming(timeline, steps, elapsedMs);
    timing.gePathSec = timing.gePathMs != null ? Math.round(timing.gePathMs / 100) / 10 : null;
    await browserIssuerBlock.unroute();
    return {
      ok: false,
      steps,
      timeline,
      timing,
      failedStep: blockers[0] || "ge_http_stop",
      error: blockers.length ? `http_ge_blockers:${blockers.join(",")}` : "stop_before_issuer",
      paymentStatus: "http_ge_hydrated",
      checkoutStage: "tokenize",
      checkoutSn: opts.checkoutSn || null,
      cartToken: guid,
      blockers,
      urlStructureToken: Boolean(urlStructureToken),
      machineId: Boolean(machineId),
      browserIssuerBlocked: Number(browserIssuerBlock.blocked || 0),
      via: "http-ge",
      elapsedMs,
      note: `HTTP GE hydrated guid=${guid}; blockers=${blockers.join(",") || "none"} total=${timing.totalSec}s`,
    };
  }

  // checkoutv2/save already ran before CreditCardForm (GEM SaveForm order).

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
    createTransaction: opts.createTransaction,
  });

  // Hard-lock single issuer POST.
  // Root cause of Revolut pairs (2026-07-22): undici retried POST after proxy
  // RST once GE had already authorized — app saw posts=1, bank saw 2.
  // Also: no live CreditCardForm iframe by default; close Playwright before pay.
  let framesNeutralized = 0;
  let issuerPostCount = 0;
  let issuer = null;
  try {
    if (issuerPage) {
      framesNeutralized = await neutralizeGePaymentFrames(issuerPage);
      mark("ge_issuer_lock", {
        framesNeutralized,
        browserBlockedSoFar: Number(browserIssuerBlock.blocked || 0),
        preferPageIssuer: opts.preferPageIssuer === true,
        mergeIovationCookies: opts.mergeIovationCookies === true,
      });
      // Park Checkout/v2 away from payment UI before undici issuer (no GEM race).
      if (opts.preferPageIssuer !== true) {
        await issuerPage.goto("about:blank", { waitUntil: "commit", timeout: 5_000 }).catch(() => null);
        mark("ge_browser_parked_before_issuer", { ok: true });
      }
    }

    const usePageIssuer = Boolean(issuerPage && opts.preferPageIssuer === true);
    issuerPostCount = 1;
    if (usePageIssuer) {
      await browserIssuerBlock.unroute();
      issuer = await postBandaiGeIssuerViaPage({
        page: issuerPage,
        url: issuerUrl,
        body,
        referer: ccUrl,
      });
    } else {
      issuer = await postBandaiGeIssuerHttp({
        url: issuerUrl,
        body,
        ctx,
        userAgent: opts.userAgent,
        referer: ccUrl,
        followRedirect: false,
        // Hold for GE/bank settle — short waits were scoring "fetch failed"
        // after Revolut already moved (2026-07-23 ~12:45 AEST).
        timeoutMs: Number(opts.issuerTimeoutMs) || 180_000,
      });
    }
  } finally {
    await browserIssuerBlock.unroute();
  }

  const browserBlocked = Number(browserIssuerBlock.blocked || 0);
  const undiciAttempts = Number(issuer?.undiciAttempts || 1);
  // Wire truth: undiciAttempts is how many times the HTTP stack sent the POST.
  const chargeReqCount = Math.max(issuerPostCount, undiciAttempts);
  const responseLost = Boolean(issuer?.responseLost);

  try {
    const prev = fs.existsSync("/tmp/bandai-ge-issuer-last.json")
      ? JSON.parse(fs.readFileSync("/tmp/bandai-ge-issuer-last.json", "utf8"))
      : {};
    fs.writeFileSync(
      "/tmp/bandai-ge-issuer-last.json",
      JSON.stringify(
        {
          ...prev,
          at: new Date().toISOString(),
          phase: prev.phase === "error" || responseLost ? "error" : "response",
          issuerUrl,
          status: issuer?.status,
          ok: issuer?.ok,
          reloadOnly: issuer?.reloadOnly,
          bankSignal: issuer?.bankSignal,
          redirectUrl: issuer?.redirectUrlFull || issuer?.redirectUrl,
          redirectPayload: issuer?.redirectPayload,
          redirectSnippet: issuer?.redirectSnippet,
          bodySnippet: issuer?.bodySnippet,
          bodyText: issuer?.bodyText || prev.bodyText || null,
          error: issuer?.error,
          errorCode: issuer?.errorCode || prev.errorCode || null,
          errorMessage: issuer?.errorMessage || prev.errorMessage || null,
          timedOut: issuer?.timedOut ?? prev.timedOut ?? null,
          responseLost,
          via: issuer?.via,
          gatewayId,
          paymentMethodId,
          shippingMethodId,
          hydrateShippingOk,
          issuerPostCount,
          undiciAttempts,
          browserIssuerBlocked: browserBlocked,
          framesNeutralized,
          isSameCartToken: (() => {
            const m = mapCcPaymentRedirect(issuer?.redirectPayload || issuer?.redirectUrlFull || "");
            return m.IsTheSameCartToken ?? null;
          })(),
        },
        null,
        2,
      ),
    );
  } catch {
    /* ignore */
  }

  const declineOnRedirect = Boolean(issuer?.declineOnRedirect);
  // Non-zero TransactionId always counts as bank (even if GE also sets IsTheSameCartToken=False).
  const txMap = mapCcPaymentRedirect(issuer?.redirectPayload || issuer?.redirectUrlFull || "");
  const isSameCartToken = /^(true|1)$/i.test(String(txMap.IsTheSameCartToken || ""));
  const transactionId =
    txMap.TransactionId && txMap.TransactionId !== "0"
      ? txMap.TransactionId
      : txMap.MerchantReference && txMap.MerchantReference !== "0"
        ? txMap.MerchantReference
        : null;
  const bankHit = Boolean(
    issuer?.sawAuthWire ||
      declineOnRedirect ||
      issuer?.bankSignal ||
      transactionId,
  );
  push("ge_issuer_http", {
    ok: Boolean(
      issuer?.ok ||
        (bankHit && declineOnRedirect) ||
        (bankHit && transactionId) ||
        responseLost,
    ),
    status: issuer?.status,
    ms: issuer?.ms,
    note: (
      responseLost
        ? `RESPONSE_LOST posts=${chargeReqCount} undiciAttempts=${undiciAttempts} code=${issuer?.errorCode || "?"} timedOut=${Boolean(issuer?.timedOut)} ${issuer?.errorMessage || ""} — check bank`
        : issuer?.reloadOnly && !bankHit
          ? `RELOAD_ONLY ${issuer.status} err=${
              Array.isArray(issuer.redirectPayload)
                ? issuer.redirectPayload
                    .filter((x) =>
                      /RedirectErrorType|ErrorMessage|Success|IsTheSameCartToken|TransactionId|TransactionStatusType/i.test(
                        String(x?.Key || ""),
                      ),
                    )
                    .map((x) => `${x.Key}=${x.Value}`)
                    .join(";")
                : ""
            }`
          : issuer?.redirectUrl || bankHit
            ? `redirect ${issuer?.status} via=${issuer?.via || "http"} bank=${bankHit} tx=${transactionId || "-"} sameCart=${txMap.IsTheSameCartToken || "?"} posts=${chargeReqCount} undiciAttempts=${undiciAttempts} blockedBrowser=${browserBlocked} framesOff=${framesNeutralized} ${issuer?.redirectUrl || ""}${declineOnRedirect ? " DECLINE?" : ""} ${issuer?.redirectSnippet || ""}`
            : issuer?.bodySnippet || issuer?.error || "issuer_null"
    ).slice(0, 280),
  });

  const fraudDetected = /^(true|1)$/i.test(String(txMap.PossibleFraudDetected || ""));
  const statusType = String(txMap.TransactionStatusType || "");
  const paymentStatus = fraudDetected
    ? "ge_fraud_refused"
    : declineOnRedirect || (bankHit && /Auth|Decline|Fail|Refuse/i.test(statusType))
      ? "declined_or_auth_failed"
      : bankHit && issuer?.ok
        ? "pay_submitted_http"
        : bankHit && transactionId
          ? "declined_or_auth_failed"
          : responseLost
            ? "pay_submitted_no_response"
            : !issuer?.ok
              ? issuer?.reloadOnly
                ? "ge_reload_only_no_bank"
                : "issuer_http_failed"
              : "pay_submitted_http";
  const orderOk = Boolean(
    issuer?.ok &&
      !declineOnRedirect &&
      !fraudDetected &&
      paymentStatus === "pay_submitted_http",
  );
  const elapsedMs = Date.now() - t0;
  const timing = buildBandaiGeTiming(timeline, steps, elapsedMs);
  timing.gePathSec = timing.gePathMs != null ? Math.round(timing.gePathMs / 100) / 10 : null;
  mark("ge_timing", timing);
  mark("ge_issuer_risk", {
    possibleFraudDetected: fraudDetected,
    transactionStatusType: statusType || null,
    forterToken: Boolean(forterToken),
    finalizeProcess: txMap.finalizeProcess || null,
  });

  return {
    ok: orderOk,
    steps,
    timeline,
    timing,
    failedStep:
      orderOk ||
      paymentStatus === "declined_or_auth_failed" ||
      paymentStatus === "ge_fraud_refused" ||
      paymentStatus === "pay_submitted_no_response"
        ? null
        : "ge_issuer_http",
    error:
      orderOk ||
      paymentStatus === "declined_or_auth_failed" ||
      paymentStatus === "ge_fraud_refused" ||
      paymentStatus === "pay_submitted_no_response"
        ? null
        : issuer?.error || issuer?.bodySnippet,
    paymentStatus,
    possibleFraudDetected: fraudDetected,
    forterTokenPresent: Boolean(forterToken),
    checkoutStage:
      paymentStatus === "declined_or_auth_failed" || paymentStatus === "ge_fraud_refused"
        ? "declined"
        : "tokenize",
    checkoutSn: opts.checkoutSn || null,
    cartToken: guid,
    chargeReqCount,
    undiciAttempts,
    responseLost,
    browserIssuerBlocked: browserBlocked,
    framesNeutralized,
    isSameCartToken,
    sawAuthWire: Boolean(bankHit),
    blockers,
    redirectUrl: issuer?.redirectUrl || null,
    redirectPayload: issuer?.redirectPayload || null,
    transactionId,
    via: issuer?.via === "page-ge-issuer" ? "http-ge+page-issuer" : "http-ge",
    elapsedMs,
    note: paymentStatus === "ge_fraud_refused"
      ? `HTTP issuer FRAUD_REFUSED tx=${transactionId || "?"} status=${statusType || "?"} forter=${Boolean(forterToken)} sameCart=${txMap.IsTheSameCartToken || "?"} posts=${chargeReqCount} undiciAttempts=${undiciAttempts} guid=${guid} total=${timing.totalSec}s`
      : paymentStatus === "declined_or_auth_failed"
        ? `HTTP issuer AUTH_FAILED/DECLINE tx=${transactionId || "?"} sameCart=${txMap.IsTheSameCartToken || "?"} via=${issuer?.via} posts=${chargeReqCount} undiciAttempts=${undiciAttempts} guid=${guid} total=${timing.totalSec}s`
        : paymentStatus === "pay_submitted_no_response"
          ? `HTTP issuer POST in-flight/sent but response lost code=${issuer?.errorCode || "?"} timedOut=${Boolean(issuer?.timedOut)} posts=${chargeReqCount} undiciAttempts=${undiciAttempts} guid=${guid} total=${timing.totalSec}s — check bank`
          : issuer?.ok
            ? `HTTP issuer ${issuer.status}${issuer.isPaymentRedirect ? "→CCPaymentRedirect" : ""} bank=${bankHit} fraud=${fraudDetected} forter=${Boolean(forterToken)} sameCart=${txMap.IsTheSameCartToken || "?"} via=${issuer.via} posts=${chargeReqCount} undiciAttempts=${undiciAttempts} guid=${guid} total=${timing.totalSec}s`
            : issuer?.reloadOnly
              ? `HTTP issuer ReloadBehaviour only (no Revolut) sameCart=${txMap.IsTheSameCartToken || "?"} via=${issuer.via} guid=${guid} total=${timing.totalSec}s`
              : `HTTP issuer failed; ${issuer?.bodySnippet || issuer?.error || "null"} total=${timing.totalSec}s`,
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
  buildCheckoutSaveBody,
  pickShippingMethodId,
  decodeCcPaymentRedirectData,
  isBandaiGePaymentRedirectSignal,
  isBandaiGeRedirectDecline,
  mapCcPaymentRedirect,
  mintIovationBlackbox,
  loadIssuerCapture,
  postBandaiGeIssuerHttp,
  postBandaiGeIssuerViaPage,
  replayCapturedIssuerHttp,
  runBandaiGeHttpPay,
  buildBandaiGeTiming,
  BANDAI_GE_MID,
  BANDAI_GE_ENCODED_MERCHANT,
};
