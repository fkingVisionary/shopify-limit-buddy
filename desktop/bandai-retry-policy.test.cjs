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
