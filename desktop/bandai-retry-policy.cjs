// Bandai outer retry policy for Desktop job-runner.
// Classify a finished /run-shaped result → stop | retry | rotate | wait_restock.
//
// Rules (owner):
// - Soft payment process fail → retry (same cart / pay-from-cart when held)
// - 403 / SoftBlock / burnt exit → rotate proxy
// - Hard decline / bad password / address → stop
// - OOS → wait for restock (task stays alive)
// - Success / cart held (ATC-only) → stop

const {
  consumerOutcome,
  isOutOfStock,
  isAkamaiFail,
  isProxyFail,
  isPaymentDeclined,
  isHeldPayRetry,
  isHeldCartGone,
  isCheckoutAddressFail,
} = require("./consumer-status.cjs");

/** @typedef {'stop'|'retry'|'rotate'|'wait_restock'} BandaiAction */

/**
 * Soft “failed to process” vs hard issuer decline.
 * Soft → retry pay; hard → stop (even if cart still held).
 */
function isSoftPaymentProcessFail(res) {
  if (!res || res.ok) return false;
  if (isPaymentDeclined(res) && !isSoftDeclineBlob(res)) return false;
  const blob = resultBlob(res);
  // Hard decline signals win over soft wording.
  if (
    /do.?not.?honor|insufficient funds|stolen|lost card|pick.?up|fraud|chargeAuthReject|auth_failed|hard.?declin/i.test(
      blob,
    )
  ) {
    return false;
  }
  return (
    /failed to process|could not process|processing error|try again|temporarily|timeout|timed out|GATEWAY|502|503|504|NETWORK CONGESTION|PAGE NOT AVAILABLE|RELOAD_ONLY|IsTheSameCartToken|ge_risk_hydrate|socket|ECONN|fetch failed/i.test(
      blob,
    ) ||
    (/ge_payment|tokenize|threeds|http_ge|pay/i.test(String(res.failedStep || "")) &&
      !/declin/i.test(blob))
  );
}

function isSoftDeclineBlob(res) {
  const blob = resultBlob(res);
  return /failed to process|try again|temporarily unavailable|processing error/i.test(blob);
}

function isBlocked403(res) {
  if (!res || res.ok) return false;
  if (isAkamaiFail(res)) return true;
  const blob = resultBlob(res);
  if (/\b403\b|SoftBlock|Access Denied|Request rejected|AkamaiGHost|Restricted/i.test(blob)) {
    return true;
  }
  // Login SoftBlock (failedStep=login with block wording)
  if (String(res.failedStep || "") === "login" && /SoftBlock|Access Denied|sensor mint|501|503/i.test(blob)) {
    return true;
  }
  return false;
}

function isBadCredentials(res) {
  if (!res || res.ok) return false;
  const blob = resultBlob(res);
  return /invalid (password|credentials)|wrong password|MemberNotFound|password.*incorrect|BadCredentials/i.test(
    blob,
  );
}

function isRetryableAtcOuter(res) {
  if (!res || res.ok) return false;
  if (isOutOfStock(res)) return false;
  if (String(res.failedStep || "") !== "addToCart" && !/addToCart|cart_atc/i.test(resultBlob(res))) {
    return false;
  }
  const blob = resultBlob(res);
  return /NETWORK CONGESTION|PAGE NOT AVAILABLE|SoftBlock|Access Denied|429|501|502|503|504|timeout|fetch failed|socket/i.test(
    blob,
  );
}

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
 * @param {object} res — finishResult-shaped
 * @param {{ mode?: string, loop?: number, maxRotate?: number, maxRetry?: number, rotateCount?: number, retryCount?: number }} [ctx]
 * @returns {{ action: BandaiAction, liveLabel: string, reason: string, retryPay?: boolean, delayMs: number, consumerCode?: string }}
 */
