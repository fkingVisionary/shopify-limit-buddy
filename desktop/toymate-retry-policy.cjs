// Toymate outer retry policy for Desktop job-runner.
// Grind until a terminal outcome — do not die on congestion / CapSolver flake.
//
// Terminal STOP:
//   - order confirmed
//   - payment declined (BigPay 30102/30106 / paymentDeclined)
//   - pay already submitted (bank check — never re-fire)
//   - hard site 403 / Request Blocked after proxy pool exhausted
//   - user stop
//
// Otherwise: retry (same sticky) or rotate (burnt exit / CF wall).

const {
  consumerOutcome,
  isOutOfStock,
  isProxyFail,
  isPaymentDeclined,
} = require("./consumer-status.cjs");
const { isPaymentAlreadySubmitted } = require("./payment-latch.cjs");

function resultBlob(res) {
  const parts = [];
  if (res?.failedStep) parts.push(String(res.failedStep));
  if (res?.error) parts.push(String(res.error));
  if (res?.debugError) parts.push(String(res.debugError));
  if (res?.note) parts.push(String(res.note));
  if (res?.paymentStatus) parts.push(String(res.paymentStatus));
  for (const s of [...(res?.steps || []), ...(res?.lastSteps || [])]) {
    if (!s) continue;
    parts.push(`${s.step || ""} ${s.status ?? ""} ${s.note || ""}`);
  }
  return parts.join("\n");
}

/** Site-wide hard block (not soft congestion / CF challenge we can re-solve). */
function isHardSite403(res) {
  if (!res || res.ok) return false;
  const blob = resultBlob(res);
  if (/Request Blocked|Access Denied|cf-browser-verification.*fail|EDGE_DENY/i.test(blob)) {
    // Soft CF "Just a moment" that CapSolver can still clear is NOT hard.
    if (/just a moment|cf_clearance|AntiCloudflare|still challenging/i.test(blob)) {
      // Challenging is recoverable via CapSolver + rotate — not terminal yet.
      return false;
    }
    return true;
  }
  // Explicit adapter note: full WAF refuse with no clearance path.
  if (
    String(res.failedStep || "") === "cf_warm" &&
    /blocked permanently|hard.?block|site.?banned/i.test(blob)
  ) {
    return true;
  }
  return false;
}

/** Congestion / flake that should keep hammering. */
function isRetryableToymateFail(res) {
  if (!res || res.ok) return false;
  if (isPaymentDeclined(res) || isPaymentAlreadySubmitted(res)) return false;
  if (isHardSite403(res)) return false;
  const step = String(res.failedStep || "");
  const blob = resultBlob(res);
  if (
    /^(cart_add|cart_create|cf_warm|checkout_spam|checkout_get|checkout_set_|payment_methods|place_order|account_login|pdp_get)/i.test(
      step,
    )
  ) {
    return true;
  }
  return /429|502|503|504|timeout|timed out|ECONN|fetch failed|congestion|chaos_congestion|CapSolver|still challenging|cf_clearance|spam|rate.?limit|socket|undici|RESPONSE_LOST|status.:.?0/i.test(
    blob,
  );
}

/**
 * @returns {{
 *   action: 'stop'|'retry'|'rotate'|'wait_restock',
 *   liveLabel: string,
 *   reason: string,
 *   delayMs: number,
 *   consumerCode?: string,
 *   reclaimHarvest?: boolean,
 * }}
 */
