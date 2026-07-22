// Bandai Global-e pay on an *existing* Playwright page (fast drop path).
// Used after HTTP + F5 bridge already logged in and ATCed — no second login/PDP.
// Single Pay click on Checkout/v2 only.

/** Only the GEM Checkout/v2 shell — never the nested CreditCardForm. */
export function isBandaiGeCheckoutPayFrame(url) {
  return /webservices\.global-e\.com\/Checkout\/v2|global-e\.com\/Checkout\/v2/i.test(
    String(url || ""),
  );
}

/** Issuer / payment submit URLs (wire proof after a single Pay click). */
export function isBandaiGeAuthPaymentUrl(url) {
  return /ProcessPayment|Authorize|CompleteOrder|CreatePayment|SubmitPayment|PayOrder|PaymentData/i.test(
    String(url || ""),
  );
}

async function dismissCookieBanner(page) {
  const sels = [
    "#onetrust-accept-btn-handler",
    "button:has-text('Accept All Cookies')",
    "button:has-text('Accept All')",
    "#accept-recommended-btn-handler",
  ];
  for (const sel of sels) {
    const btn = page.locator(sel).first();
    if (await btn.count().catch(() => 0)) {
      if (await btn.isVisible().catch(() => false)) {
        await btn.click({ timeout: 2000 }).catch(() => {});
        await page.waitForTimeout(250);
        return true;
      }
    }
  }
  const close = page.locator("#onetrust-close-btn-handler, .onetrust-close-btn-handler").first();
  if (await close.count().catch(() => 0)) {
    await close.click({ timeout: 1500 }).catch(() => {});
  }
  return false;
}

function looksLike3ds(url, text = "") {
  const u = String(url || "");
  const t = String(text || "");
  return /3ds|three.?d.?secure|acs|challenge|securecode|cardinalcommerce|authentication|creq|pareq|revolut.*3ds|otp/i.test(
    u + " " + t,
  );
}

const DECLINE_RE =
  /declin|payment failed|not authorised|not authorized|insufficient|low balance|not enough|do not honour|unable to process|authentication failed|card.*(denied|rejected|refused)|transaction.*(fail|denied)|issuer.*(fail|declin)|funds|cancelled by|canceled by|try another card|payment was not|could not be (processed|completed)/i;

function extractDeclineSnippet(text) {
  const t = String(text || "").replace(/\s+/g, " ").trim();
  if (!t || !DECLINE_RE.test(t)) return null;
  const m = t.match(
    /.{0,40}(?:declin|insufficient|low balance|not (?:authori[sz]ed|enough)|do not honour|unable to process|payment failed).{0,80}/i,
  );
  return (m?.[0] || t).slice(0, 160);
}

/**
 * Cart UI → PROCEED → fill CreditCardForm → single Checkout/v2 Pay.
 * @param {object} opts
 * @param {import('playwright').Page} opts.page
 * @param {import('playwright').BrowserContext} opts.context
 * @param {string} opts.base — https://p-bandai.com/{area}
 * @param {object} opts.card
 * @param {number} [opts.wait3dsMs=45000]
 * @param {object} [opts.meta] — areaItemNo, cartSn, cartId, cartItemSn, title
 */
