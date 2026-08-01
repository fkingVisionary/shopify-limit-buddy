// Consumer-facing task status for the desktop UI.
// Keeps analytical step/notes for debug logs; UI should only show these labels.

const LIVE = {
  warm: "Starting",
  login: "Logging in",
  product: "Loading product",
  cart: "Adding to cart",
  details: "Checking out",
  tokenize: "Processing payment",
  threeds: "Waiting for bank approval",
  order: "Placing order",
  done: "Done",
  switching: "Rotating proxy",
  retry_atc: "Retrying ATC",
  retry_pay: "Retrying pay",
  monitor: "Waiting for restock",
  oos_wait: "Out of stock — waiting",
};

const OUTCOME = {
  confirmed: "Order confirmed",
  complete: "Complete",
  cart_held: "In cart",
  oos: "Out of stock",
  akamai: "Blocked by store protection",
  proxy: "Proxy error",
  declined: "Payment declined",
  held_pay_retry: "Cart held — retry pay",
  held_cart_gone: "Cart hold expired",
  checkout_address: "Checkout needs address/name",
  error: "Something went wrong",
  stopped: "Stopped",
  limit_reached: "Limit reached",
};

function stepText(res) {
  const parts = [];
  if (res?.failedStep) parts.push(String(res.failedStep));
  if (res?.error) parts.push(String(res.error));
  if (res?.checkoutStage) parts.push(String(res.checkoutStage));
  for (const s of [...(res?.steps || []), ...(res?.lastSteps || [])]) {
    if (!s) continue;
    parts.push(`${s.step || ""} ${s.status ?? ""} ${s.note || ""}`);
  }
  return parts.join("\n");
}

function isOutOfStock(res) {
  if (!res || res.ok) return false;
  const text = [stepText(res), res?.debugError, res?.note].filter(Boolean).join("\n");
  if (/Access Denied|AkamaiGHost|akamai_unsolved/i.test(text)) return false;
  if (
    /out\s*of\s*stock|sold\s*out|SoldOut|EndOfSale|CouldNotAddToCartBy(SoldOut|OutOfStock|EndOfSale)|not\s*available|unavailable|INSUFFICIENT|no\s+stock|OOS\b/i.test(
      text,
    )
  ) {
    return true;
  }
  // ATC/verify completed HTTP-ok-ish but SKU never landed and not Akamai-denied.
  const steps = [...(res?.steps || []), ...(res?.lastSteps || [])];
  const atc = [...steps].reverse().find((s) => String(s?.step || "") === "cart_atc");
  if (atc && atc.ok === false && /hasSku=false/i.test(String(atc.note || "")) && !/denied=true/i.test(String(atc.note || ""))) {
    return true;
  }
  const verify = [...steps].reverse().find((s) => String(s?.step || "") === "cart_verify");
  if (verify && verify.ok === false && /hasSku=false/i.test(String(verify.note || ""))) {
    return true;
  }
  return false;
}

function isAkamaiFail(res) {
  if (!res || res.ok) return false;
  const text = stepText(res);
  if (res.failedStep === "akamai_unsolved") return true;
  return /akamai_unsolved|Access Denied|AkamaiGHost|pdp_get.*403|category_browse.*403/i.test(text);
}

function isProxyFail(res) {
  if (!res || res.ok) return false;
  if (res.failedStep === "proxy_egress" || res.failedStep === "proxy_parse") return true;
  return /proxy_egress|proxy_parse|same=true/i.test(stepText(res));
}

function isPaymentDeclined(res) {
  if (!res || res.ok) return false;
  const text = [
    stepText(res),
    res?.debugError,
    res?.paymentStatus,
    res?.note,
  ]
    .filter(Boolean)
    .join("\n");
  const ps = String(res?.paymentStatus || "");
  const stage = String(res?.checkoutStage || "");
  // Explicit GE/issuer hard outcomes (Bandai stage=declined).
  if (/^declined$/i.test(stage)) return true;
  if (/declined_or_auth_failed|auth_failed|fraud_refused|ge_fraud/i.test(ps)) return true;
  if (/^declined$/i.test(ps)) return true;
  // Soft "failed to process / try again" is NOT a hard decline (cart may still be held).
  if (
    /failed to process|try again|temporarily unavailable|processing error/i.test(text) &&
    !/do.?not.?honor|chargeAuthReject|hard.?declin|declined_or_auth_failed/i.test(text)
  ) {
    return false;
  }
  const summary = res?.paymentSummary || {};
  if (/declin|chargeAuthReject|do.?not.?honor|card.*declin/i.test(text)) return true;
  if (summary.processStatus === "error" || summary.acsOk === false) {
    // 3DS reject / process error after tokenize — consumer "declined"
    if (summary.oneTimeToken || summary.charge3dsId) return true;
  }
  return false;
}

