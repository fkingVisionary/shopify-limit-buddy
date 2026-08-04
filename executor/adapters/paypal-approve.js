/**
 * Complete a PayPal checkoutnow / approve URL via guest card checkout.
 * Uses the task billing profile (email + card + address) — not a PayPal login.
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

function pickCard(opts = {}) {
  const card = opts.card || {};
  const profile = opts.profile || {};
  const number = String(card.number || profile.card_number || "")
    .replace(/\s+/g, "")
    .trim();
  const cvv = String(card.cvv || profile.card_cvv || "").trim();
  const expMonth = String(card.expMonth || profile.card_exp_month || "")
    .trim()
    .padStart(2, "0");
  let expYear = String(card.expYear || profile.card_exp_year || "").trim();
  if (expYear.length === 4) expYear = expYear.slice(-2);
  const holder =
    String(card.holder || profile.card_name || "").trim() ||
    [profile.first_name, profile.last_name].filter(Boolean).join(" ").trim() ||
    "";
  return { number, cvv, expMonth, expYear, holder };
}

function pickBilling(opts = {}) {
  const profile = opts.profile || {};
  return {
    email: String(opts.email || profile.email || "").trim(),
    firstName: String(profile.first_name || "").trim(),
    lastName: String(profile.last_name || "").trim(),
    address1: String(profile.address1 || profile.address || "").trim(),
    city: String(profile.city || "").trim(),
    province: String(profile.province || profile.state || "").trim(),
    zip: String(profile.zip || profile.postcode || "").trim(),
    phone: String(profile.phone || "").trim(),
    country: String(profile.country || "AU").trim() || "AU",
  };
}

async function fillFirst(page, selectors, value) {
  if (value == null || value === "") return false;
  for (const sel of selectors) {
    const loc = page.locator(sel).first();
    if (!(await loc.count().catch(() => 0))) continue;
    if (!(await loc.isVisible().catch(() => false))) continue;
    await loc.fill(String(value), { timeout: 8_000 }).catch(async () => {
      await loc.click({ timeout: 3_000 }).catch(() => {});
      await page.keyboard.type(String(value), { delay: 20 });
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

async function openGuestCardPath(page, log) {
  const guestCtas = [
    'a:has-text("Pay with Debit or Credit Card")',
    'button:has-text("Pay with Debit or Credit Card")',
    'a:has-text("Debit or Credit Card")',
    'button:has-text("Debit or Credit Card")',
    'a:has-text("Checkout as a Guest")',
    'button:has-text("Checkout as a Guest")',
    'a:has-text("Pay with a credit or debit card")',
    'button:has-text("Pay with a credit or debit card")',
    '[data-testid="pay-with-card"]',
    '#card-option',
    'a[href*="guest"]',
  ];
  for (let i = 0; i < 4; i++) {
    if (await clickFirst(page, guestCtas)) {
      log("paypal_guest clicked debit/credit / guest CTA");
      await page.waitForTimeout(900);
      return true;
    }
    // Sometimes guest is behind "Create an Account" toggle / continue without login.
    await clickFirst(page, [
      'a:has-text("Click here")',
      'button:has-text("Guest")',
      'text=Checkout as Guest',
    ]);
    await page.waitForTimeout(600);
  }
  return false;
}

/**
 * @param {object} opts
 * @param {string} opts.approveUrl
 * @param {object} [opts.profile] — billing profile (email/address/card fields)
 * @param {object} [opts.card] — { number, expMonth, expYear, cvv, holder }
 * @param {string} [opts.email]
 * @param {string} [opts.proxy]
 * @param {boolean} [opts.headless]
 * @param {number} [opts.timeoutMs]
 * @param {(m:string)=>void} [opts.log]
 */
