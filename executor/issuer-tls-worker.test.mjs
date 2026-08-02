// node --test executor/issuer-tls-worker.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { shouldUseIssuerTlsWorker } from "./http.js";

test("issuer tls-worker: GE HandleCreditCard POST is on by default", () => {
  const prev = process.env.PAY_ISSUER_TLS_WORKER;
  delete process.env.PAY_ISSUER_TLS_WORKER;
  try {
    assert.equal(
      shouldUseIssuerTlsWorker(
        "https://secure-bandai.global-e.com/1/Payments/HandleCreditCardRequestV2/8urc/guid",
        "POST",
      ),
      true,
    );
    assert.equal(
      shouldUseIssuerTlsWorker(
        "https://payments.bigcommerce.com/stores/x/payments",
        "POST",
      ),
      true,
    );
  } finally {
    if (prev === undefined) delete process.env.PAY_ISSUER_TLS_WORKER;
    else process.env.PAY_ISSUER_TLS_WORKER = prev;
  }
});

test("issuer tls-worker: prepay GE mutates stay on task undici", () => {
  const prev = process.env.PAY_ISSUER_TLS_WORKER;
  delete process.env.PAY_ISSUER_TLS_WORKER;
  try {
    assert.equal(
      shouldUseIssuerTlsWorker(
        "https://webservices.global-e.com/checkoutv2/handleaction/1/guid/8urc",
        "POST",
      ),
      false,
    );
    assert.equal(
      shouldUseIssuerTlsWorker(
        "https://webservices.global-e.com/checkoutv2/save",
        "POST",
      ),
      false,
    );
    assert.equal(
      shouldUseIssuerTlsWorker(
        "https://secure-bandai.global-e.com/1/Payments/HandleCreditCardRequestV2/x/y",
        "GET",
      ),
      false,
    );
  } finally {
    if (prev === undefined) delete process.env.PAY_ISSUER_TLS_WORKER;
    else process.env.PAY_ISSUER_TLS_WORKER = prev;
  }
});

test("issuer tls-worker: PAY_ISSUER_TLS_WORKER=0 opts out", () => {
  const prev = process.env.PAY_ISSUER_TLS_WORKER;
  process.env.PAY_ISSUER_TLS_WORKER = "0";
  try {
    assert.equal(
      shouldUseIssuerTlsWorker(
        "https://secure-bandai.global-e.com/1/Payments/HandleCreditCardRequestV2/8urc/guid",
        "POST",
      ),
      false,
    );
  } finally {
    if (prev === undefined) delete process.env.PAY_ISSUER_TLS_WORKER;
    else process.env.PAY_ISSUER_TLS_WORKER = prev;
  }
});
