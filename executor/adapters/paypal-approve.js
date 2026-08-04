/**
 * Complete a PayPal checkoutnow / approve URL (login → Pay Now).
 * Used by Bandai Fast after InitPayPalExpress mints paypalApproveUrl.
 */
import { chromium } from "playwright";
import { parseBandaiProxy } from "./bandai-f5.js";

function proxyForPlaywright(rawProxy) {
  try {
    return parseBandaiProxy(rawProxy).playwright || undefined;
  } catch {
    return undefined;
  }
}

async function fillFirst(page, selectors, value) {
  for (const sel of selectors) {
    const loc = page.locator(sel).first();
    if (!(await loc.count().catch(() => 0))) continue;
    if (!(await loc.isVisible().catch(() => false))) continue;
    await loc.fill(String(value), { timeout: 8_000 }).catch(async () => {
      await loc.click({ timeout: 3_000 }).catch(() => {});
      await page.keyboard.type(String(value), { delay: 25 });
    });
    return true;
  }
  return false;
}

async function clickFirst(page, selectors, { timeout = 8_000 } = {}) {
  for (const sel of selectors) {
    const loc = page.locator(sel).first();
    if (!(await loc.count().catch(() => 0))) continue;
    if (!(await loc.isVisible().catch(() => false))) continue;
    if (await loc.isDisabled().catch(() => false)) continue;
    await loc.click({ timeout, noWaitAfter: true }).catch(() => {});
    return true;
  }
  return false;
}

/**
 * @param {object} opts
 * @param {string} opts.approveUrl
 * @param {string} opts.email
 * @param {string} opts.password
 * @param {string} [opts.proxy]
 * @param {boolean} [opts.headless]
 * @param {number} [opts.timeoutMs]
 * @param {(m:string)=>void} [opts.log]
 */
export async function approvePaypalCheckout(opts = {}) {
  const approveUrl = String(opts.approveUrl || "").trim();
  const email = String(opts.email || "").trim();
  const password = String(opts.password || "");
  const log = typeof opts.log === "function" ? opts.log : () => {};
  const timeoutMs = Math.min(180_000, Math.max(30_000, Number(opts.timeoutMs) || 90_000));
  // PayPal often blocks classic headless — default headed; opt into headless.
  const headless =
    opts.headless === true ||
    process.env.PAYPAL_APPROVE_HEADLESS === "1" ||
    process.env.PAYPAL_APPROVE_HEADLESS === "true";

  if (!approveUrl || !/paypal\.com/i.test(approveUrl)) {
    return { ok: false, error: "paypal_approve_url_required" };
  }
  if (!email || !password) {
    return { ok: false, error: "paypal_credentials_required" };
  }

  let browser;
  let context;
  const t0 = Date.now();
  try {
    browser = await chromium.launch({
      headless,
      proxy: proxyForPlaywright(opts.proxy),
      args: [
        "--disable-blink-features=AutomationControlled",
        "--disable-popup-blocking",
      ],
    });
    context = await browser.newContext({
      userAgent:
        process.platform === "win32"
          ? "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
          : "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
      locale: "en-AU",
      viewport: { width: 1280, height: 900 },
    });
    const page = await context.newPage();
    page.setDefaultTimeout(timeoutMs);
    log(`paypal_approve open ${approveUrl.slice(0, 120)}`);
    await page.goto(approveUrl, { waitUntil: "domcontentloaded", timeout: timeoutMs });

    // Email → Next → password → Log In (PayPal split login).
    await fillFirst(page, [
      'input#email',
      'input[name="login_email"]',
      'input[type="email"]',
      'input[autocomplete="username"]',
      'input[name="email"]',
    ], email);
    await clickFirst(page, [
      'button#btnNext',
      'button:has-text("Next")',
      'button[type="submit"]:has-text("Next")',
      '#btnNext',
    ]);
    await page.waitForTimeout(800);

    await fillFirst(page, [
      'input#password',
      'input[name="login_password"]',
      'input[type="password"]',
      'input[autocomplete="current-password"]',
    ], password);
    await clickFirst(page, [
      'button#btnLogin',
      'button:has-text("Log In")',
      'button:has-text("Log in")',
      'button[type="submit"]:has-text("Log")',
      '#btnLogin',
    ]);

    // Consent / Pay Now.
    const deadline = Date.now() + timeoutMs;
    let paid = false;
    while (Date.now() < deadline && !paid) {
      paid = await clickFirst(page, [
        'button[data-testid="submit-button"]',
        'button#payment-submit-btn',
        'button:has-text("Pay Now")',
        'button:has-text("Pay now")',
        'button:has-text("Complete Purchase")',
        'button:has-text("Agree & Pay")',
        'button:has-text("Agree and Pay")',
        'button:has-text("Continue")',
        'input[type="submit"][value*="Pay" i]',
      ]);
      if (paid) break;
      const url = page.url();
      if (/p-bandai\.com|global-e\.com\/.*(success|thank|order|confirmation)/i.test(url)) {
        paid = true;
        break;
      }
      await page.waitForTimeout(700);
    }

    // Wait for merchant return or PayPal success state.
    let finalUrl = page.url();
    const retDeadline = Date.now() + Math.min(45_000, timeoutMs);
    while (Date.now() < retDeadline) {
      finalUrl = page.url();
      if (
        /p-bandai\.com|global-e\.com/i.test(finalUrl) &&
        !/paypal\.com/i.test(finalUrl)
      ) {
        break;
      }
      if (/success|thank|confirmation|order/i.test(finalUrl)) break;
      await page.waitForTimeout(500);
    }

    const bodyText = await page.locator("body").innerText().catch(() => "");
    const orderGuess =
      (bodyText.match(/Order\s*(?:number|#|No\.?)[:\s]*([A-Z0-9-]{6,})/i) || [])[1] ||
      null;

    await context.close().catch(() => {});
    await browser.close().catch(() => {});
    const ok =
      paid ||
      /p-bandai\.com|global-e\.com/i.test(finalUrl) ||
      Boolean(orderGuess);
    log(
      `paypal_approve done ok=${ok} paid=${paid} order=${orderGuess || "-"} url=${finalUrl.slice(0, 100)}`,
    );
    return {
      ok,
      paid,
      orderNumber: orderGuess,
      finalUrl,
      ms: Date.now() - t0,
      via: "paypal-approve",
      note: ok
        ? `PayPal approved${orderGuess ? ` order=${orderGuess}` : ""}`
        : "PayPal approve incomplete (login/pay CTA)",
    };
  } catch (e) {
    try {
      await context?.close?.();
    } catch {
      /* ignore */
    }
    try {
      await browser?.close?.();
    } catch {
      /* ignore */
    }
    return {
      ok: false,
      error: String(e?.message || e).slice(0, 200),
      ms: Date.now() - t0,
      via: "paypal-approve",
    };
  }
}

export default { approvePaypalCheckout };
