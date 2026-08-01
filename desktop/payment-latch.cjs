// Cross-store payment latch — stop outer retries after any issuer/PSP POST
// has left the client. Bandai / Disney / PKC / Toymate all double-charged
// Revolut when RESPONSE_LOST / tunnel death re-entered placeOrder.
//
// Rule: once the wire was touched, bank may have moved. Never soft-retry pay
// or sticky-rotate a full /run with placeOrder still true.

function resultBlob(res) {
  return [
    res?.debugError,
    res?.error,
    res?.failedStep,
    res?.checkoutStage,
    res?.paymentStatus,
    res?.note,
    ...(res?.lastSteps || []).map((s) => `${s.step} ${s.status ?? ""} ${s.note || ""}`),
  ]
    .filter(Boolean)
    .join("\n");
}

/**
 * Count issuer/PSP POSTs already attempted (any store).
 * Prefer explicit counters; fall back to nested pay blobs.
 */
function paymentPostCount(res) {
  if (!res || typeof res !== "object") return 0;
  const direct = [
    res.chargeReqCount,
    res.undiciAttempts,
    res.bigpayAuthPosts,
    res.pay?.chargeReqCount,
    res.pay?.undiciAttempts,
    res.pay?.issuer?.undiciAttempts,
  ]
    .map((n) => Number(n))
    .filter((n) => Number.isFinite(n) && n > 0);
  if (direct.length) return Math.max(...direct);
  return 0;
}

/**
 * True when an issuer/BigPay POST already left the client (or we cannot prove
 * it did not). Outer desktop retry / sticky rotate must STOP.
 */
function isPaymentAlreadySubmitted(res) {
  if (!res || res.ok) return false;
  if (res.paymentAttempted === true || res.pay?.paymentAttempted === true) return true;
  if (res.responseLost === true || res.pay?.responseLost === true) return true;
  if (res.pay?.issuer?.responseLost === true) return true;

  const posts = paymentPostCount(res);
  // Any wire touch ≥1 is enough — do not require a specific paymentStatus.
  // Prior Bandai-only latch missed issuer_http_failed + chargeReqCount=1 and
  // soft-retried pay into a second Revolut auth.
  if (posts >= 1) return true;

  const ps = String(res.paymentStatus || res.pay?.paymentStatus || "");
  if (/pay_submitted|response_lost|issuer_response_lost|pay_attempted/i.test(ps)) {
    return true;
  }

  const blob = resultBlob(res);
  return /RESPONSE_LOST|pay_submitted_no_response|issuer_response_lost|POST in-flight\/sent|bank may (still )?have moved/i.test(
    blob,
  );
}

/**
 * Annotate a finishResult-shaped object with latch fields for desktop consumers.
 */
function withPaymentLatchFields(res, extras = {}) {
  if (!res || typeof res !== "object") return res;
  const posts = paymentPostCount({ ...res, ...extras });
  const responseLost = Boolean(
    extras.responseLost ?? res.responseLost ?? res.pay?.responseLost,
  );
  const paymentAttempted = Boolean(
    extras.paymentAttempted === true ||
      res.paymentAttempted === true ||
      posts >= 1 ||
      responseLost ||
      isPaymentAlreadySubmitted(res),
  );
  return {
    ...res,
    chargeReqCount: extras.chargeReqCount ?? res.chargeReqCount ?? (posts || null),
    undiciAttempts: extras.undiciAttempts ?? res.undiciAttempts ?? null,
    bigpayAuthPosts: extras.bigpayAuthPosts ?? res.bigpayAuthPosts ?? null,
    responseLost,
    paymentAttempted,
  };
}

module.exports = {
  isPaymentAlreadySubmitted,
  paymentPostCount,
  withPaymentLatchFields,
  resultBlob,
};