export async function browserBandaiGeFromCart(opts = {}) {
  const page = opts.page;
  const context = opts.context;
  const base = String(opts.base || "").replace(/\/$/, "");
  const wait3dsMs = Math.min(90_000, Math.max(8_000, Number(opts.wait3dsMs) || 45_000));
  const card = opts.card || {
    number: "4000000000000002",
    expMonth: "12",
    expYear: "30",
    cvv: "999",
    holder: "DECLINE TEST",
  };
  const meta = opts.meta || {};
  const steps = [];
  const timeline = [];
  const t0 = Date.now();
  const mark = (event, extra = {}) => {
    const row = {
      t: new Date().toISOString(),
      elapsedMs: Date.now() - t0,
      event,
      ...extra,
    };
    timeline.push(row);
    try {
      opts.onProgress?.(event, row);
    } catch {
      /* ignore */
    }
    return row;
  };
  const push = (step, row) => {
    const out = { step, ...row };
    steps.push(out);
    mark(step, { ok: out.ok, note: out.note, ms: out.ms });
    return out;
  };

  if (!page || !context || !base) {
    return { ok: false, error: "page_context_base_required", steps, checkoutStage: "cart" };
  }

  const geNet = [];
  const onReq = (req) => {
    const u = req.url();
    if (
      req.method() !== "GET" &&
      /global-e\.com|globale|CreditCard|payments\/|Checkout\/|3ds|acs|Authorize|ProcessPayment/i.test(u)
    ) {
      geNet.push({ t: Date.now(), kind: "req", method: req.method(), url: u.slice(0, 200) });
    }
  };
  const onRes = (res) => {
    const u = res.url();
    if (/global-e\.com|globale|CreditCard|payments\/|Checkout\/|3ds|acs|Authorize|ProcessPayment/i.test(u)) {
      if (res.request().method() === "GET" && !/ProcessPayment|Authorize|3ds|acs|Pay/i.test(u)) return;
      geNet.push({
        t: Date.now(),
        kind: "res",
        status: res.status(),
        method: res.request().method(),
        url: u.slice(0, 200),
      });
    }
  };
  page.on("request", onReq);
  page.on("response", onRes);

  let checkoutSn = null;
  let paymentStatus = "unknown";
  let reached3ds = false;
  let threeDsUrl = null;
  let orderNumber = null;
  let payClickCount = 0;
  let sawAuthWire = false;
  let declineSnippet = null;
  let geNote = "";

  try {
    mark("ge_from_cart_start");
    const sChk = Date.now();
    await page.goto(`${base}/cart`, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(800);
    await dismissCookieBanner(page);

    // Vue cart hydrates async — wait for CTA (or empty-cart copy) before failing.
    const proceedSel =
      'button:has-text("PROCEED TO CHECKOUT"), button:has-text("Proceed to Checkout"), button:has-text("Proceed to checkout")';
    let proceedVisible = false;
    for (let i = 0; i < 20; i++) {
      await dismissCookieBanner(page);
      const proceedProbe = page.locator(proceedSel).first();
      if ((await proceedProbe.count().catch(() => 0)) && (await proceedProbe.isVisible().catch(() => false))) {
        proceedVisible = true;
        break;
      }
      // Nudge SPA — sometimes first paint is a skeleton.
      if (i === 6 || i === 12) {
        await page.reload({ waitUntil: "domcontentloaded" }).catch(() => {});
        await page.waitForTimeout(600);
      }
      await page.waitForTimeout(400);
    }
    mark("cart_ui_ready", { proceedVisible });

    const areaBoxes = page.locator(
      'input[type="checkbox"]:not([name^="ot-"]):not([id^="ot-"])',
    );
    const boxCount = await areaBoxes.count();
    for (let i = 0; i < boxCount; i++) {
      const box = areaBoxes.nth(i);
      if (!(await box.isChecked().catch(() => true))) {
        await box.check({ force: true }).catch(() => {});
      }
    }

    const proceed = page.locator(proceedSel).first();
    if (!proceedVisible) {
      const bodyHint = (await page.locator("body").innerText().catch(() => ""))
        .replace(/\s+/g, " ")
        .slice(0, 160);
      push("cart_checkout", {
        ok: false,
        ms: Date.now() - sChk,
        note: `PROCEED TO CHECKOUT button missing — ${bodyHint}`,
      });
      return {
        ok: false,
        steps,
        timeline,
        failedStep: "cart_checkout",
        error: "PROCEED TO CHECKOUT button missing",
        checkoutStage: "cart",
        ...meta,
        via: "http+ge",
        elapsedMs: Date.now() - t0,
      };
    }

    let proceedReady = false;
    for (let i = 0; i < 16; i++) {
      for (let bi = 0; bi < boxCount; bi++) {
        const box = areaBoxes.nth(bi);
        if (!(await box.isChecked().catch(() => true))) {
          await box.check({ force: true }).catch(() => {});
        }
      }
      if (!(await proceed.isDisabled().catch(() => true))) {
        proceedReady = true;
        break;
      }
      await page.waitForTimeout(300);
    }
    if (!proceedReady) {
      push("cart_checkout", {
        ok: false,
        ms: Date.now() - sChk,
        note: "PROCEED TO CHECKOUT disabled (OOS / PreallocationFail)",
      });
      return {
        ok: false,
        steps,
        failedStep: "cart_checkout",
        error: "PROCEED TO CHECKOUT disabled",
        checkoutStage: "cart",
        ...meta,
        via: "http+ge",
        elapsedMs: Date.now() - t0,
      };
    }

    mark("proceed_click");
    await Promise.all([
      page.waitForURL(/orderdetails|Global-e|global-e/i, { timeout: 35_000 }).catch(() => null),
      proceed.click({ timeout: 8_000 }),
    ]);
    await page.waitForTimeout(500);
    await dismissCookieBanner(page);

    checkoutSn =
      (await page.evaluate(() => sessionStorage.getItem("bsp_checkout_sn"))) || null;
    mark("after_proceed", { checkoutSn });

    let geIframeReady = false;
    for (let i = 0; i < 25; i++) {
      const urls = page.frames().map((f) => f.url());
      if (urls.some((u) => /Checkout\/v2|CreditCardForm|secure-bandai\.global-e/i.test(u))) {
        geIframeReady = true;
        break;
      }
      await page.waitForTimeout(350);
      if (i === 6 || i === 14) await dismissCookieBanner(page);
    }

    push("cart_checkout", {
      ok: Boolean(checkoutSn) && geIframeReady,
      ms: Date.now() - sChk,
      note: checkoutSn
        ? `checkoutSn ${checkoutSn} geIframe=${geIframeReady} frames=${page.frames().length}`
        : `url=${page.url()} geIframe=${geIframeReady}`,
    });
    if (!geIframeReady) {
      return {
        ok: false,
        steps,
        failedStep: "cart_checkout",
        error: "Global-e Checkout/v2 iframe never booted",
        checkoutStage: "tokenize",
        checkoutSn,
        ...meta,
        via: "http+ge",
        elapsedMs: Date.now() - t0,
      };
    }

    const sGe = Date.now();
    let filled = false;

    await page
      .waitForFunction(
        () =>
          [...document.querySelectorAll("iframe")].some((f) =>
            /CreditCardForm|secure-bandai\.global-e|payments\//i.test(f.src || ""),
          ),
        null,
        { timeout: 20_000 },
      )
      .catch(() => null);

    for (const frame of page.frames()) {
      if (!isBandaiGeCheckoutPayFrame(frame.url())) continue;
      const cardOpt = frame
        .locator(
          'label:has-text("Credit Card"), label:has-text("Card"), button:has-text("Credit Card"), [data-payment*="card" i]',
        )
        .first();
      if (await cardOpt.count().catch(() => 0)) {
        await cardOpt.click({ timeout: 2500 }).catch(() => {});
        await page.waitForTimeout(400);
      }
    }

    for (let tick = 0; tick < 14 && !filled; tick++) {
      if (tick) await page.waitForTimeout(300);
      for (const frame of page.frames()) {
        const url = frame.url();
        if (!/CreditCardForm|secure-bandai\.global-e\.com\/payments/i.test(url)) continue;
        if (/prefetcher/i.test(url)) continue;
        const num = frame
          .locator(
            'input[autocomplete="cc-number"], input[name*="cardNumber" i], input[id*="cardNumber" i], input[name*="cardNum" i], input[placeholder*="card number" i], input[type="tel"]',
          )
          .first();
        if (!(await num.count().catch(() => 0))) continue;
        if (!(await num.isVisible().catch(() => false))) continue;

        const pan = String(card.number).replace(/\s+/g, "");
        await num.click({ timeout: 2500 }).catch(() => {});
        await num.fill(pan).catch(async () => {
          await num.pressSequentially(pan, { delay: 15 });
        });
        const mm = frame
          .locator(
            'input[autocomplete="cc-exp-month"], select[name*="month" i], input[name*="expMonth" i], input[placeholder*="MM" i]',
          )
          .first();
        const yy = frame
          .locator(
            'input[autocomplete="cc-exp-year"], select[name*="year" i], input[name*="expYear" i], input[placeholder*="YY" i]',
          )
          .first();
        const exp = frame
          .locator(
            'input[autocomplete="cc-exp"], input[name*="expiry" i], input[placeholder*="MM" i][placeholder*="YY" i]',
          )
          .first();
        const cvv = frame
          .locator(
            'input[autocomplete="cc-csc"], input[name*="cvv" i], input[name*="cvc" i], input[name*="cvd" i], input[placeholder*="CVV" i]',
          )
          .first();
        const name = frame
          .locator(
            'input[autocomplete="cc-name"], input[name*="cardHolder" i], input[name*="holder" i], input[placeholder*="name on card" i]',
          )
          .first();

        if (await exp.count().catch(() => 0)) {
          await exp.fill(`${card.expMonth}/${card.expYear}`).catch(() => {});
        } else {
          if (await mm.count().catch(() => 0)) {
            const tag = await mm.evaluate((el) => el.tagName).catch(() => "");
            if (tag === "SELECT") {
              await mm
                .selectOption({ value: String(card.expMonth) })
                .catch(() => mm.selectOption({ label: String(card.expMonth) }));
            } else await mm.fill(String(card.expMonth)).catch(() => {});
          }
          if (await yy.count().catch(() => 0)) {
            const tag = await yy.evaluate((el) => el.tagName).catch(() => "");
            if (tag === "SELECT") {
              await yy
                .selectOption({ value: String(card.expYear) })
                .catch(() => yy.selectOption({ value: `20${card.expYear}` }));
            } else await yy.fill(String(card.expYear)).catch(() => {});
          }
        }
        if (await cvv.count().catch(() => 0)) await cvv.fill(String(card.cvv)).catch(() => {});
        if (await name.count().catch(() => 0)) await name.fill(String(card.holder)).catch(() => {});
        await frame.evaluate(() => document.activeElement?.blur?.()).catch(() => {});
        await page.keyboard.press("Escape").catch(() => {});
        filled = true;
        geNote = `filled card form ${url.slice(0, 70)}`;
        break;
      }
    }

    if (!filled) {
      paymentStatus = "ge_iframe_not_filled";
      push("ge_payment", {
        ok: false,
        ms: Date.now() - sGe,
        note: paymentStatus,
      });
      return {
        ok: false,
        steps,
        failedStep: "ge_payment",
        error: paymentStatus,
        checkoutStage: "tokenize",
        checkoutSn,
        paymentStatus,
        ...meta,
        via: "http+ge",
        elapsedMs: Date.now() - t0,
      };
    }

    await page.waitForTimeout(900);

    let paid = false;
    const netBefore = geNet.length;
    const tickTerms = async () => {
      for (const frame of page.frames()) {
        if (!isBandaiGeCheckoutPayFrame(frame.url())) continue;
        const checks = frame.locator('input[type="checkbox"]');
        const n = await checks.count().catch(() => 0);
        for (let ci = 0; ci < n; ci++) {
          const c = checks.nth(ci);
          if (!(await c.isChecked().catch(() => true))) {
            await c.check({ force: true }).catch(() => {});
          }
        }
      }
    };
    await tickTerms();

    for (let attempt = 0; attempt < 6 && !paid; attempt++) {
      await tickTerms();
      for (const frame of page.frames()) {
        const url = frame.url();
        if (!isBandaiGeCheckoutPayFrame(url)) continue;
        const payBtn = frame
          .locator(
            'button:has-text("Pay"):visible, button:has-text("Place Order"):visible, button:has-text("Pay now"):visible',
          )
          .first();
        if (!(await payBtn.count().catch(() => 0))) continue;
        if (!(await payBtn.isVisible().catch(() => false))) continue;
        if (await payBtn.isDisabled().catch(() => false)) {
          geNote += `; pay_disabled@${attempt}`;
          continue;
        }
        try {
          await payBtn.click({ timeout: 8_000, noWaitAfter: true });
          payClickCount += 1;
          paymentStatus = "pay_clicked";
          geNote += `; clicked pay#${payClickCount} on ${url.slice(0, 50)}`;
          paid = true;
          mark("pay_clicked", { payClickCount, frame: url.slice(0, 80) });
        } catch (e) {
          geNote += `; pay_click_fail@${attempt}:${String(e?.message || e).slice(0, 40)}`;
        }
        break;
      }
      if (paid) break;
      await page.waitForTimeout(400);
    }

    if (!paid) {
      paymentStatus = "card_filled_no_pay_button";
      push("ge_payment", { ok: false, ms: Date.now() - sGe, note: `${paymentStatus}; ${geNote}` });
      return {
        ok: false,
        steps,
        failedStep: "ge_payment",
        error: paymentStatus,
        checkoutStage: "tokenize",
        checkoutSn,
        paymentStatus,
        payClickCount,
        ...meta,
        via: "http+ge",
        elapsedMs: Date.now() - t0,
      };
    }

    await page.waitForTimeout(1200);

    const authReqs = () =>
      geNet.slice(netBefore).filter((n) => n.kind === "req" && isBandaiGeAuthPaymentUrl(n.url));
    const payNet = geNet.slice(netBefore);
    const payNetHot = payNet.filter((n) => isBandaiGeAuthPaymentUrl(n.url));
    geNote += `; payNet=${payNet.length}/${payNetHot.length} payClicks=${payClickCount}`;
    if (payClickCount > 1) geNote += "; WARN multi_pay_click";
    if (payNet.length === 0) {
      paymentStatus = "pay_clicked_no_payment_request";
      geNote += "; WARN no GE traffic after click";
    }

    if (paymentStatus === "pay_clicked" || paymentStatus === "pay_clicked_no_payment_request") {
      const hardDeadline =
        Date.now() +
        (paymentStatus === "pay_clicked_no_payment_request"
          ? Math.min(12_000, wait3dsMs)
          : wait3dsMs);
      sawAuthWire = authReqs().length > 0;
      const wireSeenAt = { t: sawAuthWire ? Date.now() : 0 };
      // Stay long enough after wire to scrape issuer decline UI (bank soft-declines often have no ACS).
      const postWireObserveMs = Math.min(20_000, Math.max(14_000, wait3dsMs));

      while (Date.now() < hardDeadline && !reached3ds && !orderNumber) {
        if (!sawAuthWire) {
          const n = authReqs().length;
          if (n > 0) {
            sawAuthWire = true;
            wireSeenAt.t = Date.now();
            geNote += `; authWire=${n}`;
            mark("auth_wire", { authReqs: n });
          }
        } else if (
          Date.now() - wireSeenAt.t >= postWireObserveMs &&
          paymentStatus !== "declined_or_auth_failed"
        ) {
          break;
        }
        await page.waitForTimeout(500);

        // Also sniff GE JSON responses for decline codes.
        for (const n of geNet.slice(netBefore)) {
          if (n.kind !== "res" || !n.url) continue;
          if (n._sniffed) continue;
          n._sniffed = true;
        }

        for (const frame of page.frames()) {
          const furl = frame.url();
          let ftext = "";
          try {
            ftext = (await frame.locator("body").innerText({ timeout: 500 })) || "";
          } catch {
            /* ignore */
          }
          if (looksLike3ds(furl, ftext)) {
            reached3ds = true;
            threeDsUrl = furl.slice(0, 160);
            paymentStatus = "reached_3ds";
            mark("reached_3ds", { threeDsUrl });
            break;
          }
          const snip = extractDeclineSnippet(ftext);
          if (snip) {
            declineSnippet = snip;
            paymentStatus = "declined_or_auth_failed";
            mark("payment_declined", { declineSnippet: snip, where: "frame" });
            break;
          }
        }
        if (reached3ds || paymentStatus === "declined_or_auth_failed") break;

        for (const p of context.pages()) {
          if (looksLike3ds(p.url())) {
            reached3ds = true;
            threeDsUrl = p.url().slice(0, 160);
            paymentStatus = "reached_3ds";
            mark("reached_3ds", { threeDsUrl });
            break;
          }
        }
        if (reached3ds) break;

        let bodyProbe = "";
        try {
          bodyProbe = await page.locator("body").innerText({ timeout: 600 });
        } catch {
          /* ignore */
        }
        const orderHint = bodyProbe.match(/order\s*(?:no|number|#)\s*[:：]?\s*([A-Z0-9-]{6,})/i);
        if (orderHint) {
          orderNumber = orderHint[1];
          paymentStatus = "order_confirmed";
          mark("order_confirmed", { orderNumber });
          break;
        }
        const snip = extractDeclineSnippet(bodyProbe);
        if (snip) {
          declineSnippet = snip;
          paymentStatus = "declined_or_auth_failed";
          mark("payment_declined", { declineSnippet: snip, where: "page" });
          break;
        }

        // Response URL/status hints (GE sometimes encodes fail in path/query).
        for (const n of payNetHot.concat(geNet.slice(netBefore))) {
          if (n.kind === "res" && (n.status >= 400 || /fail|declin|reject/i.test(n.url || ""))) {
            if (!declineSnippet) {
              declineSnippet = `http ${n.status || "?"} ${String(n.url || "").slice(0, 100)}`;
              paymentStatus = "declined_or_auth_failed";
              mark("payment_declined", { declineSnippet, where: "net" });
              break;
            }
          }
        }
        if (paymentStatus === "declined_or_auth_failed") break;
      }
      if (paymentStatus === "pay_clicked") {
        paymentStatus = reached3ds ? "reached_3ds" : "pay_submitted_no_3ds_seen";
      }
      // Soft decline with no UI: still surface a clear terminal status when wire fired once.
      if (
        paymentStatus === "pay_submitted_no_3ds_seen" &&
        sawAuthWire &&
        payClickCount === 1 &&
        !orderNumber &&
        !reached3ds
      ) {
        // Keep pay_submitted… but attach note — bank may have declined without GE copy.
        geNote += "; await_bank_confirm_if_no_ui_decline";
        mark("pay_submitted_await_bank", { sawAuthWire: true });
      }
    }

    const gePayOk =
      reached3ds ||
      Boolean(orderNumber) ||
      paymentStatus === "declined_or_auth_failed" ||
      (payClickCount === 1 &&
        sawAuthWire &&
        (paymentStatus === "pay_submitted_no_3ds_seen" || paymentStatus === "pay_clicked"));

    push("ge_payment", {
      ok: gePayOk,
      ms: Date.now() - sGe,
      note: `${paymentStatus}; payClicks=${payClickCount}; ${geNote}`.slice(0, 280),
    });

    const cookies = {};
    for (const c of await context.cookies("https://p-bandai.com")) cookies[c.name] = c.value;

    mark("ge_done", { paymentStatus, ok: gePayOk, elapsedMs: Date.now() - t0 });
    return {
      ok: gePayOk,
      steps,
      timeline,
      checkoutStage: orderNumber
        ? "order"
        : paymentStatus === "declined_or_auth_failed"
          ? "declined"
          : reached3ds
            ? "three_ds"
            : "tokenize",
      dryRun: false,
      paymentStatus,
      reached3ds,
      threeDsUrl,
      checkoutSn,
      orderNumber,
      payClickCount,
      sawAuthWire,
      declineSnippet,
      geNetTail: geNet.slice(-20),
      cookies,
      ...meta,
      finalUrl: page.url() || `${base}/orderdetails`,
      note: reached3ds
        ? `3DS challenge seen (${threeDsUrl || "frame"})`
        : orderNumber
          ? `Order ${orderNumber}`
          : paymentStatus === "declined_or_auth_failed"
            ? `Payment declined${declineSnippet ? `: ${declineSnippet}` : ""}`
            : `GE via http+bridge; ${paymentStatus}; elapsed=${Date.now() - t0}ms`,
      failedStep: gePayOk ? null : "ge_payment",
      error: gePayOk ? null : paymentStatus,
      elapsedMs: Date.now() - t0,
      via: "http+ge",
    };
  } finally {
    page.off("request", onReq);
    page.off("response", onRes);
  }
}

export default { browserBandaiGeFromCart };
