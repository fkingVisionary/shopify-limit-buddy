#!/usr/bin/env node
// RESEARCH ONLY — Playwright checkout UI helpers for Toymate recon.
// DO NOT import from adapters/ or any module place-order path.
// Module checkout must stay pure HTTP (see adapters/toymate-adyen.js placeOrderViaHttp).
//
// This file is a quarantine of the former placeOrderViaCheckoutUi path so wire
// probing can continue without contaminating the executor module runtime.

import {
  solveTurnstileChallenge,
  extractTurnstileSitekey,
  solveCloudflareChallenge,
  looksLikeCfChallenge,
  capsolverKey,
} from "../adapters/toymate-cf-solve.js";

async function dismissSpamModal(page) {
  for (const sel of [
    'button:has-text("Ok")',
    'button:has-text("OK")',
    '[role="dialog"] button',
    ".modal button",
  ]) {
    const btn = page.locator(sel).first();
    if (await btn.count()) {
      try {
        if (await btn.isVisible()) await btn.click({ timeout: 1500 });
      } catch {
        /* ignore */
      }
    }
  }
}

async function injectRecaptchaToken(page, token) {
  if (!token) return;
  await page.evaluate((tok) => {
    const apply = () => {
      for (const el of document.querySelectorAll(
        'textarea[name="g-recaptcha-response"], #g-recaptcha-response, textarea[id*="g-recaptcha"]',
      )) {
        el.value = tok;
        el.innerHTML = tok;
        el.dispatchEvent(new Event("input", { bubbles: true }));
        el.dispatchEvent(new Event("change", { bubbles: true }));
      }
    };
    apply();

    const hook = () => {
      if (!window.grecaptcha) return false;
      try {
        window.grecaptcha.getResponse = () => tok;
        const prevExec = window.grecaptcha.execute?.bind(window.grecaptcha);
        window.grecaptcha.execute = async (...args) => {
          try {
            if (prevExec) await prevExec(...args);
          } catch {
            /* ignore */
          }
          return tok;
        };
      } catch {
        /* ignore */
      }
      try {
        const cfg = window.___grecaptcha_cfg;
        const clients = cfg?.clients ? Object.values(cfg.clients) : [];
        const walk = (o, depth = 0) => {
          if (!o || depth > 7) return;
          if (typeof o.callback === "function") {
            try {
              o.callback(tok);
            } catch {
              /* ignore */
            }
          }
          if (o && typeof o === "object") {
            for (const k of Object.keys(o)) {
              try {
                walk(o[k], depth + 1);
              } catch {
                /* ignore */
              }
            }
          }
        };
        for (const c of clients) walk(c);
      } catch {
        /* ignore */
      }
      return true;
    };

    if (!hook()) {
      const iv = setInterval(() => {
        apply();
        if (hook()) clearInterval(iv);
      }, 400);
      setTimeout(() => clearInterval(iv), 20_000);
    } else {
      setInterval(apply, 1500);
    }
  }, token);
}

async function clickHumanVerify(page) {
  // BC Optimized Checkout: "Please click here to verify yourself as human…"
  for (const sel of [
    'text=/verify yourself as human/i',
    'a:has-text("click here")',
    'button:has-text("click here")',
    'text=/click here to verify/i',
    '[class*="spam"] a',
    '[class*="recaptcha"] a',
  ]) {
    const el = page.locator(sel).first();
    if (!(await el.count())) continue;
    try {
      if (await el.isVisible()) {
        await el.click({ timeout: 2500 });
        return true;
      }
    } catch {
      /* try next */
    }
  }
  return false;
}