function classifyToymateRunResult(res, ctx = {}) {
  const mode = String(ctx.mode || "checkout").toLowerCase();
  const outcome = consumerOutcome(res);
  const retryCount = Number(ctx.retryCount) || 0;
  const rotateCount = Number(ctx.rotateCount) || 0;
  const proxyCount = Math.max(1, Number(ctx.proxyCount) || 1);
  const maxRotate = Number(ctx.maxRotate) || Math.max(24, proxyCount * 4);

  // Success — confirmed order.
  if (res?.ok && res?.orderNumber) {
    return {
      action: "stop",
      liveLabel: outcome.label || "Order confirmed",
      reason: "confirmed",
      delayMs: 0,
      consumerCode: "confirmed",
    };
  }

  // Terminal: BigPay / issuer decline (ok:true + paymentDeclined on Toymate).
  if (isPaymentDeclined(res)) {
    return {
      action: "stop",
      liveLabel: "Payment declined",
      reason: "hard_decline",
      delayMs: 0,
      consumerCode: "declined",
    };
  }

  // Dry-run / non-checkout modes that finished ok.
  if (res?.ok && mode !== "checkout") {
    return {
      action: "stop",
      liveLabel: outcome.label || "Complete",
      reason: "ok",
      delayMs: 0,
      consumerCode: outcome.code,
    };
  }

  if (res?.ok && res?.dryRun) {
    return {
      action: "stop",
      liveLabel: outcome.label || "Complete",
      reason: "dry_run",
      delayMs: 0,
      consumerCode: outcome.code,
    };
  }

  // Issuer already touched — never re-fire.
  if (isPaymentAlreadySubmitted(res)) {
    return {
      action: "stop",
      liveLabel: "Payment submitted — check bank",
      reason: "pay_already_submitted",
      delayMs: 0,
      consumerCode: outcome.code || "error",
    };
  }

  // Hard site 403 after we've walked the pool — accept defeat.
  if (isHardSite403(res)) {
    if (rotateCount >= Math.max(proxyCount, 3)) {
      return {
        action: "stop",
        liveLabel: "Site blocked (403)",
        reason: "hard_site_403",
        delayMs: 0,
        consumerCode: "akamai",
      };
    }
    return {
      action: "rotate",
      liveLabel: "Rotating proxy",
      reason: "hard_403_rotate",
      delayMs: 1500,
      consumerCode: "rotating",
      reclaimHarvest: true,
    };
  }

  // OOS — wait and keep lane alive (drop may restock).
  if (isOutOfStock(res)) {
    return {
      action: "wait_restock",
      liveLabel: "Out of stock — waiting",
      reason: "oos",
      delayMs: 8000,
      consumerCode: "oos",
      reclaimHarvest: true,
    };
  }

  // Proxy egress dead → rotate.
  if (isProxyFail(res)) {
    if (rotateCount >= maxRotate) {
      return {
        action: "retry",
        liveLabel: "Retrying",
        reason: "proxy_exhausted_retry",
        delayMs: 3000,
        consumerCode: "retry",
        reclaimHarvest: true,
      };
    }
    return {
      action: "rotate",
      liveLabel: "Rotating proxy",
      reason: "proxy",
      delayMs: 1200,
      consumerCode: "rotating",
      reclaimHarvest: true,
    };
  }

  // CapSolver / CF / congestion — grind. Escalate to rotate every few retries.
  if (isRetryableToymateFail(res)) {
    const step = String(res.failedStep || "");
    const cfWall = /cf_warm|still challenging|CapSolver/i.test(step + resultBlob(res));
    if (cfWall || (retryCount > 0 && retryCount % 3 === 0)) {
      if (rotateCount >= maxRotate) {
        return {
          action: "retry",
          liveLabel: cfWall ? "Retrying Cloudflare" : "Retrying ATC",
          reason: "retry_budget_keep_going",
          delayMs: 2500,
          consumerCode: "retry",
          reclaimHarvest: true,
        };
      }
      return {
        action: "rotate",
        liveLabel: "Rotating proxy",
        reason: cfWall ? "cf_escalate_rotate" : "atc_escalate_rotate",
        delayMs: 1500,
        consumerCode: "rotating",
        reclaimHarvest: true,
      };
    }
    return {
      action: "retry",
      liveLabel: /place_order|payment|spam/i.test(step)
        ? "Retrying pay"
        : /cf_warm/i.test(step)
          ? "Retrying Cloudflare"
          : "Retrying ATC",
      reason: "soft_retry",
      delayMs: 2000,
      consumerCode: /place_order|payment|spam/i.test(step) ? "retry_pay" : "retry_atc",
      reclaimHarvest: true,
    };
  }

  // Unknown fail — keep trying (user asked grind until terminal).
  if (rotateCount < maxRotate && retryCount > 0 && retryCount % 4 === 0) {
    return {
      action: "rotate",
      liveLabel: "Rotating proxy",
      reason: "unknown_escalate",
      delayMs: 2000,
      consumerCode: "rotating",
      reclaimHarvest: true,
    };
  }
  return {
    action: "retry",
    liveLabel: "Retrying",
    reason: "unknown_keep_going",
    delayMs: 2500,
    consumerCode: "retry",
    reclaimHarvest: true,
  };
}

module.exports = {
  classifyToymateRunResult,
  isHardSite403,
  isRetryableToymateFail,
  resultBlob,
};
