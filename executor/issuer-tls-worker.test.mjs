// node --test executor/issuer-tls-worker.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { shouldUseIssuerTlsWorker, payTlsWorkerCacheKey } from "./http.js";

test("issuer tls-worker: GE HandleCreditCard POST is on by default", () => {
  const prev = process.env.PAY_ISSUER_TLS_WORKER;
  const prevPay = process.env.PAY_PAYHOST_TLS_WORKER;
  delete process.env.PAY_ISSUER_TLS_WORKER;
  delete process.env.PAY_PAYHOST_TLS_WORKER;
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
    if (prevPay === undefined) delete process.env.PAY_PAYHOST_TLS_WORKER;
    else process.env.PAY_PAYHOST_TLS_WORKER = prevPay;
  }
});

test("payHost tls-worker: non-GE prepay uses PAY_PAYHOST_TLS_WORKER", () => {
  const prev = process.env.PAY_ISSUER_TLS_WORKER;
  const prevPay = process.env.PAY_PAYHOST_TLS_WORKER;
  const prevGe = process.env.PAY_GE_TLS_WORKER;
  delete process.env.PAY_ISSUER_TLS_WORKER;
  delete process.env.PAY_PAYHOST_TLS_WORKER;
  process.env.PAY_GE_TLS_WORKER = "0";
  try {
    // With GE-all off, GE prepay POST still follows PAY_PAYHOST_TLS_WORKER.
    assert.equal(
      shouldUseIssuerTlsWorker(
        "https://webservices.global-e.com/checkoutv2/handleaction/1/guid/8urc",
        "POST",
      ),
      true,
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
    if (prevPay === undefined) delete process.env.PAY_PAYHOST_TLS_WORKER;
    else process.env.PAY_PAYHOST_TLS_WORKER = prevPay;
    if (prevGe === undefined) delete process.env.PAY_GE_TLS_WORKER;
    else process.env.PAY_GE_TLS_WORKER = prevGe;
  }
});

test("payHost tls-worker: PAY_PAYHOST_TLS_WORKER=0 keeps GE prepay undici when GE-all off", () => {
  const prev = process.env.PAY_ISSUER_TLS_WORKER;
  const prevPay = process.env.PAY_PAYHOST_TLS_WORKER;
  const prevGe = process.env.PAY_GE_TLS_WORKER;
  delete process.env.PAY_ISSUER_TLS_WORKER;
  process.env.PAY_PAYHOST_TLS_WORKER = "0";
  process.env.PAY_GE_TLS_WORKER = "0";
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
        "https://secure-bandai.global-e.com/1/Payments/HandleCreditCardRequestV2/8urc/guid",
        "POST",
      ),
      true,
    );
  } finally {
    if (prev === undefined) delete process.env.PAY_ISSUER_TLS_WORKER;
    else process.env.PAY_ISSUER_TLS_WORKER = prev;
    if (prevPay === undefined) delete process.env.PAY_PAYHOST_TLS_WORKER;
    else process.env.PAY_PAYHOST_TLS_WORKER = prevPay;
    if (prevGe === undefined) delete process.env.PAY_GE_TLS_WORKER;
    else process.env.PAY_GE_TLS_WORKER = prevGe;
  }
});

test("issuer tls-worker: PAY_ISSUER_TLS_WORKER=0 opts out (non-GE)", () => {
  const prev = process.env.PAY_ISSUER_TLS_WORKER;
  const prevPay = process.env.PAY_PAYHOST_TLS_WORKER;
  const prevGe = process.env.PAY_GE_TLS_WORKER;
  process.env.PAY_ISSUER_TLS_WORKER = "0";
  delete process.env.PAY_PAYHOST_TLS_WORKER;
  process.env.PAY_GE_TLS_WORKER = "0";
  try {
    assert.equal(
      shouldUseIssuerTlsWorker(
        "https://payments.bigcommerce.com/stores/x/payments",
        "POST",
      ),
      false,
    );
  } finally {
    if (prev === undefined) delete process.env.PAY_ISSUER_TLS_WORKER;
    else process.env.PAY_ISSUER_TLS_WORKER = prev;
    if (prevPay === undefined) delete process.env.PAY_PAYHOST_TLS_WORKER;
    else process.env.PAY_PAYHOST_TLS_WORKER = prevPay;
    if (prevGe === undefined) delete process.env.PAY_GE_TLS_WORKER;
    else process.env.PAY_GE_TLS_WORKER = prevGe;
  }
});