/** Bandai: cart still held after soft pay fail — Retry pay (cart-verified). */
function isHeldPayRetry(res) {
  if (!res || res.ok) return false;
  if (res.heldCartGone === true || String(res.checkoutStage || "") === "held_cart_gone") {
    return false;
  }
  // Hard decline clears Bandai cart — never label as held retry.
  if (isPaymentDeclined(res)) return false;
  const ps = String(res.paymentStatus || "");
  const stage = String(res.checkoutStage || "");
  if (/declined|auth_failed|fraud/i.test(ps) || /^declined$/i.test(stage)) return false;
  if (res.heldPayRetry === true && (res.heldCart?.cartSn || res.cartSn)) return true;
  const cartSn = res.cartSn ?? res.heldCart?.cartSn;
  const cartItemSn = res.cartItemSn ?? res.heldCart?.cartItemSn;
  if (!cartSn || !cartItemSn) return false;
  if (/tokenize|threeds|http_ge|ge_|pay_submitted|reload/i.test(ps) || /tokenize|threeds/i.test(stage)) {
    return true;
  }
  return false;
}

function isHeldCartGone(res) {
  if (!res || res.ok) return false;
  return (
    res.heldCartGone === true ||
    String(res.checkoutStage || "") === "held_cart_gone" ||
    String(res.failedStep || "") === "held_cart_verify"
  );
}

/** GE / Bandai shipping+billing blockers after ATC. */
function isCheckoutAddressFail(res) {
  if (!res || res.ok) return false;
  if (String(res.failedStep || "") === "checkout_address") return true;
  const text = stepText(res);
  return /checkout_address|BillingMandatory|BillingFirstName|BillingLastName|hasAddress=false/i.test(
    text,
  );
}

/**
 * Map live /progress payload → short consumer line.
 */
function consumerProgressMessage(progress) {
  if (!progress) return LIVE.warm;
  const label = String(progress.label || "");
  const detail = String(progress.detail || "");
  if (/rotating proxy|switching proxy/i.test(label) || /rotating proxy|switching proxy/i.test(detail)) {
    return LIVE.switching;
  }
  if (/retrying pay/i.test(label) || /retrying pay/i.test(detail)) return LIVE.retry_pay;
  if (/retrying atc/i.test(label) || /retrying atc/i.test(detail)) return LIVE.retry_atc;
  if (/waiting for restock/i.test(label) || /waiting for restock/i.test(detail)) {
    return LIVE.monitor;
  }
  if (/out of stock/i.test(label)) return LIVE.oos_wait;
  const stage = progress.stage || "warm";
  if (progress.done) {
    if (progress.ok && progress.orderNumber) return OUTCOME.confirmed;
    if (progress.ok) return OUTCOME.complete;
    return OUTCOME.error;
  }
  // Prefer explicit consumer labels from Bandai-aware stages.
  if (label && Object.values(LIVE).includes(label)) return label;
  return LIVE[stage] || label || LIVE.warm;
}

/**
 * Map finished /run-shaped result → { code, label, stockStatus }.
 */
function consumerOutcome(res) {
  if (!res) {
    return { code: "error", label: OUTCOME.error, stockStatus: "unknown" };
  }
  if (res.ok) {
    if (res.loginCheck) {
      return { code: "login_ok", label: "Login proven", stockStatus: "ok" };
    }
    if (res.orderNumber) {
      return { code: "confirmed", label: OUTCOME.confirmed, stockStatus: "ok" };
    }
    // ATC-only / stop-at-cart: cart held for ~30 min pay window.
    if (
      res.atcOnly === true ||
      (res.heldPayRetry === true &&
        (res.heldCart?.cartSn || res.cartSn) &&
        /^(cart|cart_hold)$/i.test(String(res.checkoutStage || "")))
    ) {
      return { code: "cart_held", label: OUTCOME.cart_held, stockStatus: "ok" };
    }
    return { code: "complete", label: OUTCOME.complete, stockStatus: "ok" };
  }
  if (isProxyFail(res)) {
    return { code: "proxy", label: OUTCOME.proxy, stockStatus: "unknown" };
  }
  if (isOutOfStock(res)) {
    return { code: "oos", label: OUTCOME.oos, stockStatus: "oos" };
  }
  if (isAkamaiFail(res)) {
    return { code: "akamai", label: OUTCOME.akamai, stockStatus: "unknown" };
  }
  if (isHeldCartGone(res)) {
    return { code: "held_cart_gone", label: OUTCOME.held_cart_gone, stockStatus: "unknown" };
  }
  // Address/name blockers before treating the fail as a generic held-cart pay retry.
  if (isCheckoutAddressFail(res)) {
    return {
      code: "checkout_address",
      label: OUTCOME.checkout_address,
      stockStatus: "unknown",
    };
  }
  // Hard decline wins — Bandai clears the cart; do not show "Cart held — retry pay".
  if (isPaymentDeclined(res)) {
    return { code: "declined", label: OUTCOME.declined, stockStatus: "ok" };
  }
  // Soft pay fail with surviving cart ids → Retry pay.
  if (isHeldPayRetry(res)) {
    return { code: "held_pay_retry", label: OUTCOME.held_pay_retry, stockStatus: "ok" };
  }
  // Soft member-address POST failed and nothing later recovered — treat as address.
  if (String(res.failedStep || "") === "shipping_ensure") {
    return {
      code: "checkout_address",
      label: OUTCOME.checkout_address,
      stockStatus: "unknown",
    };
  }
  return { code: "error", label: OUTCOME.error, stockStatus: "unknown" };
}

module.exports = {
  LIVE,
  OUTCOME,
  consumerProgressMessage,
  consumerOutcome,
  isOutOfStock,
  isAkamaiFail,
  isProxyFail,
  isPaymentDeclined,
  isHeldPayRetry,
  isHeldCartGone,
  isCheckoutAddressFail,
};
