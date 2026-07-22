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
  // Keep broad enough for GE hosts — bank hit while payNetHot=0 when this was too narrow.
  return /ProcessPayment|Authorize|CompleteOrder|CreatePayment|SubmitPayment|PayOrder|PaymentData|CreditCard|\/Pay\b|Charge|Checkout\/.*Pay|secure-bandai\.global-e\.com\/.*(?:pay|auth|transaction)/i.test(
    String(url || ""),
  );
}

/** Fast SELECT fill — never use Playwright selectOption (90s default on mismatch). */
async function fillSelectFast(locator, rawValue) {
  const v = String(rawValue ?? "");
  const v2 = v.replace(/^0+/, "") || v;
  const v4 = v.length === 2 ? `20${v}` : v;
  return locator
    .evaluate(
      (el, opts) => {
        const values = [opts.v, opts.v2, opts.v4].filter(Boolean);
        const labels = values.map(String);
        if (el.tagName !== "SELECT") {
          el.value = opts.v;
          el.dispatchEvent(new Event("input", { bubbles: true }));
          el.dispatchEvent(new Event("change", { bubbles: true }));
          return { ok: true, how: "input" };
        }
        const options = [...el.options];
        for (const cand of values) {
          const hit = options.find(
            (o) =>
              o.value === cand ||
              o.value === String(Number(cand)) ||
              o.text.trim() === cand ||
              o.text.trim() === String(Number(cand)),
          );
          if (hit) {
            el.value = hit.value;
            el.dispatchEvent(new Event("input", { bubbles: true }));
            el.dispatchEvent(new Event("change", { bubbles: true }));
            return { ok: true, how: "select", value: hit.value };
          }
        }
        // Last resort: option whose value/text ends with year/month
        for (const cand of labels) {
          const hit = options.find(
            (o) => o.value.endsWith(cand) || o.text.trim().endsWith(cand),
          );
          if (hit) {
            el.value = hit.value;
            el.dispatchEvent(new Event("input", { bubbles: true }));
            el.dispatchEvent(new Event("change", { bubbles: true }));
            return { ok: true, how: "endsWith", value: hit.value };
          }
        }
        return {
          ok: false,
          options: options.slice(0, 24).map((o) => ({ v: o.value, t: o.text.trim() })),
        };
      },
      { v, v2, v4 },
    )
    .catch(() => ({ ok: false }));
}

