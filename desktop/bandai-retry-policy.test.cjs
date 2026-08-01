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
