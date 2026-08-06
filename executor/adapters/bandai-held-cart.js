/**
 * Bandai held-cart / pay-window helpers.
 *
 * After ATC the site holds a cart ~30 min for pay. Soft pay fails can keep a
 * cart-verified "retry pay" path. Hard issuer declines clear the cart on
 * Bandai's side — do not treat those as held-cart retries.
 */

export const BANDAI_PAY_WINDOW_MS = 30 * 60_000;

/** Hard issuer decline / fraud — cart is gone; never "retry pay". */
export function isHardPaymentDecline(res = {}) {
  if (!res || res.ok === true) return false;
  const ps = String(res.paymentStatus || "");
  const stage = String(res.checkoutStage || "");
  const blob = [ps, stage, res.error, res.note, res.debugError].filter(Boolean).join("\n");
  if (/^declined$/i.test(stage)) return true;
  if (/declined_or_auth_failed|auth_failed|fraud_refused|ge_fraud/i.test(ps)) return true;
  if (/do.?not.?honor|chargeAuthReject|hard.?declin/i.test(blob)) return true;
  // Bare "declined" paymentStatus (not soft "failed to process")
  if (/^declined$/i.test(ps)) return true;
  return false;
}

/** True when a failed run still has cart identifiers worth a pay retry. */
export function isHeldPayRetryEligible(res = {}) {
  if (!res || res.ok === true) return false;
  if (res.heldCartGone === true) return false;
  // Decline empties the Bandai cart — stale cartSn must not become Retry pay.
  if (isHardPaymentDecline(res)) return false;
  const cartSn = res.cartSn ?? res.heldCart?.cartSn;
  const cartItemSn = res.cartItemSn ?? res.heldCart?.cartItemSn;
  if (!cartSn || !cartItemSn) return false;

  const ps = String(res.paymentStatus || "");
  const stage = String(res.checkoutStage || "");
  const failed = String(res.failedStep || "");

  if (/tokenize|threeds|ge_|issuer|http_ge|pay_submitted|reload/i.test(ps)) return true;
  if (/tokenize|threeds|cart_checkout|checkout_address/i.test(stage)) return true;
  if (/ge_|issuer|cart_checkout|checkout_address/i.test(failed)) return true;
  if (Array.isArray(res.blockers) && res.blockers.length > 0) return true;
  // Explicit adapter flag after cart_hold + soft pay fail
  if (res.heldPayRetry === true) return true;
  return false;
}

export function payWindowRemainingMs(cartHoldAt, now = Date.now(), windowMs = BANDAI_PAY_WINDOW_MS) {
  const start = Number(cartHoldAt);
  if (!Number.isFinite(start) || start <= 0) return null;
  const left = Math.max(0, start + Number(windowMs || BANDAI_PAY_WINDOW_MS) - Number(now));
  return left;
}

export function payWindowExpired(cartHoldAt, now = Date.now(), windowMs = BANDAI_PAY_WINDOW_MS) {
  const left = payWindowRemainingMs(cartHoldAt, now, windowMs);
  if (left == null) return false; // unknown clock — do not expire locally; verify cart live
  return left <= 0;
}

/** Snapshot persisted on the desktop task for Retry pay. */
export function buildHeldCartSnapshot(res = {}, now = Date.now()) {
  if (!isHeldPayRetryEligible(res) && !(res.cartSn && res.cartItemSn && res.ok === false)) {
    // Allow explicit build when cart ids present after pay fail even if status odd
    if (!(res.cartSn && res.cartItemSn)) return null;
  }
  const cartSn = res.cartSn ?? res.heldCart?.cartSn ?? null;
  const cartItemSn = res.cartItemSn ?? res.heldCart?.cartItemSn ?? null;
  if (!cartSn || !cartItemSn) return null;
  return {
    cartSn,
    cartId: res.cartId ?? res.heldCart?.cartId ?? null,
    cartItemSn,
    areaItemNo: res.areaItemNo ?? res.heldCart?.areaItemNo ?? null,
    productCode: res.productCode ?? res.heldCart?.productCode ?? null,
    title: res.title ?? res.heldCart?.title ?? null,
    cartHoldAt: Number(res.cartHoldAt || res.heldCart?.cartHoldAt || now),
    payWindowMs: Number(res.payWindowMs || res.heldCart?.payWindowMs || BANDAI_PAY_WINDOW_MS),
    paymentStatus: res.paymentStatus || null,
    accountId: res.accountId ?? res.heldCart?.accountId ?? null,
  };
}

/** Attach held-cart fields onto an adapter result (mutate-safe copy). */
export function withHeldCartMeta(out = {}, now = Date.now()) {
  const next = { ...out };
  if (next.ok === true) {
    next.heldPayRetry = false;
    return next;
  }
  if (next.heldCartGone === true || isHardPaymentDecline(next)) {
    next.heldPayRetry = false;
    next.heldCart = null;
    return next;
  }
  if (!next.cartHoldAt && next.cartSn && next.cartItemSn) {
    next.cartHoldAt = now;
  }
  next.payWindowMs = next.payWindowMs || BANDAI_PAY_WINDOW_MS;
  if (isHeldPayRetryEligible(next)) {
    next.heldPayRetry = true;
    next.heldCart = buildHeldCartSnapshot(next, now);
  }
  return next;
}

/** Desktop: should the Retry pay button show? Timer is hint-only. */
export function shouldShowRetryPay(task = {}, now = Date.now()) {
  const held = task?.heldCart;
  if (!held?.cartSn || !held?.cartItemSn) return false;
  // If we know the clock and it's clearly expired, still allow click — live cart verify decides.
  // UI may dim when expired.
  void now;
  return true;
}

export function retryPayHint(task = {}, now = Date.now()) {
  const held = task?.heldCart;
  if (!held?.cartSn) return null;
  const left = payWindowRemainingMs(held.cartHoldAt, now, held.payWindowMs);
  if (left == null) return "Cart held — verify live on retry";
  if (left <= 0) return "Pay window may have expired — cart check on retry";
  const mins = Math.ceil(left / 60_000);
  return `Cart held · ~${mins}m left (verify on retry)`;
}

export default {
  BANDAI_PAY_WINDOW_MS,
  isHardPaymentDecline,
  isHeldPayRetryEligible,
  payWindowRemainingMs,
  payWindowExpired,
  buildHeldCartSnapshot,
  withHeldCartMeta,
  shouldShowRetryPay,
  retryPayHint,
};
