/**
 * Resolve Bandai checkout pay-path flags for the desktop → executor payload.
 * ATC is always HTTP+F5; this only chooses Fast vs Safe GE pay after cart hold.
 *
 * Fast (bible / product default): riskHydrate → drop page → undici issuer.
 * Autocheckout test: same shape as Fast but executor uses bandai-ge-http-test.js
 * (experimental fork — production Fast stays on bandai-ge-http.js).
 * Page issuer is opt-in only (bandaiGePreferPageIssuer=true).
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
  const testFork =
    raw === "autocheckout_test" ||
    raw === "test" ||
    raw === "fast_test" ||
    task.bandaiGeHttpPayTest === true;

  if (mode !== "checkout" || !placeOrder) {
    return {
      bandaiCheckoutMode: safe ? "safe" : testFork ? "autocheckout_test" : "fast",
      bandaiGeHttpPay: false,
      bandaiBrowserCheckout: false,
      bandaiGeRiskHydrate: undefined,
      bandaiGeNoPage: undefined,
      bandaiGePreferPageIssuer: undefined,
      bandaiGeUndiciIssuer: undefined,
      bandaiGeHttpPayTest: undefined,
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
      bandaiGeHttpPayTest: undefined,
    };
  }

  if (testFork) {
    return {
      bandaiCheckoutMode: "autocheckout_test",
      bandaiGeHttpPay: true,
      bandaiBrowserCheckout: false,
      bandaiGeRiskHydrate: task.bandaiGeNoPage === true ? false : task.bandaiGeRiskHydrate !== false,
      bandaiGeNoPage: task.bandaiGeNoPage === true,
      bandaiGePreferPageIssuer: false,
      bandaiGeUndiciIssuer: true,
      bandaiGeHttpPayTest: true,
    };
  }

  const noPage = task.bandaiGeNoPage === true;
  // Opt-in only — do not default page issuer (bible = undici after riskHydrate).
  const preferPage =
    !noPage &&
    task.bandaiGePreferPageIssuer === true &&
    task.bandaiGeUndiciIssuer !== true &&
    raw !== "fast_undici" &&
    raw !== "fast-http" &&
    raw !== "undici";

  return {
    bandaiCheckoutMode: preferPage
      ? "fast"
      : raw === "fast_undici" || raw === "fast-http" || raw === "undici"
        ? "fast_undici"
        : "fast",
    bandaiGeHttpPay: task.bandaiGeHttpPay !== false,
    bandaiBrowserCheckout: false,
    bandaiGeRiskHydrate: noPage ? false : task.bandaiGeRiskHydrate !== false,
    bandaiGeNoPage: noPage,
    bandaiGePreferPageIssuer: preferPage,
    bandaiGeUndiciIssuer: !preferPage,
    bandaiGeHttpPayTest: undefined,
  };
}

module.exports = { resolveDesktopBandaiPayPath };
