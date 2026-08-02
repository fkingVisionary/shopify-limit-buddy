/**
 * Shared Playwright stealth for pay/risk browser contexts.
 * Dual-Revolut angle A: Forter/GE/Adyen risk can fan out two bank lines from
 * one later PSP POST when the risk session was stamped automation=true.
 *
 * Does not change GE issuer body / form-nav / mute.
 * Opt in only: PAY_CHROME_STEALTH=1 (default off — avoid F5/login churn).
 */

/**
 * @param {import('playwright').BrowserContext} context
 */
export async function installChromePayStealth(context) {
  if (process.env.PAY_CHROME_STEALTH !== "1") return { ok: false, skipped: true };
  if (!context?.addInitScript) return { ok: false, error: "no_context" };
  await context.addInitScript(() => {
    try {
      Object.defineProperty(navigator, "webdriver", {
        get: () => undefined,
        configurable: true,
      });
    } catch {
      /* ignore */
    }
    try {
      // HeadlessChromium often exposes chrome gaps Forter watches.
      if (!window.chrome) {
        window.chrome = { runtime: {} };
      }
    } catch {
      /* ignore */
    }
    try {
      const orig = Permissions.prototype.query;
      Permissions.prototype.query = function (params) {
        if (params && params.name === "notifications") {
          return Promise.resolve({ state: Notification.permission });
        }
        return orig.call(this, params);
      };
    } catch {
      /* ignore */
    }
  });
  return { ok: true };
}

/**
 * Read automation tells from a live page (forensics only).
 * @param {import('playwright').Page} page
 */
export async function probeChromePayStealth(page) {
  if (!page?.evaluate) return null;
  try {
    return await page.evaluate(() => ({
      webdriver: navigator.webdriver,
      languages: Array.from(navigator.languages || []),
      platform: navigator.platform,
      hardwareConcurrency: navigator.hardwareConcurrency || null,
      hasChrome: Boolean(window.chrome),
    }));
  } catch {
    return null;
  }
}
