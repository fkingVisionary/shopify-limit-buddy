// Global-e pay helper for Pokémon Centre AU/NZ — Bandai-informed playbook.
// Wire-proven mid (2026-07-22 Next `_app` prod config):
//   globalE.iframeUrl = //gepi.global-e.com/includes/js/1634  → mid 1634
// Do not use Bandai 1925.
//
// Policy: HTTP through Cortex → /intl-checkout handoff; browser only for GE Pay UI.
// Score: bank ping → GE confirmation → TPCI order id (not client ok alone).

import { chromium } from "playwright";

/** Prod Global-e merchant id from gepi `/includes/js/{mid}` (confirmed GEM_JS_1634). */
export const PC_GLOBALE_MID = 1634;
export const PC_GLOBALE_SCRIPT = "https://gepi.global-e.com/includes/js/1634";

function parseProxy(raw) {
  if (!raw) return null;
  const s = String(raw).trim();
  if (!s) return null;
  try {
    if (/^https?:\/\//i.test(s)) {
      const u = new URL(s);
      return {
        server: `${u.protocol}//${u.hostname}:${u.port || (u.protocol === "https:" ? "443" : "80")}`,
        username: u.username ? decodeURIComponent(u.username) : undefined,
        password: u.password ? decodeURIComponent(u.password) : undefined,
      };
    }
  } catch {
    /* fall through */
  }
  const parts = s.split(":");
  if (parts.length >= 4 && /^\d+$/.test(parts[1])) {
    return {
      server: `http://${parts[0]}:${parts[1]}`,
      username: parts[2],
      password: parts.slice(3).join(":"),
    };
  }
  if (parts.length === 2) return { server: `http://${parts[0]}:${parts[1]}` };
  return null;
}

async function dismissCmp(page) {
  const sels = [
    "#onetrust-accept-btn-handler",
    "button:has-text('Accept All')",
    "button:has-text('Accept Cookies')",
    "button:has-text('I Accept')",
    "[aria-label='Close']",
  ];
  for (const sel of sels) {
    const el = page.locator(sel).first();
    if (await el.count().catch(() => 0)) {
      await el.click({ timeout: 2000 }).catch(() => {});
      await page.waitForTimeout(500);
    }
  }
}

/**
 * Drive Global-e Checkout/v2 + nested CreditCardForm after landing on intl-checkout.
 *
 * @param {object} opts
 * @param {string} opts.checkoutUrl — PC /intl-checkout (or GE orderdetails) URL
 * @param {object} [opts.card]
 * @param {string} [opts.proxyRaw]
 * @param {object} [opts.cookies] — name→value from HTTP jar
 * @param {string} [opts.userAgent]
 * @param {string|number} [opts.globaleMid] — from HAR; optional
 * @param {string} [opts.secureHostPattern] — e.g. secure-pokemon / secure-*.global-e.com
 * @param {boolean} [opts.placeOrder]
 * @param {Function} [opts.onProgress]
 */
