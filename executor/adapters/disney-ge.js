/**
 * Disney Store AU — Global-e handoff (merchant **1696**, encoded **8u87**).
 *
 * Research only from Bandai / PKC modules (do not edit those files):
 *   Bandai: mid 1925 · encoded 8urc · secure-bandai.global-e.com
 *   PKC:    mid 1634 · encoded 8u22 · secure.ges.global-e.com
 *   Disney: mid 1696 · encoded 8u87 · secure.ges.global-e.com (Checkout/v2 HTML 2026-07-26)
 *
 * Wire (TLS ATC → filled bag):
 *   POST SFCC Globale-GetCartToken → { cartToken: <GUID>, success:true }
 *   SFCC cartToken IS the Checkout/v2 GUID (no GEM GetCartToken hop required).
 *   GET webservices.global-e.com/Checkout/v2/{guid} → Checkout HTML
 *   Issuer form: secure.ges.global-e.com/payments/handlecreditcardrequestV2
 *   Card iframe: secure.ges.global-e.com/payments/CreditCardForm/{guid}
 *
 * Reuses pure helpers from bandai-ge-http.js only. Never calls runBandaiGeHttpPay /
 * runPcGeHttpPay. Stops before issuer POST unless explicitly extended later.
 */

import { request, makeDispatcher } from "../http.js";
import {
  buildGetCartTokenUrl,
  extractGeCheckoutGuid,
  extractUrlStructureToken,
  parseCheckoutV2Form,
  parseJsonp,
} from "./bandai-ge-http.js";
import { DISNEY_GE_MID, DISNEY_GE_CLIENT_SDK, looksLikeAkamaiDenied } from "./disney-session.js";

export const DISNEY_GLOBALE_MID = DISNEY_GE_MID;
export const DISNEY_GE_SCRIPT = DISNEY_GE_CLIENT_SDK;
export const DISNEY_GE_GEPI = "https://gepi.global-e.com";
export const DISNEY_GE_WEBSERVICES = "https://webservices.global-e.com";
/** Hashed mid from clientsdk — not the issuer path code. */
export const DISNEY_GE_MERCHANT_HASHED = "mZ25";
/** Encoded merchant from Checkout/v2 `encodedMerchantId` (Bandai 8urc / PC 8u22 analogue). */
export const DISNEY_GE_ENCODED_MERCHANT = "8u87";
/** Same secure host family as PKC (not Bandai secure-bandai). */
export const DISNEY_GE_SECURE = "https://secure.ges.global-e.com";
export const DISNEY_GE_CREDIT_CARD_FORM = `${DISNEY_GE_SECURE}/payments/CreditCardForm`;
export const DISNEY_GE_ISSUER_ACTION = `${DISNEY_GE_SECURE}/payments/handlecreditcardrequestV2`;

const DEFAULT_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

function safeJson(text) {
  try {
    return JSON.parse(String(text || ""));
  } catch {
    return null;
  }
}

