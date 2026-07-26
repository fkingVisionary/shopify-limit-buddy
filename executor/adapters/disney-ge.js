/**
 * Disney Store AU — Global-e handoff (merchant **1696**).
 *
 * Reuses pure builders from bandai-ge-http.js (read-only). Do NOT call
 * runBandaiGeHttpPay / hard-code Bandai mid 1925 / 8urc / secure-bandai.
 *
 * SFCC bridge: GET/POST Globale-GetCartToken → MerchantCartToken →
 * gepi GetCartToken?MerchantId=1696 → Checkout/v2.
 *
 * Encoded issuer merchant code (Bandai=8urc, PC=8u22) is still unknown for
 * Disney — stop before issuer until HAR/pay lab confirms secure host + code.
 */

import {
  buildGetCartTokenUrl,
  extractGeCheckoutGuid,
  parseJsonp,
} from "./bandai-ge-http.js";
import { DISNEY_GE_MID, DISNEY_GE_CLIENT_SDK, looksLikeAkamaiDenied } from "./disney-session.js";

export const DISNEY_GLOBALE_MID = DISNEY_GE_MID;
export const DISNEY_GE_SCRIPT = DISNEY_GE_CLIENT_SDK;
export const DISNEY_GE_GEPI = "https://gepi.global-e.com";
/** Hashed mid from clientsdk — not the issuer path code. */
export const DISNEY_GE_MERCHANT_HASHED = "mZ25";

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
      raw: res.json,
    };
  });
}

/**
 * Call SFCC Globale-GetCartToken. Response shape needs HAR confirmation —
 * accept JSON token fields commonly used by SFCC GE cartridges.
 */
export async function fetchDisneySfccCartToken(session, opts = {}) {
  const tStep = opts.tStep || (async (_n, fn) => fn());
  return tStep("ge_sfcc_cart_token", async () => {
    const url = session.urls.geCartToken;
    // Prefer GET (controller often tokenizes from basket session); POST if body provided.
    const res = opts.body
      ? await session.post(url, opts.body, {
          referer: opts.referer || `${session.state.origin}/bag`,
          contentType: opts.contentType || "application/x-www-form-urlencoded; charset=UTF-8",
        })
      : await session.get(url, { xhr: true, referer: opts.referer || `${session.state.origin}/bag` });

    if (looksLikeAkamaiDenied(res.text, res.status)) {
      return { ok: false, status: res.status, note: "Globale-GetCartToken Akamai denied", denied: true };
    }

    const j = res.json || safeJson(res.text) || {};
    const token =
      j.MerchantCartToken ||
      j.merchantCartToken ||
      j.cartToken ||
      j.CartToken ||
      j.token ||
      j?.globale?.MerchantCartToken ||
      extractGeCheckoutGuid(res.text) ||
      null;

    return {
      ok: res.ok && Boolean(token),
      status: res.status,
      note: token
        ? `SFCC GE cart token ${String(token).slice(0, 12)}…`
        : `Globale-GetCartToken status=${res.status} (no token yet — empty bag or shape needs HAR)`,
      merchantCartToken: token,
      raw: j,
      textBytes: res.text?.length || 0,
    };
  });
}

function safeJson(text) {
  try {
    return JSON.parse(String(text || ""));
  } catch {
    return null;
  }
}

/**
 * GEM GetCartToken for Disney mid 1696 (parameterized Bandai builder).
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
    const res = await session.get(url, {
      xhr: true,
      referer: opts.referer || `${session.state.origin}/bag`,
    });
    // GE endpoints may not share Disney cookies meaningfully — still use same ctx.
    const parsed = parseJsonp(res.text) || safeJson(res.text) || {};
    const cartToken =
      parsed.CartToken ||
      parsed.cartToken ||
      parsed.Token ||
      extractGeCheckoutGuid(res.text) ||
      null;
    return {
      ok: Boolean(cartToken),
      status: res.status,
      note: cartToken
        ? `GE CartToken mid=${mid} ${String(cartToken).slice(0, 12)}…`
        : `GetCartToken fail status=${res.status} body=${String(res.text || "").slice(0, 140)}`,
      cartToken,
      merchantId: mid,
      url,
      raw: parsed,
    };
  });
}

/**
 * Phase C handoff: SFCC token → GEM token. Stops before Checkout/v2 pay unless
 * opts.continueToCheckoutV2 (still no issuer — encoded merchant unknown).
 */
export async function runDisneyGeHandoff(session, ctx, opts = {}) {
  const tStep = opts.tStep || (async (_n, fn) => fn());
  const loader = await fetchDisneyGeScriptLoader(session, { tStep, referer: opts.referer });
  const sfcc = await fetchDisneySfccCartToken(session, {
    tStep,
    referer: opts.referer || `${session.state.origin}/bag`,
    body: opts.sfccBody,
  });

  if (!sfcc.merchantCartToken) {
    return {
      ok: false,
      dryRun: opts.placeOrder !== true,
      checkoutStage: "ge_handoff",
      note: sfcc.note,
      loader,
      sfcc,
      merchantId: DISNEY_GLOBALE_MID,
      stoppedBeforePay: true,
    };
  }

  const gem = await getDisneyGeCartToken(session, ctx, {
    tStep,
    merchantCartToken: sfcc.merchantCartToken,
    merchantId: loader.merchantId || DISNEY_GLOBALE_MID,
    customerEmail: opts.customerEmail,
    referer: opts.referer || `${session.state.origin}/bag`,
  });

  const checkoutV2Url = gem.cartToken
    ? `${DISNEY_GE_GEPI}/Checkout/v2/${encodeURIComponent(gem.cartToken)}`
    : null;

  return {
    ok: Boolean(gem.cartToken),
    dryRun: opts.placeOrder !== true,
    checkoutStage: gem.cartToken ? "ge_checkout" : "ge_handoff",
    note: gem.cartToken
      ? `GE handoff ready mid=${DISNEY_GLOBALE_MID} (stop before pay — issuer code TBD)`
      : gem.note,
    loader,
    sfcc,
    gem,
    checkoutV2Url,
    merchantId: DISNEY_GLOBALE_MID,
    merchantHashed: DISNEY_GE_MERCHANT_HASHED,
    stoppedBeforePay: true,
    placeOrder: false,
  };
}

export default {
  DISNEY_GLOBALE_MID,
  DISNEY_GE_MERCHANT_HASHED,
  fetchDisneyGeScriptLoader,
  fetchDisneySfccCartToken,
  getDisneyGeCartToken,
  runDisneyGeHandoff,
};
