const test = require("node:test");
const assert = require("node:assert/strict");
const {
  classifyBandaiRunResult,
  isSoftPaymentProcessFail,
  isBlocked403,
} = require("./bandai-retry-policy.cjs");

test("403 SoftBlock → rotate", () => {
  const d = classifyBandaiRunResult({
    ok: false,
    failedStep: "login",
    debugError: "SoftBlock RestrictedType",
    lastSteps: [{ step: "login", ok: false, status: 403, note: "SoftBlock" }],
  });
  assert.equal(d.action, "rotate");
  assert.equal(d.liveLabel, "Rotating proxy");
  assert.equal(isBlocked403({
    ok: false,
    failedStep: "login",
    debugError: "SoftBlock",
  }), true);
});

test("soft payment process fail → retry pay", () => {
  const res = {
    ok: false,
    failedStep: "ge_payment",
    debugError: "failed to process payment — try again",
    cartSn: 1,
    cartItemSn: 2,
    heldPayRetry: true,
    heldCart: { cartSn: 1, cartItemSn: 2 },
  };
  assert.equal(isSoftPaymentProcessFail(res), true);
  const d = classifyBandaiRunResult(res);
  assert.equal(d.action, "retry");
  assert.equal(d.retryPay, true);
  assert.equal(d.liveLabel, "Retrying pay");
});

test("ProductInfoChanged on stale cart → retry ATC (not pay)", () => {
  const res = {
    ok: false,
    failedStep: "ge_get_cart_token",
    checkoutStage: "tokenize",
    paymentStatus: "ge_token_failed",
    debugError: "CouldNotOrderByProductInfoChanged",
    cartSn: 72846608,
    cartItemSn: 15609155,
    heldPayRetry: true,
    heldCart: { cartSn: 72846608, cartItemSn: 15609155, areaItemNo: "NAI0873518AU" },
    lastSteps: [
      {
        step: "cart_checkout",
        ok: false,
        note: "CouldNotOrderByProductInfoChanged",
      },
      {
        step: "ge_get_cart_token",
        ok: false,
        note: "We are sorry we could not process your request",
      },
    ],
  };
  assert.equal(isSoftPaymentProcessFail(res), false);
  const d = classifyBandaiRunResult(res);
  assert.equal(d.action, "retry");
  assert.equal(d.retryPay, false);
  assert.equal(d.clearHeldCart, true);
  assert.equal(d.liveLabel, "Retrying ATC");
});

test("hard decline → stop", () => {
  const d = classifyBandaiRunResult({
    ok: false,
    failedStep: "ge_payment",
    debugError: "do not honor / declined",
    paymentStatus: "declined",
  });
  assert.equal(d.action, "stop");
  assert.match(d.liveLabel, /declined|Payment declined/i);
});

test("RESPONSE_LOST / pay already submitted → stop (no second charge)", () => {
  const d = classifyBandaiRunResult({
    ok: false,
    paymentStatus: "pay_submitted_no_response",
    checkoutStage: "tokenize",
    chargeReqCount: 1,
    responseLost: true,
    debugError: "RESPONSE_LOST posts=1 — check bank",
    note: "HTTP issuer POST in-flight/sent but response lost",
  });
  assert.equal(d.action, "stop");
  assert.equal(d.reason, "pay_already_submitted");
  assert.notEqual(d.retryPay, true);
});

test("stop_before_issuer / http_ge_hydrated → stop (no soft-retry loop)", () => {
  const res = {
    ok: false,
    failedStep: "ge_http_stop",
    paymentStatus: "http_ge_hydrated",
    paymentAttempted: false,
    chargeReqCount: null,
    error: "stop_before_issuer",
    note: "HTTP GE hydrated guid=…",
  };
  assert.equal(isSoftPaymentProcessFail(res), false);
  const d = classifyBandaiRunResult(res);
  assert.equal(d.action, "stop");
  assert.notEqual(d.retryPay, true);
});

test("issuer_http_failed + chargeReqCount>=1 → stop (not soft retry pay)", () => {
  const res = {
    ok: false,
    failedStep: "ge_payment",
    paymentStatus: "issuer_http_failed",
    chargeReqCount: 1,
    undiciAttempts: 1,
    debugError: "timeout / fetch failed / ECONNRESET",
  };
  assert.equal(isSoftPaymentProcessFail(res), false);
  const d = classifyBandaiRunResult(res);
  assert.equal(d.action, "stop");
  assert.equal(d.reason, "pay_already_submitted");
});