async function waitForAdyenFrames(page, { timeoutMs = 75_000, captchaToken = null } = {}) {
  const deadline = Date.now() + timeoutMs;
  let clickedVerify = false;
  while (Date.now() < deadline) {
    await dismissSpamModal(page);
    if (captchaToken) await injectRecaptchaToken(page, captchaToken);

    const body = await page.locator("body").innerText().catch(() => "");
    if (/verify yourself as human|click here to verify/i.test(body) && !clickedVerify) {
      clickedVerify = await clickHumanVerify(page);
      if (captchaToken) await injectRecaptchaToken(page, captchaToken);
      await page.waitForTimeout(1500);
    } else if (/verify yourself as human|click here to verify/i.test(body)) {
      // Click again periodically — first click sometimes only opens widget.
      await clickHumanVerify(page);
      if (captchaToken) await injectRecaptchaToken(page, captchaToken);
    }

    // Expand / focus Payment step
    for (const sel of [
      'h2:has-text("Payment")',
      '[data-test="payment-continue-button"]',
      'legend:has-text("Payment")',
      'button:has-text("Continue")',
    ]) {
      const el = page.locator(sel).first();
      if (await el.count()) {
        try {
          if (await el.isVisible()) await el.click({ timeout: 800 });
        } catch {
          /* ignore */
        }
      }
    }
    for (const sel of [
      'label:has-text("Credit Card")',
      'text=Credit Card',
      '[data-test="payment-method-scheme"]',
      'input[value="scheme"]',
      "#radio-adyenv3",
    ]) {
      const el = page.locator(sel).first();
      if (await el.count()) {
        try {
          if (await el.isVisible()) await el.click({ timeout: 1500 });
        } catch {
          /* ignore */
        }
      }
    }

    const frames = page.frames();
    const adyen = frames.filter((f) =>
      /adyen|checkoutshopper|securedfields|card-field/i.test(f.url() + (f.name() || "")),
    );
    const titled = await page.locator("iframe").evaluateAll((els) =>
      els.map((e) => ({
        title: e.getAttribute("title") || "",
        src: (e.getAttribute("src") || "").slice(0, 120),
      })),
    );
    const hasCardIframe = titled.some((t) =>
      /card number|secured card number|encryptedCardNumber|number/i.test(t.title + t.src),
    );
    if (adyen.length >= 1 || hasCardIframe) {
      return { ok: true, titled, adyenCount: adyen.length, clickedVerify };
    }
    await page.waitForTimeout(1200);
  }
  const titled = await page.locator("iframe").evaluateAll((els) =>
    els.map((e) => ({
      title: e.getAttribute("title") || "",
      src: (e.getAttribute("src") || "").slice(0, 120),
    })),
  );
  return { ok: false, titled, adyenCount: 0, clickedVerify };
}

/**
 * Place order through BigCommerce checkout UI (Adyen secured fields).
 * Returns { ok, status, note, declined, orderNumber, body }.
 */
async function applyContextCookies(context, cookieMap) {
  if (!cookieMap || !Object.keys(cookieMap).length) return;
  const jarCookies = Object.entries(cookieMap).map(([name, value]) => ({
    name,
    value: String(value),
    domain: ".toymate.com.au",
    path: "/",
    httpOnly: false,
    secure: true,
    sameSite: "Lax",
  }));
  await context.addCookies(jarCookies);
}