export async function approvePaypalCheckout(opts = {}) {
  const approveUrl = String(opts.approveUrl || "").trim();
  const log = typeof opts.log === "function" ? opts.log : () => {};
  const timeoutMs = Math.min(180_000, Math.max(30_000, Number(opts.timeoutMs) || 90_000));
  const headless =
    opts.headless === true ||
    process.env.PAYPAL_APPROVE_HEADLESS === "1" ||
    process.env.PAYPAL_APPROVE_HEADLESS === "true";

  const billing = pickBilling(opts);
  const card = pickCard(opts);

  if (!approveUrl || !/paypal\.com/i.test(approveUrl)) {
    return { ok: false, error: "paypal_approve_url_required" };
  }
  if (!billing.email) {
    return { ok: false, error: "paypal_guest_needs_billing_email" };
  }
  if (!card.number || !card.cvv || !card.expMonth || !card.expYear) {
    return { ok: false, error: "paypal_guest_needs_billing_card" };
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
    log(`paypal_guest open ${approveUrl.slice(0, 120)}`);
    await page.goto(approveUrl, { waitUntil: "domcontentloaded", timeout: timeoutMs });

    await openGuestCardPath(page, log);

    // Email (guest path often asks before card form).
    await fillFirst(
      page,
      [
        'input#email',
        'input[name="login_email"]',
        'input[type="email"]',
        'input[autocomplete="email"]',
        'input[name="email"]',
        'input#guestEmail',
      ],
      billing.email,
    );
    await clickFirst(page, [
      'button#btnNext',
      'button:has-text("Next")',
      'button:has-text("Continue")',
      'button[type="submit"]:has-text("Next")',
      'button[type="submit"]:has-text("Continue")',
      '#btnNext',
    ]);
    await page.waitForTimeout(700);

    // Prefer guest card again after email step (PayPal sometimes re-prompts login).
    await openGuestCardPath(page, log);

    // Card fields (PayPal guest / hosted fields vary).
    await fillFirst(
      page,
      [
        'input#cardNumber',
        'input[name="cardNumber"]',
        'input[name="cardnumber"]',
        'input[autocomplete="cc-number"]',
        'input[data-testid="cardNumber"]',
        'input[aria-label*="card number" i]',
      ],
      card.number,
    );
    const expCombined = `${card.expMonth}${card.expYear.length === 2 ? card.expYear : card.expYear.slice(-2)}`;
    const filledExp =
      (await fillFirst(
        page,
        [
          'input#cardExpiry',
          'input[name="cardExpiry"]',
          'input[name="expiry"]',
          'input[autocomplete="cc-exp"]',
          'input[aria-label*="expir" i]',
        ],
        `${card.expMonth} / ${card.expYear}`,
      )) ||
      (await fillFirst(
        page,
        ['input#expiryDate', 'input[name="expiryDate"]'],
        expCombined,
      ));
    if (!filledExp) {
      await fillFirst(
        page,
        ['input[name="expMonth"]', 'input#expMonth', 'select#expMonth'],
        card.expMonth,
      );
      await fillFirst(
        page,
        ['input[name="expYear"]', 'input#expYear', 'select#expYear'],
        card.expYear.length === 2 ? `20${card.expYear}` : card.expYear,
      );
    }
    await fillFirst(
      page,
      [
        'input#cardCvv',
        'input#cvv',
        'input[name="cardCvv"]',
        'input[name="cvv"]',
        'input[autocomplete="cc-csc"]',
        'input[aria-label*="CSC" i]',
        'input[aria-label*="security" i]',
      ],
      card.cvv,
    );
    await fillFirst(
      page,
      [
        'input#cardHolderName',
        'input[name="cardHolderName"]',
        'input[autocomplete="cc-name"]',
        'input[name="name"]',
      ],
      card.holder,
    );

    // Billing address from task profile.
    await fillFirst(
      page,
      ['input#billingFirstName', 'input[name="billingFirstName"]', 'input[name="firstName"]'],
      billing.firstName,
    );
    await fillFirst(
      page,
      ['input#billingLastName', 'input[name="billingLastName"]', 'input[name="lastName"]'],
      billing.lastName,
    );
    await fillFirst(
      page,
      [
        'input#billingAddressLine1',
        'input[name="billingAddressLine1"]',
        'input[name="line1"]',
        'input[autocomplete="address-line1"]',
        'input#billingLine1',
      ],
      billing.address1,
    );
    await fillFirst(
      page,
      ['input#billingCity', 'input[name="billingCity"]', 'input[name="city"]', 'input[autocomplete="address-level2"]'],
      billing.city,
    );
    await fillFirst(
      page,
      [
        'input#billingState',
        'input[name="billingState"]',
        'select#billingState',
        'select[name="billingState"]',
        'input[name="state"]',
        'select[name="state"]',
      ],
      billing.province,
    );
    await fillFirst(
      page,
      [
        'input#billingPostalCode',
        'input[name="billingPostalCode"]',
        'input[name="postalCode"]',
        'input[autocomplete="postal-code"]',
        'input#billingZip',
      ],
      billing.zip,
    );
    await fillFirst(
      page,
      ['input#billingPhone', 'input[name="billingPhone"]', 'input[type="tel"]', 'input[name="phone"]'],
      billing.phone,
    );

    const deadline = Date.now() + timeoutMs;
    let paid = false;
    while (Date.now() < deadline && !paid) {
      paid = await clickFirst(page, [
        'button[data-testid="submit-button"]',
        'button#payment-submit-btn',
        'button:has-text("Pay Now")',
        'button:has-text("Pay now")',
        'button:has-text("Continue to Review")',
        'button:has-text("Continue")',
        'button:has-text("Complete Purchase")',
        'button:has-text("Agree & Pay")',
        'button:has-text("Agree and Pay")',
        'button:has-text("Submit Order")',
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

    let finalUrl = page.url();
    const retDeadline = Date.now() + Math.min(45_000, timeoutMs);
    while (Date.now() < retDeadline) {
      finalUrl = page.url();
      if (/p-bandai\.com|global-e\.com/i.test(finalUrl) && !/paypal\.com/i.test(finalUrl)) {
        break;
      }
      if (/success|thank|confirmation|order/i.test(finalUrl)) break;
      // After "Continue to Review", hit Pay Now once more.
      await clickFirst(page, [
        'button[data-testid="submit-button"]',
        'button#payment-submit-btn',
        'button:has-text("Pay Now")',
        'button:has-text("Pay now")',
        'button:has-text("Agree & Pay")',
      ]);
      await page.waitForTimeout(500);
    }

    const bodyText = await page.locator("body").innerText().catch(() => "");
    const orderGuess =
      (bodyText.match(/Order\s*(?:number|#|No\.?)[:\s]*([A-Z0-9-]{6,})/i) || [])[1] || null;

    await context.close().catch(() => {});
    await browser.close().catch(() => {});
    const ok =
      paid ||
      /p-bandai\.com|global-e\.com/i.test(finalUrl) ||
      Boolean(orderGuess);
    log(
      `paypal_guest done ok=${ok} paid=${paid} order=${orderGuess || "-"} url=${finalUrl.slice(0, 100)}`,
    );
    return {
      ok,
      paid,
      orderNumber: orderGuess,
      finalUrl,
      ms: Date.now() - t0,
      via: "paypal-guest",
      note: ok
        ? `PayPal guest approved${orderGuess ? ` order=${orderGuess}` : ""}`
        : "PayPal guest incomplete (card/pay CTA)",
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
      via: "paypal-guest",
    };
  }
}

export default { approvePaypalCheckout };
