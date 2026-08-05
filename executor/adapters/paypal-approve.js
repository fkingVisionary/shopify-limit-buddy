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

/** Guest email — wait for input (body text races ahead of mount). */
async function fillGuestEmail(page, email, log) {
  await dismissPaypalCookies(page, log);
  // Wait up to 15s for guest email field — openGuest used to return early on text.
  const waited = await page
    .waitForSelector("#onboardingFlowEmail, input[placeholder='Enter email address']", {
      state: "attached",
      timeout: 15_000,
    })
    .then(() => true)
    .catch(() => false);
  if (!waited) {
    // Try frames (some PayPal builds iframe the guest form).
    for (const frame of page.frames()) {
      if (frame === page.mainFrame()) continue;
      const handle = await frame
        .waitForSelector("#onboardingFlowEmail, input[placeholder='Enter email address']", {
          state: "attached",
          timeout: 2_000,
        })
        .catch(() => null);
      if (handle) {
        log(`paypal_guest email in frame ${String(frame.url() || "").slice(0, 60)}`);
        await handle.click({ force: true }).catch(() => {});
        await handle.fill(String(email), { force: true }).catch(() => {});
        const v = await handle.inputValue().catch(() => "");
        if (/@/.test(v)) {
          log("paypal_guest email filled via=frame");
          return true;
        }
      }
    }
    log("paypal_guest email fill FAILED — input never mounted");
    return false;
  }
  await page.waitForTimeout(400);

  // Click Accept only (do not strip random cookie nodes — can break the form).
  await page
    .evaluate(() => {
      document.querySelectorAll("button").forEach((b) => {
        if (/^Accept$/i.test(String(b.textContent || "").trim())) b.click();
      });
    })
    .catch(() => {});

  const ok = await page.evaluate((addr) => {
    const candidates = [
      document.querySelector("#onboardingFlowEmail"),
      document.querySelector('input[placeholder="Enter email address"]'),
      ...Array.from(document.querySelectorAll('input[type="email"]')).filter(
        (el) => el.id !== "email" && el.offsetParent !== null,
      ),
    ].filter(Boolean);
    const el = candidates[0];
    if (!el) return { ok: false, reason: "no_input" };
    el.focus();
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
    if (setter) setter.call(el, String(addr || ""));
    else el.value = String(addr || "");
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    el.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true }));
    el.dispatchEvent(new Event("blur", { bubbles: true }));
    return { ok: /@/.test(el.value || ""), value: String(el.value || "").slice(0, 40), id: el.id || "" };
  }, String(email || ""));

  if (ok?.ok) {
    log(`paypal_guest email DOM-filled id=${ok.id} val=${String(ok.value || "").slice(0, 6)}…`);
    return true;
  }
  // Keyboard type — PayPal React often ignores .value setter / fill().
  const loc = page.locator("#onboardingFlowEmail, input[placeholder='Enter email address']").first();
  if (await loc.count().catch(() => 0)) {
    await loc.click({ force: true, timeout: 5_000 }).catch(() => {});
    await page.keyboard.press("Control+A").catch(() => {});
    await page.keyboard.press("Backspace").catch(() => {});
    await page.keyboard.type(String(email), { delay: 35 }).catch(() => {});
    const v = await loc.inputValue().catch(() => "");
    if (/@/.test(v)) {
      log(`paypal_guest email filled via=keyboard val=${v.slice(0, 6)}…`);
      return true;
    }
  }
  log(`paypal_guest email fill FAILED ${JSON.stringify(ok)}`);
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

/** AU guest phone field already shows +61 — strip country / leading 0. */
function auPhoneLocal(phone) {
  let p = String(phone || "").replace(/\D/g, "");
  if (p.startsWith("61") && p.length >= 11) p = p.slice(2);
  if (p.startsWith("0") && p.length >= 9) p = p.slice(1);
  return p;
}

const AU_STATE_LABELS = {
  QLD: "Queensland",
  NSW: "New South Wales",
  VIC: "Victoria",
  SA: "South Australia",
  WA: "Western Australia",
  TAS: "Tasmania",
  ACT: "Australian Capital Territory",
  NT: "Northern Territory",
};

/**
 * Live Weasley guest form (2026-08-05): create-account toggle defaults ON and
 * turns Pay into "Create Account and Continue". Guest path = toggle OFF.
 */
