/**
 * Behavior-neutral double-charge forensics.
 * Append-only JSON lines: every /run start + every PSP issuer POST we know about.
 * Correlates desktop runId/taskId with executor taskId + card last4 + timestamps.
 *
 * Does NOT change checkout / retry / pay behavior.
 *
 * Log path: PAY_FORENSICS_PATH or <tmpdir>/j1m-pay-forensics.jsonl
 *
 * Dual-Revolut angles (see DUAL_REVOLUT_CROSS_MODULE.md):
 *   A) merchant/PSP fan-out — enrich psp_post_end with redirect/tx fields
 *   B) shared pre-pay hops — stage=prepay|issuer on http_mutate*
 *   C) score on stock Fast (via=page-ge-issuer) only
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** Hosts that may participate in checkout/pay. */
export const PAY_WIRE_HOST_RE =
  /global-e\.com|payments\.bigcommerce\.com|paydock\.com|adyen\.com|checkout\.com|stripe\.com|braintree|paypal\.com/i;

/** Paths that can actually hit a card issuer. */
export const ISSUER_PATH_RE =
  /HandleCreditCard|\/payments(?:\/|$)|\/charges|standalone-3ds|\/Payment|CreditCard/i;

/** Redirect / ACS-ish locations (fan-out correlation, not a second client POST). */
export const ACS_OR_REDIRECT_RE =
  /CCPaymentRedirect|\/acs|3ds|cardinalcommerce|secure\.|pareq|creq|methodurl/i;

function logPath() {
  const env = String(process.env.PAY_FORENSICS_PATH || "").trim();
  if (env) return env;
  return path.join(os.tmpdir(), "j1m-pay-forensics.jsonl");
}

function maskLast4(card) {
  const n = String(card?.number || "").replace(/\s+/g, "");
  return n.length >= 4 ? n.slice(-4) : null;
}

/**
 * Classify a pay-host mutate as issuer vs prepay (angle B).
 * @param {string} host
 * @param {string} pathName
 * @returns {"issuer"|"prepay"|"other"}
 */
export function classifyPayWireStage(host, pathName) {
  const h = String(host || "");
  const p = String(pathName || "");
  if (ISSUER_PATH_RE.test(p) || /payments\.bigcommerce\.com/i.test(h)) {
    return "issuer";
  }
  if (PAY_WIRE_HOST_RE.test(h)) return "prepay";
  return "other";
}

/**
 * Behavior-neutral fan-out fields from a PSP redirect / JWT map (angle A).
 * @param {string|null|undefined} redirectUrl
 * @param {Record<string, unknown>|null|undefined} redirectPayload
 */
export function redirectFanoutFields(redirectUrl, redirectPayload = null) {
  let redirectHost = null;
  let redirectPath = null;
  const raw = redirectUrl ? String(redirectUrl) : "";
  if (raw) {
    try {
      const abs = /^https?:\/\//i.test(raw)
        ? raw
        : `https://webservices.global-e.com${raw.startsWith("/") ? "" : "/"}${raw}`;
      const u = new URL(abs);
      redirectHost = u.host;
      redirectPath = u.pathname.slice(0, 180);
    } catch {
      redirectPath = raw.slice(0, 180);
    }
  }
  const map =
    redirectPayload && typeof redirectPayload === "object" ? redirectPayload : {};
  const transactionId =
    map.TransactionId != null && String(map.TransactionId) !== "0"
      ? String(map.TransactionId)
      : map.MerchantReference
        ? String(map.MerchantReference)
        : null;
  const statusType =
    map.StatusType != null
      ? String(map.StatusType)
      : map.ErrorCode != null
        ? String(map.ErrorCode)
        : null;
  return {
    redirectHost,
    redirectPath,
    isPaymentRedirect: /CCPaymentRedirect/i.test(raw),
    locationLooksAcs: Boolean(raw && ACS_OR_REDIRECT_RE.test(raw)),
    transactionId,
    statusType,
  };
}

/**
 * @param {string} event
 * @param {Record<string, unknown>} fields
 */
export function payForensics(event, fields = {}) {
  const row = {
    t: new Date().toISOString(),
    ts: Date.now(),
    event: String(event || "unknown"),
    ...fields,
  };
  // Never persist PAN/CVV if a caller accidentally passes card.
  if (row.card && typeof row.card === "object") {
    row.cardLast4 = maskLast4(row.card);
    delete row.card;
  }
  const line = JSON.stringify(row);
  try {
    console.log(`[pay-forensics] ${line}`);
  } catch {
    /* ignore */
  }
  try {
    fs.appendFileSync(logPath(), `${line}\n`, "utf8");
  } catch {
    /* ignore — forensics must never break checkout */
  }
  return row;
}

export function payForensicsPath() {
  return logPath();
}

function issuerHost(url) {
  try {
    return new URL(String(url || "")).host;
  } catch {
    return null;
  }
}

/**
 * Thin shared wrapper for PSP / issuer mutation posts across stores.
 * Behavior-neutral — callers still own retry:false / single-flight.
 *
 * @param {"start"|"end"|"suppressed"} phase
 * @param {Record<string, unknown>} fields — must include store + via
 */
export function pspPostForensics(phase, fields = {}) {
  const event =
    phase === "end"
      ? "psp_post_end"
      : phase === "suppressed"
        ? "psp_post_suppressed"
        : "psp_post_start";
  const url = fields.url || fields.issuerUrl || null;
  const {
    url: _u,
    issuerUrl: _iu,
    body: _b,
    ...rest
  } = fields;
  return payForensics(event, {
    store: rest.store || null,
    via: rest.via || null,
    desktopTaskId: rest.desktopTaskId || null,
    desktopRunId: rest.desktopRunId || null,
    desktopAttempt: rest.desktopAttempt || null,
    executorTaskId: rest.executorTaskId || null,
    issuerHost: rest.issuerHost || issuerHost(url),
    bodyBytes:
      rest.bodyBytes != null
        ? Number(rest.bodyBytes)
        : _b != null
          ? String(_b).length
          : null,
    ...rest,
  });
}

export default {
  payForensics,
  payForensicsPath,
  pspPostForensics,
  classifyPayWireStage,
  redirectFanoutFields,
  PAY_WIRE_HOST_RE,
  ISSUER_PATH_RE,
  ACS_OR_REDIRECT_RE,
};
