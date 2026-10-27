/**
 * Shopify fraud / risk forensics — BUYER SIDE, read-only, log-only.
 *
 * Purpose: after an order has been submitted (by the full desktop bot — this
 * executor's Shopify adapter itself stops before payment), watch the order's
 * buyer-visible state and record when it gets flagged (cancelled for fraud,
 * refunded, or held for review), then correlate that flag with the signals the
 * run itself could see so you can trace a likely cause.
 *
 * Hard limits of the buyer side (be honest about them):
 *   • Shopify's actual fraud SCORE and the specific indicators that fired
 *     (CVV/AVS, "high risk internet connection", billing≠shipping, device
 *     velocity) are MERCHANT-only (Admin API order.risk). A buyer only ever
 *     sees the downstream effect — the order flipping to cancelled/refunded/
 *     held. So correlateFlag() produces *likely causes*, not ground truth.
 *   • This module never writes to any store (no cancel/refund). It reads order
 *     state the operator already has access to and appends a quiet log line.
 *
 * Log: SHOPIFY_RISK_LOG or <tmpdir>/j1m-shopify-risk.jsonl (append-only JSONL,
 * one console line per event — no Discord, no alerts).
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { request } from "../http.js";

const now = () => Date.now();

function logPath() {
  return process.env.SHOPIFY_RISK_LOG || path.join(os.tmpdir(), "j1m-shopify-risk.jsonl");
}

/** Quiet forensics append: one JSONL line + one console line. Never throws. */
export function recordRiskEvent(taskId, event, fields = {}) {
  const row = { t: new Date().toISOString(), ts: now(), taskId: taskId || null, event: String(event || "risk"), ...fields };
  const line = JSON.stringify(row);
  try {
    console.log(`[shopify-risk] ${line}`);
  } catch {
    /* ignore */
  }
  try {
    fs.appendFileSync(logPath(), `${line}\n`, "utf8");
  } catch {
    /* forensics must never break anything */
  }
  return row;
}

// ── Order-status parsing ────────────────────────────────────────────────────