export async function runGlobalEPay(opts = {}) {
  const steps = [];
  const push = (step, extra = {}) => {
    const row = { step, ok: extra.ok !== false, ...extra };
    steps.push(row);
    opts.onProgress?.(step, extra.note || null);
    return row;
  };

  const checkoutUrl = String(opts.checkoutUrl || "").trim();
  if (!checkoutUrl) {
    return { ok: false, steps, error: "checkoutUrl required", checkoutStage: "tokenize" };
  }

  const card = opts.card || {
    number: "4000000000000002",
    expMonth: "12",
    expYear: "30",
    cvv: "999",
    holder: "DECLINE TEST",
  };
  const placeOrder = opts.placeOrder === true;
  const proxy = parseProxy(opts.proxyRaw);
  const secureRe = opts.secureHostPattern
    ? new RegExp(opts.secureHostPattern, "i")
    : /CreditCardForm|secure-[a-z0-9-]+\.global-e\.com|payments\//i;

  const browser = await chromium.launch({
    headless: opts.headless !== false,
    proxy: proxy || undefined,
  });
  const context = await browser.newContext({
    userAgent:
      opts.userAgent ||
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    locale: "en-AU",
    viewport: { width: 1280, height: 900 },
  });
  if (opts.cookies && typeof opts.cookies === "object") {
    const jarCookies = [];
    for (const [name, value] of Object.entries(opts.cookies)) {
      const v = String(value);
      // Reese is host-only on www in PC HAR; rest on eTLD+1.
      const domain = name === "reese84" ? "www.pokemoncenter.com" : ".pokemoncenter.com";
      jarCookies.push({ name, value: v, domain, path: "/" });
      if (/globale|GlobalE/i.test(name)) {
        jarCookies.push({ name, value: v, domain: ".global-e.com", path: "/" });
      }
    }
    await context.addCookies(jarCookies).catch(() => {});
  }

  const page = await context.newPage();
  let reached3ds = false;
  let threeDsUrl = null;
  let orderNumber = null;
  let paymentStatus = "unknown";
  let geIframeReady = false;
  let filled = false;
  let payClicked = false;
  const mid = opts.globaleMid || PC_GLOBALE_MID;
  const debugDir = opts.debugDir || null;

  try {
    const s0 = Date.now();
    // Prefer cart → Checkout click; bare /intl-checkout often 302s to /cart without GEM boot.
    const cartUrl = opts.cartUrl || checkoutUrl.replace(/\/intl-checkout\/?$/i, "/cart");
    await page.goto(cartUrl, { waitUntil: "domcontentloaded", timeout: 90_000 });
    await dismissCmp(page);
    push("ge_cart", { ok: true, ms: Date.now() - s0, note: page.url() });

    // Click storefront checkout CTA if present
    const ctaSels = [
      'a[href*="intl-checkout"]',
      'button:has-text("Checkout")',
      'a:has-text("Checkout")',
      'button:has-text("Proceed to Checkout")',
      '[data-testid*="checkout"]',
      'button:has-text("Secure Checkout")',
    ];
    let clicked = false;
    for (const sel of ctaSels) {
      const el = page.locator(sel).first();
      if (await el.count().catch(() => 0)) {
        await el.click({ timeout: 4000 }).catch(() => {});
        clicked = true;
        await page.waitForTimeout(1500);
        break;
      }
    }
    if (!clicked && /intl-checkout/i.test(checkoutUrl)) {
      await page.goto(checkoutUrl, { waitUntil: "domcontentloaded", timeout: 90_000 }).catch(() => {});
      await dismissCmp(page);
    }
    push("ge_nav", { ok: true, note: page.url(), clickedCheckout: clicked });

    // Ensure GEM script for mid is present (prod: gepi.global-e.com/includes/js/1634)
    await page
      .evaluate((scriptUrl) => {
        if ([...document.scripts].some((s) => s.src && s.src.includes("global-e.com/includes/js/"))) {
          return;
        }
        const s = document.createElement("script");
        s.src = scriptUrl;
        s.async = true;
        document.head.appendChild(s);
      }, PC_GLOBALE_SCRIPT)
      .catch(() => {});

    for (let i = 0; i < 50; i++) {
      const urls = page.frames().map((f) => f.url());
      if (urls.some((u) => /Checkout\/v2|webservices\.global-e\.com\/Checkout/i.test(u))) {
        geIframeReady = true;
        break;
      }
      if (urls.some((u) => secureRe.test(u))) {
        geIframeReady = true;
        break;
      }
      // Keep trying checkout CTAs mid-wait (SPA hydrate)
      if (i === 5 || i === 15) {
        for (const sel of ctaSels) {
          const el = page.locator(sel).first();
          if (await el.count().catch(() => 0)) {
            await el.click({ timeout: 2000 }).catch(() => {});
            break;
          }
        }
        await dismissCmp(page);
      }
      await page.waitForTimeout(1000);
    }
    push("ge_checkout_v2", {
      ok: geIframeReady,
      note: geIframeReady
        ? `frames=${page.frames().length}`
        : "Checkout/v2 never booted (CMP / mid / GEM flake)",
      frameSample: page
        .frames()
        .map((f) => f.url())
        .filter((u) => u && u !== "about:blank")
        .slice(0, 12),
      url: page.url(),
    });
    if (!geIframeReady) {
      if (debugDir) {
        try {
          const fs = await import("node:fs");
          fs.mkdirSync(debugDir, { recursive: true });
          fs.writeFileSync(`${debugDir}/ge-fail.html`, await page.content());
          await page.screenshot({ path: `${debugDir}/ge-fail.png`, fullPage: true }).catch(() => {});
        } catch {
          /* ignore */
        }
      }
      await browser.close();
      return {
        ok: false,
        steps,
        failedStep: "ge_checkout_v2",
        error: "Global-e Checkout/v2 iframe never booted",
        checkoutStage: "tokenize",
        globaleMid: mid,
      };
    }

    if (!placeOrder) {
      await browser.close();
      return {
        ok: true,
        steps,
        dryRun: true,
        checkoutStage: "tokenize",
        note: "GE iframe ready — placeOrder=false (stop before Pay)",
        globaleMid: opts.globaleMid ?? null,
        paymentStatus: "dry_run",
      };
    }

    let payNet = 0;
    page.on("request", (req) => {
      const u = req.url();
      if (/global-e\.com|globale/i.test(u) && /pay|complete|preComplete|ProcessPayment/i.test(u)) {
        payNet++;
      }
    });
    page.on("response", async (res) => {
      try {
        const u = res.url();
        if (!/global-e\.com|globale/i.test(u)) return;
        if (!/pay|complete|ProcessPayment|Checkout\/v2/i.test(u)) return;
        const st = res.status();
        if (st >= 200 && st < 500) {
          steps.push({ step: "ge_net", ok: st < 400, note: `${st} ${u.slice(0, 120)}` });
        }
      } catch {
        /* ignore */
      }
    });

    // 1) Shipping/email first — gates Pay CTA on PC GE.
    let addressFilled = false;
    for (let tick = 0; tick < 12 && !addressFilled; tick++) {
      for (const frame of page.frames()) {
        if (!/Checkout\/v2|webservices\.global-e/i.test(frame.url())) continue;
        const email = frame.locator('input[type="email"], input[name*="email" i]').first();
        if (!(await email.count().catch(() => 0))) continue;
        await email.fill(opts.email || "decline.test@example.com").catch(() => {});
        const phone = frame.locator('input[type="tel"], input[name*="phone" i]').first();
        if (await phone.count().catch(() => 0)) {
          await phone.fill(opts.phone || "0400000000").catch(() => {});
        }
        for (const [sel, val] of [
          ['input[name*="FirstName" i], input[autocomplete="given-name"]', "Test"],
          ['input[name*="LastName" i], input[autocomplete="family-name"]', "User"],
          ['input[name*="Address1" i], input[autocomplete="address-line1"]', "1 George Street"],
          ['input[name*="City" i], input[autocomplete="address-level2"]', "Sydney"],
          ['input[name*="ZIP" i], input[name*="Postal" i], input[autocomplete="postal-code"]', "2000"],
        ]) {
          const el = frame.locator(sel).first();
          if (await el.count().catch(() => 0)) await el.fill(val).catch(() => {});
        }
        const state = frame.locator('select[name*="State" i], select[autocomplete="address-level1"]').first();
        if (await state.count().catch(() => 0)) {
          await state.selectOption({ label: "New South Wales" }).catch(() =>
            state.selectOption("NSW").catch(() => {}),
          );
        }
        // Continue / next shipping step if present
        const next = frame
          .locator(
            'button:has-text("Continue"), button:has-text("Next"), button:has-text("Save"), button:has-text("Ship")',
          )
          .first();
        if (await next.count().catch(() => 0)) {
          await next.click({ timeout: 4000 }).catch(() => {});
        }
        addressFilled = true;
        break;
      }
      if (!addressFilled) await page.waitForTimeout(1000);
    }
    push("ge_address", { ok: addressFilled, note: addressFilled ? "guest address attempted" : "no address fields yet" });
    await page.waitForTimeout(2000);

    // 2) CreditCardForm (Bandai field shape — nested secure iframe common).
    for (let tick = 0; tick < 24 && !filled; tick++) {
      await page.waitForTimeout(1500);
      for (const frame of page.frames()) {
        const url = frame.url();
        if (!/global-e\.com|globale/i.test(url)) continue;
        if (/prefetcher/i.test(url)) continue;
        // Allow Checkout/v2 parent + nested CreditCardForm / secure-* / payments
        if (
          !secureRe.test(url) &&
          !/CreditCardForm|payments\/|Checkout\/v2|secure-/i.test(url)
        ) {
          continue;
        }

        const cardNum = frame
          .locator(
            'input[name="cardNum"], input#cardNum, input[autocomplete="cc-number"], input[name*="card" i][type="text"], input[name*="card" i][type="tel"]',
          )
          .first();
        if (!(await cardNum.count().catch(() => 0))) continue;

        await cardNum.fill(String(card.number).replace(/\s+/g, ""), { timeout: 5000 }).catch(() => {});
        const mm = frame.locator('select[name="cardExpiryMonth"], select#cardExpiryMonth, select[name*="Month" i]').first();
        const yy = frame.locator('select[name="cardExpiryYear"], select#cardExpiryYear, select[name*="Year" i]').first();
        if (await mm.count().catch(() => 0)) {
          await mm.selectOption(String(card.expMonth).padStart(2, "0")).catch(() => {});
        }
        if (await yy.count().catch(() => 0)) {
          const y = String(card.expYear);
          await yy
            .selectOption(y.length === 2 ? y : y.slice(-2))
            .catch(() => yy.selectOption(y).catch(() => {}));
        }
        // Some GE UIs use text expiry MM/YY
        const expText = frame.locator('input[autocomplete="cc-exp"], input[name*="expir" i][type="text"]').first();
        if (await expText.count().catch(() => 0)) {
          await expText
            .fill(`${String(card.expMonth).padStart(2, "0")}/${String(card.expYear).slice(-2)}`)
            .catch(() => {});
        }
        const cvv = frame
          .locator('input[name="cvdNumber"], input#cvdNumber, input[autocomplete="cc-csc"], input[name*="cvv" i], input[name*="cvc" i]')
          .first();
        if (await cvv.count().catch(() => 0)) {
          await cvv.fill(String(card.cvv), { timeout: 3000 }).catch(() => {});
        }
        const holder = frame.locator('input[autocomplete="cc-name"], input[name*="cardHolder" i], input[name*="Holder" i]').first();
        if (await holder.count().catch(() => 0)) {
          await holder.fill(String(card.holder || "TEST USER")).catch(() => {});
        }
        filled = true;
        break;
      }
    }
    push("ge_card_fill", {
      ok: filled,
      note: filled ? "CreditCardForm filled" : "card form not found — confirm secure-* host in HAR",
    });

    // 3) T&Cs checkbox (Bandai: Pay no-ops if unchecked)
    for (const frame of page.frames()) {
      if (!/global-e\.com|Checkout\/v2/i.test(frame.url())) continue;
      const boxes = frame.locator('input[type="checkbox"]');
      const n = await boxes.count().catch(() => 0);
      for (let i = 0; i < Math.min(n, 8); i++) {
        const box = boxes.nth(i);
        await box.check({ force: true }).catch(() => box.click({ force: true }).catch(() => {}));
      }
    }
    await page.waitForTimeout(2500);

    // 4) Pay CTA — scan all GE frames + dump button labels if missing
    const buttonDump = [];
    for (const frame of page.frames()) {
      if (!/Checkout\/v2|webservices\.global-e|CreditCardForm|secure-|global-e/i.test(frame.url())) continue;
      const labels = await frame
        .evaluate(() =>
          [...document.querySelectorAll("button, a[role='button'], input[type='submit']")]
            .map((el) => ({
              tag: el.tagName,
              text: (el.innerText || el.value || "").trim().slice(0, 60),
              id: el.id || "",
              cls: String(el.className || "").slice(0, 80),
              disabled: Boolean(el.disabled),
            }))
            .filter((b) => b.text || b.id)
            .slice(0, 20),
        )
        .catch(() => []);
      if (labels?.length) buttonDump.push({ url: frame.url().slice(0, 100), labels });
      const payBtn = frame
        .locator(
          [
            'button:has-text("Pay")',
            'button:has-text("Place Order")',
            'button:has-text("Complete")',
            'button:has-text("Submit")',
            'button:has-text("Confirm")',
            'button[data-testid*="pay" i]',
            'button.btn-pay',
            '#btnPay',
            'button[type="submit"]',
            ".pay-button",
            'input[type="submit"]',
          ].join(", "),
        )
        .first();
      if (await payBtn.count().catch(() => 0)) {
        const disabled = await payBtn.isDisabled().catch(() => false);
        if (!disabled) {
          await payBtn.click({ timeout: 8000 }).catch(() => {});
          payClicked = true;
          break;
        }
      }
    }
    if (!payClicked) {
      const payBtn = page
        .locator('button:has-text("Pay"), button:has-text("Place Order"), #btnPay')
        .first();
      if (await payBtn.count().catch(() => 0)) {
        await payBtn.click({ timeout: 5000 }).catch(() => {});
        payClicked = true;
      }
    }
    if (debugDir && !payClicked) {
      try {
        const fs = await import("node:fs");
        fs.writeFileSync(`${debugDir}/ge-buttons.json`, JSON.stringify(buttonDump, null, 2));
        fs.writeFileSync(`${debugDir}/ge-pay-fail.html`, await page.content());
        await page.screenshot({ path: `${debugDir}/ge-pay-fail.png`, fullPage: true }).catch(() => {});
      } catch {
        /* ignore */
      }
    }
    push("ge_pay_click", {
      ok: payClicked,
      note: payClicked ? `Pay clicked payNet≈${payNet}` : "Pay button missing (address/T&Cs may still gate)",
      buttonDump: buttonDump.slice(0, 4),
      frames: page
        .frames()
        .map((f) => f.url())
        .filter((u) => /global-e|Checkout/i.test(u))
        .slice(0, 8),
    });

    // Optional 3DS — success/decline can be frictionless (Bandai lesson).
    for (let i = 0; i < 30; i++) {
      await page.waitForTimeout(1000);
      for (const frame of page.frames()) {
        const u = frame.url();
        if (/acs|3ds|cardinal|challenge/i.test(u)) {
          reached3ds = true;
          threeDsUrl = u;
        }
      }
      const bodyText = await page.locator("body").innerText().catch(() => "");
      if (/order\s*(number|#)|thank you|confirmation/i.test(bodyText)) {
        paymentStatus = "approved_or_pending";
        const om = bodyText.match(/order\s*(?:number|#)?\s*[:\s]*([A-Z0-9-]{6,})/i);
        if (om) orderNumber = om[1];
        break;
      }
      if (
        /declin|insufficient|not authorised|not authorized|payment failed|could not be processed|unable to process|do not honour|do not honor|funds/i.test(
          bodyText,
        )
      ) {
        paymentStatus = "declined";
        break;
      }
      // Also scan Checkout/v2 iframe body
      for (const frame of page.frames()) {
        if (!/Checkout\/v2|webservices\.global-e/i.test(frame.url())) continue;
        const ft = await frame.locator("body").innerText().catch(() => "");
        if (/declin|insufficient|not authorised|not authorized|payment failed|unable to process/i.test(ft)) {
          paymentStatus = "declined";
          break;
        }
        if (/acs|3ds|challenge/i.test(frame.url()) || /one.?time.?password|verify your/i.test(ft)) {
          reached3ds = true;
          threeDsUrl = frame.url();
          paymentStatus = "reached_3ds";
        }
      }
      if (paymentStatus === "declined" || paymentStatus === "reached_3ds") break;
      if (reached3ds) {
        paymentStatus = "reached_3ds";
        break;
      }
    }

    const cookies = {};
    for (const c of await context.cookies()) cookies[c.name] = c.value;
    await browser.close();

    const ok =
      paymentStatus === "approved_or_pending" ||
      paymentStatus === "reached_3ds" ||
      paymentStatus === "declined"; // issuer wire proof counts

    return {
      ok,
      steps,
      checkoutStage: reached3ds ? "three_ds" : paymentStatus === "declined" ? "payment" : "payment",
      paymentStatus,
      reached3ds,
      threeDsUrl,
      orderNumber,
      payClicked,
      cardFilled: filled,
      globaleMid: opts.globaleMid ?? null,
      cookies,
      note: `GE payStatus=${paymentStatus} 3ds=${reached3ds} order=${orderNumber || "-"}`,
    };
  } catch (e) {
    try {
      await browser.close();
    } catch {
      /* ignore */
    }
    return {
      ok: false,
      steps,
      error: e?.message || String(e),
      failedStep: "ge_pay",
      checkoutStage: "payment",
      globaleMid: opts.globaleMid ?? null,
    };
  }
}
