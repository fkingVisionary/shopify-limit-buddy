// node --test executor/pay-forensics-angles.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import {
  classifyPayWireStage,
  redirectFanoutFields,
} from "./pay-forensics.js";

test("angle B: GE handleaction is prepay, HandleCreditCard is issuer", () => {
  assert.equal(
    classifyPayWireStage(
      "webservices.global-e.com",
      "/checkoutv2/handleaction/1/guid/8urc",
    ),
    "prepay",
  );
  assert.equal(
    classifyPayWireStage(
      "webservices.global-e.com",
      "/checkoutv2/save",
    ),
    "prepay",
  );
  assert.equal(
    classifyPayWireStage(
      "secure-bandai.global-e.com",
      "/1/Payments/HandleCreditCardRequestV2/8urc/guid",
    ),
    "issuer",
  );
  assert.equal(
    classifyPayWireStage("payments.bigcommerce.com", "/stores/x/payments"),
    "issuer",
  );
});

test("angle A: redirect fan-out extracts GE transaction id", () => {
  const f = redirectFanoutFields(
    "https://webservices.global-e.com/payments/CCPaymentRedirect?Data=x",
    { TransactionId: "172445269", StatusType: "1", ErrorCode: "0" },
  );
  assert.equal(f.isPaymentRedirect, true);
  assert.equal(f.locationLooksAcs, true);
  assert.equal(f.transactionId, "172445269");
  assert.equal(f.statusType, "1");
  assert.equal(f.redirectHost, "webservices.global-e.com");
});

test("angle A: GE Key/Value JWT array flattens to transactionId", () => {
  const f = redirectFanoutFields(
    "https://webservices.global-e.com/payments/CCPaymentRedirect?Data=eyJ",
    [
      { Key: "TransactionId", Value: "172447213" },
      { Key: "TransactionStatusType", Value: "AutherizationFailed" },
      { Key: "RedirectErrorType", Value: "PaymentAuthenticationFailed" },
    ],
  );
  assert.equal(f.transactionId, "172447213");
  assert.equal(f.statusType, "AutherizationFailed");
});
