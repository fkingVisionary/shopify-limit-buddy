// node --test desktop/consumer-status.held.test.cjs
const { test } = require("node:test");
const assert = require("node:assert/strict");
const {
  consumerOutcome,
  isHeldPayRetry,
  isHeldCartGone,
  OUTCOME,
} = require("./consumer-status.cjs");

test("held pay retry preferred over plain declined when cart ids present", () => {
  const res = {
    ok: false,
    cartSn: 99,
    cartItemSn: 12,
    paymentStatus: "declined_or_auth_failed",
    checkoutStage: "declined",
    heldPayRetry: true,
    heldCart: { cartSn: 99, cartItemSn: 12 },
  };
  assert.equal(isHeldPayRetry(res), true);
  const out = consumerOutcome(res);
  assert.equal(out.code, "held_pay_retry");
  assert.equal(out.label, OUTCOME.held_pay_retry);
});

test("held cart gone maps to expired label", () => {
  const res = {
    ok: false,
    heldCartGone: true,
    checkoutStage: "held_cart_gone",
    failedStep: "held_cart_verify",
  };
  assert.equal(isHeldCartGone(res), true);
  assert.equal(consumerOutcome(res).code, "held_cart_gone");
});

test("decline without cart ids stays declined", () => {
  const res = {
    ok: false,
    paymentStatus: "declined_or_auth_failed",
    checkoutStage: "declined",
    error: "card declined",
  };
  assert.equal(isHeldPayRetry(res), false);
  assert.equal(consumerOutcome(res).code, "declined");
});

test("ATC-only success maps to cart_held", () => {
  const out = consumerOutcome({
    ok: true,
    atcOnly: true,
    checkoutStage: "cart_hold",
    heldPayRetry: true,
    heldCart: { cartSn: 1, cartItemSn: 2 },
  });
  assert.equal(out.code, "cart_held");
  assert.equal(out.label, OUTCOME.cart_held);
});

test("checkout_address preferred over held_pay_retry", () => {
  const out = consumerOutcome({
    ok: false,
    failedStep: "checkout_address",
    cartSn: 99,
    cartItemSn: 12,
    heldPayRetry: true,
    heldCart: { cartSn: 99, cartItemSn: 12 },
    error: 'BillingMandatory BillingFirstName',
    checkoutStage: "tokenize",
  });
  assert.equal(out.code, "checkout_address");
  assert.equal(out.label, OUTCOME.checkout_address);
});
