/**
 * Resolve Bandai checkout pay-path flags for the desktop → executor payload.
 * ATC is always HTTP+F5; this only chooses Fast vs Safe GE pay after cart hold.
 *
 * @param {{ bandaiCheckoutMode?: string, bandaiBrowserCheckout?: boolean, bandaiGeHttpPay?: boolean, bandaiGeRiskHydrate?: boolean, bandaiGeNoPage?: boolean }} task
 * @param {{ placeOrder?: boolean, mode?: string }} [opts]
 */
function resolveDesktopBandaiPayPath(task = {}, opts = {}) {
  const mode = String(opts.mode || task.bandaiMode || "checkout").toLowerCase();
  const placeOrder = opts.placeOrder === true;
  const raw = String(task.bandaiCheckoutMode || "fast").toLowerCase();
  const safe =
    raw === "safe" ||
    raw === "browser" ||
    raw === "playwright" ||
    task.bandaiBrowserCheckout === true;

  const bandaiCheckoutMode = safe ? "safe" : "fast";

  if (mode !== "checkout" || !placeOrder) {
    return {
      bandaiCheckoutMode,
      bandaiGeHttpPay: false,
      bandaiBrowserCheckout: false,
      bandaiGeRiskHydrate: undefined,
      bandaiGeNoPage: undefined,
    };
  }

  if (safe) {
    return {
      bandaiCheckoutMode: "safe",
      bandaiGeHttpPay: false,
      bandaiBrowserCheckout: true,
      bandaiGeRiskHydrate: undefined,
      bandaiGeNoPage: undefined,
    };
  }

  // Fast: risk-hydrate on; stale noPage off unless task explicitly opts in.
  const noPage = task.bandaiGeNoPage === true;
  return {
    bandaiCheckoutMode: "fast",
    bandaiGeHttpPay: task.bandaiGeHttpPay !== false,
    bandaiBrowserCheckout: false,
    bandaiGeRiskHydrate: noPage ? false : task.bandaiGeRiskHydrate !== false,
    bandaiGeNoPage: noPage,
  };
}

module.exports = { resolveDesktopBandaiPayPath };
