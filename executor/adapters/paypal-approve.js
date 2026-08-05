/**
 * Complete a PayPal checkoutnow / approve URL via guest card checkout.
 * Uses the task billing profile (email + card + address) — not a PayPal login.
 *
 * Success is fail-closed: merchant return (Bandai / Global-E) or an explicit
 * PayPal success page. Clicking "Continue" alone is NOT success — that caused
 * a false paypal_approved with no Revolut ping (2026-08-05).
 */
import fs from "node:fs";
import path from "node:path";
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

function extractPayerId(url) {
  try {
    const u = new URL(String(url || ""));
    return u.searchParams.get("PayerID") || u.searchParams.get("payerID") || null;
  } catch {
    return null;
  }
}

function isMerchantReturn(url) {
  const u = String(url || "");
  if (!u || /paypal\.com/i.test(u)) return false;
  // Classic EC return lands on merchant/GE with token (+ often PayerID).
  return /p-bandai\.com|global-e\.com/i.test(u);
}

function isPaypalSuccessUrl(url) {
  const u = String(url || "");
  // Still on checkoutnow = not done, even if query has "success" noise.
  if (/checkoutnow/i.test(u)) return false;
  return /paypal\.com\/.*(checkout\/done|receipt|thank|success|webapps\/hermes)/i.test(u);
}

