#!/usr/bin/env node
/**
 * Lab: full Toymate guest checkout in Chromium on THIS machine (no proxy).
 * Isolates undici/proxy from the dual-Revolut question.
 *
 * Env: PLACE_ORDER=1 (default), TOYMATE_PDP_URL, headed=1 for visible browser
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { chromium } from "playwright";

const db = JSON.parse(
  fs.readFileSync(
    path.join(process.env.APPDATA, "vanta-desktop/j1ms-desktop/db.json"),
    "utf8",
  ),
);
const task =
  db.tasks.find((t) => t.id === (process.env.DESKTOP_E2E_TASK_ID || "task_toymate_dual_e2e")) ||
  db.tasks[0];
const profile = db.profiles.find((p) => p.id === task.profileId) || db.profiles[0];
const pdp =
  process.env.TOYMATE_PDP_URL ||
  task.pdpUrl ||
  "https://toymate.com.au/lego-city-the-lego-van-60500/";
const placeOrder = process.env.PLACE_ORDER !== "0";
const headed = process.env.HEADED === "1";
const outPath =
  process.env.TOYMATE_PW_OUT ||
  path.join(os.tmpdir(), "j1m-toymate-pw-placeorder.json");

const pan = String(profile.card_number || "").replace(/\s+/g, "");
const expMonth = String(profile.card_exp_month || "").padStart(2, "0");
const expYear = String(profile.card_exp_year || "").slice(-2);
const cvv = String(profile.card_cvv || "");
const email = String(profile.email || "buyer@example.com");
const first = String(profile.first_name || "Test");
const last = String(profile.last_name || "User");
const address1 = String(profile.address1 || "");
const city = String(profile.city || "");
const province = String(profile.province || "NSW");
const zip = String(profile.zip || "");
const phone = String(profile.phone || "0400000000");

const bigpayHits = [];
const summary = {
  pdp,
  placeOrder,
  headed,
  direct: true,
  panLast4: pan.slice(-4),
  steps: [],
  bigpayHits,
};

function step(name, ok, note) {
  summary.steps.push({ name, ok, note: String(note || "").slice(0, 200) });
  console.log(JSON.stringify({ step: name, ok, note: String(note || "").slice(0, 160) }));
}

const browser = await chromium.launch({
  headless: !headed,
  args: ["--disable-blink-features=AutomationControlled"],
});
const context = await browser.newContext({
  userAgent:
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  locale: "en-AU",
  viewport: { width: 1280, height: 900 },
});
await context.addInitScript(() => {
  Object.defineProperty(navigator, "webdriver", { get: () => undefined });
});
const page = await context.newPage();

page.on("request", (req) => {
  const u = req.url();
  if (/payments\.bigcommerce\.com\/.*\/payments/i.test(u) && req.method() === "POST") {
    bigpayHits.push({
      t: new Date().toISOString(),
      url: u.slice(0, 160),
      bodyBytes: (req.postData() || "").length,
    });
    console.log(JSON.stringify({ event: "bigpay_post", bodyBytes: (req.postData() || "").length }));
  }
});

try {
  await page.goto("https://toymate.com.au/", { waitUntil: "domcontentloaded", timeout: 90_000 });
  await page.waitForTimeout(5000);
  let title = await page.title();
  if (/just a moment/i.test(title)) {
    await page.waitForTimeout(12000);
    title = await page.title();
  }
  step("home", !/just a moment/i.test(title), title);

  await page.goto(pdp, { waitUntil: "domcontentloaded", timeout: 90_000 });
  await page.waitForTimeout(3000);
  step("pdp", true, await page.title());

  const atc = page.locator("#form-action-addToCart, #add-to-cart, button[data-button-type='add'], input[type='submit'][value*='Cart' i]").first();
  await atc.click({ timeout: 15_000 }).catch(async () => {
    await page.locator("text=Add to Cart").first().click({ timeout: 10_000 });
  });
  await page.waitForTimeout(4000);
  step("atc", true, page.url());

  await page.goto("https://toymate.com.au/checkout", {
    waitUntil: "domcontentloaded",
    timeout: 90_000,
  });
  await page.waitForTimeout(8000);
  step("checkout", true, page.url());

  // Guest email / shipping — selectors are best-effort for BC checkout-js
  const fill = async (sel, value) => {
    const loc = page.locator(sel).first();
    if ((await loc.count()) === 0) return false;
    await loc.fill(String(value));
    return true;
  };

  await fill('input[name="email"]', email);
  await fill('input[id*="email" i]', email);
  await fill('input[name="firstName"]', first);
  await fill('input[name="lastName"]', last);
  await fill('input[name="address1"]', address1);
  await fill('input[name="city"]', city);
  await fill('input[name="postalCode"]', zip);
  await fill('input[name="phone"]', phone);
  // province select
  const prov = page.locator('select[name="stateOrProvinceCode"], select[name="stateOrProvince"]').first();
  if ((await prov.count()) > 0) {
    await prov.selectOption({ label: province }).catch(() =>
      prov.selectOption({ value: province }),
    );
  }
  step("shipping_fields", true, "filled best-effort");

  // Continue buttons
  for (const label of ["Continue", "Continue to Payment", "Payment"]) {
    const btn = page.getByRole("button", { name: new RegExp(label, "i") }).first();
    if ((await btn.count()) > 0 && (await btn.isVisible().catch(() => false))) {
      await btn.click().catch(() => {});
      await page.waitForTimeout(4000);
    }
  }

  // Card fields (Adyen / BC hosted fields may be iframes)
  const frames = page.frames();
  let cardFilled = false;
  for (const frame of [page.mainFrame(), ...frames]) {
    try {
      const num = frame.locator(
        'input[name="number"], input[id*="encryptedCardNumber"], input[autocomplete="cc-number"]',
      ).first();
      if ((await num.count()) === 0) continue;
      await num.fill(pan, { timeout: 5000 });
      await frame
        .locator('input[name="expiryMonth"], input[id*="encryptedExpiry"], input[autocomplete="cc-exp"]')
        .first()
        .fill(`${expMonth}${expYear.length === 2 ? expYear : expYear.slice(-2)}`, { timeout: 5000 })
        .catch(async () => {
          await frame.locator('input[name="expiryMonth"]').fill(expMonth).catch(() => {});
          await frame.locator('input[name="expiryYear"]').fill(expYear).catch(() => {});
        });
      await frame
        .locator('input[name="ccCvv"], input[id*="encryptedSecurity"], input[autocomplete="cc-csc"]')
        .first()
        .fill(cvv, { timeout: 5000 })
        .catch(() => {});
      cardFilled = true;
      break;
    } catch {
      /* try next frame */
    }
  }
  step("card_fields", cardFilled, cardFilled ? "filled" : "could not find card inputs (iframe?)");

  if (placeOrder && cardFilled) {
    const payBtn = page
      .getByRole("button", { name: /place order|pay now|complete order|submit/i })
      .first();
    if ((await payBtn.count()) > 0) {
      await payBtn.click();
      await page.waitForTimeout(20_000);
      step("place_order_click", true, page.url());
    } else {
      step("place_order_click", false, "no place-order button");
    }
  } else if (!placeOrder) {
    step("place_order_click", true, "skipped PLACE_ORDER=0");
  }

  summary.finalUrl = page.url();
  summary.finalTitle = await page.title();
  summary.bigpayPostCount = bigpayHits.length;
  summary.ok = bigpayHits.length >= 1 || /order|thank|confirmation/i.test(summary.finalTitle + summary.finalUrl);
} catch (err) {
  summary.error = String(err?.stack || err).slice(0, 800);
  step("fatal", false, summary.error);
} finally {
  await browser.close().catch(() => {});
  fs.writeFileSync(outPath, `${JSON.stringify(summary, null, 2)}\n`);
  console.log(JSON.stringify({ wrote: outPath, bigpayPostCount: summary.bigpayPostCount, steps: summary.steps.length }, null, 2));
}

process.exit(summary.bigpayPostCount > 0 ? 0 : 2);
