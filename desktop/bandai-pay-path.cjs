/**
 * Resolve Bandai checkout pay-path flags for the desktop → executor payload.
 * ATC is always HTTP+F5; this only chooses Fast vs Safe GE pay after cart hold.
 *
 * Fast default: riskHydrate + page issuer (same cookies/TLS as mint).
 * Undici issuer after page-drop often → RELOAD_ONLY / no bank — A/B via
 * bandaiCheckoutMode=fast_undici or bandaiGeUndiciIssuer=true.
 *
 * @param {{ bandaiCheckoutMode?: string, bandaiBrowserCheckout?: boolean, bandaiGeHttpPay?: boolean, bandaiGeRiskHydrate?: boolean, bandaiGeNoPage?: boolean, bandaiGePreferPageIssuer?: boolean, bandaiGeUndiciIssuer?: boolean }} task
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
  const undiciIssuer =
    raw === "fast_undici" ||
    raw === "fast-http" ||
    raw === "undici" ||
    task.bandaiGeUndiciIssuer === true ||
    task.bandaiGePreferPageIssuer === false;

  const bandaiCheckoutMode = safe ? "safe" : undiciIssuer ? "fast_undici" : "fast";

  if (mode !== "checkout" || !placeOrder) {
    return {
      bandaiCheckoutMode: safe ? "safe" : "fast",
      bandaiGeHttpPay: false,
      bandaiBrowserCheckout: false,
      bandaiGeRiskHydrate: undefined,
      bandaiGeNoPage: undefined,
      bandaiGePreferPageIssuer: undefined,
      bandaiGeUndiciIssuer: undefined,
    };
  }

  if (safe) {
    return {
      bandaiCheckoutMode: "safe",
      bandaiGeHttpPay: false,
      bandaiBrowserCheckout: true,
      bandaiGeRiskHydrate: undefined,
      bandaiGeNoPage: undefined,
      bandaiGePreferPageIssuer: undefined,
      bandaiGeUndiciIssuer: undefined,
    };
  }

  // Fast: risk-hydrate on; stale noPage off unless task explicitly opts in.
  const noPage = task.bandaiGeNoPage === true;
  const preferPage =
    !noPage &&
    !undiciIssuer &&
    task.bandaiGePreferPageIssuer !== false;
  return {
    bandaiCheckoutMode,
    bandaiGeHttpPay: task.bandaiGeHttpPay !== false,
    bandaiBrowserCheckout: false,
    bandaiGeRiskHydrate: noPage ? false : task.bandaiGeRiskHydrate !== false,
    bandaiGeNoPage: noPage,
    // Explicit true/false for executor (undefined would also default page issuer).
    bandaiGePreferPageIssuer: preferPage,
    bandaiGeUndiciIssuer: undiciIssuer || noPage,
  };
}

module.exports = { resolveDesktopBandaiPayPath };
