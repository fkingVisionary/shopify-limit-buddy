// Consumer-facing task status for the desktop UI.
// Keeps analytical step/notes for debug logs; UI should only show these labels.

const LIVE = {
  warm: "Starting",
  product: "Loading product",
  cart: "Adding to cart",
  details: "Proceeding to checkout",
  tokenize: "Processing payment",
  threeds: "Waiting for bank approval",
  order: "Placing order",
  done: "Done",
};

const OUTCOME = {
  confirmed: "Order confirmed",
  complete: "Complete",
  oos: "Out of stock",
  akamai: "Failed on Akamai",
  proxy: "Proxy error",
  declined: "Payment declined",
  error: "Something went wrong",
  stopped: "Stopped",
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
  const text = stepText(res);
  if (/Access Denied|AkamaiGHost|akamai_unsolved/i.test(text)) return false;
  if (/out\s*of\s*stock|sold\s*out|not\s+available|unavailable|INSUFFICIENT|no\s+stock|OOS\b/i.test(text)) {
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
  const text = stepText(res);
  const ps = res?.paymentSummary || {};
  if (/declin|chargeAuthReject|payment.*fail|card.*fail|do.?not.?honor/i.test(text)) return true;
  if (ps.processStatus === "error" || ps.acsOk === false) {
    // 3DS reject / process error after tokenize — consumer "declined"
    if (ps.oneTimeToken || ps.charge3dsId) return true;
  }
  return false;
}

/**
 * Map live /progress payload → short consumer line.
 */
function consumerProgressMessage(progress) {
  if (!progress) return LIVE.warm;
  const stage = progress.stage || "warm";
  if (progress.done) {
    if (progress.ok && progress.orderNumber) return OUTCOME.confirmed;
    if (progress.ok) return OUTCOME.complete;
    return OUTCOME.stopped;
  }
  return LIVE[stage] || LIVE.warm;
}

/**
 * Map finished /run-shaped result → { code, label, stockStatus }.
 */
function consumerOutcome(res) {
  if (!res) {
    return { code: "error", label: OUTCOME.error, stockStatus: "unknown" };
  }
  if (res.ok) {
    if (res.orderNumber) {
      return { code: "confirmed", label: OUTCOME.confirmed, stockStatus: "ok" };
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
  if (isPaymentDeclined(res)) {
    return { code: "declined", label: OUTCOME.declined, stockStatus: "ok" };
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
};
