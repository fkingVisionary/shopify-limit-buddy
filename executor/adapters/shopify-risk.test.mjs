import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { makeDispatcher, createJar } from "../http.js";
import {
  parseOrderStatus,
  classifyOutcome,
  riskSignalsFromRun,
  correlateFlag,
  recordRiskEvent,
  pollOrderStatus,
} from "./shopify-risk.js";

// ── parseOrderStatus: order JSON ────────────────────────────────────────────

test("parseOrderStatus: paid order JSON → not flagged", () => {
  const s = parseOrderStatus({ name: "#1001", financial_status: "paid", fulfillment_status: null });
  assert.equal(s.flagged, false);
  assert.equal(s.flagSignal, "paid");
  assert.equal(s.name, "#1001");
});

test("parseOrderStatus: cancelled-fraud order JSON → cancelled_fraud", () => {
  const s = parseOrderStatus({ name: "#1002", cancelled_at: "2026-10-27T00:00:00Z", cancel_reason: "fraud" });
  assert.equal(s.flagged, true);
  assert.equal(s.flagSignal, "cancelled_fraud");
  assert.equal(s.cancelled, true);
});

test("parseOrderStatus: refunded order JSON → refunded", () => {
  const s = parseOrderStatus({ name: "#1003", financial_status: "refunded" });
  assert.equal(s.flagSignal, "refunded");
  assert.equal(s.flagged, true);
});

test("parseOrderStatus: GraphQL-style fields (displayFinancialStatus/cancelReason)", () => {
  const s = parseOrderStatus({ name: "#1004", displayFinancialStatus: "PENDING" });
  assert.equal(s.flagSignal, "payment_review");
  assert.equal(s.flagged, true);
});

// ── parseOrderStatus: HTML ──────────────────────────────────────────────────

test("parseOrderStatus: HTML thank-you page → paid, not flagged", () => {
  const s = parseOrderStatus("<html><body><h1>Thank you</h1>Order #2001 confirmed</body></html>");
  assert.equal(s.source, "html");
  assert.equal(s.flagged, false);
  assert.equal(s.flagSignal, "paid");
});

test("parseOrderStatus: HTML cancelled-for-fraud page → cancelled_fraud", () => {
  const s = parseOrderStatus("<html><body>Your order has been cancelled. Reason: flagged as fraudulent.</body></html>");
  assert.equal(s.flagSignal, "cancelled_fraud");
  assert.equal(s.flagged, true);
  assert.equal(s.cancelReason, "fraud");
});

test("parseOrderStatus: HTML refunded + review", () => {
  assert.equal(parseOrderStatus("<p>Your refund has been issued</p>").flagSignal, "refunded");
  assert.equal(parseOrderStatus("<p>Payment pending — under review</p>").flagSignal, "payment_review");
});

// ── classifyOutcome ──────────────────────────────────────────────────────────

test("classifyOutcome: paid → cancelled_fraud is a new flag", () => {
  const prev = parseOrderStatus({ financial_status: "paid" });
  const curr = parseOrderStatus({ cancel_reason: "fraud", cancelled_at: "x" });
  const o = classifyOutcome(prev, curr);
  assert.equal(o.flipped, true);
  assert.equal(o.newlyFlagged, true);
  assert.equal(o.flagSignal, "cancelled_fraud");
});

// ── riskSignalsFromRun ───────────────────────────────────────────────────────

test("riskSignalsFromRun: detects 3DS, captcha re-challenge, billing≠shipping, proxy", () => {
  const sigs = riskSignalsFromRun(
    {
      reached3ds: true,
      shopify: { captcha: { detected: ["cloudflare_waf"] } },
      steps: [],
    },
    {
      proxy: "http://u:p@1.2.3.4:9",
      profile: {
        address1: "1 Main St",
        zip: "2000",
        country: "AU",
        billing_address: { address1: "99 Other Rd", zip: "3000", country: "AU" },
      },
    },
  );
  const names = sigs.map((s) => s.signal);
  assert.ok(names.includes("three_ds_stepup"));
  assert.ok(names.includes("captcha_rechallenge"));
  assert.ok(names.includes("billing_shipping_mismatch"));
  assert.ok(names.includes("proxy_used"));
});