const HTML_SIGNALS = [
  { signal: "cancelled_fraud", re: /cancel(?:l)?ed[^.]*fraud|fraudulent|flagged as fraud|risk of fraud/i },
  { signal: "refunded", re: /\brefunded\b|refund (?:was )?issued|your refund|has been refunded/i },
  { signal: "cancelled", re: /order (?:has been |was )?cancel(?:l)?ed|order canceled|has been voided/i },
  { signal: "payment_review", re: /payment pending|pending payment|under review|awaiting payment|on hold|hold for review|being reviewed/i },
  { signal: "paid", re: /thank you|order confirmed|payment (?:accepted|received)|confirmation #|your order is confirmed/i },
];

const FLAG_SIGNALS = new Set(["cancelled_fraud", "refunded", "cancelled", "payment_review"]);

/**
 * Normalise either a Shopify Order object (Admin/webhook JSON) or a raw
 * order-status HTML page into a comparable state.
 *
 * @returns {{
 *   source: "json"|"html",
 *   name: string|null,
 *   financialStatus: string|null,
 *   fulfillmentStatus: string|null,
 *   cancelled: boolean,
 *   cancelReason: string|null,
 *   flagged: boolean,
 *   flagSignal: string|null,
 *   stateKey: string,     // stable key for flip detection
 * }}
 */
export function parseOrderStatus(input) {
  // JSON order object (or a JSON string of one).
  let obj = null;
  if (input && typeof input === "object") obj = input;
  else if (typeof input === "string") {
    const t = input.trim();
    if (t.startsWith("{")) {
      try {
        obj = JSON.parse(t);
      } catch {
        obj = null;
      }
    }
  }

  if (obj) {
    const order = obj.order && typeof obj.order === "object" ? obj.order : obj;
    const financialStatus = order.financial_status ?? order.displayFinancialStatus ?? null;
    const fulfillmentStatus = order.fulfillment_status ?? order.displayFulfillmentStatus ?? null;
    const cancelReason = order.cancel_reason ?? order.cancelReason ?? null;
    const cancelled = Boolean(order.cancelled_at ?? order.cancelledAt ?? cancelReason);
    const fin = String(financialStatus || "").toLowerCase();
    let flagSignal = null;
    if (cancelled) flagSignal = /fraud/i.test(String(cancelReason || "")) ? "cancelled_fraud" : "cancelled";
    else if (/refund/.test(fin)) flagSignal = "refunded";
    else if (/pending|authorized|on_hold|review/.test(fin)) flagSignal = "payment_review";
    else if (/paid/.test(fin)) flagSignal = "paid";
    return {
      source: "json",
      name: order.name ?? order.order_number ?? order.id ?? null,
      financialStatus: financialStatus ?? null,
      fulfillmentStatus: fulfillmentStatus ?? null,
      cancelled,
      cancelReason: cancelReason ?? null,
      flagged: flagSignal != null && FLAG_SIGNALS.has(flagSignal),
      flagSignal,
      stateKey: `${fin || "?"}|${cancelled ? "cancelled" : "open"}|${flagSignal || "?"}`,
    };
  }

  // HTML order-status page.
  const html = String(input || "");
  let flagSignal = null;
  for (const s of HTML_SIGNALS) {
    if (s.re.test(html)) {
      flagSignal = s.signal;
      break; // ordered most-specific first
    }
  }
  const cancelled = flagSignal === "cancelled" || flagSignal === "cancelled_fraud";
  const cancelReason = /fraud/i.test(html) && cancelled ? "fraud" : null;
  const nameMatch = html.match(/(?:order|confirmation)\s*#?\s*([A-Z]{0,4}\d{3,})/i);
  return {
    source: "html",
    name: nameMatch?.[1] ?? null,
    financialStatus: null,
    fulfillmentStatus: null,
    cancelled,
    cancelReason,
    flagged: flagSignal != null && FLAG_SIGNALS.has(flagSignal),
    flagSignal,
    stateKey: `html|${cancelled ? "cancelled" : "open"}|${flagSignal || "?"}`,
  };
}

/** True when `curr` is a worse (flag) state than `prev` — i.e. an order got flagged after submission. */
export function classifyOutcome(prev, curr) {
  const before = prev?.stateKey ?? null;
  const after = curr?.stateKey ?? null;
  const flipped = before !== after;
  const newlyFlagged = Boolean(curr?.flagged) && !prev?.flagged;
  return { flipped, newlyFlagged, from: before, to: after, flagSignal: curr?.flagSignal ?? null };
}

// ── Buyer-visible pre-submission signals ────────────────────────────────────

/**
 * Surface the risk-relevant signals the run itself could observe. These are
 * what a buyer can see — not Shopify's private fraud facts — and are what we
 * line up against a later flag.
 *
 * @param runResult a checkout/run result ({ steps, shopify, reached3ds, transport, ... })
 * @param task      the task ({ profile, proxy, ... }) for billing/shipping comparison
 */
export function riskSignalsFromRun(runResult = {}, task = {}) {
  const steps = Array.isArray(runResult.steps) ? runResult.steps : [];
  const stepNames = steps.map((s) => String(s?.step || ""));
  const signals = [];

  // 3DS / step-up verification reached.
  if (
    runResult.reached3ds ||
    runResult.threeDsUrl ||
    stepNames.some((n) => /3ds|threeds|create_3ds|acs|challenge/i.test(n))
  ) {
    signals.push({ signal: "three_ds_stepup", severity: "info", detail: "issuer/risk step-up verification reached" });
  }

  // Captcha re-challenge (from the shopify adapter's captcha telemetry).
  const detected = runResult.shopify?.captcha?.detected ?? [];
  if (detected.length) {
    signals.push({
      signal: "captcha_rechallenge",
      severity: "warn",
      detail: `antibot challenge(s): ${[...new Set(detected)].join(", ")}`,
    });
  }

  // Billing ≠ shipping (classic AVS risk fact).
  const p = task.profile || runResult.profile || null;
  const bill = p?.billing_address || p?.billingAddress || null;
  if (bill && (p?.address1 || p?.zip)) {
    const mism =
      norm(bill.address1) !== norm(p.address1) ||
      norm(bill.zip) !== norm(p.zip) ||
      norm(bill.country) !== norm(p.country);
    if (mism) signals.push({ signal: "billing_shipping_mismatch", severity: "warn", detail: "billing address differs from shipping" });
  }

  // Proxy used (residential/ISP exits can still be reputation-flagged).
  if (task.proxy || runResult.transport) {
    signals.push({ signal: "proxy_used", severity: "info", detail: task.proxy ? "run used a proxy exit" : `transport=${runResult.transport}` });
  }

  // Declined / rejected at submit.
  if (/declin|reject/i.test(String(runResult.failedStep || "")) || /declin|reject/i.test(String(runResult.error || ""))) {
    signals.push({ signal: "declined", severity: "high", detail: String(runResult.failedStep || runResult.error).slice(0, 120) });
  }

  return signals;
}

function norm(v) {
  return String(v ?? "").trim().toLowerCase().replace(/\s+/g, " ");
}

/**
 * Map a detected flag + the run's buyer-visible signals to likely causes.
 * Honest by construction: confidence never exceeds "medium" because the buyer
 * side cannot read Shopify's real risk facts.
 */
export function correlateFlag(outcome, runSignals = []) {
  const causes = [];
  const have = new Set(runSignals.map((s) => s.signal));
  const flag = outcome?.flagSignal ?? outcome?.to ?? null;

  if (flag === "cancelled_fraud" || flag === "cancelled" || flag === "refunded") {
    if (have.has("proxy_used"))
      causes.push('proxy/IP reputation — Shopify commonly cites "high risk internet connection" for proxy exits');
    if (have.has("billing_shipping_mismatch"))
      causes.push("billing ≠ shipping — a frequent AVS/address risk fact");
    if (have.has("captcha_rechallenge"))
      causes.push("antibot re-challenge during checkout — bot-protection correlated with the decision");
    // Only meaningful alongside other positive signals — never as a lone "cause".
    if (have.size > 0 && !have.has("three_ds_stepup"))
      causes.push("no 3DS step-up seen — a frictionless auth can still be reversed by post-auth fraud review");
  }
  if (flag === "payment_review") {
    causes.push("order held for manual/automatic review — medium risk; may still clear or cancel");
  }
  // The buyer side can never read Shopify's real fraud facts — always say so.
  causes.push("root cause detail is merchant-side only (Admin API order.risk); buyer view is downstream");

  const positive = have.has("proxy_used") || have.has("billing_shipping_mismatch") || have.has("captcha_rechallenge");
  const confidence = positive ? "medium" : "low";
  return {
    flagSignal: flag,
    likelyCauses: causes,
    confidence,
    note: "buyer side cannot read Shopify's fraud facts; these are correlations, not ground truth",
  };
}

// ── Order-status watcher ─────────────────────────────────────────────────────

/**
 * Poll a buyer order-status URL until it resolves (flagged / terminal) or the
 * time budget runs out. Reads only — appends a quiet risk event on each change.
 *
 * @param opts { orderStatusUrl, ctx (dispatcher+jar), taskId?, runSignals?,
 *               intervalMs?=30000, maxMs?=1800000, onChange? }
 */
export async function pollOrderStatus(opts = {}) {
  const { orderStatusUrl, ctx, taskId = null, runSignals = [], onChange } = opts;
  const intervalMs = Math.max(1000, Number(opts.intervalMs ?? 30_000));
  const maxMs = Math.max(intervalMs, Number(opts.maxMs ?? 30 * 60_000));
  if (!orderStatusUrl || !ctx?.dispatcher) throw new Error("pollOrderStatus needs orderStatusUrl + ctx{dispatcher,jar}");

  const start = now();
  const history = [];
  let prev = null;
  let polls = 0;

  while (now() - start < maxMs) {
    polls++;
    let parsed = null;
    try {
      const res = await request(
        orderStatusUrl,
        { method: "GET", headers: { accept: "text/html,application/json;q=0.9,*/*;q=0.8" } },
        ctx,
      );
      const body = await res.text();
      const ct = String(res.headers.get("content-type") || "");
      parsed = parseOrderStatus(/json/i.test(ct) ? body : body);
      parsed.httpStatus = res.status;
    } catch (e) {
      recordRiskEvent(taskId, "order_poll_error", { poll: polls, error: e?.message ?? String(e) });
      await sleep(intervalMs);
      continue;
    }

    const outcome = classifyOutcome(prev, parsed);
    history.push({ at: now() - start, poll: polls, state: parsed.stateKey, flagSignal: parsed.flagSignal });

    if (outcome.flipped || polls === 1) {
      const correlation = parsed.flagged ? correlateFlag(outcome, runSignals) : null;
      const row = recordRiskEvent(taskId, parsed.flagged ? "order_flagged" : "order_state", {
        orderName: parsed.name,
        financialStatus: parsed.financialStatus,
        flagSignal: parsed.flagSignal,
        from: outcome.from,
        to: outcome.to,
        poll: polls,
        correlation,
      });
      try {
        onChange?.(parsed, outcome, correlation, row);
      } catch {
        /* onChange must not break the poll loop */
      }
    }

    prev = parsed;
    // Terminal: a cancellation/refund won't un-happen; stop watching.
    if (parsed.flagSignal === "cancelled_fraud" || parsed.flagSignal === "cancelled" || parsed.flagSignal === "refunded") {
      break;
    }
    await sleep(intervalMs);
  }

  return { polls, history, final: prev };
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

export default {
  parseOrderStatus,
  classifyOutcome,
  riskSignalsFromRun,
  correlateFlag,
  recordRiskEvent,
  pollOrderStatus,
  riskLogPath: logPath,
};
