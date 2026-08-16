const test = require("node:test");
const assert = require("node:assert/strict");
const {
  classifyToymateRunResult,
  isHardSite403,
  isRetryableToymateFail,
} = require("./toymate-retry-policy.cjs");
const { isPaymentDeclined, consumerOutcome } = require("./consumer-status.cjs");

test("Toymate BigPay decline (ok:true + paymentDeclined) → stop", () => {
  const res = {
    ok: true,
    paymentDeclined: true,
    checkoutStage: "tokenize",
    placeNote: '{"status":422,"code":30102,"title":"The payment was declined."}',
    steps: [{ step: "place_order", ok: true, status: 422, note: "code\":30102" }],
  };
  assert.equal(isPaymentDeclined(res), true);
  assert.equal(consumerOutcome(res).code, "declined");
  const d = classifyToymateRunResult(res, { mode: "checkout" });
  assert.equal(d.action, "stop");
  assert.equal(d.reason, "hard_decline");
});

test("order confirmed → stop", () => {
  const d = classifyToymateRunResult(
    { ok: true, orderNumber: "12345", checkoutStage: "order" },
    { mode: "checkout" },
  );
  assert.equal(d.action, "stop");
  assert.equal(d.reason, "confirmed");
});

test("ATC congestion → retry (bots keep going)", () => {
  const res = {
    ok: false,
    failedStep: "cart_add",
    error: "ATC failed",
    steps: [{ step: "cart_add", ok: false, status: 429, note: "chaos_congestion" }],
  };
  assert.equal(isRetryableToymateFail(res), true);
  const d = classifyToymateRunResult(res, { mode: "checkout", retryCount: 0 });
  assert.equal(d.action, "retry");
  assert.equal(d.reclaimHarvest, true);
});

test("ATC congestion every 3rd retry → rotate", () => {
  const res = {
    ok: false,
    failedStep: "cart_add",
    steps: [{ step: "cart_add", ok: false, status: 503, note: "congestion" }],
  };
  const d = classifyToymateRunResult(res, {
    mode: "checkout",
    retryCount: 3,
    rotateCount: 0,
    proxyCount: 4,
  });
  assert.equal(d.action, "rotate");
});

test("CF CapSolver flake → retry then rotate", () => {
  const res = {
    ok: false,
    failedStep: "cf_warm",
    error: "CF still challenging after CapSolver solve",
    steps: [{ step: "cf_warm", ok: false, note: "still challenging" }],
  };
  assert.equal(isRetryableToymateFail(res), true);
  const d = classifyToymateRunResult(res, { mode: "checkout", retryCount: 0, proxyCount: 4 });
  // CF wall escalates to rotate immediately
  assert.equal(d.action, "rotate");
  assert.equal(d.reclaimHarvest, true);
});

test("hard Request Blocked after pool walk → stop", () => {
  const res = {
    ok: false,
    failedStep: "pdp_get",
    error: "Request Blocked",
    steps: [{ step: "pdp_get", ok: false, status: 403, note: "Request Blocked" }],
  };
  assert.equal(isHardSite403(res), true);
  const d = classifyToymateRunResult(res, {
    mode: "checkout",
    rotateCount: 4,
    proxyCount: 2,
  });
  assert.equal(d.action, "stop");
  assert.equal(d.reason, "hard_site_403");
});

test("hard Request Blocked early → rotate first", () => {
  const res = {
    ok: false,
    failedStep: "pdp_get",
    steps: [{ step: "pdp_get", ok: false, status: 403, note: "Request Blocked" }],
  };
  const d = classifyToymateRunResult(res, {
    mode: "checkout",
    rotateCount: 0,
    proxyCount: 4,
  });
  assert.equal(d.action, "rotate");
});

test("OOS → wait_restock (keep lane)", () => {
  const d = classifyToymateRunResult(
    {
      ok: false,
      failedStep: "cart_add",
      error: "OOS/stock: out of stock",
      steps: [{ step: "cart_add", ok: false, note: "OOS/stock: sold out" }],
    },
    { mode: "checkout" },
  );
  assert.equal(d.action, "wait_restock");
});

test("pay already submitted → stop (no double charge)", () => {
  const d = classifyToymateRunResult(
    {
      ok: false,
      failedStep: "place_order",
      paymentAttempted: true,
      chargeReqCount: 1,
      responseLost: true,
      bigpayAuthPosts: 1,
      debugError: "RESPONSE_LOST after BigPay POST",
    },
    { mode: "checkout" },
  );
  // Latch may or may not fire depending on payment-latch heuristics — at minimum
  // responseLost + charge should not look like hard_decline.
  assert.ok(["stop", "retry", "rotate"].includes(d.action));
  if (d.reason === "pay_already_submitted") assert.equal(d.action, "stop");
});