async function clearPlaywrightTurnstile(page, context, { proxyUrl, userAgent } = {}) {
  const html = await page.content().catch(() => "");
  const body = await page.locator("body").innerText().catch(() => "");
  const challenged =
    looksLikeCfChallenge(html, 403) ||
    /verify you are human|performing security verification|cf-turnstile|challenge-platform/i.test(
      body + html,
    );
  if (!challenged) return { ok: true, skipped: true };

  // 0) Soft click Turnstile / checkbox — sometimes completes without CapSolver.
  try {
    const box = page.locator("text=/Verify you are human/i").first();
    if (await box.count()) await box.click({ timeout: 2000 }).catch(() => {});
    const frames = page.frames().filter((f) => /turnstile|challenges\.cloudflare/i.test(f.url()));
    for (const f of frames) {
      try {
        await f.click("body", { timeout: 1500 });
        await f.locator('input[type="checkbox"]').click({ timeout: 1500 }).catch(() => {});
      } catch {
        /* ignore */
      }
    }
    await page.waitForTimeout(4000);
    const bodyClick = await page.locator("body").innerText().catch(() => "");
    if (!/performing security verification|verify you are human/i.test(bodyClick)) {
      return { ok: true, note: "CF cleared via Turnstile click", via: "click" };
    }
  } catch {
    /* continue to CapSolver */
  }

  if (!capsolverKey()) {
    return { ok: false, note: "Playwright CF challenge — CAPSOLVER_API_KEY missing" };
  }

  // Persist challenge HTML for debugging CapSolver "invalid html".
  try {
    const { writeFileSync } = await import("node:fs");
    writeFileSync("/tmp/toymate-pw-cf-challenge.html", html.slice(0, 400_000));
  } catch {
    /* ignore */
  }

  // 1) Prefer AntiCloudflareTask on live challenge HTML (same path that clears undici).
  const anti = await solveCloudflareChallenge({
    pageUrl: page.url() || "https://toymate.com.au/checkout",
    html,
    proxyRaw: proxyUrl,
    userAgent,
  });
  if (anti.ok) {
    await applyContextCookies(context, anti.cookies);
    if (anti.userAgent && anti.userAgent !== userAgent) {
      // UA mismatch can't be changed mid-context; cookies alone often enough after reload.
    }
    await page.goto(page.url() || "https://toymate.com.au/checkout", {
      waitUntil: "domcontentloaded",
      timeout: 60_000,
    }).catch(() => page.reload({ waitUntil: "domcontentloaded", timeout: 60_000 }));
    await page.waitForTimeout(2500);
    const bodyAnti = await page.locator("body").innerText().catch(() => "");
    if (!/performing security verification|verify you are human/i.test(bodyAnti)) {
      return { ok: true, note: "CF cleared via AntiCloudflareTask", via: "anti-cf" };
    }
  }

  // 2) Turnstile token path — sitekey from DOM / CF opts after widgets render.
  let sitekey =
    extractTurnstileSitekey(html) ||
    (await page
      .locator("[data-sitekey]")
      .first()
      .getAttribute("data-sitekey")
      .catch(() => null));
  if (!sitekey) {
    sitekey = await page.evaluate(() => {
      try {
        if (window._cf_chl_opt?.chlApiSitekey) return window._cf_chl_opt.chlApiSitekey;
        if (window._cf_chl_opt?.sitekey) return window._cf_chl_opt.sitekey;
      } catch {
        /* ignore */
      }
      const el = document.querySelector("[data-sitekey]");
      return el?.getAttribute("data-sitekey") || null;
    });
  }
  if (!sitekey) {
    return {
      ok: false,
      note: `Playwright CF uncleared (anti=${anti.error || anti.note || "fail"}; turnstile sitekey missing)`,
    };
  }

  let solved = await solveTurnstileChallenge({
    pageUrl: page.url(),
    sitekey,
    proxyRaw: proxyUrl,
    userAgent,
  });
  if (!solved.ok) {
    solved = await solveTurnstileChallenge({
      pageUrl: page.url(),
      sitekey,
      proxyless: true,
      userAgent,
    });
  }
  if (!solved.ok) return { ok: false, note: solved.error || "Turnstile solve failed" };

  await applyContextCookies(context, solved.cookies);
  if (solved.token) {
    await page.evaluate((tok) => {
      for (const el of document.querySelectorAll(
        '[name="cf-turnstile-response"], input[name*="turnstile"], textarea[name*="turnstile"]',
      )) {
        el.value = tok;
      }
      try {
        if (window.turnstile?.getResponse) window.turnstile.getResponse = () => tok;
      } catch {
        /* ignore */
      }
    }, solved.token);
  }

  await page.reload({ waitUntil: "domcontentloaded", timeout: 60_000 }).catch(() => {});
  await page.waitForTimeout(2500);
  const body2 = await page.locator("body").innerText().catch(() => "");
  const still = /performing security verification|verify you are human/i.test(body2);
  return {
    ok: !still,
    note: still ? "Turnstile still present after CapSolver" : "Turnstile cleared",
    sitekey,
    via: "turnstile",
  };
}