function extractEncodedMerchantId(html) {
  const m = String(html || "").match(/encodedMerchantId\s*:\s*["']([a-z0-9]+)["']/i);
  return m?.[1] || null;
}

function extractSecureFrameUrl(html) {
  const m = String(html || "").match(/secureFrameURL\s*:\s*["']([^"']+)["']/i);
  return m?.[1] || null;
}

/**
 * Fetch SFCC Globale-ScriptLoaderData (confirms mid / client SDK).
 */
export async function fetchDisneyGeScriptLoader(session, opts = {}) {
  const tStep = opts.tStep || (async (_n, fn) => fn());
  return tStep("ge_script_loader", async () => {
    const res = await session.get(session.urls.geScriptLoader, {
      xhr: true,
      referer: opts.referer || `${session.state.origin}/`,
    });
    if (looksLikeAkamaiDenied(res.text, res.status)) {
      return { ok: false, status: res.status, note: "GE script loader Akamai denied", denied: true };
    }
    const mid = String(res.json?.clientJsMerchantId || DISNEY_GLOBALE_MID);
    return {
      ok: res.ok && Boolean(res.json?.clientJsUrl),
      status: res.status,
      note: `GE loader mid=${mid} sdk=${res.json?.clientJsUrl || "?"}`,
      merchantId: mid,
      clientJsUrl: res.json?.clientJsUrl || null,
      apiVersion: res.json?.apiVersion || null,
      culture: res.json?.culture || null,
      currency: res.json?.currency || null,
      raw: res.json,
    };
  });
}

/**
 * POST SFCC Globale-GetCartToken → Checkout GUID.
 * GET returns SFCC 500 even with bag lines (wire 2026-07-26).
 */
export async function fetchDisneySfccCartToken(session, opts = {}) {
  const tStep = opts.tStep || (async (_n, fn) => fn());
  return tStep("ge_sfcc_cart_token", async () => {
    const url = session.urls.geCartToken;
    const preferPost = opts.method !== "GET";
    let res;
    if (preferPost) {
      res = await session.post(url, opts.body ?? "", {
        referer: opts.referer || `${session.state.origin}/bag`,
        contentType: opts.contentType || "application/x-www-form-urlencoded; charset=UTF-8",
      });
    } else {
      res = await session.get(url, { xhr: true, referer: opts.referer || `${session.state.origin}/bag` });
    }

    if (looksLikeAkamaiDenied(res.text, res.status)) {
      return { ok: false, status: res.status, note: "Globale-GetCartToken Akamai denied", denied: true };
    }

    const j = res.json || safeJson(res.text) || {};
    const token =
      j.cartToken ||
      j.CartToken ||
      j.MerchantCartToken ||
      j.merchantCartToken ||
      j.token ||
      j?.globale?.MerchantCartToken ||
      extractGeCheckoutGuid(res.text) ||
      null;

    return {
      ok: (res.ok || j.success === true) && Boolean(token),
      status: res.status,
      note: token
        ? `SFCC GE cartToken ${String(token).slice(0, 12)}… via=${preferPost ? "POST" : "GET"} (Checkout GUID)`
        : `Globale-GetCartToken status=${res.status} via=${preferPost ? "POST" : "GET"} (no token — ${String(j.message || "").slice(0, 80)})`,
      merchantCartToken: token,
      checkoutGuid: token,
      raw: j,
      textBytes: res.text?.length || 0,
    };
  });
}

/**
 * Optional GEM GetCartToken (Bandai-shaped). Disney SFCC already returns a
 * Checkout GUID — this hop often 500s on WebStoreCode mismatch and is not required.
 */
export async function getDisneyGeCartToken(session, ctx, opts = {}) {
  const tStep = opts.tStep || (async (_n, fn) => fn());
  const mid = String(opts.merchantId || DISNEY_GLOBALE_MID);
  const merchantCartToken = opts.merchantCartToken || opts.cartGuid || "";
  if (!merchantCartToken) {
    return { ok: false, note: "merchantCartToken required for GE GetCartToken" };
  }

  const url = buildGetCartTokenUrl({
    merchantId: mid,
    merchantCartToken,
    countryCode: opts.countryCode || "AU",
    currencyCode: opts.currencyCode || "AUD",
    cultureCode: opts.cultureCode || "en-GB",
    preferedCultureCode: opts.preferedCultureCode || "en-GB",
    webStoreCode: opts.webStoreCode || "disneystore.com.au",
    webStoreInstanceCode: opts.webStoreInstanceCode || "au",
    customerEmail: opts.customerEmail || "",
    gepiBase: opts.gepiBase || DISNEY_GE_GEPI,
  });

  return tStep("ge_get_cart_token", async () => {
    const res = await request(
      url,
      {
        method: "GET",
        headers: {
          "user-agent": session.state.userAgent || DEFAULT_UA,
          accept: "application/javascript, application/json, */*",
          "accept-language": "en-AU,en;q=0.9",
          referer: opts.referer || `${session.state.origin}/bag`,
          origin: session.state.origin,
        },
      },
      ctx,
    );
    const text = await res.text().catch(() => "");
    const parsed = parseJsonp(text) || safeJson(text) || {};
    const cartToken =
      parsed.CartToken ||
      parsed.cartToken ||
      parsed.Token ||
      extractGeCheckoutGuid(text) ||
      null;
    return {
      ok: Boolean(cartToken) && parsed.Success !== false,
      status: res.status,
      note: cartToken
        ? `GE CartToken mid=${mid} ${String(cartToken).slice(0, 12)}…`
        : `GetCartToken optional-fail status=${res.status} (SFCC GUID still usable) body=${text.replace(/\s+/g, " ").slice(0, 100)}`,
      cartToken,
      merchantId: mid,
      url,
      raw: parsed,
    };
  });
}

function buildCheckoutV2Urls(guid, encodedMerchant = DISNEY_GE_ENCODED_MERCHANT) {
  const g = encodeURIComponent(guid);
  const m = encodeURIComponent(encodedMerchant || DISNEY_GE_ENCODED_MERCHANT);
  return {
    /** Proven boot URL (guid-only) — 200 Checkout HTML. */
    primary: `${DISNEY_GE_WEBSERVICES}/Checkout/v2/${g}`,
    /** Bandai/PC-shaped path with Disney encoded merchant. */
    withMerchant: `${DISNEY_GE_WEBSERVICES}/Checkout/v2/${m}/${g}`,
  };
}

/**
 * Load Checkout/v2 HTML. Prefer same proxy; fall back to direct undici when
 * tls-client / CF 429s webservices (common after ISP spray).
 */
export async function fetchDisneyCheckoutV2(ctx, opts = {}) {
  const tStep = opts.tStep || (async (_n, fn) => fn());
  const guid = opts.checkoutGuid || opts.cartToken || opts.guid;
  if (!guid) return { ok: false, note: "checkoutGuid required" };

  const urls = buildCheckoutV2Urls(guid, opts.encodedMerchant || DISNEY_GE_ENCODED_MERCHANT);
  const tryUrls = opts.preferMerchantPath
    ? [urls.withMerchant, urls.primary]
    : [urls.primary, urls.withMerchant];
  const referer = opts.referer || "https://www.disneystore.com.au/bag";
  const ua = opts.userAgent || DEFAULT_UA;

  return tStep("ge_checkout_v2", async () => {
    const attempts = [];
    const dispatchers = [{ label: "session", dispatcher: ctx.dispatcher }];
    let ownedDirect = null;
    if (opts.allowDirect !== false) {
      ownedDirect = makeDispatcher(null, { forceUndici: true });
      dispatchers.push({ label: "direct-undici", dispatcher: ownedDirect });
    }

    try {
      for (const { label, dispatcher } of dispatchers) {
        for (const url of tryUrls) {
          try {
            const res = await request(
              url,
              {
                method: "GET",
                headers: {
                  "user-agent": ua,
                  accept: "text/html,application/xhtml+xml,*/*",
                  "accept-language": "en-GB,en;q=0.9",
                  referer,
                },
              },
              { jar: ctx.jar, dispatcher },
            );
            const text = await res.text().catch(() => "");
            const ok =
              res.status >= 200 &&
              res.status < 300 &&
              text.length > 20_000 &&
              /<title[^>]*>\s*Checkout/i.test(text);
            attempts.push({
              via: label,
              url: url.replace(guid, "{guid}"),
              status: res.status,
              bytes: text.length,
              ok,
            });
            if (!ok) continue;

            const encodedFromHtml = extractEncodedMerchantId(text) || DISNEY_GE_ENCODED_MERCHANT;
            const secureFrameUrl = extractSecureFrameUrl(text);
            const jwt = extractUrlStructureToken(text);
            const form = parseCheckoutV2Form(text);
            return {
              ok: true,
              status: res.status,
              note: `Checkout/v2 ${res.status} via=${label} encoded=${encodedFromHtml} jwt=${Boolean(jwt)} bytes=${text.length}`,
              url,
              checkoutGuid: guid,
              encodedMerchantId: encodedFromHtml,
              secureFrameUrl,
              issuerAction: DISNEY_GE_ISSUER_ACTION,
              creditCardFormUrl: secureFrameUrl || `${DISNEY_GE_CREDIT_CARD_FORM}/${guid}`,
              urlStructureToken: jwt,
              form: {
                hasAddress: form.hasAddress,
                shippingMethodId: form.selectedShippingOptionId || null,
                countryId: form.shipping?.CountryId || form.shipping?.Country || null,
              },
              ioBlackBox: /ioBlackBox|snare\.js|iovation/i.test(text),
              forter: /forter/i.test(text),
              attempts,
              htmlBytes: text.length,
              // Keep HTML out of task results by default (large + PII-ish).
              html: opts.includeHtml === true ? text : undefined,
            };
          } catch (e) {
            attempts.push({
              via: label,
              url: url.replace(String(guid), "{guid}"),
              ok: false,
              err: e?.message || String(e),
            });
          }
        }
      }
      return {
        ok: false,
        note: `Checkout/v2 not loaded after ${attempts.length} attempts`,
        checkoutGuid: guid,
        attempts,
      };
    } finally {
      await ownedDirect?.close?.();
    }
  });
}

/**
 * Phase C handoff: SFCC GUID → optional Checkout/v2 boot. Stops before issuer pay.
 *
 * Speed: pay path should set skipCheckoutV2 (and usually skipLoader) so Checkout/v2
 * is fetched once inside runDisneyGeHttpPay — the double fetch cost ~3–8s.
 */
export async function runDisneyGeHandoff(session, ctx, opts = {}) {
  const tStep = opts.tStep || (async (_n, fn) => fn());
  let loader = null;
  if (opts.skipLoader === true) {
    loader = {
      ok: true,
      merchantId: DISNEY_GLOBALE_MID,
      culture: "en-GB",
      note: "GE loader skipped (mid known)",
    };
    await tStep("ge_script_loader", async () => loader);
  } else {
    loader = await fetchDisneyGeScriptLoader(session, { tStep, referer: opts.referer });
  }

  const sfcc = await fetchDisneySfccCartToken(session, {
    tStep,
    referer: opts.referer || `${session.state.origin}/bag`,
    body: opts.sfccBody,
  });

  if (!sfcc.checkoutGuid && !sfcc.merchantCartToken) {
    return {
      ok: false,
      dryRun: true,
      checkoutStage: "ge_handoff",
      note: sfcc.note,
      loader,
      sfcc,
      merchantId: DISNEY_GLOBALE_MID,
      encodedMerchantId: DISNEY_GE_ENCODED_MERCHANT,
      stoppedBeforePay: true,
    };
  }

  const guid = sfcc.checkoutGuid || sfcc.merchantCartToken;

  // Optional GEM hop — informational only; SFCC GUID is authoritative for Disney.
  let gem = null;
  if (opts.tryGemGetCartToken === true) {
    gem = await getDisneyGeCartToken(session, ctx, {
      tStep,
      merchantCartToken: guid,
      merchantId: loader.merchantId || DISNEY_GLOBALE_MID,
      customerEmail: opts.customerEmail,
      cultureCode: loader.culture || "en-GB",
      referer: opts.referer || `${session.state.origin}/bag`,
    });
  }

  const checkoutGuid = gem?.cartToken || guid;
  const urls = buildCheckoutV2Urls(checkoutGuid, DISNEY_GE_ENCODED_MERCHANT);

  // Pay path defers Checkout/v2 to the issuer hydrate (single fetch).
  if (opts.skipCheckoutV2 === true) {
    return {
      ok: true,
      dryRun: true,
      placeOrder: false,
      checkoutStage: "ge_guid",
      note: `GE cartToken ready mid=${DISNEY_GLOBALE_MID} (Checkout/v2 deferred for pay)`,
      loader,
      sfcc,
      gem,
      checkout: null,
      checkoutGuid,
      checkoutV2Url: urls.primary,
      checkoutV2UrlWithMerchant: urls.withMerchant,
      creditCardFormUrl: `${DISNEY_GE_CREDIT_CARD_FORM}/${checkoutGuid}`,
      issuerAction: DISNEY_GE_ISSUER_ACTION,
      merchantId: DISNEY_GLOBALE_MID,
      merchantHashed: DISNEY_GE_MERCHANT_HASHED,
      encodedMerchantId: DISNEY_GE_ENCODED_MERCHANT,
      secureHost: DISNEY_GE_SECURE,
      stoppedBeforePay: true,
      deferredCheckoutV2: true,
    };
  }

  const v2 = await fetchDisneyCheckoutV2(ctx, {
    tStep,
    checkoutGuid,
    referer: opts.referer || `${session.state.origin}/bag`,
    userAgent: session.state.userAgent,
    allowDirect: opts.allowDirectCheckout !== false,
    includeHtml: opts.includeHtml === true,
  });

  const encodedMerchantId = v2.encodedMerchantId || DISNEY_GE_ENCODED_MERCHANT;
  const ok = Boolean(v2.ok);

  return {
    ok,
    dryRun: true,
    placeOrder: false,
    checkoutStage: ok ? "ge_checkout" : "ge_handoff",
    note: ok
      ? `GE Checkout/v2 ready mid=${DISNEY_GLOBALE_MID} encoded=${encodedMerchantId} (stop before pay)`
      : v2.note || sfcc.note,
    loader,
    sfcc,
    gem,
    checkout: v2,
    checkoutGuid,
    checkoutV2Url: urls.primary,
    checkoutV2UrlWithMerchant: urls.withMerchant,
    creditCardFormUrl: v2.creditCardFormUrl || `${DISNEY_GE_CREDIT_CARD_FORM}/${checkoutGuid}`,
    issuerAction: DISNEY_GE_ISSUER_ACTION,
    merchantId: DISNEY_GLOBALE_MID,
    merchantHashed: DISNEY_GE_MERCHANT_HASHED,
    encodedMerchantId,
    secureHost: DISNEY_GE_SECURE,
    stoppedBeforePay: true,
  };
}

export default {
  DISNEY_GLOBALE_MID,
  DISNEY_GE_MERCHANT_HASHED,
  DISNEY_GE_ENCODED_MERCHANT,
  DISNEY_GE_SECURE,
  DISNEY_GE_WEBSERVICES,
  DISNEY_GE_ISSUER_ACTION,
  fetchDisneyGeScriptLoader,
  fetchDisneySfccCartToken,
  getDisneyGeCartToken,
  fetchDisneyCheckoutV2,
  runDisneyGeHandoff,
};
