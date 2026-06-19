// Local Playwright checkout — runs in the user's Electron process with their
// real residential IP. Logically identical to the Browserless script in
// src/lib/browserless.functions.ts, just using Playwright's API and local
// chromium instead of the remote Puppeteer.

const { chromium } = require("playwright");

async function runCheckout(job) {
  const steps = [];
  const t0 = Date.now();
  const log = (step, ok, note) => steps.push({ step, t: Date.now() - t0, ok, note });
  let lastStep = "launch";
  let browser, context, page;

  const fail = async (err) => {
    let shot = null;
    try { shot = page ? (await page.screenshot({ type: "png" })).toString("base64") : null; } catch {}
    try { await browser?.close(); } catch {}
    return {
      jobId: job.id, ok: false, failedStep: lastStep, error: err,
      steps, screenshotB64: shot, elapsedMs: Date.now() - t0,
    };
  };

  try {
    const launchOpts = {
      headless: false, // visible window helps debugging; flip to true for batch.
      args: ["--disable-blink-features=AutomationControlled"],
    };
    if (job.proxy) {
      const m = job.proxy.match(/^(?:([^:]+):([^@]+)@)?([^:]+):(\d+)$/);
      if (m) {
        launchOpts.proxy = {
          server: `http://${m[3]}:${m[4]}`,
          username: m[1] || undefined,
          password: m[2] || undefined,
        };
      }
    }
    browser = await chromium.launch(launchOpts);
    context = await browser.newContext({
      userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
      viewport: { width: 1280, height: 800 },
    });
    page = await context.newPage();
    log("launch", true);

    // 1. Warm cookies + add to cart
    lastStep = "cart_add";
    await page.goto(job.storeUrl, { waitUntil: "domcontentloaded", timeout: 30_000 });
    const addRes = await page.evaluate(async ({ storeUrl, vid, q }) => {
      const r = await fetch(`${storeUrl.replace(/\/$/, "")}/cart/add.js`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ id: String(vid), quantity: String(q) }).toString(),
        credentials: "include",
      });
      return { status: r.status, body: await r.text() };
    }, { storeUrl: job.storeUrl, vid: job.variantId, q: job.qty });
    if (addRes.status >= 400) {
      log("cart_add", false, `HTTP ${addRes.status}`);
      return await fail(`cart_add failed: ${addRes.body.slice(0, 200)}`);
    }
    log("cart_add", true);

    // 2. Checkout page
    lastStep = "checkout_load";
    await page.goto(`${job.storeUrl.replace(/\/$/, "")}/checkout`, {
      waitUntil: "domcontentloaded", timeout: 45_000,
    });
    log("checkout_load", true, page.url());

    // 3. Contact + shipping
    lastStep = "contact_fill";
    const p = job.profile;
    const fill = async (sel, val) => {
      const el = await page.$(sel);
      if (!el) return false;
      await el.click({ clickCount: 3 }).catch(() => {});
      await el.type(val, { delay: 15 });
      return true;
    };
    await fill('input[name="checkout[email]"], input[name="email"]', p.email);
    await fill('input[name="checkout[shipping_address][first_name]"], input[name="firstName"]', p.first_name);
    await fill('input[name="checkout[shipping_address][last_name]"], input[name="lastName"]', p.last_name);
    await fill('input[name="checkout[shipping_address][address1]"], input[name="address1"]', p.address1);
    if (p.address2) await fill('input[name="checkout[shipping_address][address2]"], input[name="address2"]', p.address2);
    await fill('input[name="checkout[shipping_address][city]"], input[name="city"]', p.city);
    await fill('input[name="checkout[shipping_address][zip]"], input[name="postalCode"]', p.zip);
    await fill('input[name="checkout[shipping_address][phone]"], input[name="phone"]', p.phone);
    try {
      await page.selectOption('select[name="checkout[shipping_address][country]"]', p.country);
      await page.selectOption('select[name="checkout[shipping_address][province]"]', p.province);
    } catch {}
    log("contact_fill", true);

    // 4. Continue to shipping
    lastStep = "shipping_continue";
    const clickContinue = async () => {
      const candidates = [
        'button#continue_button',
        'button[type="submit"][name="button"]',
        'button:has-text("Continue to shipping")',
        'button:has-text("Continue")',
      ];
      for (const sel of candidates) {
        const btn = await page.$(sel).catch(() => null);
        if (btn) { await btn.click(); return true; }
      }
      return false;
    };
    await clickContinue();
    await page.waitForLoadState("domcontentloaded", { timeout: 30_000 }).catch(() => {});
    log("shipping_continue", true, page.url());

    // 5. Shipping method
    lastStep = "shipping_method";
    await page.waitForSelector('input[name="checkout[shipping_rate][id]"], [data-shipping-method]', { timeout: 15_000 }).catch(() => {});
    const firstRate = await page.$('input[name="checkout[shipping_rate][id]"]');
    if (firstRate) await firstRate.click().catch(() => {});
    log("shipping_method", true);

    lastStep = "payment_continue";
    await clickContinue();
    await page.waitForLoadState("domcontentloaded", { timeout: 30_000 }).catch(() => {});
    log("payment_continue", true, page.url());

    // 6. Card fill (Stripe iframes)
    lastStep = "card_fill";
    await page.waitForSelector('iframe[name^="card-fields-number"]', { timeout: 20_000 });
    const frames = page.frames();
    const numFrame  = frames.find((f) => /card-fields-number/.test(f.name()));
    const expFrame  = frames.find((f) => /card-fields-expiry/.test(f.name()));
    const cvvFrame  = frames.find((f) => /card-fields-verification/.test(f.name()));
    const nameFrame = frames.find((f) => /card-fields-name/.test(f.name()));
    if (!numFrame || !expFrame || !cvvFrame) {
      log("card_fill", false, "card iframes missing");
      return await fail("card iframes not found");
    }
    await numFrame.locator("input").type(job.card.number, { delay: 20 });
    await expFrame.locator("input").type(`${String(job.card.exp_month).padStart(2, "0")}/${String(job.card.exp_year).slice(-2)}`, { delay: 20 });
    await cvvFrame.locator("input").type(job.card.cvv, { delay: 20 });
    if (nameFrame) await nameFrame.locator("input").type(job.card.name, { delay: 20 });
    log("card_fill", true);

    // 7. Captcha token injection
    if (job.captchaToken) {
      lastStep = "captcha_inject";
      await page.evaluate((tok) => {
        const set = (name) => {
          let el = document.querySelector(`input[name="${name}"]`);
          if (!el) {
            el = document.createElement("input");
            el.type = "hidden"; el.name = name;
            document.querySelector("form")?.appendChild(el);
          }
          el.value = tok;
        };
        set("cf-turnstile-response");
        set("g-recaptcha-response");
        set("h-captcha-response");
      }, job.captchaToken);
      log("captcha_inject", true);
    }

    // 8. Submit or dry-run stop
    if (job.dryRun) {
      const shot = (await page.screenshot({ type: "png" })).toString("base64");
      await browser.close();
      return {
        jobId: job.id, ok: true, orderId: null, finalUrl: page.url(),
        steps, screenshotB64: shot, elapsedMs: Date.now() - t0, dryRun: true,
      };
    }

    lastStep = "submit";
    await clickContinue();
    log("submit", true);

    // 9. Confirm — wait for thank-you OR a decline message. Detect 3-D Secure
    // challenge and extend the wait window so the user can approve in-bank.
    lastStep = "confirm";
    const paymentTerms = /declined|payment\s*(?:failed|could(?:n['\u2019])?t|cannot|can\s*not)|card\s*(?:invalid|declined|not accepted)|unable to process|try another card|expired|insufficient funds/i;
    const isThankYou = (u) => /\/thank_you|orders\/|checkouts\/.+\/thank/i.test(u);
    const detect3DS = async () => {
      try {
        for (const f of page.frames()) {
          const u = f.url() || "";
          if (/three_d_secure|3d[_-]?secure|3ds|hooks\.stripe\.com\/3d|challenges\.stripe\.com|acs|authenticate|challenge/i.test(u)) return true;
        }
        return await page.evaluate(() => {
          const t = (document.body && document.body.innerText) || "";
          return /3-?D\s*Secure|verify(?:\s+your)?\s+(?:identity|payment|purchase)|authenticate your card|approve.*?(?:bank|app)|sent (?:a|you) (?:code|notification)|enter (?:the )?(?:code|otp)/i.test(t);
        });
      } catch { return false; }
    };
    let deadline = Date.now() + 15000;
    let threeDsActive = false;
    let declineMsg = null;
    while (Date.now() < deadline) {
      if (isThankYou(page.url())) break;
      let bodyText = "";
      try { bodyText = await page.evaluate(() => (document.body && document.body.innerText) || ""); } catch (_) {}
      const m = bodyText.match(new RegExp("[^\\n]*(?:" + paymentTerms.source + ")[^\\n]*", "i"));
      if (m) { declineMsg = m[0].trim().slice(0, 240); break; }
      if (!threeDsActive && await detect3DS()) {
        threeDsActive = true;
        lastStep = "three_d_secure";
        log("three_d_secure", true, "challenge detected");
        deadline = Date.now() + 240000;
      }
      await new Promise((r) => setTimeout(r, threeDsActive ? 1000 : 300));
    }

    const finalUrl = page.url();
    const shot = (await page.screenshot({ type: "png" })).toString("base64");

    if (/\/thank_you|orders\/|checkouts\/.+\/thank/i.test(finalUrl)) {
      const orderMatch = finalUrl.match(/orders\/(\d+)|checkouts\/[^/]+\/([a-z0-9]+)\/thank_you/i);
      const orderId = orderMatch ? (orderMatch[1] ?? orderMatch[2] ?? null) : null;
      log("confirm", true, orderId ?? finalUrl);
      await browser.close();
      return {
        jobId: job.id, ok: true, orderId, finalUrl,
        steps, screenshotB64: shot, elapsedMs: Date.now() - t0, dryRun: false,
      };
    }

    // Look for a decline message in the page body.
    let bodyText = "";
    try { bodyText = await page.evaluate(() => (document.body && document.body.innerText) || ""); } catch (_) {}
    const m = bodyText.match(new RegExp("[^\\n]*(?:" + paymentTerms.source + ")[^\\n]*", "i"));
    if (m) {
      const msg = m[0].trim().slice(0, 240);
      log("payment_result", true, msg);
      await browser.close();
      return {
        jobId: job.id, ok: true, paymentRejected: true, paymentMessage: msg,
        orderId: null, finalUrl, steps, screenshotB64: shot,
        elapsedMs: Date.now() - t0, dryRun: false,
      };
    }

    // No confirmation and no decline marker — surface as failure.
    log("confirm", false, finalUrl);
    await browser.close();
    return {
      jobId: job.id, ok: false, failedStep: "confirm",
      error: "No thank-you page and no decline marker detected",
      finalUrl, steps, screenshotB64: shot, elapsedMs: Date.now() - t0,
    };
  } catch (e) {
    return await fail(e.message || String(e));
  }
}

module.exports = { runCheckout };
