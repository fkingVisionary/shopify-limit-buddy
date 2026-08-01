import test from "node:test";
import assert from "node:assert/strict";
import {
  isHardPaymentDecline,
  isHeldPayRetryEligible,
  payWindowRemainingMs,
  payWindowExpired,
  buildHeldCartSnapshot,
  withHeldCartMeta,
  shouldShowRetryPay,
  retryPayHint,
  BANDAI_PAY_WINDOW_MS,
} from "./bandai-held-cart.js";

test("hard decline is never held-pay-retry eligible (cart cleared server-side)", () => {
  assert.equal(isHeldPayRetryEligible({ ok: false, checkoutStage: "declined" }), false);
  assert.equal(
    isHeldPayRetryEligible({
      ok: false,
      cartSn: 1,
      cartItemSn: 2,
      paymentStatus: "declined_or_auth_failed",
      checkoutStage: "declined",
    }),
    false,
  );
  assert.equal(
    isHardPaymentDecline({
      ok: false,
      cartSn: 1,
      cartItemSn: 2,
      paymentStatus: "declined_or_auth_failed",
      checkoutStage: "declined",
    }),
    true,
  );
  assert.equal(
    isHeldPayRetryEligible({
      ok: true,
      cartSn: 1,
      cartItemSn: 2,
      paymentStatus: "declined_or_auth_failed",
    }),
    false,
  );
  assert.equal(
    isHeldPayRetryEligible({
      ok: false,
      cartSn: 1,
      cartItemSn: 2,
      heldCartGone: true,
      paymentStatus: "declined_or_auth_failed",
    }),
    false,
  );
});

test("soft tokenize fail with cart ids stays retry-eligible", () => {
  assert.equal(
    isHeldPayRetryEligible({
      ok: false,
      cartSn: 1,
      cartItemSn: 2,
      paymentStatus: "ge_reload_only_no_bank",
      checkoutStage: "tokenize",
      failedStep: "ge_issuer_http",
    }),
    true,
  );
});

test("pay window remaining / expired", () => {
  const now = 2_000_000_000_000; // far from epoch so holdAt stays positive
  assert.equal(payWindowRemainingMs(now - 5 * 60_000, now), BANDAI_PAY_WINDOW_MS - 5 * 60_000);
  assert.equal(payWindowExpired(now - BANDAI_PAY_WINDOW_MS - 1, now), true);
  assert.equal(payWindowExpired(now - 60_000, now), false);
  assert.equal(payWindowRemainingMs(null, now), null);
});

test("withHeldCartMeta clears hold on hard decline", () => {
  const out = withHeldCartMeta(
    {
      ok: false,
      cartSn: 99,
      cartId: "abc",
      cartItemSn: 12,
      areaItemNo: "NAI0868879AU",
      paymentStatus: "declined_or_auth_failed",
      checkoutStage: "declined",
    },
    1_700_000_000_000,
  );
  assert.equal(out.heldPayRetry, false);
  assert.equal(out.heldCart, null);
});

test("withHeldCartMeta attaches snapshot on soft pay fail", () => {
  const out = withHeldCartMeta(
    {
      ok: false,
      cartSn: 99,
      cartId: "abc",
      cartItemSn: 12,
      areaItemNo: "NAI0868879AU",
      paymentStatus: "ge_reload_only_no_bank",
      checkoutStage: "tokenize",
      failedStep: "ge_issuer_http",
    },
    1_700_000_000_000,
  );
  assert.equal(out.heldPayRetry, true);
  assert.equal(out.heldCart.cartSn, 99);
  assert.equal(out.heldCart.areaItemNo, "NAI0868879AU");
  assert.equal(out.heldCart.cartHoldAt, 1_700_000_000_000);
});

test("buildHeldCartSnapshot + retry UI helpers", () => {
  const snap = buildHeldCartSnapshot({
    ok: false,
    cartSn: 1,
    cartItemSn: 2,
    paymentStatus: "ge_reload_only_no_bank",
    checkoutStage: "tokenize",
  });
  assert.ok(snap);
  assert.equal(shouldShowRetryPay({ heldCart: snap }), true);
  assert.equal(shouldShowRetryPay({}), false);
  const hint = retryPayHint({ heldCart: { ...snap, cartHoldAt: Date.now() - 60_000 } });
  assert.match(hint, /Cart held/);
});
