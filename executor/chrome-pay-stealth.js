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
 * @param {{ force?: boolean }} [opts] — force=true for Full-browser stealth A/B
 */
export async function installChromePayStealth(context, opts = {}) {
  const envOn = process.env.PAY_CHROME_STEALTH === "1";
  const envOff = process.env.PAY_CHROME_STEALTH === "0";
  if (envOff) return { ok: false, skipped: true, reason: "PAY_CHROME_STEALTH=0" };
  if (!opts.force && !envOn) return { ok: false, skipped: true };
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
      } else if (!window.chrome.runtime) {
        window.chrome.runtime = {};
      }
    } catch {
      /* ignore */
    }
    try {
      Object.defineProperty(navigator, "plugins", {
        get: () => [1, 2, 3, 4, 5],
        configurable: true,
      });
    } catch {
      /* ignore */
    }
    try {
      Object.defineProperty(navigator, "languages", {
        get: () => ["en-AU", "en-GB", "en"],
        configurable: true,
      });
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
  return { ok: true, forced: Boolean(opts.force) };
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