test("GE tls-worker: GetCartToken GET off by default (CCForm uses issuer tls)", () => {
  const prevGe = process.env.PAY_GE_TLS_WORKER;
  const prevCc = process.env.PAY_ISSUER_CCFORM_TLS;
  delete process.env.PAY_GE_TLS_WORKER;
  process.env.PAY_ISSUER_CCFORM_TLS = "0";
  try {
    assert.equal(
      shouldUseIssuerTlsWorker(
        "https://secure-bandai.global-e.com/payments/CreditCardForm/guid/2",
        "GET",
      ),
      false,
    );
    assert.equal(
      shouldUseIssuerTlsWorker(
        "https://gepi.global-e.com/Checkout/GetCartToken?x=1",
        "GET",
      ),
      false,
    );
  } finally {
    if (prevGe === undefined) delete process.env.PAY_GE_TLS_WORKER;
    else process.env.PAY_GE_TLS_WORKER = prevGe;
    if (prevCc === undefined) delete process.env.PAY_ISSUER_CCFORM_TLS;
    else process.env.PAY_ISSUER_CCFORM_TLS = prevCc;
  }
});

test("GE tls-worker: PAY_GE_TLS_WORKER=1 opts all GE hops incl GET", () => {
  const prevGe = process.env.PAY_GE_TLS_WORKER;
  const prevPay = process.env.PAY_PAYHOST_TLS_WORKER;
  process.env.PAY_GE_TLS_WORKER = "1";
  delete process.env.PAY_PAYHOST_TLS_WORKER;
  try {
    assert.equal(
      shouldUseIssuerTlsWorker(
        "https://secure-bandai.global-e.com/payments/CreditCardForm/guid/2",
        "GET",
      ),
      true,
    );
    assert.equal(
      shouldUseIssuerTlsWorker(
        "https://webservices.global-e.com/checkoutv2/save",
        "POST",
      ),
      true,
    );
  } finally {
    if (prevGe === undefined) delete process.env.PAY_GE_TLS_WORKER;
    else process.env.PAY_GE_TLS_WORKER = prevGe;
    if (prevPay === undefined) delete process.env.PAY_PAYHOST_TLS_WORKER;
    else process.env.PAY_PAYHOST_TLS_WORKER = prevPay;
  }
});

test("CreditCardForm GET uses issuer tls-worker by default", () => {
  const prev = process.env.PAY_ISSUER_TLS_WORKER;
  const prevCc = process.env.PAY_ISSUER_CCFORM_TLS;
  const prevGe = process.env.PAY_GE_TLS_WORKER;
  delete process.env.PAY_ISSUER_TLS_WORKER;
  delete process.env.PAY_ISSUER_CCFORM_TLS;
  delete process.env.PAY_GE_TLS_WORKER;
  try {
    assert.equal(
      shouldUseIssuerTlsWorker(
        "https://secure-bandai.global-e.com/payments/CreditCardForm/guid/2",
        "GET",
      ),
      true,
    );
    process.env.PAY_ISSUER_CCFORM_TLS = "0";
    assert.equal(
      shouldUseIssuerTlsWorker(
        "https://secure-bandai.global-e.com/payments/CreditCardForm/guid/2",
        "GET",
      ),
      false,
    );
  } finally {
    if (prev === undefined) delete process.env.PAY_ISSUER_TLS_WORKER;
    else process.env.PAY_ISSUER_TLS_WORKER = prev;
    if (prevCc === undefined) delete process.env.PAY_ISSUER_CCFORM_TLS;
    else process.env.PAY_ISSUER_CCFORM_TLS = prevCc;
    if (prevGe === undefined) delete process.env.PAY_GE_TLS_WORKER;
    else process.env.PAY_GE_TLS_WORKER = prevGe;
  }
});

test("cold issuer tls: separate cache keys by default; shared when =0", () => {
  const prev = process.env.PAY_ISSUER_COLD_TLS;
  delete process.env.PAY_ISSUER_COLD_TLS;
  try {
    assert.equal(payTlsWorkerCacheKey("prepay"), "_prepayRemoteTls");
    assert.equal(payTlsWorkerCacheKey("issuer"), "_issuerRemoteTls");
    process.env.PAY_ISSUER_COLD_TLS = "0";
    assert.equal(payTlsWorkerCacheKey("prepay"), "_issuerRemoteTls");
    assert.equal(payTlsWorkerCacheKey("issuer"), "_issuerRemoteTls");
  } finally {
    if (prev === undefined) delete process.env.PAY_ISSUER_COLD_TLS;
    else process.env.PAY_ISSUER_COLD_TLS = prev;
  }
});
