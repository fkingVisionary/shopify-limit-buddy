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

/** PayPal Weasley cardNumber is minlength/maxlength 19 → spaced PAN. */
function formatPanSpaces(number) {
  const d = String(number || "").replace(/\D/g, "");
  return d.replace(/(\d{4})(?=\d)/g, "$1 ").trim();
}

/** Expiry pattern on Weasley: \\d{2}\\s\\/\\s\\d{2} → "MM / YY". */
function formatExpiryMmYy(mm, yy) {
  const m = String(mm || "").padStart(2, "0").slice(-2);
  let y = String(yy || "").trim();
  if (y.length === 4) y = y.slice(-2);
  return `${m} / ${y}`;
}

/** Force AU locale on checkoutnow — Noontide often lands en_GB (UK states + Create Account). */
function forceAuApproveUrl(raw) {
  try {
    const u = new URL(String(raw || ""));
    u.searchParams.set("locale.x", "en_AU");
    u.searchParams.set("country.x", "AU");
    // Some EC urls embed locale in path /GB/ — leave path; query wins for guest UI.
    return u.toString();
  } catch {
    return String(raw || "");
  }
}

/** React-controlled <select> — Playwright selectOption alone often leaves UK state list. */
async function setSelectValue(page, selectors, { value, label }, log, tag) {
  for (const sel of selectors) {
    const loc = page.locator(sel).first();
    if (!(await loc.count().catch(() => 0))) continue;
    // Short timeout — default page timeout (3m) hung the guest loop on wrong page.
    if (label) {
      await loc.selectOption({ label }, { timeout: 2_500 }).catch(() => {});
    }
    if (value) {
      await loc.selectOption({ value }, { timeout: 2_500 }).catch(() => {});
    }
    const ok = await page
      .evaluate(
        ({ sel: s, value: v, label: lab }) => {
          const el = document.querySelector(s);
          if (!el) return { ok: false, reason: "missing" };
          let next = v || "";
          if (!next && lab) {
            const opt = Array.from(el.options || []).find((o) =>
              String(o.textContent || "").trim().toLowerCase() === String(lab).trim().toLowerCase(),
            );
            if (opt) next = opt.value;
          }
          if (!next) return { ok: false, reason: "no_value", cur: el.value };
          const proto = window.HTMLSelectElement.prototype;
          const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
          if (setter) setter.call(el, next);
          else el.value = next;
          el.dispatchEvent(new Event("input", { bubbles: true }));
          el.dispatchEvent(new Event("change", { bubbles: true }));
          return { ok: el.value === next, cur: el.value };
        },
        { sel, value: value || "", label: label || "" },
      )
      .catch(() => ({ ok: false }));
    log(`paypal_guest select ${tag || sel} → ${ok?.cur || "?"} ok=${Boolean(ok?.ok)}`);
    if (ok?.ok) return true;
  }
  return false;
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

/** True when Weasley is still in create-account mode (forbidden). */
async function isCreateAccountMode(page) {
  const body = await page.locator("body").innerText().catch(() => "");
  if (/Create Account and Continue/i.test(body)) return true;
  const sw = page.locator('[data-testid="onboard-options-switch"], input[role="switch"][value="signup"]').first();
  if (await sw.count().catch(() => 0)) {
    const checked = await sw.isChecked().catch(() => false);
    const aria = await sw.getAttribute("aria-checked").catch(() => "");
    if (checked || aria === "true") return true;
  }
  return false;
}

/**
 * Guest-only: create-account toggle MUST be OFF.
 * Never proceed with "Create Account and Continue".
 */
async function disableCreateAccountToggle(page, log) {
  for (let attempt = 0; attempt < 5; attempt++) {
    // 1) Playwright uncheck (best for real checkbox switches).
    const sw = page
      .locator('[data-testid="onboard-options-switch"], input[role="switch"][value="signup"], input[role="switch"]')
      .first();
    if (await sw.count().catch(() => 0)) {
      const checked = await sw.isChecked().catch(() => false);
      if (checked) {
        await sw.uncheck({ force: true }).catch(async () => {
          await sw.click({ force: true }).catch(() => {});
        });
      }
    }

    // 2) Click the visible "Save information & create..." control / nearby switch UI / label.
    await page
      .locator('text=/Save information.*create your PayPal account/i')
      .first()
      .click({ force: true })
      .catch(() => {});
    await page
      .locator('label[for^="Switch_"], label.css-ltr-8vwtr6-state')
      .first()
      .click({ force: true })
      .catch(() => {});
    await page
      .locator('[data-testid="onboard-options-switch"]')
      .locator("xpath=ancestor::*[contains(@class,\"switch\") or contains(@class,\"Switch\") or @data-ppui][1]")
      .first()
      .click({ force: true })
      .catch(() => {});

    // 3) DOM: force checked=false + click parent visual track (PPUI often ignores input.click).
    await page
      .evaluate(() => {
        const sw =
          document.querySelector('[data-testid="onboard-options-switch"]') ||
          document.querySelector('input[role="switch"][value="signup"]');
        if (!sw) return;
        const turnOff = () => {
          sw.checked = false;
          sw.removeAttribute("checked");
          sw.setAttribute("aria-checked", "false");
          sw.dispatchEvent(new Event("input", { bubbles: true }));
          sw.dispatchEvent(new Event("change", { bubbles: true }));
        };
        if (sw.checked || sw.getAttribute("aria-checked") === "true") {
          // Click parent/label first (visual switch), then force state.
          const host =
            sw.closest("[data-ppui]") ||
            sw.closest("label") ||
            sw.parentElement ||
            sw;
          host.click();
          if (sw.checked || sw.getAttribute("aria-checked") === "true") turnOff();
        } else {
          turnOff();
        }
        // Prefer any explicit guest CTA if present.
        for (const b of document.querySelectorAll("button,a")) {
          const t = String(b.textContent || "");
          if (/continue as guest|pay without (creating|an) account|guest checkout/i.test(t)) {
            b.click();
            break;
          }
        }
      })
      .catch(() => {});

    await page.waitForTimeout(700);
    const createMode = await isCreateAccountMode(page);
    const body = await page.locator("body").innerText().catch(() => "");
    // AU Weasley uses "Continue as a Guest" (not Pay Now) after guest toggle OFF.
    const payVisible =
      /Pay Now|Pay now|Agree & Pay|Agree and Pay|Continue as a Guest|Continue as Guest/i.test(body);
    const off = !createMode || (payVisible && !/Create Account and Continue/i.test(body));
    log(
      `paypal_guest GUEST-ONLY toggle attempt=${attempt} off=${off} payVisible=${payVisible} createCta=${/Create Account and Continue/i.test(body)}`,
    );
    if (off && !/Create Account and Continue/i.test(body)) return true;
  }
  log("paypal_guest GUEST-ONLY FAILED — still in create-account mode");
  return false;
}

/** Click pay only when CTA is guest pay — never Create Account. */
async function clickGuestPayOnly(page, payCtas, log) {
  // Spinner / disabled Continue as a Guest means validation or DataDome still running.
  const spinner = page.locator('[data-testid="exit-loader-spinner"], [data-testid="spinner-icon"]');
  if (await spinner.count().catch(() => 0)) {
    const visible = await spinner.first().isVisible().catch(() => false);
    if (visible) {
      log("paypal_guest pay CTA deferred — spinner visible");
      await page.waitForTimeout(1500);
      return null;
    }
  }
  const submit = page.locator('[data-testid="submit-button"]').first();
  if (await submit.count().catch(() => 0)) {
    const text = String((await submit.innerText().catch(() => "")) || "");
    if (/Create Account/i.test(text)) {
      log(`paypal_guest blocked Create Account CTA: "${text.slice(0, 60)}"`);
      return null;
    }
    if (
      /Pay Now|Pay now|Agree & Pay|Agree and Pay|Continue to Review|Continue as a Guest|Continue as Guest|^Pay$/i.test(
        text.trim(),
      )
    ) {
      const disabled = await submit.isDisabled().catch(() => true);
      if (disabled) {
        // Wait briefly for enable after fill / security check.
        await submit.waitFor({ state: "visible", timeout: 2_000 }).catch(() => {});
        const still = await submit.isDisabled().catch(() => true);
        if (still) {
          log(`paypal_guest pay CTA disabled ("${text.slice(0, 40)}") — waiting`);
          await page.waitForTimeout(1200);
          return null;
        }
      }
      await submit.click({ noWaitAfter: true, timeout: 8_000 }).catch(async () => {
        await submit.click({ force: true, noWaitAfter: true }).catch(() => {});
      });
      log(`paypal_guest pay CTA (submit-button text=${text.slice(0, 40)} enabled)`);
      return "submit-button";
    }
  }
  // Fallback selectors — still skip any Create Account match.
  for (const sel of payCtas) {
    if (/Create Account/i.test(sel)) continue;
    const loc = page.locator(sel).first();
    if (!(await loc.count().catch(() => 0))) continue;
    const text = String((await loc.innerText().catch(() => "")) || "");
    if (/Create Account/i.test(text)) continue;
    if (!(await loc.isVisible().catch(() => false))) continue;
    await loc.click({ force: true, noWaitAfter: true }).catch(() => {});
    log(`paypal_guest pay CTA (${sel})`);
    return sel;
  }
  // Last resort: DOM click guest continue (AU label).
  const dom = await page
    .evaluate(() => {
      const btns = Array.from(document.querySelectorAll('button, [data-testid="submit-button"], a'));
      const hit = btns.find((b) =>
        /^(Continue as a Guest|Continue as Guest|Pay Now|Pay now|Agree & Pay)$/i.test(
          String(b.textContent || "").trim(),
        ),
      );
      if (!hit || /Create Account/i.test(String(hit.textContent || ""))) return null;
      hit.click();
      return String(hit.textContent || "").trim().slice(0, 40);
    })
    .catch(() => null);
  if (dom) {
    log(`paypal_guest pay CTA (dom "${dom}")`);
    return `dom:${dom}`;
  }
  return null;
}

/**
 * Address validation sheet after Continue as a Guest (lab 2026-08-05):
 * "We've found a match for your address" → Continue.
 */
async function dismissAddressMatchSheet(page, log) {
  const body = await page.locator("body").innerText().catch(() => "");
  if (!/We've found a match for your address|Use the address you entered|Use this address/i.test(body)) {
    return false;
  }
  // Prefer the address we entered (profile) when offered.
  await page
    .locator('text=/Use the address you entered/i')
    .first()
    .click({ force: true, timeout: 3_000 })
    .catch(() => {});
  const cont =
    (await clickFirst(
      page,
      [
        'button:has-text("Continue"):not(:has-text("Continue as a Guest"))',
        '[data-testid="address-suggestion-continue"]',
        'button:has-text("Continue")',
      ],
      { force: true },
    )) ||
    (await page
      .evaluate(() => {
        const sheet = Array.from(document.querySelectorAll("button")).find((b) =>
          /^Continue$/i.test(String(b.textContent || "").trim()),
        );
        if (!sheet) return null;
        sheet.click();
        return "Continue";
      })
      .catch(() => null));
  if (cont) {
    log(`paypal_guest address-match sheet (${cont})`);
    await page.waitForTimeout(1500);
    return true;
  }
  log("paypal_guest address-match sheet visible but Continue miss");
  return false;
}

/** Wait out PayPal/DataDome "security check" overlay before guest pay. */
async function waitPaypalSecurityCheck(page, log, ms = 25_000) {
  const deadline = Date.now() + ms;
  let saw = false;
  while (Date.now() < deadline) {
    const body = await page.locator("body").innerText().catch(() => "");
    if (/perform security check|please wait while we/i.test(body)) {
      if (!saw) {
        log("paypal_guest waiting security check…");
        saw = true;
      }
      await page.waitForTimeout(800);
      continue;
    }
    if (saw) {
      log("paypal_guest security check cleared");
      await page.waitForTimeout(400);
    }
    return !saw;
  }
  if (saw) log("paypal_guest security check still visible after wait");
  return false;
}

/** Force AU country — PayPal defaulted to UK/GB on Noontide (2026-08-05). */
async function selectAustraliaCountry(page, log) {
  const before = await page
    .locator('select#country, select[data-testid="countrySelector"]')
    .first()
    .inputValue()
    .catch(() => "");
  const ok = await setSelectValue(
    page,
    ['select[data-testid="countrySelector"]', "select#country", 'select[name="country"]'],
    { value: "AU", label: "Australia" },
    log,
    "country",
  );
  await page.waitForTimeout(1200);
  const after = await page
    .locator('select#country, select[data-testid="countrySelector"]')
    .first()
    .inputValue()
    .catch(() => "");
  // State list must remount to AU (QLD/NSW…) — UK list has "Aberdeen City".
  const stateHtml = await page
    .locator("select#billingState")
    .innerHTML()
    .catch(() => "");
  const auStates = /Queensland|New South Wales|QLD|NSW/i.test(stateHtml);
  const ukStates = /Aberdeen City|Greater London/i.test(stateHtml);
  log(
    `paypal_guest country ${before || "?"}→${after || "?"} setOk=${ok} auStates=${auStates} ukStates=${ukStates}`,
  );
  return /AU/i.test(after) || (ok && auStates && !ukStates);
}

/** Fill contact + AU billing — IDs from checkoutweb/signup forensics. */
async function fillGuestContactAndAddress(page, billing, log) {
  const hasForm = await page
    .locator(
      'select[data-testid="countrySelector"], select#country, input#billingLine1, input#firstName',
    )
    .first()
    .count()
    .catch(() => 0);
  if (!hasForm) {
    log("paypal_guest address skip — Weasley fields not mounted");
    return {
      first: false,
      last: false,
      phone: false,
      line1: false,
      city: false,
      state: false,
      zip: false,
    };
  }
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

  const prov = String(billing.province || "QLD").trim().toUpperCase();
  const label = AU_STATE_LABELS[prov] || billing.province;
  filled.state = await setSelectValue(
    page,
    ['select#billingState', 'select[name="billingState"]'],
    { value: prov, label },
    log,
    "state",
  );
  if (!filled.state) {
    // Some AU builds use full label as option value.
    filled.state = await setSelectValue(
      page,
      ['select#billingState', 'select[name="billingState"]'],
      { value: label, label },
      log,
      "state-label",
    );
  }

  log(
    `paypal_guest address fill first=${filled.first} last=${filled.last} phone=${filled.phone} line1=${filled.line1} city=${filled.city} state=${filled.state} zip=${filled.zip}`,
  );
  return filled;
}

async function fillGuestCardFields(page, card, log) {
  const panSpaced = formatPanSpaces(card.number);
  const expiry = formatExpiryMmYy(card.expMonth, card.expYear);
  // Prefer keyboard into focused fields — React floating labels ignore many .fill() paths.
  const cardLoc = page
    .locator('input#cardNumber, input[name="cardnumber"], input[autocomplete="cc-number"]')
    .first();
  let cardFilled = false;
  if (await cardLoc.count().catch(() => 0)) {
    await cardLoc.click({ force: true }).catch(() => {});
    await page.keyboard.press("Control+A").catch(() => {});
    await page.keyboard.press("Backspace").catch(() => {});
    await page.keyboard.type(panSpaced, { delay: 25 }).catch(() => {});
    const v = await cardLoc.inputValue().catch(() => "");
    cardFilled = String(v).replace(/\D/g, "").length >= 15;
    if (!cardFilled) {
      cardFilled = await fillFirst(
        page,
        ['input#cardNumber', 'input[name="cardnumber"]', 'input[autocomplete="cc-number"]'],
        panSpaced,
      );
    }
  } else {
    cardFilled = await fillFirst(
      page,
      ['input#cardNumber', 'input[name="cardnumber"]', 'input[autocomplete="cc-number"]'],
      panSpaced,
    );
  }
  const expFilled =
    (await fillFirst(
      page,
      ['input#cardExpiry', 'input[name="exp-date"]', 'input[autocomplete="cc-exp"]'],
      expiry,
    )) ||
    (await fillFirst(page, ['input#expiryDate', 'input[name="expiryDate"]'], `${card.expMonth}${card.expYear}`));
  // Verify expiry matches spaced pattern; retype if needed.
  const expLoc = page.locator('input#cardExpiry, input[autocomplete="cc-exp"]').first();
  if (await expLoc.count().catch(() => 0)) {
    const ev = await expLoc.inputValue().catch(() => "");
    if (!/^\d{2}\s\/\s\d{2}$/.test(ev)) {
      await expLoc.click({ force: true }).catch(() => {});
      await page.keyboard.press("Control+A").catch(() => {});
      await page.keyboard.type(expiry, { delay: 30 }).catch(() => {});
    }
  }
  const cvvFilled = await fillFirst(
    page,
    ['input#cardCvv', 'input#cvv', 'input[name="cardCvv"]', 'input[name="cvv"]', 'input[autocomplete="cc-csc"]'],
    card.cvv,
  );
  const panLen = await cardLoc
    .inputValue()
    .then((v) => String(v || "").replace(/\D/g, "").length)
    .catch(() => 0);
  // Blur so Weasley validation enables Continue as a Guest (was stuck disabled=true).
  await page.locator("input#cardCvv, input#cardNumber").last().blur().catch(() => {});
  await page.keyboard.press("Tab").catch(() => {});
  await page.waitForTimeout(400);
  log(
    `paypal_guest card fill card=${cardFilled} panDigits=${panLen} exp=${Boolean(expFilled)} cvv=${cvvFilled} panFmt=spaced`,
  );
  return { cardFilled: cardFilled || panLen >= 15, expFilled: Boolean(expFilled), cvvFilled };
}

async function dismissPaypalCookies(page, log) {
  // Prefer #acceptAllButton (cookie banner overlays guest CTA on GB wall).
  const accept = page.locator("#acceptAllButton, button.acceptButton").first();
  if (await accept.count().catch(() => 0)) {
    await accept.click({ force: true, timeout: 5_000 }).catch(() => {});
    await page
      .locator("#acceptAllButton")
      .waitFor({ state: "hidden", timeout: 5_000 })
      .catch(() => {});
    log("paypal_guest cookies (#acceptAllButton)");
    await page.waitForTimeout(300);
    return true;
  }
  const hit = await clickFirst(
    page,
    [
      'button:has-text("Accept Cookies")',
      'button:has-text("Accept")',
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

async function leftLoginWall(page) {
  // Require real guest controls — body-text matches alone false-positived (hung on selects).
  const guestEmail = await page
    .locator("#onboardingFlowEmail, input[placeholder='Enter email address']")
    .first()
    .count()
    .catch(() => 0);
  if (guestEmail) return true;
  const cardReady = await page
    .locator('input#cardNumber, input[autocomplete="cc-number"]')
    .first()
    .count()
    .catch(() => 0);
  if (cardReady) return true;
  const continuePay = await page
    .locator('button:has-text("Continue to Payment")')
    .first()
    .count()
    .catch(() => 0);
  if (continuePay) return true;
  const weasleyCountry = await page
    .locator('select[data-testid="countrySelector"], select#country')
    .first()
    .count()
    .catch(() => 0);
  return Boolean(weasleyCountry);
}

async function openGuestCardPath(page, log) {
  // Live Bandai/GE PayPal login (2026-08-05): #startGuestOnboardingFlow
  // label = "Pay by Debit or Credit Card" (by, not with).
  // Cookie banner + login "Next" used to steal clicks. Do NOT treat login #email as success.
  // Accept cookies FIRST — guest CTA is a no-op while the banner is up (lab 2026-08-05).
  for (let c = 0; c < 8; c++) {
    const accepted = await dismissPaypalCookies(page, log);
    const still = await page.locator("#acceptAllButton").count().catch(() => 0);
    if (accepted && !still) break;
    if (!still && c > 0) break;
    await page.waitForTimeout(500);
  }
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
  for (let i = 0; i < 10; i++) {
    await dismissPaypalCookies(page, log);
    if (await leftLoginWall(page)) {
      log("paypal_guest already past login wall");
      return true;
    }
    // DOM click first — banner overlays often eat Playwright locator clicks.
    const domClicked = await page
      .evaluate(() => {
        const btn =
          document.querySelector("#startGuestOnboardingFlow") ||
          Array.from(document.querySelectorAll("button,a")).find((b) =>
            /Pay by Debit or Credit Card|Pay with Debit or Credit Card/i.test(
              String(b.textContent || ""),
            ),
          );
        if (!btn) return false;
        btn.click();
        return true;
      })
      .catch(() => false);
    if (domClicked) {
      log("paypal_guest clicked guest CTA (dom #startGuestOnboardingFlow)");
    } else {
      const hit =
        (await clickFirst(page, guestCtas)) ||
        (await clickFirst(page, guestCtas, { force: true }));
      if (hit) log(`paypal_guest clicked guest CTA (${hit})`);
    }
    // Wait for REAL guest UI controls — never login #email / body text alone.
    await page
      .waitForSelector(
        "#onboardingFlowEmail, input[placeholder='Enter email address'], button:has-text('Continue to Payment'), input#cardNumber, input[autocomplete='cc-number'], select[data-testid='countrySelector']",
        { timeout: 12_000 },
      )
      .catch(() => null);
    await page.waitForTimeout(800);
    if (await leftLoginWall(page)) {
      log("paypal_guest left login wall");
      return true;
    }
    log(`paypal_guest still on login wall attempt=${i}`);
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
    await page
      .screenshot({ path: `${base}.png`, fullPage: true, timeout: 8_000 })
      .catch(() => {});
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
    // Prefer real Chrome channel — stock Chromium often lands DataDome blank shell.
    // Direct (no proxy) for PayPal UI: Noontide resi often sticks on DataDome
    // "security check" with Continue as a Guest disabled. Bandai/GE still use proxy.
    const approveDirect =
      opts.direct === true ||
      process.env.PAYPAL_APPROVE_DIRECT === "1" ||
      process.env.PAYPAL_APPROVE_DIRECT === "true";
    const launchOpts = {
      headless,
      proxy: approveDirect ? undefined : proxyForPlaywright(opts.proxy),
      args: [
        "--disable-blink-features=AutomationControlled",
        "--disable-popup-blocking",
      ],
    };
    if (process.platform === "win32" || process.env.PAYPAL_USE_CHROME === "1") {
      launchOpts.channel = "chrome";
    }
    try {
      browser = await chromium.launch(launchOpts);
    } catch {
      delete launchOpts.channel;
      browser = await chromium.launch(launchOpts);
    }
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

    const openUrl = forceAuApproveUrl(approveUrl);
    log(
      `paypal_guest open ${openUrl.slice(0, 140)} chrome=${Boolean(launchOpts.channel)} direct=${approveDirect}`,
    );
    await page.goto(openUrl, { waitUntil: "domcontentloaded", timeout: timeoutMs });
    // Wait out DataDome interstitial (blank body / tiny html) before guest CTA.
    for (let d = 0; d < 20; d++) {
      const ready = await page.locator("#startGuestOnboardingFlow, #email, #acceptAllButton").count().catch(() => 0);
      const bodyLen = (await page.locator("body").innerText().catch(() => "")).trim().length;
      if (ready > 0 && bodyLen > 40) break;
      log(`paypal_guest waiting DataDome/UI ready bodyLen=${bodyLen} attempt=${d}`);
      await page.waitForTimeout(1000);
    }
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
    // Real charge / guest-advance CTAs — never "Create Account and Continue".
    // AU Weasley guest CTA is "Continue as a Guest" (forensics 2026-08-05).
    const payCtas = [
      'button[data-testid="submit-button"]:has-text("Continue as a Guest")',
      'button[data-testid="submit-button"]:has-text("Continue as Guest")',
      'button:has-text("Continue as a Guest")',
      'button:has-text("Continue as Guest")',
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
    let weasleyPasses = 0;
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

      // Guest email gate — never click Continue to Payment on empty email.
      if (
        /Check out as a guest|Continue to Payment/i.test(bodyNow) &&
        !/card number|Pay with debit/i.test(bodyNow)
      ) {
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

      // Weasley card form — fill at most twice. Re-selecting country remounts and
      // undoes a successful Continue as a Guest click (lab 2026-08-05).
      if (
        !payClicked &&
        /Pay with debit or credit card|Create Account and Continue|Continue as a Guest/i.test(bodyNow)
      ) {
        if (weasleyPasses < 2) {
          weasleyPasses += 1;
          if (weasleyPasses === 1) {
            await selectAustraliaCountry(page, log);
            await page.waitForTimeout(1000);
          }
          await fillGuestCardFields(page, card, log);
          await fillGuestContactAndAddress(page, billing, log);
          const toggled = await disableCreateAccountToggle(page, log);
          await fillGuestCardFields(page, card, log);
          await waitPaypalSecurityCheck(page, log, 20_000);
          log(`paypal_guest weasley pass=${weasleyPasses} toggled=${toggled}`);
          await dumpForensics(page, forensicsDir, `weasley-${weasleyPasses}`);
        }
      }

      // HARD RULE: never click while Create Account CTA is showing.
      if (/Create Account and Continue/i.test(bodyNow)) {
        await disableCreateAccountToggle(page, log);
        await page.waitForTimeout(800);
        continue;
      }

      // Address suggestion sheet blocks EC return after guest submit.
      if (/We've found a match for your address|Use the address you entered/i.test(bodyNow)) {
        await dismissAddressMatchSheet(page, log);
        await page.waitForTimeout(1000);
        continue;
      }

      // Don't hammer pay while DataDome security check is up.
      if (/perform security check|please wait while we/i.test(bodyNow)) {
        await waitPaypalSecurityCheck(page, log, 12_000);
        continue;
      }

      // After pay click, spinner + address sheet are progress — not failure.
      if (payClicked) {
        const sheet = await dismissAddressMatchSheet(page, log);
        if (sheet) continue;
        if (/perform security check|please wait while we|exit-loader|spinner/i.test(bodyNow)) {
          await page.waitForTimeout(1500);
          if (isMerchantReturn(page.url()) || isPaypalSuccessUrl(page.url())) break;
          continue;
        }
      }

      const payHit = await clickGuestPayOnly(page, payCtas, log);
      if (payHit) {
        payClicked = payHit;
        log(`paypal_guest waiting after pay CTA (${payHit})`);
        // Address sheet often appears within a few seconds of submit.
        for (let w = 0; w < 20; w++) {
          if (isMerchantReturn(page.url()) || isPaypalSuccessUrl(page.url())) break;
          const b = await page.locator("body").innerText().catch(() => "");
          if (/We've found a match for your address/i.test(b)) {
            await dismissAddressMatchSheet(page, log);
          }
          await page.waitForTimeout(1500);
        }
        await Promise.race([
          page.waitForURL(
            (u) => isMerchantReturn(String(u)) || isPaypalSuccessUrl(String(u)),
            { timeout: 60_000 },
          ).catch(() => null),
          page.waitForTimeout(60_000),
        ]);
        continue;
      }

      if (navClicks < 4 && !/Create Account/i.test(bodyNow)) {
        const navHit = await clickFirst(page, advanceCtas);
        if (navHit) {
          navClicks += 1;
          log(`paypal_guest nav CTA (${navHit}) #${navClicks}`);
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
      if (payClicked && !(await isCreateAccountMode(page))) {
        await clickGuestPayOnly(page, payCtas, log);
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
    const createAccountStuck = /Create Account and Continue/i.test(bodyText);

    // Fail-closed: Express Checkout proof is merchant/GE return (ideally + PayerID).
    // Guest email "Continue" / staying on /pay/ is NOT a charge (false Revolut miss 2026-08-05).
    // Create Account path is NEVER success — guest only.
    const ok =
      !createAccountStuck &&
      (merchantReturned || paypalSuccessPage || (bodyOk && !stillOnPaypalPayUi && Boolean(payerId))) &&
      !stillOnPaypalPayUi;

    const forensicBase = await dumpForensics(page, forensicsDir, ok ? "done-ok" : "done-fail");

    await context.close().catch(() => {});
    await browser.close().catch(() => {});

    const note = ok
      ? `PayPal guest charged${orderGuess ? ` order=${orderGuess}` : ""}${
          merchantReturned ? " merchant_return" : ""
        }${payerId ? ` payerId=${payerId}` : ""}`
      : createAccountStuck
        ? `PayPal GUEST-ONLY refused — still on Create Account (cardFilled=${cardFilled2} payClicked=${payClicked || "none"})`
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