function looksChargedBody(text) {
  const t = String(text || "");
  if (/something went wrong|try again|payment.*(declined|failed|couldn't)|unable to process/i.test(t)) {
    return false;
  }
  return (
    /payment (was )?sent|you paid|thanks for your (order|payment)|order (is )?complete|transaction (id|completed)/i.test(
      t,
    ) || /Order\s*(?:number|#|No\.?)[:\s]*[A-Z0-9-]{6,}/i.test(t)
  );
}

async function fillInContext(ctx, selectors, value) {
  for (const sel of selectors) {
    const loc = ctx.locator(sel).first();
    if (!(await loc.count().catch(() => 0))) continue;
    if (!(await loc.isVisible().catch(() => false))) continue;
    await loc.fill(String(value), { timeout: 8_000 }).catch(async () => {
      await loc.click({ timeout: 3_000 }).catch(() => {});
      await ctx.keyboard?.type?.(String(value), { delay: 20 }).catch(async () => {
        await loc.pressSequentially(String(value), { delay: 20 }).catch(() => {});
      });
    });
    return true;
  }
  return false;
}

/** PayPal guest card fields are often PCI iframes — fill main page then frames. */
async function fillFirst(page, selectors, value) {
  if (value == null || value === "") return false;
  if (await fillInContext(page, selectors, value)) return true;
  for (const frame of page.frames()) {
    if (frame === page.mainFrame()) continue;
    // Skip tiny/tracker frames.
    const url = frame.url() || "";
    if (/google|doubleclick|facebook|analytics/i.test(url)) continue;
    if (await fillInContext(frame, selectors, value)) return true;
  }
  return false;
}

async function clickFirst(page, selectors, { timeout = 8_000, force = false } = {}) {
  for (const sel of selectors) {
    const loc = page.locator(sel).first();
    if (!(await loc.count().catch(() => 0))) continue;
    if (!force && !(await loc.isVisible().catch(() => false))) continue;
    if (!force && (await loc.isDisabled().catch(() => false))) continue;
    await loc
      .click({ timeout, noWaitAfter: true, force })
      .catch(async () => {
        if (!force) await loc.click({ timeout, force: true, noWaitAfter: true }).catch(() => {});
      });
    return sel;
  }
  return null;
}

async function openGuestCardPath(page, log) {
  // Live Bandai/GE PayPal login (2026-08-05): #startGuestOnboardingFlow
  // label = "Pay by Debit or Credit Card" (by, not with).
  const guestCtas = [
    "#startGuestOnboardingFlow",
    'button#startGuestOnboardingFlow',
    'button:has-text("Pay by Debit or Credit Card")',
    'a:has-text("Pay by Debit or Credit Card")',
    'button:has-text("Pay with Debit or Credit Card")',
    'a:has-text("Pay with Debit or Credit Card")',
    'button:has-text("Debit or Credit Card")',
    'a:has-text("Debit or Credit Card")',
    'button:has-text("Checkout as a Guest")',
    'a:has-text("Checkout as a Guest")',
    '[data-testid="pay-with-card"]',
    "#card-option",
  ];
  for (let i = 0; i < 5; i++) {
    const hit =
      (await clickFirst(page, guestCtas)) ||
      (await clickFirst(page, guestCtas, { force: true }));
    if (hit) {
      log(`paypal_guest clicked guest CTA (${hit})`);
      await page
        .waitForSelector(
          'input#cardNumber, input[name="cardNumber"], input[autocomplete="cc-number"], #credit-card-number, iframe[name*="card"], iframe[title*="card" i]',
          { timeout: 12_000 },
        )
        .catch(() => null);
      await page.waitForTimeout(800);
      return true;
    }
    await page.waitForTimeout(700);
  }
  return false;
}

async function dumpForensics(page, dir, tag) {
  if (!dir) return null;
  try {
    fs.mkdirSync(dir, { recursive: true });
    const base = path.join(dir, `paypal-guest-${tag}-${Date.now()}`);
    const url = page.url();
    const text = await page.locator("body").innerText().catch(() => "");
    const html = await page.content().catch(() => "");
    fs.writeFileSync(`${base}.url.txt`, url);
    fs.writeFileSync(`${base}.txt`, String(text).slice(0, 12_000));
    fs.writeFileSync(`${base}.html`, String(html).slice(0, 200_000));
    await page.screenshot({ path: `${base}.png`, fullPage: true }).catch(() => {});
    return base;
  } catch {
    return null;
  }
}

/**
 * @param {object} opts
 * @param {string} opts.approveUrl
 * @param {object} [opts.profile]
 * @param {object} [opts.card]
 * @param {string} [opts.email]
 * @param {string} [opts.proxy]
 * @param {boolean} [opts.headless]
 * @param {number} [opts.timeoutMs]
 * @param {string} [opts.forensicsDir]
 * @param {(m:string)=>void} [opts.log]
 */
export async function approvePaypalCheckout(opts = {}) {
  const approveUrl = String(opts.approveUrl || "").trim();
  const log = typeof opts.log === "function" ? opts.log : () => {};
  const timeoutMs = Math.min(180_000, Math.max(30_000, Number(opts.timeoutMs) || 120_000));
  const headless =
    opts.headless === true ||
    process.env.PAYPAL_APPROVE_HEADLESS === "1" ||
    process.env.PAYPAL_APPROVE_HEADLESS === "true";
  const forensicsDir =
    opts.forensicsDir ||
    process.env.PAYPAL_GUEST_FORENSICS_DIR ||
    path.join(process.cwd(), "artifacts", "paypal-guest");

  const billing = pickBilling(opts);
  const card = pickCard(opts);
  const trail = [];

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
    page.on("framenavigated", (frame) => {
      if (frame === page.mainFrame()) trail.push(frame.url());
    });

    log(`paypal_guest open ${approveUrl.slice(0, 120)}`);
    await page.goto(approveUrl, { waitUntil: "domcontentloaded", timeout: timeoutMs });
    await dumpForensics(page, forensicsDir, "open");

    const guestOpened = await openGuestCardPath(page, log);
    log(`paypal_guest guestPath=${guestOpened}`);

    const emailFilled = await fillFirst(
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
    // Next after email — not a pay confirmation.
    await clickFirst(page, [
      'button#btnNext',
      'button:has-text("Next")',
      'button[type="submit"]:has-text("Next")',
      '#btnNext',
    ]);
    await page.waitForTimeout(800);
    await openGuestCardPath(page, log);

    const cardFilled = await fillFirst(
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
    let expFilled =
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
      (await fillFirst(page, ['input#expiryDate', 'input[name="expiryDate"]'], expCombined));
    if (!expFilled) {
      expFilled =
        (await fillFirst(
          page,
          ['input[name="expMonth"]', 'input#expMonth', 'select#expMonth'],
          card.expMonth,
        )) &&
        (await fillFirst(
          page,
          ['input[name="expYear"]', 'input#expYear', 'select#expYear'],
          card.expYear.length === 2 ? `20${card.expYear}` : card.expYear,
        ));
    }
    const cvvFilled = await fillFirst(
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
      [
        'input#billingCity',
        'input[name="billingCity"]',
        'input[name="city"]',
        'input[autocomplete="address-level2"]',
      ],
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

    log(
      `paypal_guest filled email=${emailFilled} card=${cardFilled} exp=${Boolean(expFilled)} cvv=${cvvFilled}`,
    );
    await dumpForensics(page, forensicsDir, "filled");

    // Guest /pay/ step 1: email → Continue to Payment → card fields (2026-08-05 forensics).
    const advanceCtas = [
      'button:has-text("Continue to Payment")',
      'button:has-text("Continue to Review")',
      'button:has-text("Continue")',
      'button#btnNext',
      'button:has-text("Next")',
    ];
    // Real charge CTAs only.
    const payCtas = [
      'button[data-testid="submit-button"]',
      'button#payment-submit-btn',
      'button:has-text("Pay Now")',
      'button:has-text("Pay now")',
      'button:has-text("Complete Purchase")',
      'button:has-text("Agree & Pay")',
      'button:has-text("Agree and Pay")',
      'button:has-text("Submit Order")',
      'input[type="submit"][value*="Pay" i]',
    ];

    // Always try guest email + Continue to Payment once on /pay/ (card fields are next).
    for (let gate = 0; gate < 3; gate++) {
      if (!/\/pay\//i.test(page.url()) && !/guest/i.test(await page.locator("body").innerText().catch(() => ""))) {
        break;
      }
      await fillFirst(
        page,
        [
          'input#email',
          'input[type="email"]',
          'input[name="email"]',
          'input[autocomplete="email"]',
          'input[placeholder*="email" i]',
        ],
        billing.email,
      );
      const adv = await clickFirst(
        page,
        ['button:has-text("Continue to Payment")', 'button:has-text("Continue")'],
        { force: true },
      );
      if (adv) {
        log(`paypal_guest advance after email (${adv}) gate=${gate}`);
        await page
          .waitForSelector(
            'input#cardNumber, input[name="cardNumber"], input[autocomplete="cc-number"], iframe[title*="card" i], iframe[name*="card" i], iframe[src*="card"]',
            { timeout: 15_000 },
          )
          .catch(() => null);
        await page.waitForTimeout(1200);
        // Stop gating once card-ish UI appears or URL leaves guest email step.
        const body = await page.locator("body").innerText().catch(() => "");
        if (/card number|expiry|security code|cvv|csc/i.test(body)) break;
        if (!/Continue to Payment/i.test(body)) break;
      } else {
        break;
      }
    }
    await dumpForensics(page, forensicsDir, "after-continue-payment");

    // Re-attempt card fill after Continue to Payment (fields often appear then).
    const cardFilled2 =
      cardFilled ||
      (await fillFirst(
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
      ));
    const cvvFilled2 =
      cvvFilled ||
      (await fillFirst(
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
      ));
    if (!expFilled) {
      await fillFirst(
        page,
        [
          'input#cardExpiry',
          'input[name="cardExpiry"]',
          'input[autocomplete="cc-exp"]',
          'input[aria-label*="expir" i]',
        ],
        `${card.expMonth} / ${card.expYear}`,
      );
    }
    log(`paypal_guest after-advance card=${cardFilled2} cvv=${cvvFilled2}`);
    await dumpForensics(page, forensicsDir, "after-advance");

    let payClicked = null;
    let navClicks = 0;
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (isMerchantReturn(page.url()) || isPaypalSuccessUrl(page.url())) break;

      const payHit = await clickFirst(page, payCtas);
      if (payHit) {
        payClicked = payHit;
        log(`paypal_guest pay CTA (${payHit})`);
        await page.waitForTimeout(1200);
        continue;
      }

      // Advance CTAs are OK on guest email / review steps — not success by themselves.
      const navHit = await clickFirst(page, advanceCtas);
      if (navHit) {
        navClicks += 1;
        log(`paypal_guest nav CTA (${navHit}) #${navClicks}`);
        // After each advance, try card fields again (lazy-mounted iframes).
        if (!cardFilled2) {
          await fillFirst(
            page,
            ['input#cardNumber', 'input[name="cardNumber"]', 'input[autocomplete="cc-number"]'],
            card.number,
          );
        }
        await page.waitForTimeout(900);
        continue;
      }

      await page.waitForTimeout(700);
    }

    // Wait for merchant return / success after a real Pay click.
    const retDeadline = Date.now() + Math.min(60_000, timeoutMs);
    while (Date.now() < retDeadline) {
      if (isMerchantReturn(page.url()) || isPaypalSuccessUrl(page.url())) break;
      if (payClicked) {
        await clickFirst(page, payCtas);
      }
      await page.waitForTimeout(600);
    }

    const finalUrl = page.url();
    const bodyText = await page.locator("body").innerText().catch(() => "");
    const orderGuess =
      (bodyText.match(/Order\s*(?:number|#|No\.?)[:\s]*([A-Z0-9-]{6,})/i) || [])[1] || null;
    const payerId =
      extractPayerId(finalUrl) ||
      trail.map(extractPayerId).find(Boolean) ||
      null;
    const merchantReturned = isMerchantReturn(finalUrl);
    const paypalSuccessPage = isPaypalSuccessUrl(finalUrl);
    const bodyOk = looksChargedBody(bodyText);
    const stillOnPaypalPayUi = /checkoutnow|paypal\.com\/pay\//i.test(finalUrl);

    // Fail-closed: Express Checkout proof is merchant/GE return (ideally + PayerID).
    // Guest email "Continue" / staying on /pay/ is NOT a charge (false Revolut miss 2026-08-05).
    const ok =
      (merchantReturned || paypalSuccessPage || (bodyOk && !stillOnPaypalPayUi && Boolean(payerId))) &&
      !stillOnPaypalPayUi;

    const forensicBase = await dumpForensics(page, forensicsDir, ok ? "done-ok" : "done-fail");

    await context.close().catch(() => {});
    await browser.close().catch(() => {});

    const note = ok
      ? `PayPal guest charged${orderGuess ? ` order=${orderGuess}` : ""}${
          merchantReturned ? " merchant_return" : ""
        }${payerId ? ` payerId=${payerId}` : ""}`
      : stillOnPaypalPayUi
        ? `PayPal guest incomplete — still on PayPal UI (cardFilled=${cardFilled2} payClicked=${payClicked || "none"} nav=${navClicks})`
        : `PayPal guest incomplete (cardFilled=${cardFilled2} payClicked=${payClicked || "none"} url=${finalUrl.slice(0, 80)})`;

    log(`paypal_guest done ok=${ok} ${note}`);
    return {
      ok,
      paid: ok,
      merchantReturned,
      paypalSuccessPage,
      payerId,
      cardFilled: Boolean(cardFilled2),
      payClicked: payClicked || null,
      navClicks,
      orderNumber: orderGuess,
      finalUrl,
      trail: trail.slice(-12),
      forensics: forensicBase,
      ms: Date.now() - t0,
      via: "paypal-guest",
      note,
      error: ok ? undefined : "paypal_guest_not_completed",
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
      trail: trail.slice(-12),
    };
  }
}

export default { approvePaypalCheckout };