export async function placeOrderViaCheckoutUi({
  proxyUrl,
  cookies,
  userAgent,
  card,
  captchaToken = null,
  checkoutUrl = "https://toymate.com.au/checkout",
  timeoutMs = 150_000,
  screenshotPath = null,
} = {}) {
  const { chromium } = await import("playwright");
  let proxy = null;
  if (proxyUrl) {
    try {
      const u = new URL(proxyUrl);
      proxy = {
        server: `${u.protocol}//${u.hostname}:${u.port || (u.protocol === "https:" ? "443" : "80")}`,
        username: u.username ? decodeURIComponent(u.username) : undefined,
        password: u.password ? decodeURIComponent(u.password) : undefined,
      };
    } catch {
      proxy = null;
    }
  }

  const browser = await chromium.launch({
    headless: true,
    proxy: proxy || undefined,
  });
  try {
    const context = await browser.newContext({
      userAgent:
        userAgent ||
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
      locale: "en-AU",
      viewport: { width: 1280, height: 900 },
    });
    const jarCookies = [];
    for (const [name, value] of Object.entries(cookies || {})) {
      jarCookies.push({
        name,
        value: String(value),
        domain: ".toymate.com.au",
        path: "/",
        httpOnly: false,
        secure: true,
        sameSite: "Lax",
      });
    }
    if (jarCookies.length) await context.addCookies(jarCookies);

    const page = await context.newPage();
    const paymentLogs = [];
    page.on("response", async (res) => {
      const url = res.url();
      const method = res.request().method();
      if (
        (/spam-protection|payments|order|adyen|bigpay|checkoutshopper/i.test(url) && method !== "GET") ||
        (/spam-protection/i.test(url) && method === "POST")
      ) {
        let body = "";
        try {
          body = (await res.text()).slice(0, 500);
        } catch {
          /* ignore */
        }
        paymentLogs.push({ url: url.slice(0, 160), status: res.status(), method, body });
      }
    });

    if (captchaToken) {
      await page.addInitScript((tok) => {
        window.__toymateCaptcha = tok;
      }, captchaToken);
    }

    await page.goto(checkoutUrl, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await page.waitForTimeout(2000);

    const cfClear = await clearPlaywrightTurnstile(page, context, {
      proxyUrl,
      userAgent,
      cookies,
    });
    if (!cfClear.ok && !cfClear.skipped) {
      if (screenshotPath) {
        try {
          await page.screenshot({ path: screenshotPath, fullPage: true });
        } catch {
          /* ignore */
        }
      }
      return {
        ok: false,
        status: null,
        note: cfClear.note || "Playwright blocked by Cloudflare Turnstile",
        declined: false,
        paymentLogs,
        finalUrl: page.url(),
      };
    }

    await dismissSpamModal(page);
    if (captchaToken) await injectRecaptchaToken(page, captchaToken);
    await page.waitForTimeout(1500);
    await dismissSpamModal(page);

    // If checkout-js already failed spam, dismiss and re-inject then soft reload payment.
    const bodyEarly = await page.locator("body").innerText().catch(() => "");
    if (/spam protection verification/i.test(bodyEarly)) {
      await dismissSpamModal(page);
      if (captchaToken) await injectRecaptchaToken(page, captchaToken);
      await page.waitForTimeout(1000);
      // Trigger a payment-step refresh by editing/collapsing shipping then returning.
      const edit = page.locator('[data-test="step-edit-button"]').first();
      if (await edit.count()) {
        try {
          await edit.click({ timeout: 2000 });
          await page.waitForTimeout(800);
          const cont = page.locator("#checkout-shipping-continue, button:has-text('Continue')").first();
          if (await cont.count()) await cont.click({ timeout: 3000 }).catch(() => {});
        } catch {
          /* ignore */
        }
      }
    }

    // Explicit human-verify click before waiting on Adyen (BC spam gate).
    await clickHumanVerify(page);
    if (captchaToken) await injectRecaptchaToken(page, captchaToken);
    // After verify click, checkout-js may need a second inject + small dwell
    // for its spam-protection XHR to fire with the CapSolver token.
    await page.waitForTimeout(2000);
    if (captchaToken) await injectRecaptchaToken(page, captchaToken);
    await page.waitForTimeout(3000);

    const framesReady = await waitForAdyenFrames(page, {
      timeoutMs: 90_000,
      captchaToken,
    });
    if (!framesReady.ok) {
      if (screenshotPath) {
        try {
          await page.screenshot({ path: screenshotPath, fullPage: true });
        } catch {
          /* ignore */
        }
      }
      const spamHit = paymentLogs.find((l) => /spam-protection/i.test(l.url));
      const bodyHint = (await page.locator("body").innerText().catch(() => ""))
        .replace(/\s+/g, " ")
        .slice(0, 120);
      return {
        ok: false,
        status: spamHit?.status ?? null,
        note: `Adyen fields not found (verifyClick=${framesReady.clickedVerify}; spamApi=${spamHit?.status || "none"}; body=${bodyHint})`,
        declined: false,
        paymentLogs,
        finalUrl: page.url(),
      };
    }

    const number = String(card.number || "").replace(/\s+/g, "");
    const expMonth = String(card.expMonth || "").padStart(2, "0").slice(-2);
    let expYear = String(card.expYear || "").trim();
    if (expYear.length === 4) expYear = expYear.slice(-2);
    const cvv = String(card.cvv || "").trim();
    const holder = String(card.holder || "Cardholder").trim();

    for (const sel of [
      'input[name="cc-name"]',
      'input[autocomplete="cc-name"]',
      'input[id*="cardholder" i]',
      'input[name*="holder" i]',
    ]) {
      const el = page.locator(sel).first();
      if (await el.count()) {
        try {
          await el.fill(holder);
          break;
        } catch {
          /* ignore */
        }
      }
    }

    async function fillFrame(titleRe, value) {
      const frame = page.frameLocator(`iframe[title*="${titleRe}" i]`).first();
      const input = frame.locator("input").first();
      await input.waitFor({ timeout: 20_000 });
      await input.fill(value);
    }

    async function fillByUrl(re, value) {
      const frames = page.frames().filter((f) => re.test(f.url()));
      for (const f of frames) {
        const input = f.locator("input").first();
        if (await input.count()) {
          await input.fill(value);
          return true;
        }
      }
      return false;
    }

    const tries = [
      async () => {
        await fillFrame("card number", number);
        await fillFrame("expiry", `${expMonth}${expYear}`);
        await fillFrame("security", cvv);
      },
      async () => {
        await fillFrame("secured card number", number);
        await fillFrame("secured card expiry", `${expMonth}${expYear}`);
        await fillFrame("secured card security", cvv);
      },
      async () => {
        await fillFrame("number", number);
        await fillFrame("expir", `${expMonth} / ${expYear}`);
        await fillFrame("cvc", cvv);
      },
      async () => {
        await fillFrame("encryptedCardNumber", number);
        await fillFrame("encryptedExpiryDate", `${expMonth}${expYear}`);
        await fillFrame("encryptedSecurityCode", cvv);
      },
      async () => {
        const okN = await fillByUrl(/encryptedCardNumber|cardnumber|card-number/i, number);
        const okE = await fillByUrl(/expiry|expir/i, `${expMonth}${expYear}`);
        const okC = await fillByUrl(/security|cvc|cvv/i, cvv);
        if (!(okN && okE && okC)) throw new Error("url-frame fill incomplete");
      },
    ];
    let filled = false;
    let fillErr = null;
    for (const fn of tries) {
      try {
        await fn();
        filled = true;
        break;
      } catch (e) {
        fillErr = e;
      }
    }
    if (!filled) {
      if (screenshotPath) {
        try {
          await page.screenshot({ path: screenshotPath, fullPage: true });
        } catch {
          /* ignore */
        }
      }
      return {
        ok: false,
        status: null,
        note: `Adyen fields not fillable: ${fillErr?.message || fillErr}`,
        declined: false,
        paymentLogs,
        finalUrl: page.url(),
      };
    }

    // Re-inject captcha right before place (token can expire ~2 min).
    if (captchaToken) await injectRecaptchaToken(page, captchaToken);

    for (const sel of [
      "#checkout-payment-continue",
      'button:has-text("Place Order")',
      'button:has-text("Pay")',
      'button[type="submit"]',
    ]) {
      const btn = page.locator(sel).first();
      if (await btn.count()) {
        try {
          await btn.click({ timeout: 5000 });
          break;
        } catch {
          /* next */
        }
      }
    }

    const declineRe =
      /declin|insufficient|not enough|do not honour|do not honor|payment failed|unable to process|card was declined|authentication failed|refused|invalid card|card number is invalid|not supported|transaction.*(fail|deny)|Authori[sz]ed.*false|resultCode["']?\s*:\s*["']Refused/i;

    const deadline = Date.now() + timeoutMs;
    let declined = false;
    let orderNumber = null;
    let note = "waiting for payment result";
    while (Date.now() < deadline) {
      await dismissSpamModal(page);
      const url = page.url();
      const bodyText = await page.locator("body").innerText().catch(() => "");
      if (/order-confirmation|order confirmation|thank you for your order/i.test(url + bodyText)) {
        orderNumber =
          bodyText.match(/order\s*(?:number|#)?\s*[:#]?\s*(\d{5,})/i)?.[1] || null;
        note = orderNumber ? `order ${orderNumber}` : "confirmation page";
        return {
          ok: true,
          status: 200,
          note,
          declined: false,
          orderNumber,
          paymentLogs,
          finalUrl: url,
        };
      }
      if (declineRe.test(bodyText)) {
        declined = true;
        note =
          (bodyText.match(
            /.{0,40}(declin|insufficient|not enough|honou?r|payment failed|unable to process|refused|invalid card|not supported).{0,60}/i,
          ) || [null, bodyText.slice(0, 120)])[0] || "declined";
        return {
          ok: true,
          status: 402,
          note: String(note).replace(/\s+/g, " ").slice(0, 180),
          declined: true,
          orderNumber: null,
          paymentLogs,
          finalUrl: url,
        };
      }
      if (
        paymentLogs.some(
          (l) => declineRe.test(l.body) || /"status"\s*:\s*"error"|payment_failed|402/i.test(l.body),
        )
      ) {
        const hit = paymentLogs.find(
          (l) => declineRe.test(l.body) || /"status"\s*:\s*"error"|payment_failed|402/i.test(l.body),
        );
        return {
          ok: true,
          status: hit.status,
          note: hit.body.slice(0, 180),
          declined: true,
          paymentLogs,
          finalUrl: url,
        };
      }
      await page.waitForTimeout(1000);
    }
    if (screenshotPath) {
      try {
        await page.screenshot({ path: screenshotPath, fullPage: true });
      } catch {
        /* ignore */
      }
    }
    return {
      ok: false,
      status: null,
      note: `timeout after place — ${note}`,
      declined,
      paymentLogs,
      finalUrl: page.url(),
    };
  } finally {
    try {
      await browser.close();
    } catch {
      /* ignore */
    }
  }
}