async function disableCreateAccountToggle(page, log) {
  const sw = page
    .locator('[data-testid="onboard-options-switch"], input[role="switch"][value="signup"]')
    .first();
  if (!(await sw.count().catch(() => 0))) return false;
  const checked = await sw.isChecked().catch(() => false);
  if (!checked) {
    log("paypal_guest create-account toggle already off");
    return true;
  }
  await sw.click({ force: true }).catch(async () => {
    await page
      .locator('text=Save information & create your PayPal account')
      .first()
      .click({ force: true })
      .catch(() => {});
  });
  await page.waitForTimeout(500);
  const still = await sw.isChecked().catch(() => true);
  log(`paypal_guest create-account toggle off=${!still}`);
  return !still;
}

/** Force AU country — PayPal defaulted to UK/GB on Noontide (2026-08-05). */
async function selectAustraliaCountry(page, log) {
  const country = page.locator('select#country, select[name="country"], select[data-testid*="country" i]').first();
  if (!(await country.count().catch(() => 0))) return false;
  const before = await country.inputValue().catch(() => "");
  await country
    .selectOption({ label: "Australia" })
    .catch(async () => country.selectOption({ value: "AU" }).catch(() => {}));
  await page.waitForTimeout(800);
  const after = await country.inputValue().catch(() => "");
  log(`paypal_guest country ${before || "?"}→${after || "?"}`);
  return /AU|Australia/i.test(after) || after !== before;
}

/** Fill contact + AU billing — IDs from checkoutweb/signup forensics. */
async function fillGuestContactAndAddress(page, billing, log) {
  await selectAustraliaCountry(page, log);
  const phone = auPhoneLocal(billing.phone);
  const filled = {
    first: await fillFirst(
      page,
      ['input#firstName', '[data-testid="firstNameInput"]', 'input[name="fname"]'],
      billing.firstName,
    ),
    last: await fillFirst(
      page,
      ['input#lastName', '[data-testid="lastNameInput"]', 'input[name="lname"]'],
      billing.lastName,
    ),
    phone: await fillFirst(
      page,
      ['input#phone', '[data-testid="phone"]'],
      phone || billing.phone,
    ),
    line1: await fillFirst(
      page,
      ['input#billingLine1', 'input[name="billingLine1"]'],
      billing.address1,
    ),
    city: await fillFirst(
      page,
      ['input#billingCity', 'input[name="billingCity"]'],
      billing.city,
    ),
    zip: await fillFirst(
      page,
      ['input#billingPostalCode', 'input[name="billingPostalCode"]'],
      billing.zip,
    ),
    state: false,
  };

  const stateSel = page.locator('select#billingState, select[name="billingState"]').first();
  if (await stateSel.count().catch(() => 0)) {
    const prov = String(billing.province || "QLD").trim().toUpperCase();
    const label = AU_STATE_LABELS[prov] || billing.province;
    await stateSel
      .selectOption({ label })
      .catch(async () =>
        stateSel
          .selectOption({ value: prov })
          .catch(async () => stateSel.selectOption({ label: prov }).catch(() => {})),
      );
    const v = await stateSel.inputValue().catch(() => "");
    filled.state = Boolean(v);
  }

  log(
    `paypal_guest address fill first=${filled.first} last=${filled.last} phone=${filled.phone} line1=${filled.line1} city=${filled.city} state=${filled.state} zip=${filled.zip}`,
  );
  return filled;
}

async function fillGuestCardFields(page, card, log) {
  const cardFilled = await fillFirst(
    page,
    [
      'input#cardNumber',
      'input[name="cardNumber"]',
      'input[name="cardnumber"]',
      'input[autocomplete="cc-number"]',
      'input[data-testid="cardNumber"]',
    ],
    card.number,
  );
  const expFilled =
    (await fillFirst(
      page,
      ['input#cardExpiry', 'input[name="cardExpiry"]', 'input[autocomplete="cc-exp"]'],
      `${card.expMonth} / ${card.expYear}`,
    )) ||
    (await fillFirst(page, ['input#expiryDate', 'input[name="expiryDate"]'], `${card.expMonth}${card.expYear}`));
  const cvvFilled = await fillFirst(
    page,
    ['input#cardCvv', 'input#cvv', 'input[name="cardCvv"]', 'input[name="cvv"]', 'input[autocomplete="cc-csc"]'],
    card.cvv,
  );
  log(`paypal_guest card fill card=${cardFilled} exp=${Boolean(expFilled)} cvv=${cvvFilled}`);
  return { cardFilled, expFilled: Boolean(expFilled), cvvFilled };
}

