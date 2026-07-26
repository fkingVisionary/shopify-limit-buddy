// Pure helpers for Bandai monitor → checkout handoff (no Playwright / no network).

/**
 * Whether a Bandai monitor task should fire Autocheckout on the first matching
 * in-stock hit. Default: yes when Place order is on (unless explicitly off).
 */
function shouldCheckoutOnMonitorHit(task = {}, placeOrder) {
  if (String(task.bandaiMode || "").toLowerCase() !== "monitor") return false;
  if (task.bandaiCheckoutOnHit === false || task.checkoutOnHit === false) return false;
  if (task.bandaiCheckoutOnHit === true || task.checkoutOnHit === true) return true;
  // Default: follow Place order checkbox (desktop placeOrder !== false).
  return placeOrder !== false;
}

/**
 * Build PDP / product code for checkout from a stock_changed hit + area.
 */
function checkoutTargetFromHit(hit, area = "au") {
  const region = String(area || "au").toLowerCase();
  const productId = String(hit?.productId || hit?.productCode || "").trim();
  if (!productId) return { ok: false, error: "hit missing productId" };
  const pdpUrl = `https://p-bandai.com/${region}/item/${productId}`;
  return {
    ok: true,
    productId,
    pdpUrl,
    title: hit?.title || hit?.productName || null,
    reason: hit?.reason || null,
  };
}

/**
 * Merge a monitor hit into a task copy switched to checkout mode.
 */
function taskForMonitorCheckout(task, hit, area) {
  const target = checkoutTargetFromHit(hit, area || task.bandaiArea || "au");
  if (!target.ok) return { ok: false, error: target.error };
  return {
    ok: true,
    task: {
      ...task,
      bandaiMode: "checkout",
      pdpUrl: target.pdpUrl,
      input: target.productId,
      storeUrl: target.pdpUrl,
      // Keep watch fields for logs; checkout ignores them.
      _monitorHit: {
        productId: target.productId,
        title: target.title,
        reason: target.reason,
        at: Date.now(),
      },
    },
    target,
  };
}

module.exports = {
  shouldCheckoutOnMonitorHit,
  checkoutTargetFromHit,
  taskForMonitorCheckout,
};
