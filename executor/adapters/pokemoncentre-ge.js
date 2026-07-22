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
    const jarCookies = Object.entries(opts.cookies).map(([name, value]) => ({
      name,
      value: String(value),
      domain: ".pokemoncenter.com",
      path: "/",
    }));
    // Also seed global-e if present
    for (const [name, value] of Object.entries(opts.cookies)) {
      if (/globale|GlobalE/i.test(name)) {
        jarCookies.push({
          name,
          value: String(value),
          domain: ".global-e.com",
          path: "/",
        });
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

  try {
    const s0 = Date.now();
    await page.goto(checkoutUrl, { waitUntil: "domcontentloaded", timeout: 90_000 });
    await dismissCmp(page);
    push("ge_nav", { ok: true, ms: Date.now() - s0, note: page.url() });

    for (let i = 0; i < 45; i++) {
      const urls = page.frames().map((f) => f.url());
      if (urls.some((u) => /Checkout\/v2|webservices\.global-e\.com\/Checkout/i.test(u))) {
        geIframeReady = true;
        break;
      }
      if (urls.some((u) => secureRe.test(u))) {
        geIframeReady = true;
        break;
      }
      await page.waitForTimeout(1000);
      if (i === 10 || i === 25) await dismissCmp(page);
    }
    push("ge_checkout_v2", {
      ok: geIframeReady,
      note: geIframeReady
        ? `frames=${page.frames().length}`
        : "Checkout/v2 never booted (CMP / mid / GEM flake)",
    });
    if (!geIframeReady) {
      await browser.close();
      return {
        ok: false,
        steps,
        failedStep: "ge_checkout_v2",
        error: "Global-e Checkout/v2 iframe never booted",
        checkoutStage: "tokenize",
        globaleMid: opts.globaleMid ?? null,
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

    // Fill nested CreditCardForm (Bandai field shape — confirm on PC HAR).
    for (let tick = 0; tick < 24 && !filled; tick++) {
      await page.waitForTimeout(1500);
      for (const frame of page.frames()) {
        const url = frame.url();
        if (!/global-e\.com|globale/i.test(url)) continue;
        if (/prefetcher/i.test(url)) continue;
        if (!secureRe.test(url) && !/CreditCardForm|payments\//i.test(url)) continue;

        const cardNum = frame.locator('input[name="cardNum"], input#cardNum, input[autocomplete="cc-number"]').first();
        if (!(await cardNum.count().catch(() => 0))) continue;

        await cardNum.fill(String(card.number).replace(/\s+/g, ""), { timeout: 5000 }).catch(() => {});
        const mm = frame.locator('select[name="cardExpiryMonth"], select#cardExpiryMonth').first();
        const yy = frame.locator('select[name="cardExpiryYear"], select#cardExpiryYear').first();
        if (await mm.count().catch(() => 0)) {
          await mm.selectOption(String(card.expMonth).padStart(2, "0")).catch(() => {});
        }
        if (await yy.count().catch(() => 0)) {
          const y = String(card.expYear);
          await yy
            .selectOption(y.length === 2 ? y : y.slice(-2))
            .catch(() => yy.selectOption(y).catch(() => {}));
        }
        const cvv = frame.locator('input[name="cvdNumber"], input#cvdNumber, input[autocomplete="cc-csc"]').first();
        if (await cvv.count().catch(() => 0)) {
          await cvv.fill(String(card.cvv), { timeout: 3000 }).catch(() => {});
        }
        filled = true;
        break;
      }
    }
    push("ge_card_fill", {
      ok: filled,
      note: filled ? "CreditCardForm filled" : "card form not found — confirm secure-* host in HAR",
    });

    // T&Cs checkbox (Bandai: Pay no-ops if unchecked)
    for (const frame of page.frames()) {
      if (!/global-e\.com|Checkout\/v2/i.test(frame.url())) continue;
      const box = frame
        .locator(
          'input[type="checkbox"][name*="term" i], input[type="checkbox"][id*="term" i], label:has-text("I confirm") input',
        )
        .first();
      if (await box.count().catch(() => 0)) {
        await box.check({ force: true }).catch(() => box.click().catch(() => {}));
      }
    }

    // Wait briefly for invisible captcha / Forter tokens if present
    await page.waitForTimeout(2500);

    let payNet = 0;
    page.on("request", (req) => {
      const u = req.url();
      if (/global-e\.com|globale/i.test(u) && /pay|complete|preComplete|ProcessPayment/i.test(u)) {
        payNet++;
      }
    });

    for (const frame of page.frames()) {
      if (!/Checkout\/v2|webservices\.global-e/i.test(frame.url())) continue;
      const payBtn = frame
        .locator(
          'button:has-text("Pay"), button:has-text("Place Order"), button[type="submit"], .pay-button',
        )
        .first();
      if (await payBtn.count().catch(() => 0)) {
        await payBtn.click({ timeout: 8000 }).catch(() => {});
        payClicked = true;
        break;
      }
    }
    push("ge_pay_click", {
      ok: payClicked,
      note: payClicked ? `Pay clicked payNet≈${payNet}` : "Pay button missing",
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
      if (/declin|insufficient|not authorised|not authorized|payment failed/i.test(bodyText)) {
        paymentStatus = "declined";
        break;
      }
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