async function dismissPaypalCookies(page, log) {
  const hit = await clickFirst(
    page,
    [
      'button:has-text("Accept")',
      'button:has-text("Accept Cookies")',
      '#acceptAllButton',
      'button[data-testid="accept-cookies"]',
    ],
    { force: true },
  );
  if (hit) {
    log(`paypal_guest cookies (${hit})`);
    await page.waitForTimeout(400);
  }
  return Boolean(hit);
}

async function openGuestCardPath(page, log) {
  // Live Bandai/GE PayPal login (2026-08-05): #startGuestOnboardingFlow
  // label = "Pay by Debit or Credit Card" (by, not with).
  // Cookie banner + login "Next" used to steal clicks (nav=121, cardFilled=false).
  await dismissPaypalCookies(page, log);
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
  for (let i = 0; i < 8; i++) {
    await dismissPaypalCookies(page, log);
    // Only treat as ready when the guest email INPUT exists (body text races).
    const emailReady = await page
      .locator("#onboardingFlowEmail, input[placeholder='Enter email address']")
      .first()
      .count()
      .catch(() => 0);
    if (emailReady) {
      log("paypal_guest already on guest form (email input present)");
      return true;
    }
    const cardReady = await page
      .locator('input#cardNumber, input[autocomplete="cc-number"]')
      .first()
      .count()
      .catch(() => 0);
    if (cardReady) {
      log("paypal_guest already on card form");
      return true;
    }
    const hit =
      (await clickFirst(page, guestCtas)) ||
      (await clickFirst(page, guestCtas, { force: true }));
    if (hit) {
      log(`paypal_guest clicked guest CTA (${hit})`);
      await page
        .waitForSelector(
          'input#cardNumber, input[name="cardNumber"], input[autocomplete="cc-number"], #credit-card-number, iframe[name*="card"], iframe[title*="card" i], input#email, button:has-text("Continue to Payment")',
          { timeout: 15_000 },
        )
        .catch(() => null);
      await page.waitForTimeout(1000);
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
  const timeoutMs = Math.min(240_000, Math.max(30_000, Number(opts.timeoutMs) || 180_000));
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
    await page.waitForTimeout(1200);
    await dismissPaypalCookies(page, log);
    await dumpForensics(page, forensicsDir, "open");

    // Guest CTA FIRST — never click login "Next" on the wall (that caused nav=121).
    let guestOpened = await openGuestCardPath(page, log);
    log(`paypal_guest guestPath=${guestOpened}`);
    if (!guestOpened) {
      await dumpForensics(page, forensicsDir, "guest-cta-miss");
      // One more hard attempt after Accept.
      await dismissPaypalCookies(page, log);
      guestOpened = await openGuestCardPath(page, log);
      log(`paypal_guest guestPath_retry=${guestOpened}`);
    }

    const onLoginWall = /Log in to PayPal|Pay by Debit or Credit Card/i.test(
      await page.locator("body").innerText().catch(() => ""),
    );
    let emailFilled = false;
    if (!onLoginWall || guestOpened) {
      emailFilled = await fillGuestEmail(page, billing.email, log);
    }
    // Only click Continue to Payment on guest email step — never login Next.
    const bodyAfterGuest = await page.locator("body").innerText().catch(() => "");
    if (/Continue to Payment|Check out as a guest/i.test(bodyAfterGuest)) {
      if (!emailFilled) emailFilled = await fillGuestEmail(page, billing.email, log);
      if (emailFilled) {
        await clickFirst(page, [
          'button:has-text("Continue to Payment")',
          'button.actionContinue:has-text("Continue")',
        ]);
        await page.waitForTimeout(1500);
      }
    }
    // Wait for Weasley card form AFTER Continue to Payment (not before).
    await page
      .waitForSelector(
        'input#cardNumber, input[autocomplete="cc-number"], text=Pay with debit or credit card',
        { timeout: 30_000 },
      )
      .catch(() => null);
    await page.waitForTimeout(1000);

    let { cardFilled, expFilled, cvvFilled } = await fillGuestCardFields(page, card, log);
    await fillGuestContactAndAddress(page, billing, log);
    await disableCreateAccountToggle(page, log);

    log(
      `paypal_guest filled email=${emailFilled} card=${cardFilled} exp=${Boolean(expFilled)} cvv=${cvvFilled}`,
    );
    await dumpForensics(page, forensicsDir, "filled");

    // Review advance only. "Continue to Payment" is gated on verified email fill.
    const advanceCtas = ['button:has-text("Continue to Review")'];
    const continuePaymentCtas = [
      'button:has-text("Continue to Payment")',
      'button.actionContinue:has-text("Continue to Payment")',
    ];
    // Real charge CTAs only — never "Create Account and Continue" (toggle must be OFF).
    const payCtas = [
      'button[data-testid="submit-button"]:has-text("Pay Now")',
      'button[data-testid="submit-button"]:has-text("Pay now")',
      'button[data-testid="submit-button"]:has-text("Agree & Pay")',
      'button[data-testid="submit-button"]:has-text("Agree and Pay")',
      'button[data-testid="submit-button"]:has-text("Continue to Review")',
      'button[data-testid="submit-button"]:has-text("Pay")',
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
      const gateBody = await page.locator("body").innerText().catch(() => "");
      if (
        !/\/pay\//i.test(page.url()) &&
        !/Check out as a guest|Continue to Payment|guest/i.test(gateBody)
      ) {
        break;
      }
      const filledGate = await fillGuestEmail(page, billing.email, log);
      if (!filledGate) break;
      const adv = await clickFirst(
        page,
        [
          'button:has-text("Continue to Payment")',
          'button.actionContinue:has-text("Continue")',
        ],
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

    // Signup/guest_user re-mount — country AU + card + address + toggle OFF.
    const refill = await fillGuestCardFields(page, card, log);
    const cardFilled2 = cardFilled || refill.cardFilled;
    const cvvFilled2 = cvvFilled || refill.cvvFilled;
    await fillGuestContactAndAddress(page, billing, log);
    await disableCreateAccountToggle(page, log);
    log(`paypal_guest after-advance card=${cardFilled2} cvv=${cvvFilled2}`);
    await dumpForensics(page, forensicsDir, "after-advance");

    let payClicked = null;
    let navClicks = 0;
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (isMerchantReturn(page.url()) || isPaypalSuccessUrl(page.url())) break;

      const bodyNow = await page.locator("body").innerText().catch(() => "");
      // Still on login wall → only guest CTA / cookies, never Next/Continue spam.
      if (/Log in to PayPal/i.test(bodyNow) && /Pay by Debit or Credit Card/i.test(bodyNow)) {
        await dismissPaypalCookies(page, log);
        await openGuestCardPath(page, log);
        await page.waitForTimeout(800);
        continue;
      }

      // Keep guest mode if PayPal re-checks the create-account switch.
      if (
        /signup|guest_user|checkoutweb/i.test(page.url()) ||
        /Create Account/i.test(bodyNow)
      ) {
        await fillGuestContactAndAddress(page, billing, log);
        await disableCreateAccountToggle(page, log);
      }

      const payHit = await clickFirst(page, payCtas);
      if (payHit) {
        payClicked = payHit;
        log(`paypal_guest pay CTA (${payHit})`);
        await page.waitForTimeout(1500);
        continue;
      }

      // Guest email gate — never click Continue to Payment on empty email.
      if (/Check out as a guest|Continue to Payment/i.test(bodyNow) && !/card number|Pay with debit/i.test(bodyNow)) {
        const em = await fillGuestEmail(page, billing.email, log);
        if (em) {
          const cont = await clickFirst(page, continuePaymentCtas, { force: true });
          log(`paypal_guest continue-payment after email (${cont || "miss"})`);
          await page.waitForTimeout(1500);
        } else {
          log("paypal_guest skip Continue to Payment — email empty");
          await page.waitForTimeout(800);
        }
        continue;
      }

      if (navClicks < 6 && !/Create Account and Continue/i.test(bodyNow)) {
        const navHit = await clickFirst(page, advanceCtas);
        if (navHit) {
          navClicks += 1;
          log(`paypal_guest nav CTA (${navHit}) #${navClicks}`);
          await fillFirst(
            page,
            ['input#cardNumber', 'input[name="cardNumber"]', 'input[autocomplete="cc-number"]'],
            card.number,
          );
          await fillGuestContactAndAddress(page, billing, log);
          await disableCreateAccountToggle(page, log);
          await page.waitForTimeout(900);
          continue;
        }
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