function classifyBandaiRunResult(res, ctx = {}) {
  const mode = String(ctx.mode || "checkout").toLowerCase();
  const outcome = consumerOutcome(res);

  if (res?.ok) {
    if (mode === "monitor" && res.monitor && !res.checkout && !res.orderNumber) {
      // Dry monitor finished polls — keep waiting if we want persistent monitor.
      if (res.dryRun) {
        return {
          action: "wait_restock",
          liveLabel: "Waiting for restock",
          reason: "monitor_dry",
          delayMs: 5000,
          consumerCode: "waiting_restock",
        };
      }
    }
    return {
      action: "stop",
      liveLabel: outcome.label,
      reason: "success",
      delayMs: 0,
      consumerCode: outcome.code,
    };
  }

  if (isBadCredentials(res)) {
    return {
      action: "stop",
      liveLabel: "Login failed",
      reason: "bad_credentials",
      delayMs: 0,
      consumerCode: "error",
    };
  }

  if (isCheckoutAddressFail(res)) {
    return {
      action: "stop",
      liveLabel: outcome.label,
      reason: "address",
      delayMs: 0,
      consumerCode: outcome.code,
    };
  }

  // Hard decline → stop (do not spray pay). Soft process fail handled below.
  // Check before SoftBlock/rotate so "declined" never becomes a proxy spin.
  if (isPaymentDeclined(res) && !isSoftPaymentProcessFail(res)) {
    return {
      action: "stop",
      liveLabel: outcome.label || "Payment declined",
      reason: "hard_decline",
      delayMs: 0,
      consumerCode: outcome.code || "declined",
    };
  }

  if (isHeldCartGone(res)) {
    return {
      action: "wait_restock",
      liveLabel: "Cart hold expired — waiting",
      reason: "held_cart_gone",
      delayMs: 8000,
      consumerCode: outcome.code,
    };
  }

  // Soft pay process fail — retry pay (prefer held cart when present).
  if (isSoftPaymentProcessFail(res) || (isHeldPayRetry(res) && isSoftPaymentProcessFail(res))) {
    const retryCount = Number(ctx.retryCount) || 0;
    const maxRetry = Number(ctx.maxRetry) || 12;
    if (retryCount >= maxRetry) {
      return {
        action: "stop",
        liveLabel: outcome.label,
        reason: "retry_exhausted",
        delayMs: 0,
        consumerCode: outcome.code,
      };
    }
    return {
      action: "retry",
      liveLabel: "Retrying pay",
      reason: "soft_payment",
      retryPay: Boolean(res.heldCart?.cartSn || res.cartSn || res.heldPayRetry),
      delayMs: 2500,
      consumerCode: "retry_pay",
    };
  }

  // 403 / SoftBlock / Akamai → rotate
  if (isBlocked403(res) || isProxyFail(res)) {
    const rotateCount = Number(ctx.rotateCount) || 0;
    const maxRotate = Number(ctx.maxRotate) || 24;
    if (rotateCount >= maxRotate) {
      return {
        action: "stop",
        liveLabel: outcome.label,
        reason: "rotate_exhausted",
        delayMs: 0,
        consumerCode: outcome.code,
      };
    }
    return {
      action: "rotate",
      liveLabel: "Rotating proxy",
      reason: isProxyFail(res) ? "proxy" : "blocked_403",
      delayMs: 1200,
      consumerCode: "rotating",
    };
  }

  // OOS → wait (monitor or checkout lane)
  if (isOutOfStock(res)) {
    return {
      action: "wait_restock",
      liveLabel: mode === "monitor" ? "Waiting for restock" : "Out of stock — waiting",
      reason: "oos",
      delayMs: mode === "monitor" ? 5000 : 10000,
      consumerCode: "waiting_restock",
    };
  }

  // ATC congestion / soft fail → retry ATC (same proxy); escalate to rotate after a few
  if (isRetryableAtcOuter(res)) {
    const retryCount = Number(ctx.retryCount) || 0;
    if (retryCount > 0 && retryCount % 3 === 0) {
      return {
        action: "rotate",
        liveLabel: "Rotating proxy",
        reason: "atc_escalate_rotate",
        delayMs: 1500,
        consumerCode: "rotating",
      };
    }
    return {
      action: "retry",
      liveLabel: "Retrying ATC",
      reason: "atc_soft",
      retryPay: false,
      delayMs: 2000,
      consumerCode: "retry_atc",
    };
  }

  // Login SoftBlock already covered by isBlocked403; other login flakes → rotate
  if (String(res.failedStep || "") === "login") {
    return {
      action: "rotate",
      liveLabel: "Rotating proxy",
      reason: "login_flake",
      delayMs: 1500,
      consumerCode: "rotating",
    };
  }

  // Generic transient → retry a few times then rotate
  const blob = resultBlob(res);
  if (/timeout|timed out|ECONN|fetch failed|socket|502|503|504|429/i.test(blob)) {
    const retryCount = Number(ctx.retryCount) || 0;
    if (retryCount >= 2) {
      return {
        action: "rotate",
        liveLabel: "Rotating proxy",
        reason: "transient_escalate",
        delayMs: 1500,
        consumerCode: "rotating",
      };
    }
    return {
      action: "retry",
      liveLabel: "Retrying",
      reason: "transient",
      delayMs: 2000,
      consumerCode: "retry",
    };
  }

  // Unknown failure — rotate once budget allows, else stop
  const rotateCount = Number(ctx.rotateCount) || 0;
  if (rotateCount < Math.min(6, Number(ctx.maxRotate) || 24)) {
    return {
      action: "rotate",
      liveLabel: "Rotating proxy",
      reason: "unknown_rotate",
      delayMs: 2000,
      consumerCode: "rotating",
    };
  }

  return {
    action: "stop",
    liveLabel: outcome.label,
    reason: "unknown_stop",
    delayMs: 0,
    consumerCode: outcome.code,
  };
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, Math.max(0, Number(ms) || 0)));
}

module.exports = {
  classifyBandaiRunResult,
  isSoftPaymentProcessFail,
  isBlocked403,
  isBadCredentials,
  isRetryableAtcOuter,
  sleep,
};