// ── correlateFlag ────────────────────────────────────────────────────────────

test("correlateFlag: refund + proxy + billing mismatch → likely causes, medium confidence", () => {
  const c = correlateFlag(
    { flagSignal: "refunded" },
    [
      { signal: "proxy_used" },
      { signal: "billing_shipping_mismatch" },
    ],
  );
  assert.equal(c.flagSignal, "refunded");
  assert.equal(c.confidence, "medium");
  assert.ok(c.likelyCauses.some((x) => /proxy|IP reputation/i.test(x)));
  assert.ok(c.likelyCauses.some((x) => /billing/i.test(x)));
});

test("correlateFlag: no signals → honest 'merchant-side only' note, low confidence", () => {
  const c = correlateFlag({ flagSignal: "cancelled" }, []);
  assert.equal(c.confidence, "low");
  assert.ok(c.likelyCauses.some((x) => /merchant-side/i.test(x)));
});

// ── recordRiskEvent writes a quiet JSONL line ───────────────────────────────

test("recordRiskEvent appends a JSONL line to SHOPIFY_RISK_LOG", () => {
  const tmp = path.join(os.tmpdir(), `risk-test-${Date.now()}.jsonl`);
  const save = process.env.SHOPIFY_RISK_LOG;
  process.env.SHOPIFY_RISK_LOG = tmp;
  try {
    recordRiskEvent("t1", "order_flagged", { flagSignal: "cancelled_fraud" });
    const lines = fs.readFileSync(tmp, "utf8").trim().split("\n");
    assert.equal(lines.length, 1);
    const row = JSON.parse(lines[0]);
    assert.equal(row.taskId, "t1");
    assert.equal(row.event, "order_flagged");
    assert.equal(row.flagSignal, "cancelled_fraud");
  } finally {
    if (save === undefined) delete process.env.SHOPIFY_RISK_LOG;
    else process.env.SHOPIFY_RISK_LOG = save;
    fs.rmSync(tmp, { force: true });
  }
});

// ── pollOrderStatus against a mock store that flips paid → cancelled ────────

test("pollOrderStatus: detects a paid → cancelled-fraud flip and stops", async () => {
  let hits = 0;
  const server = http.createServer((req, res) => {
    hits++;
    res.writeHead(200, { "content-type": "application/json" });
    // First poll: paid. Second+: cancelled for fraud.
    if (hits === 1) res.end(JSON.stringify({ name: "#9001", financial_status: "paid" }));
    else res.end(JSON.stringify({ name: "#9001", cancel_reason: "fraud", cancelled_at: "2026-10-27T00:00:00Z" }));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${server.address().port}/orders/status`;

  const tmp = path.join(os.tmpdir(), `risk-poll-${Date.now()}.jsonl`);
  const save = process.env.SHOPIFY_RISK_LOG;
  process.env.SHOPIFY_RISK_LOG = tmp;

  const dispatcher = makeDispatcher(null, { forceUndici: true });
  const jar = createJar();
  const changes = [];
  try {
    const out = await pollOrderStatus({
      orderStatusUrl: url,
      ctx: { dispatcher, jar },
      taskId: "poll1",
      intervalMs: 1000,
      maxMs: 20000,
      runSignals: [{ signal: "proxy_used" }],
      onChange: (parsed, outcome, correlation) => changes.push({ parsed, outcome, correlation }),
    });
    assert.equal(out.final.flagSignal, "cancelled_fraud");
    // First state (paid) + the flip (cancelled_fraud) both reported.
    assert.ok(changes.length >= 2);
    const flip = changes.find((c) => c.parsed.flagSignal === "cancelled_fraud");
    assert.ok(flip);
    assert.ok(flip.correlation.likelyCauses.some((x) => /proxy|IP reputation/i.test(x)));
  } finally {
    if (save === undefined) delete process.env.SHOPIFY_RISK_LOG;
    else process.env.SHOPIFY_RISK_LOG = save;
    fs.rmSync(tmp, { force: true });
    try {
      await dispatcher.close?.();
    } catch {
      /* ignore */
    }
    await new Promise((r) => server.close(r));
  }
});