test("sibling task same profile still soft-retries when it has not paid", () => {
  // Simulate: task A latched; task B (same profileId) still soft-fails pre-pay.
  classifyBandaiRunResult({
    ok: false,
    taskId: "a",
    profileId: "p1",
    chargeReqCount: 1,
    responseLost: true,
    paymentStatus: "pay_submitted_no_response",
  });
  const sibling = {
    ok: false,
    taskId: "b",
    profileId: "p1",
    failedStep: "ge_payment",
    debugError: "failed to process payment — try again",
    cartSn: 1,
    heldPayRetry: true,
    heldCart: { cartSn: 1, cartItemSn: 2 },
  };
  assert.equal(isSoftPaymentProcessFail(sibling), true);
  const d = classifyBandaiRunResult(sibling);
  assert.equal(d.action, "retry");
  assert.equal(d.retryPay, true);
});

test("OOS → wait_restock", () => {
  const d = classifyBandaiRunResult(
    {
      ok: false,
      failedStep: "addToCart",
      debugError: "CouldNotAddToCartBySoldOut",
      lastSteps: [{ step: "addToCart", ok: false, note: "SoldOut" }],
    },
    { mode: "checkout" },
  );
  assert.equal(d.action, "wait_restock");
  assert.match(d.liveLabel, /waiting|Out of stock/i);
});

test("EndOfSale on checkout → stop", () => {
  const d = classifyBandaiRunResult(
    {
      ok: false,
      failedStep: "addToCart",
      debugError: "CouldNotAddToCartByEndOfSale cart=[]",
      lastSteps: [{ step: "addToCart", ok: false, note: "CouldNotAddToCartByEndOfSale cart=[]" }],
    },
    { mode: "checkout" },
  );
  assert.equal(d.action, "stop");
  assert.equal(d.consumerCode, "oos");
});

test("EndOfSale on monitor → wait_restock", () => {
  const d = classifyBandaiRunResult(
    {
      ok: false,
      failedStep: "addToCart",
      debugError: "CouldNotAddToCartByEndOfSale cart=[]",
      lastSteps: [{ step: "addToCart", ok: false, note: "CouldNotAddToCartByEndOfSale cart=[]" }],
    },
    { mode: "monitor" },
  );
  assert.equal(d.action, "wait_restock");
});

test("held cart empty is not ProductInfoChanged stale-cart ATC", () => {
  const { isStaleCartProductChanged } = require("./bandai-retry-policy.cjs");
  assert.equal(
    isStaleCartProductChanged({
      ok: false,
      failedStep: "held_cart_verify",
      error: "held cart empty for [N123] cart=[]",
      heldCartGone: true,
    }),
    false,
  );
});

test("success → stop", () => {
  const d = classifyBandaiRunResult({ ok: true, orderNumber: "X1" });
  assert.equal(d.action, "stop");
});

test("bad password → stop", () => {
  const d = classifyBandaiRunResult({
    ok: false,
    failedStep: "login",
    debugError: "invalid password",
  });
  assert.equal(d.action, "stop");
  assert.equal(d.liveLabel, "Login failed");
});

test("ATC NETWORK CONGESTION → retry (keep trying while stock)", () => {
  const d = classifyBandaiRunResult({
    ok: false,
    failedStep: "addToCart",
    debugError: "NETWORK CONGESTION — PAGE NOT AVAILABLE",
    lastSteps: [{ step: "addToCart", ok: false, note: "NETWORK CONGESTION" }],
  });
  assert.equal(d.action, "retry");
  assert.equal(d.reason, "atc_soft");
});

test("soft pay retry_exhausted → rotate (not stop)", () => {
  const d = classifyBandaiRunResult(
    {
      ok: false,
      failedStep: "ge_payment",
      debugError: "failed to process payment — try again",
      cartSn: 1,
      heldPayRetry: true,
      heldCart: { cartSn: 1, cartItemSn: 2 },
    },
    { retryCount: 40, maxRetry: 40 },
  );
  assert.equal(d.action, "rotate");
  assert.equal(d.reason, "soft_payment_escalate");
});

test("unknown failure after rotate budget → retry (not stop)", () => {
  const d = classifyBandaiRunResult(
    {
      ok: false,
      failedStep: "mystery",
      debugError: "something odd happened",
    },
    { rotateCount: 48, maxRotate: 48 },
  );
  assert.equal(d.action, "retry");
  assert.equal(d.reason, "unknown_retry");
});

test("f5_bridge hang/timeout → rotate immediately", () => {
  const d = classifyBandaiRunResult({
    ok: false,
    failedStep: "f5_bridge",
    error: "f5_bridge timed out after 10000ms",
    debugError: "f5_bridge timed out after 10000ms",
  });
  assert.equal(d.action, "rotate");
  assert.equal(d.reason, "f5_bridge");
  assert.equal(d.liveLabel, "Rotating proxy");
});
