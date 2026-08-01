const test = require("node:test");
const assert = require("node:assert/strict");
const {
  isPaymentAlreadySubmitted,
  paymentPostCount,
  withPaymentLatchFields,
} = require("./payment-latch.cjs");

test("chargeReqCount>=1 alone latches (no paymentStatus required)", () => {
  assert.equal(
    isPaymentAlreadySubmitted({
      ok: false,
      failedStep: "ge_payment",
      paymentStatus: "issuer_http_failed",
      chargeReqCount: 1,
      debugError: "timeout / fetch failed",
    }),
    true,
  );
});

test("undiciAttempts / bigpayAuthPosts latch", () => {
  assert.equal(
    isPaymentAlreadySubmitted({ ok: false, undiciAttempts: 1, paymentStatus: "x" }),
    true,
  );
  assert.equal(
    isPaymentAlreadySubmitted({ ok: false, bigpayAuthPosts: 1 }),
    true,
  );
  assert.equal(paymentPostCount({ pay: { undiciAttempts: 2 } }), 2);
});

test("responseLost / paymentAttempted latch", () => {
  assert.equal(isPaymentAlreadySubmitted({ ok: false, responseLost: true }), true);
  assert.equal(isPaymentAlreadySubmitted({ ok: false, paymentAttempted: true }), true);
  assert.equal(
    isPaymentAlreadySubmitted({ ok: false, pay: { responseLost: true } }),
    true,
  );
});

test("soft process fail without posts does not latch", () => {
  assert.equal(
    isPaymentAlreadySubmitted({
      ok: false,
      failedStep: "ge_payment",
      debugError: "failed to process payment — try again",
      chargeReqCount: 0,
    }),
    false,
  );
});

test("withPaymentLatchFields stamps paymentAttempted", () => {
  const out = withPaymentLatchFields({
    ok: false,
    chargeReqCount: 1,
    paymentStatus: "issuer_http_failed",
  });
  assert.equal(out.paymentAttempted, true);
  assert.equal(out.chargeReqCount, 1);
});

test("ok results never latch", () => {
  assert.equal(isPaymentAlreadySubmitted({ ok: true, chargeReqCount: 1 }), false);
});
