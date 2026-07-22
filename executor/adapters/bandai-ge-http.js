/**
 * Bandai Global-e Pay over HTTP (undici) — research track to drop Playwright GE UI.
 *
 * Wire-proven issuer (Revolut 2026-07-22):
 *   POST https://secure-bandai.global-e.com/1/Payments/HandleCreditCardRequestV2/…
 *
 * Blockers before this can replace browserBandaiGeFromCart on a drop:
 *   1. Checkout/v2 session GUID (SPA PROCEED / GEM boot — not in checkoutSn alone)
 *   2. Card iframe / tokenized PAN fields in the issuer body
 *   3. Forter (+ often FingerprintJS) tokens minted in GEM
 *
 * Lab path: browserBandaiGeFromCart writes /tmp/bandai-ge-issuer-capture.json on the
 * first allowed issuer POST. Use postBandaiGeIssuerHttp to replay / mutate that body
 * once GUID+Forter can be obtained without the full Pay UI.
 */

import { request } from "undici";
import fs from "node:fs";
import { isBandaiGeIssuerPaymentUrl } from "./bandai-ge-pay.js";

const CAPTURE_DEFAULT = "/tmp/bandai-ge-issuer-capture.json";

/** UUID-ish GUID from Checkout/v2 / handleaction / orderdetails HTML. */
export function extractGeCheckoutGuid(htmlOrUrl) {
  const s = String(htmlOrUrl || "");
  const patterns = [
    /HandleCreditCardRequestV2\/[^/]+\/([0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12})/i,
    /checkoutv2\/handleaction\/\d+\/([0-9a-f-]{36})\//i,
    /Checkout\/v2\/[^"'?\s]*([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i,
    /"checkoutId"\s*:\s*"([0-9a-f-]{36})"/i,
    /"CartToken"\s*:\s*"([0-9a-f-]{36})"/i,
  ];
  for (const re of patterns) {
    const m = s.match(re);
    if (m?.[1]) return m[1];
  }
  return null;
}

export function loadIssuerCapture(path = CAPTURE_DEFAULT) {
  if (!fs.existsSync(path)) return null;
  try {
    return JSON.parse(fs.readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

/**
 * POST HandleCreditCardRequestV2 via undici (optional proxy).
 * Does not invent Forter/card fields — pass a captured or constructed body.
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
    accept: "application/json, text/plain, */*",
    "content-type": opts.contentType || "application/json;charset=UTF-8",
    origin: "https://secure-bandai.global-e.com",
    referer: "https://secure-bandai.global-e.com/",
    "user-agent":
      opts.userAgent ||
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    ...(opts.cookieHeader ? { cookie: opts.cookieHeader } : {}),
    ...(opts.headers || {}),
  };

  const dispatcher = opts.dispatcher || undefined;
  const t0 = Date.now();
  try {
    const res = await request(url, {
      method: "POST",
      headers,
      body,
      dispatcher,
      headersTimeout: opts.timeoutMs || 45_000,
      bodyTimeout: opts.timeoutMs || 45_000,
    });
    const text = await res.body.text();
    const ms = Date.now() - t0;
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      /* ignore */
    }
    return {
      ok: res.statusCode >= 200 && res.statusCode < 300,
      status: res.statusCode,
      ms,
      bodySnippet: String(text || "").replace(/\s+/g, " ").slice(0, 240),
      json,
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

/**
 * Replay last lab capture (if present). Useful for schema inspection — not a
 * funded drop path until GUID/Forter are refreshed for the current cart.
 */
export async function replayCapturedIssuerHttp(opts = {}) {
  const cap = loadIssuerCapture(opts.capturePath || CAPTURE_DEFAULT);
  if (!cap?.url || !cap?.body) {
    return {
      ok: false,
      error: "no_capture",
      note: `Missing ${opts.capturePath || CAPTURE_DEFAULT} — run browser GE once to capture`,
      blockers: ["checkout_guid", "card_iframe_state", "forter", "fingerprintjs"],
    };
  }
  return postBandaiGeIssuerHttp({
    url: cap.url,
    body: cap.body,
    contentType: cap.contentType || undefined,
    cookieHeader: opts.cookieHeader,
    headers: opts.headers,
    dispatcher: opts.dispatcher,
    timeoutMs: opts.timeoutMs,
  });
}

export default {
  extractGeCheckoutGuid,
  loadIssuerCapture,
  postBandaiGeIssuerHttp,
  replayCapturedIssuerHttp,
};
