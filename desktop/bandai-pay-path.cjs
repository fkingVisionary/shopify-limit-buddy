/**
 * Resolve Bandai checkout pay-path flags for the desktop → executor payload.
 * ATC is always HTTP+F5 for fast/safe; full = lab-only all-Playwright journey.
 *
 * Fast product default: HTTP GE pay via undici issuer — hard no Playwright pay
 * (Safe owns Playwright checkout fingerprinting). Dual-Revolut workshop is
 * shared http.js/undici, not page-issuer — and Safe13 proved mode≠dual fix.
 * Page issuer only when explicitly requested (bandaiGePreferPageIssuer=true).
 * Autocheckout test is an opt-in research fork (bandai-ge-http-test.js).
 * Full (`bandaiCheckoutMode=full`) is the dual-pivot lab: no HTTP GetCartToken.
 *
 * @param {{ bandaiCheckoutMode?: string, bandaiBrowserCheckout?: boolean, bandaiBrowserFull?: boolean, bandaiGeHttpPay?: boolean, bandaiGeRiskHydrate?: boolean, bandaiGeNoPage?: boolean, bandaiGePreferPageIssuer?: boolean, bandaiGeUndiciIssuer?: boolean, bandaiGeHttpPayTest?: boolean }} task
 * @param {{ placeOrder?: boolean, mode?: string }} [opts]
 */
function resolveDesktopBandaiPayPath(task = {}, opts = {}) {
  const mode = String(opts.mode || task.bandaiMode || "checkout").toLowerCase();
  const placeOrder = opts.placeOrder === true;
  const raw = String(task.bandaiCheckoutMode || "fast").toLowerCase();
  const full = raw === "full" || task.bandaiBrowserFull === true;
  const safe =
    !full &&
    (raw === "safe" ||
      raw === "browser" ||
      raw === "playwright" ||
      task.bandaiBrowserCheckout === true);
  const testFork =
    raw === "autocheckout_test" ||
    raw === "test" ||
    raw === "fast_test" ||
    task.bandaiGeHttpPayTest === true;

  if (mode !== "checkout" || !placeOrder) {
    return {
      bandaiCheckoutMode: full
        ? "full"
        : safe
          ? "safe"
          : testFork
            ? "autocheckout_test"
            : "fast",
      bandaiGeHttpPay: false,
      bandaiBrowserCheckout: false,
      bandaiBrowserFull: full || undefined,
      bandaiGeRiskHydrate: undefined,
      bandaiGeNoPage: undefined,
      bandaiGePreferPageIssuer: undefined,
      bandaiGeUndiciIssuer: undefined,
      bandaiGeHttpPayTest: undefined,
    };
  }

  if (full) {
    return {
      bandaiCheckoutMode: "full",
      bandaiGeHttpPay: false,
      bandaiBrowserCheckout: false,
      bandaiBrowserFull: true,
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
      bandaiBrowserFull: undefined,
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
      bandaiBrowserFull: undefined,
      bandaiGeRiskHydrate: task.bandaiGeNoPage === true ? false : task.bandaiGeRiskHydrate !== false,
      bandaiGeNoPage: task.bandaiGeNoPage === true,
      bandaiGePreferPageIssuer: false,
      bandaiGeUndiciIssuer: true,
      bandaiGeHttpPayTest: true,
    };
  }

  const noPage = task.bandaiGeNoPage === true;
  // Opt-in only — Fast must not default to Playwright page issuer.
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
    bandaiBrowserFull: undefined,
    bandaiGeRiskHydrate: noPage ? false : task.bandaiGeRiskHydrate !== false,
    bandaiGeNoPage: noPage,
    bandaiGePreferPageIssuer: preferPage,
    bandaiGeUndiciIssuer: !preferPage,
    bandaiGeHttpPayTest: undefined,
  };
}

module.exports = { resolveDesktopBandaiPayPath };