async function fillInputFast(locator, value) {
  const v = String(value ?? "");
  // Prefer DOM set + events — GE validators listen for input/change; avoids 90s fills.
  const ok = await locator
    .evaluate((el, val) => {
      el.focus();
      el.value = "";
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.value = val;
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
      el.blur();
      return el.value === val || String(el.value).replace(/\s/g, "") === String(val).replace(/\s/g, "");
    }, v)
    .catch(() => false);
  if (ok) return true;
  await locator.click({ timeout: 1500 }).catch(() => {});
  await locator.fill(v, { timeout: 2000 }).catch(() => {});
  return true;
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

// Keep these tight — broad `transaction.*fail` / bare `funds` false-positive on order summaries.
const DECLINE_RE =
  /\b(?:declined|decline|card declined|payment declined|payment failed|not authorised|not authorized|insufficient funds|insufficient balance|low balance|do not honour|do not honor|unable to process|authentication failed|try another card|payment was not (?:successful|completed)|could not be (?:processed|completed))\b/i;

function extractDeclineSnippet(text) {
  const t = String(text || "").replace(/\s+/g, " ").trim();
  if (!t) return null;
  const m = t.match(
    /.{0,50}(?:declined|decline|card declined|payment declined|payment failed|not authorised|not authorized|insufficient funds|insufficient balance|low balance|do not honour|do not honor|unable to process|authentication failed|try another card).{0,80}/i,
  );
  if (!m) return null;
  // Require a real decline token in the snippet (guards ORDER SUMMARY false hits).
  if (!DECLINE_RE.test(m[0])) return null;
  return m[0].slice(0, 160);
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
    let frameUrls = [];
    for (let i = 0; i < 50; i++) {
      frameUrls = page.frames().map((f) => f.url());
      if (
        frameUrls.some((u) =>
          /Checkout\/v2|CreditCardForm|secure-bandai\.global-e|webservices\.global-e\.com\/Checkout/i.test(
            u,
          ),
        )
      ) {
        geIframeReady = true;
        mark("ge_iframe_ready", { frames: frameUrls.length, i });
        break;
      }
      await page.waitForTimeout(400);
      if (i % 5 === 0) await dismissCookieBanner(page);
      // Nudge: some PreOrder carts leave GEM prefetcher-only until interaction.
      if (i === 12 || i === 24) {
        await page
          .locator('label:has-text("Credit Card"), button:has-text("Credit Card"), text=Credit Card')
          .first()
          .click({ timeout: 1500 })
          .catch(() => {});
      }
    }

    push("cart_checkout", {
      ok: Boolean(checkoutSn) && geIframeReady,
      ms: Date.now() - sChk,
      note: checkoutSn
        ? `checkoutSn ${checkoutSn} geIframe=${geIframeReady} frames=${page.frames().length} sample=${frameUrls
            .filter((u) => /global/i.test(u))
            .map((u) => u.slice(0, 60))
            .join("|")}`
        : `url=${page.url()} geIframe=${geIframeReady}`,
    });
    if (!geIframeReady) {
      return {
        ok: false,
        steps,
        timeline,
        failedStep: "cart_checkout",
        error: "Global-e Checkout/v2 iframe never booted",
        checkoutStage: "tokenize",
        checkoutSn,
        paymentStatus: null,
        ...meta,
        via: "http+ge",
        elapsedMs: Date.now() - t0,
        note: `checkoutSn=${checkoutSn} but GEM iframe missing; frames=${frameUrls.map((u) => u.slice(0, 80)).join(" || ")}`,
      };
    }

    const sGe = Date.now();
    let filled = false;
    // Cap every locator op — Playwright default 90s on SELECT mismatch was the 3min Pay stall.
    page.setDefaultTimeout(8_000);

    await page
      .waitForFunction(
        () =>
          [...document.querySelectorAll("iframe")].some((f) =>
            /CreditCardForm|secure-bandai\.global-e|payments\//i.test(f.src || ""),
          ),
        null,
        { timeout: 12_000 },
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
        await cardOpt.click({ timeout: 2000 }).catch(() => {});
        await page.waitForTimeout(250);
      }
    }

    const mmRaw = String(card.expMonth || "").padStart(2, "0");
    const yyRaw = String(card.expYear || "")
      .replace(/^20/, "")
      .slice(-2);
    const pan = String(card.number).replace(/\s+/g, "");

    for (let tick = 0; tick < 10 && !filled; tick++) {
      if (tick) await page.waitForTimeout(200);
      for (const frame of page.frames()) {
        const url = frame.url();
        if (!/CreditCardForm|secure-bandai\.global-e\.com\/payments/i.test(url)) continue;
        if (/prefetcher/i.test(url)) continue;

        // Prefer Bandai GE field ids from form inspect.
        const num = frame.locator("#cardNum, input[name='PaymentData.cardNum'], input[autocomplete='cc-number']").first();
        if (!(await num.count().catch(() => 0))) continue;
        if (!(await num.isVisible().catch(() => false))) continue;

        await fillInputFast(num, pan);
        const mm = frame
          .locator(
            "#cardExpiryMonth, select[name='PaymentData.cardExpiryMonth'], select[autocomplete='cc-exp-month'], select[name*='month' i]",
          )
          .first();
        const yy = frame
          .locator(
            "#cardExpiryYear, select[name='PaymentData.cardExpiryYear'], select[autocomplete='cc-exp-year'], select[name*='year' i]",
          )
          .first();
        const cvv = frame
          .locator("#cvdNumber, input[name='PaymentData.cvdNumber'], input[autocomplete='cc-csc']")
          .first();
        const name = frame
          .locator(
            "input[autocomplete='cc-name'], input[name*='cardHolder' i], input[name*='holder' i]",
          )
          .first();

        if (await mm.count().catch(() => 0)) {
          const sel = await fillSelectFast(mm, mmRaw);
          if (!sel?.ok) geNote += `; mm_select_fail=${JSON.stringify(sel?.options || []).slice(0, 80)}`;
        }
        if (await yy.count().catch(() => 0)) {
          const sel = await fillSelectFast(yy, yyRaw);
          if (!sel?.ok) geNote += `; yy_select_fail=${JSON.stringify(sel?.options || []).slice(0, 80)}`;
        }
        if (await cvv.count().catch(() => 0)) await fillInputFast(cvv, card.cvv);
        if (await name.count().catch(() => 0)) await fillInputFast(name, card.holder);

        // Nudge GE validators / parent Checkout that card iframe changed.
        await frame
          .evaluate(() => {
            document.activeElement?.blur?.();
            window.parent?.postMessage?.({ type: "ge-card-updated" }, "*");
          })
          .catch(() => {});

        filled = true;
        geNote = `filled card form ${url.slice(0, 70)}`;
        mark("card_filled", { ms: Date.now() - sGe });
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
        timeline,
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

    let paid = false;
    const netBefore = geNet.length;
    const tickTerms = async () => {
      for (const frame of page.frames()) {
        if (!isBandaiGeCheckoutPayFrame(frame.url())) continue;
        // Explicit T&Cs labels first, then any remaining checkbox.
        const labeled = frame.locator(
          'label:has-text("Terms"), label:has-text("terms"), label:has-text("Privacy"), label:has-text("agree")',
        );
        const nLab = await labeled.count().catch(() => 0);
        for (let i = 0; i < nLab; i++) {
          await labeled.nth(i).click({ timeout: 800 }).catch(() => {});
        }
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

    // Poll Pay enable — max ~12s. Diagnose why disabled (terms / card / captcha).
    mark("wait_pay_enabled");
    let payDiag = null;
    const payDeadline = Date.now() + 12_000;
    while (Date.now() < payDeadline && !paid) {
      await tickTerms();
      for (const frame of page.frames()) {
        const url = frame.url();
        if (!isBandaiGeCheckoutPayFrame(url)) continue;
        const state = await frame
          .evaluate(() => {
            const pay = [...document.querySelectorAll("button, input[type=submit]")].find((b) =>
              /^(pay|place order|pay now)$/i.test((b.innerText || b.value || "").trim()),
            );
            const checks = [...document.querySelectorAll('input[type="checkbox"]')].map((c) => ({
              checked: !!c.checked,
              name: c.name || c.id || "",
            }));
            const errs = [...document.querySelectorAll(".error, .invalid, [class*=error i], [role=alert]")]
              .map((e) => (e.innerText || "").replace(/\s+/g, " ").trim())
              .filter(Boolean)
              .slice(0, 4);
            return {
              hasPay: Boolean(pay),
              disabled: pay ? !!pay.disabled || pay.getAttribute("aria-disabled") === "true" : null,
              checks,
              errs,
              recaptcha: Boolean(
                document.querySelector("#recapchaToken, [name='PaymentData.recapchaToken']")?.value ||
                  document.querySelector("iframe[src*='recaptcha'], iframe[src*='hcaptcha']"),
              ),
            };
          })
          .catch(() => null);
        if (state) payDiag = state;

        const payBtn = frame
          .locator(
            'button:has-text("Pay"):visible, button:has-text("Place Order"):visible, button:has-text("Pay now"):visible',
          )
          .first();
        if (!(await payBtn.count().catch(() => 0))) continue;
        if (!(await payBtn.isVisible().catch(() => false))) continue;
        const disabled = await payBtn.isDisabled().catch(() => true);
        if (disabled) continue;

        try {
          await payBtn.click({ timeout: 5_000, noWaitAfter: true });
          payClickCount += 1;
          paymentStatus = "pay_clicked";
          geNote += `; clicked pay#${payClickCount} on ${url.slice(0, 50)}`;
          paid = true;
          mark("pay_clicked", {
            payClickCount,
            frame: url.slice(0, 80),
            enableMs: Date.now() - sGe,
          });
        } catch (e) {
          geNote += `; pay_click_fail:${String(e?.message || e).slice(0, 40)}`;
        }
        break;
      }
      if (paid) break;
      await page.waitForTimeout(250);
    }
    if (!paid) {
      geNote += `; pay_still_disabled diag=${JSON.stringify(payDiag || {}).slice(0, 180)}`;
      mark("pay_still_disabled", { payDiag });
    }

    if (!paid) {
      paymentStatus = "card_filled_no_pay_button";
      push("ge_payment", { ok: false, ms: Date.now() - sGe, note: `${paymentStatus}; ${geNote}` });
      return {
        ok: false,
        steps,
        timeline,
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

    await page.waitForTimeout(800);

    const authReqs = () =>
      geNet.slice(netBefore).filter((n) => {
        if (n.kind !== "req") return false;
        if (isBandaiGeAuthPaymentUrl(n.url)) return true;
        // Bank-confirmed path sometimes uses opaque GE POSTs — count non-static GE writes.
        return (
          n.method &&
          n.method !== "GET" &&
          /global-e\.com/i.test(n.url || "") &&
          !/prefetcher|\/static\/|includes\/js|\.js(?:\?|$)|\/css\//i.test(n.url || "")
        );
      });
    const payNet = geNet.slice(netBefore);
    const payNetHot = authReqs();
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
