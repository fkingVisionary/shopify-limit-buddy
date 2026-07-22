// Premium Bandai AU — browser session for F5-gated login + ATC (+ optional GE).
// Raw HTTP can warm/search/product, but POST /login and ATC bind to browser TLS.
// Keep OnlineSim/HTTP agen separate; this is checkout-path only.

import { chromium } from "playwright";

function proxyForPlaywright(rawProxy) {
  if (!rawProxy) return null;
  let url;
  try {
    url = new URL(/^https?:\/\//i.test(rawProxy) ? rawProxy : `http://${rawProxy}`);
  } catch {
    return null;
  }
  return {
    server: `${url.protocol}//${url.hostname}:${url.port || (url.protocol === "https:" ? 443 : 80)}`,
    username: url.username ? decodeURIComponent(url.username) : undefined,
    password: url.password ? decodeURIComponent(url.password) : undefined,
  };
}

async function pageApi(page, method, path, body) {
  return page.evaluate(
    async ({ method, path, body }) => {
      window.__bandaiCsrf =
        window.__bandaiCsrf ||
        window.USER_DATA?.csrfToken ||
        "";
      const csrf = window.__bandaiCsrf || window.USER_DATA?.csrfToken || "";
      const headers = {
        accept: "application/json, text/plain, */*",
        "x-g1-area-code": "au",
        "x-requested-with": "XMLHttpRequest",
        ...(csrf ? { "x-csrf-token": csrf } : {}),
      };
      if (body != null) headers["content-type"] = "application/json";
      const res = await fetch(path, {
        method,
        headers,
        body: body != null ? JSON.stringify(body) : undefined,
        credentials: "include",
      });
      const nextCsrf = res.headers.get("x-csrf-token");
      if (nextCsrf) {
        window.__bandaiCsrf = nextCsrf;
        if (window.USER_DATA) window.USER_DATA.csrfToken = nextCsrf;
      } else if (res.ok) {
        try {
          const peek = await res.clone().json();
          if (peek?.csrfToken) {
            window.__bandaiCsrf = peek.csrfToken;
            if (window.USER_DATA) window.USER_DATA.csrfToken = peek.csrfToken;
          }
        } catch {
          /* ignore */
        }
      }
      const text = await res.text();
      let json = null;
      try {
        json = JSON.parse(text);
      } catch {
        /* html error page */
      }
      if (json?.csrfToken) {
        window.__bandaiCsrf = json.csrfToken;
        if (window.USER_DATA) window.USER_DATA.csrfToken = json.csrfToken;
      }
      return {
        status: res.status,
        json,
        title: json ? null : (text.match(/<title>([^<]+)/i) || [])[1] || null,
        preview: (json ? JSON.stringify(json) : text).replace(/\s+/g, " ").slice(0, 400),
      };
    },
    { method, path, body: body ?? null },
  );
}

function extractPreloadSuffix(html) {
  const m =
    String(html || "").match(/globaleMerchantCartTokenSuffix["']?\s*[:=]\s*["']([^"']+)["']/i) ||
    String(html || "").match(
      /PRELOAD_DATA\s*=\s*\{[\s\S]*?globaleMerchantCartTokenSuffix["']?\s*:\s*["']([^"']+)["']/i,
    );
  return m?.[1] || null;
}

/** Walk Bandai cart.detail — lines live under subCarts[].combinedShippings[].lineItems[]. */
function findCartLine(cartJson, areaItemNo) {
  const subs = Array.isArray(cartJson?.subCarts) ? cartJson.subCarts : [];
  for (const sc of subs) {
    const nested = [];
    for (const ship of sc.combinedShippings || []) {
      for (const it of ship.lineItems || []) nested.push(it);
    }
    for (const it of [
      ...nested,
      ...(sc.items || []),
      ...(sc.cartItems || []),
      ...(sc.lineItems || []),
    ]) {
      const prod = it.product || it;
      const aino = prod.areaItemNo || it.areaItemNo;
      if (areaItemNo && String(aino || "") !== String(areaItemNo)) continue;
      if (!areaItemNo && !aino) continue;
      return {
        cartSn: sc.cartSn,
        cartId: sc.cartId,
        cartItemSn: it.cartLineItemSn || it.cartItemSn || prod.cartItemSn || null,
        cartType: sc.cartType,
        qty: prod.qty || it.qty || 1,
        areaItemNo: aino,
        line: it,
        sub: sc,
      };
    }
  }
  return null;
}

function listCartLines(cartJson) {
  const out = [];
  for (const sc of cartJson?.subCarts || []) {
    for (const ship of sc.combinedShippings || []) {
      for (const it of ship.lineItems || []) {
        out.push({
          cartSn: sc.cartSn,
          cartId: sc.cartId,
          cartItemSn: it.cartLineItemSn || it.product?.cartItemSn,
          areaItemNo: it.product?.areaItemNo,
          qty: it.product?.qty,
        });
      }
    }
  }
  return out;
}

/**
 * Full browser checkout dry-run / decline attempt.
 * @param {object} opts
 * @param {string} opts.email
 * @param {string} opts.password
 * @param {string} opts.productCode — e.g. A2880191001
 * @param {string} [opts.proxy]
 * @param {number} [opts.qty=1]
 * @param {boolean} [opts.placeOrder=false] — if true, attempt GE with decline card
 * @param {object} [opts.card] — fake/decline card only
 */
export async function browserBandaiCheckout(opts = {}) {
  const email = String(opts.email || "").trim();
  const password = String(opts.password || "");
  const productCode = String(opts.productCode || "").trim();
  const qty = Math.max(1, Math.min(5, Number(opts.qty) || 1));
  const placeOrder = opts.placeOrder === true;
  const steps = [];
  const t0 = Date.now();

  const push = (step, out) => {
    const row = {
      step,
      ok: out?.ok !== false,
      status: out?.status ?? null,
      ms: out?.ms ?? null,
      note: out?.note ?? null,
    };
    steps.push(row);
    return out;
  };

  if (!email || !password) {
    return { ok: false, error: "email_password_required", steps, checkoutStage: "pre_cart" };
  }
  if (!productCode) {
    return { ok: false, error: "productCode_required", steps, checkoutStage: "pre_cart" };
  }

  const proxy = proxyForPlaywright(opts.proxy);
  let browser;
  try {
    browser = await chromium.launch({
      headless: opts.headless !== false,
      proxy: proxy || undefined,
      args: ["--disable-blink-features=AutomationControlled"],
    });
    const context = await browser.newContext({
      locale: "en-AU",
      userAgent:
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
      viewport: { width: 1360, height: 900 },
    });
    const page = await context.newPage();
    page.setDefaultTimeout(Number(opts.timeoutMs) || 90_000);

    // ── Login ────────────────────────────────────────────────────────────
    const sLogin = Date.now();
    await page.goto("https://p-bandai.com/au/login", { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(1200);
    const login = await page.evaluate(async ({ email: em, password: pw }) => {
      const csrf = window.USER_DATA?.csrfToken || window.__bandaiCsrf || "";
      const body = `grantType=password&memberId=${encodeURIComponent(em)}&password=${encodeURIComponent(pw)}&saveLoginId=false&autoLogin=false`;
      const res = await fetch("/login", {
        method: "POST",
        headers: {
          accept: "application/json, text/plain, */*",
          "content-type": "application/x-www-form-urlencoded;charset=utf-8",
          "x-g1-area-code": "au",
          "x-requested-with": "XMLHttpRequest",
          ...(csrf ? { "x-csrf-token": csrf } : {}),
        },
        body,
        credentials: "include",
      });
      const next = res.headers.get("x-csrf-token");
      if (next) {
        window.__bandaiCsrf = next;
        if (window.USER_DATA) window.USER_DATA.csrfToken = next;
      }
      return {
        status: res.status,
        restrictedType: res.headers.get("x-restricted-type"),
        csrf: next,
      };
    }, { email, password });
    await page.waitForTimeout(1500);

    const member = await pageApi(page, "GET", "/api/context/member/refresh");
    const memberNo = member.json?.memberNo || null;
    const loginOk = login.status >= 200 && login.status < 300 && Boolean(memberNo);
    push("login_browser", {
      ok: loginOk,
      status: login.status,
      ms: Date.now() - sLogin,
      note: loginOk
        ? `member ${memberNo}`
        : `login ${login.status} restricted=${login.restrictedType || "none"} refresh=${member.status}`,
    });
    if (!loginOk) {
      await browser.close();
      return {
        ok: false,
        steps,
        failedStep: "login_browser",
        error: "browser login failed",
        checkoutStage: "pre_cart",
        restrictedType: login.restrictedType,
      };
    }

    // ── PDP warm (required before ATC — mints CSRF / cart cookies) ───────
    const sPdp = Date.now();
    await page.goto(`https://p-bandai.com/au/item/${encodeURIComponent(productCode)}`, {
      waitUntil: "domcontentloaded",
    });
    await page.waitForTimeout(3500);
    // Re-seed CSRF after navigation (USER_DATA rotates on SPA route changes).
    await pageApi(page, "GET", "/api/context/member");
    const product = await pageApi(page, "GET", `/api/products/${encodeURIComponent(productCode)}`);
    const areaItemNo =
      product.json?.areaItemNos?.[0] ||
      Object.keys(product.json?.areaItemInventoryInfoMap || {})[0] ||
      null;
    const title =
      product.json?.productName ||
      product.json?.name ||
      (await page.title().catch(() => productCode));
    push("product_get", {
      ok: product.status === 200 && Boolean(areaItemNo),
      status: product.status,
      ms: Date.now() - sPdp,
      note: areaItemNo
        ? `${areaItemNo} avail=${Boolean(product.json?.purchaseAvailable)}`
        : `product ${product.status}`,
    });
    if (!areaItemNo) {
      await browser.close();
      return {
        ok: false,
        steps,
        failedStep: "product_get",
        error: "areaItemNo missing",
        checkoutStage: "pre_cart",
      };
    }

    // If SKU already in cart (max 1 / prior dry-run), skip ATC and continue.
    const cartBefore = await pageApi(page, "GET", "/api/cart/detail");
    const alreadyInCart = findCartLine(cartBefore.json, areaItemNo);
    let atc = { status: null, json: null, title: null };

    // ── ATC ──────────────────────────────────────────────────────────────
    const sAtc = Date.now();
    let atcOk = false;
    if (alreadyInCart?.cartItemSn) {
      atcOk = true;
      atc = {
        status: 200,
        json: {
          items: [{ cartLineItemSn: alreadyInCart.cartItemSn, addedNewCart: false }],
          totalCartCount: cartBefore.json?.totalItemCount,
        },
      };
      push("addToCart", {
        ok: true,
        status: 200,
        ms: Date.now() - sAtc,
        note: `already in cart line=${alreadyInCart.cartItemSn} qty=${alreadyInCart.qty}`,
      });
    } else {
      for (let attempt = 0; attempt < 2 && !atcOk; attempt++) {
        if (attempt > 0) {
          await page.waitForTimeout(2000);
          await page.goto(`https://p-bandai.com/au/item/${encodeURIComponent(productCode)}`, {
            waitUntil: "domcontentloaded",
          });
          await page.waitForTimeout(3000);
        }
        atc = await pageApi(page, "POST", "/api/cart/addToCart", [{ areaItemNo, qty }]);
        const errCode = String(atc.json?.error || atc.json?.errorCode || "");
        atcOk = atc.status >= 200 && atc.status < 300 && !/CouldNotAddToCart/i.test(errCode);
        // Bandai returns HTTP 404 + JSON error for business ATC failures.
        if (!atcOk && /MaxPurchaseQty/i.test(errCode + String(atc.preview || ""))) {
          const again = await pageApi(page, "GET", "/api/cart/detail");
          const line = findCartLine(again.json, areaItemNo);
          if (line?.cartItemSn) {
            atcOk = true;
            atc = {
              status: 200,
              json: { items: [{ cartLineItemSn: line.cartItemSn, addedNewCart: false }] },
            };
          }
        }
      }
      push("addToCart", {
        ok: atcOk,
        status: atc.status,
        ms: Date.now() - sAtc,
        note: atcOk
          ? `ATC ok cart=${atc.json?.totalCartCount ?? "?"}`
          : atc.json?.error || atc.title || atc.json?.errorCode || `ATC ${atc.status}`,
      });
    }
    if (!atcOk) {
      await browser.close();
      return {
        ok: false,
        steps,
        failedStep: "addToCart",
        error: steps[steps.length - 1].note,
        checkoutStage: "cart",
        areaItemNo,
        title,
      };
    }

    // ── Cart detail ──────────────────────────────────────────────────────
    const sCart = Date.now();
    let cart = await pageApi(page, "GET", "/api/cart/detail");
    let hit = findCartLine(cart.json, areaItemNo);
    // Keep qty at 1 before any payment attempt (prior dry-runs may have stacked).
    if (hit?.cartItemSn && Number(hit.qty) > 1) {
      const mod = await pageApi(
        page,
        "PUT",
        `/api/cart/modifyCartItem?cartItemSn=${encodeURIComponent(hit.cartItemSn)}&qty=1`,
      );
      push("cart_qty_normalize", {
        ok: mod.status >= 200 && mod.status < 300,
        status: mod.status,
        note: `qty ${hit.qty}→1`,
      });
      cart = await pageApi(page, "GET", "/api/cart/detail");
      hit = findCartLine(cart.json, areaItemNo);
    }
    const cartSn = hit?.cartSn || null;
    const cartId = hit?.cartId || null;
    const cartItemSn = hit?.cartItemSn || atc.json?.items?.[0]?.cartLineItemSn || null;
    push("cart_detail", {
      ok: cart.status === 200 && Boolean(cartSn) && Boolean(cartItemSn),
      status: cart.status,
      ms: Date.now() - sCart,
      note: cartSn
        ? `cartSn ${cartSn} line=${cartItemSn} type=${hit?.cartType || "?"} lines=${listCartLines(cart.json).length}`
        : `cart ${cart.status}`,
    });

    // Default: stop before GE (dry-run)
    if (!placeOrder) {
      const cookies = {};
      for (const c of await context.cookies("https://p-bandai.com")) cookies[c.name] = c.value;
      await browser.close();
      return {
        ok: true,
        steps,
        checkoutStage: "cart",
        dryRun: true,
        areaItemNo,
        cartSn,
        cartId,
        cartItemSn,
        title,
        finalUrl: "https://p-bandai.com/au/cart",
        cookies,
        note: "Browser ATC + cart ok — GE skipped (placeOrder:false)",
        elapsedMs: Date.now() - t0,
        via: "browser",
      };
    }

    // ── UI checkout → Global-e iframe (decline card only) ────────────────
    // SPA "PROCEED TO CHECKOUT" boots GEM correctly; raw API checkoutSn alone
    // often leaves orderdetails without the payment iframe.
    const sChk = Date.now();
    await page.goto("https://p-bandai.com/au/cart", { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(3500);

    // PreOrder carts may show a shipping-area checkbox — tick if present.
    const areaBoxes = page.locator('input[type="checkbox"]');
    const boxCount = await areaBoxes.count();
    for (let i = 0; i < boxCount; i++) {
      const box = areaBoxes.nth(i);
      if (!(await box.isChecked().catch(() => true))) {
        await box.check({ force: true }).catch(() => {});
      }
    }

    const proceed = page
      .locator('button:has-text("PROCEED TO CHECKOUT"), button:has-text("Proceed to Checkout")')
      .first();
    if (!(await proceed.count()) || !(await proceed.isVisible().catch(() => false))) {
      push("cart_checkout", {
        ok: false,
        status: null,
        ms: Date.now() - sChk,
        note: "PROCEED TO CHECKOUT button missing",
      });
      await browser.close();
      return {
        ok: false,
        steps,
        failedStep: "cart_checkout",
        error: "PROCEED TO CHECKOUT button missing",
        checkoutStage: "tokenize",
        areaItemNo,
        cartSn,
        cartItemSn,
      };
    }

    await Promise.all([
      page
        .waitForURL(/orderdetails|Global-e|global-e/i, { timeout: 60_000 })
        .catch(() => null),
      proceed.click(),
    ]);
    await page.waitForTimeout(5000);

    const checkoutSn =
      (await page.evaluate(() => sessionStorage.getItem("bsp_checkout_sn"))) || null;
    const geIframeReady = await page
      .waitForSelector('iframe[src*="global-e.com"], iframe[src*="global-e"]', {
        timeout: 45_000,
      })
      .then(() => true)
      .catch(() => false);

    push("cart_checkout", {
      ok: Boolean(checkoutSn) || /orderdetails/i.test(page.url()),
      status: null,
      ms: Date.now() - sChk,
      note: checkoutSn
        ? `checkoutSn ${checkoutSn} geIframe=${geIframeReady}`
        : `url=${page.url()} geIframe=${geIframeReady}`,
    });

    const sGe = Date.now();
    // Decline-only fake card — never the owner's real PAN.
    const card = opts.card || {
      number: "4000000000000002",
      expMonth: "12",
      expYear: "30",
      cvv: "999",
      holder: "DECLINE TEST",
    };

    let geNote = "";
    let paymentStatus = "unknown";
    let filled = false;
    try {
      // Prefer waiting for the secure card form frame (flaky timing on GE boot).
      await page
        .waitForFunction(
          () =>
            [...document.querySelectorAll("iframe")].some((f) =>
              /CreditCardForm|secure-bandai\.global-e|payments\//i.test(f.src || ""),
            ),
          null,
          { timeout: 60_000 },
        )
        .catch(() => null);

      // Click Credit Card / Card payment method inside Checkout iframe if needed.
      for (const frame of page.frames()) {
        if (!/Checkout\/v2|webservices\.global-e/i.test(frame.url())) continue;
        const cardOpt = frame
          .locator(
            'label:has-text("Credit Card"), label:has-text("Card"), button:has-text("Credit Card"), [data-payment*="card" i]',
          )
          .first();
        if (await cardOpt.count().catch(() => 0)) {
          await cardOpt.click({ timeout: 5000 }).catch(() => {});
          await page.waitForTimeout(2000);
        }
      }

      for (let tick = 0; tick < 20 && !filled; tick++) {
        await page.waitForTimeout(1500);
        for (const frame of page.frames()) {
          const url = frame.url();
          if (!/global-e\.com|globale/i.test(url)) continue;
          if (/prefetcher/i.test(url)) continue;

          const num = frame
            .locator(
              'input[autocomplete="cc-number"], input[name*="cardNumber" i], input[id*="cardNumber" i], input[placeholder*="card number" i], input[type="tel"]',
            )
            .first();
          if (!(await num.count().catch(() => 0))) continue;
          if (!(await num.isVisible().catch(() => false))) continue;

          await num.fill(String(card.number).replace(/\s+/g, ""), { timeout: 8000 });
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
            .locator('input[autocomplete="cc-exp"], input[name*="expiry" i], input[placeholder*="MM" i][placeholder*="YY" i]')
            .first();
          const cvv = frame
            .locator(
              'input[autocomplete="cc-csc"], input[name*="cvv" i], input[name*="cvc" i], input[placeholder*="CVV" i]',
            )
            .first();
          const name = frame
            .locator('input[autocomplete="cc-name"], input[name*="cardHolder" i], input[name*="name" i]')
            .first();

          if (await exp.count().catch(() => 0)) {
            await exp.fill(`${card.expMonth}/${card.expYear}`, { timeout: 5000 }).catch(() => {});
          } else {
            if (await mm.count().catch(() => 0)) {
              const tag = await mm.evaluate((el) => el.tagName).catch(() => "");
              if (tag === "SELECT") await mm.selectOption({ value: String(card.expMonth) }).catch(() => mm.selectOption({ label: String(card.expMonth) }));
              else await mm.fill(String(card.expMonth), { timeout: 3000 }).catch(() => {});
            }
            if (await yy.count().catch(() => 0)) {
              const tag = await yy.evaluate((el) => el.tagName).catch(() => "");
              if (tag === "SELECT") {
                await yy
                  .selectOption({ value: String(card.expYear) })
                  .catch(() => yy.selectOption({ value: `20${card.expYear}` }));
              } else await yy.fill(String(card.expYear), { timeout: 3000 }).catch(() => {});
            }
          }
          if (await cvv.count().catch(() => 0)) await cvv.fill(String(card.cvv), { timeout: 5000 }).catch(() => {});
          if (await name.count().catch(() => 0)) await name.fill(String(card.holder), { timeout: 5000 }).catch(() => {});

          filled = true;
          geNote = `filled card form ${url.slice(0, 70)}`;
          break;
        }
      }

      // Pay / Place Order usually lives on the parent Checkout/v2 frame, not the card form.
      if (filled) {
        let paid = false;
        for (const frame of page.frames()) {
          const url = frame.url();
          if (!/global-e\.com\/Checkout|webservices\.global-e|secure-bandai\.global-e/i.test(url)) {
            continue;
          }
          const payBtn = frame
            .locator(
              'button:has-text("Pay"), button:has-text("Place Order"), button:has-text("Complete"), button:has-text("Confirm"), button[type="submit"], input[type="submit"]',
            )
            .first();
          if (await payBtn.count().catch(() => 0)) {
            if (await payBtn.isVisible().catch(() => false)) {
              await payBtn.click({ timeout: 10_000 }).catch(() => {});
              await page.waitForTimeout(10_000);
              paymentStatus = "submitted_decline_attempt";
              geNote += `; clicked pay on ${url.slice(0, 50)}`;
              paid = true;
              break;
            }
          }
        }
        if (!paid) {
          // Last resort: main page
          const mainPay = page
            .locator('button:has-text("Pay"), button:has-text("Place Order")')
            .first();
          if (await mainPay.count().catch(() => 0)) {
            await mainPay.click({ timeout: 5000 }).catch(() => {});
            await page.waitForTimeout(8000);
            paymentStatus = "submitted_decline_attempt";
            geNote += "; clicked pay on main";
          } else {
            paymentStatus = "card_filled_no_pay_button";
          }
        }
      }
      if (!filled) {
        paymentStatus = "ge_iframe_not_filled";
        const urls = page.frames().map((f) => f.url().slice(0, 100));
        geNote = `frames=${urls.length} ${urls.filter((u) => /global/i.test(u)).join(" | ")}`;
      }
    } catch (e) {
      paymentStatus = "ge_error";
      geNote = String(e?.message || e).slice(0, 200);
    }

    let bodyText = "";
    try {
      bodyText = await page.locator("body").innerText();
      for (const frame of page.frames()) {
        if (/global-e\.com/i.test(frame.url())) {
          bodyText += " " + ((await frame.locator("body").innerText().catch(() => "")) || "");
        }
      }
    } catch {
      /* ignore */
    }
    const declined =
      /declin|payment failed|not authorised|not authorized|card.*invalid|do not honour|unable to process/i.test(
        bodyText,
      );
    if (declined) paymentStatus = "declined";

    // Abort if an order number somehow appeared — never treat as success charge.
    const orderHint = bodyText.match(/order\s*(?:no|number|#)\s*[:：]?\s*([A-Z0-9-]{6,})/i);
    if (orderHint) {
      push("ge_payment", {
        ok: false,
        status: null,
        ms: Date.now() - sGe,
        note: `UNEXPECTED order-like token ${orderHint[1]} — abort`,
      });
      await browser.close();
      return {
        ok: false,
        steps,
        failedStep: "ge_payment",
        error: "Unexpected order confirmation — aborting (decline-only mode)",
        checkoutStage: "order",
        orderNumber: orderHint[1],
        declineTarget: true,
      };
    }

    push("ge_payment", {
      ok: declined || paymentStatus.startsWith("submitted") || paymentStatus.startsWith("card_filled") || paymentStatus === "ge_iframe_not_filled",
      status: null,
      ms: Date.now() - sGe,
      note: `${paymentStatus}; ${geNote}`.slice(0, 240),
    });

    const finalUrl = page.url();
    const cookies = {};
    for (const c of await context.cookies("https://p-bandai.com")) cookies[c.name] = c.value;
    await browser.close();
    browser = null;

    return {
      ok: declined || Boolean(checkoutSn) || /orderdetails/i.test(finalUrl),
      steps,
      checkoutStage: "tokenize",
      dryRun: false,
      declineTarget: true,
      paymentStatus,
      checkoutSn,
      areaItemNo,
      cartSn,
      cartId,
      cartItemSn,
      title,
      finalUrl: finalUrl || "https://p-bandai.com/au/orderdetails",
      cookies,
      note: declined
        ? "Payment declined (expected with fake card)"
        : `GE UI handoff; paymentStatus=${paymentStatus}`,
      elapsedMs: Date.now() - t0,
      via: "browser",
      orderNumber: null,
    };
  } catch (e) {
    try {
      await browser?.close?.();
    } catch {
      /* ignore */
    }
    push("browser_error", { ok: false, note: String(e?.message || e).slice(0, 240) });
    return {
      ok: false,
      steps,
      failedStep: "browser_error",
      error: String(e?.message || e).slice(0, 300),
      checkoutStage: "pre_cart",
      via: "browser",
    };
  }
}

export default { browserBandaiCheckout };
