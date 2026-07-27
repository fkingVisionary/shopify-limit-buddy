// Pure helpers for Pokémon Centre monitor → checkout handoff (no network).

/**
 * Whether a PC monitor task should fire Autocheckout on the first in-stock hit.
 * Default: yes when Place order is on (unless explicitly off).
 */
function shouldCheckoutOnMonitorHit(task = {}, placeOrder) {
  const mode = String(task.pcMode || task.pokemoncentreMode || "").toLowerCase();
  if (mode !== "monitor") return false;
  if (task.pcCheckoutOnHit === false || task.checkoutOnHit === false) return false;
  if (task.pcCheckoutOnHit === true || task.checkoutOnHit === true) return true;
  return placeOrder !== false;
}

/**
 * Merge a monitor availability hit into a task copy switched to checkout mode.
 */
function taskForMonitorCheckout(task, hit = {}) {
  const sku = String(hit.sku || task.sku || "").trim();
  const pdpUrl = String(hit.pdpUrl || hit.finalUrl || task.pdpUrl || task.input || "").trim();
  if (!sku && !pdpUrl) {
    return { ok: false, error: "monitor hit missing sku/pdpUrl" };
  }
  return {
    ok: true,
    task: {
      ...task,
      pcMode: "checkout",
      pokemoncentreMode: "checkout",
      pdpUrl: pdpUrl || task.pdpUrl,
      input: pdpUrl || sku || task.input,
      sku: sku || task.sku,
      storeUrl: pdpUrl || task.storeUrl,
      _monitorHit: {
        sku: sku || null,
        title: hit.title || null,
        purchaseAvailable: hit.purchaseAvailable ?? true,
        at: Date.now(),
      },
    },
    target: {
      sku: sku || null,
      pdpUrl: pdpUrl || null,
      title: hit.title || null,
    },
  };
}

module.exports = {
  shouldCheckoutOnMonitorHit,
  taskForMonitorCheckout,
};
