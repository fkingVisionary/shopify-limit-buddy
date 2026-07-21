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

    // ── Checkout POST → Global-e (decline card only) ─────────────────────
    const sCartPage = Date.now();
    await page.goto("https://p-bandai.com/au/cart", { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(2500);
    const cartHtml = await page.content();
    let tokenSuffix =
      opts.globaleMerchantCartTokenSuffix ||
      extractPreloadSuffix(cartHtml) ||
      (await page.evaluate(() => window.PRELOAD_DATA?.globaleMerchantCartTokenSuffix || null));
    push("cart_page_preload", {
      ok: Boolean(tokenSuffix),
      status: 200,
      ms: Date.now() - sCartPage,
      note: tokenSuffix
        ? `suffix ${String(tokenSuffix).slice(0, 12)}…`
        : "globaleMerchantCartTokenSuffix missing",
    });

    if (!tokenSuffix || !cartSn || !cartItemSn) {
      await browser.close();
      return {
        ok: false,
        steps,
        failedStep: "ge_token",
        error: "Missing cartSn/cartItemSn/token suffix for GE",
        checkoutStage: "tokenize",
        areaItemNo,
        cartSn,
        cartItemSn,
      };
    }

    const merchantCartToken = `${cartId || cartSn}_Checkout_${tokenSuffix}`;
    const sChk = Date.now();
    const checkout = await pageApi(page, "POST", `/api/cart/${encodeURIComponent(cartSn)}/checkout`, {
      merchantCartToken,
      shippingAreaCode: opts.shippingAreaCode || "au",
      items: [{ cartItemSn }],
    });
    const checkoutSn = checkout.json?.checkoutSn || null;
    push("cart_checkout", {
      ok: checkout.status >= 200 && checkout.status < 300 && Boolean(checkoutSn),
      status: checkout.status,
      ms: Date.now() - sChk,
      note: checkoutSn
        ? `checkoutSn ${checkoutSn}`
        : checkout.json?.detail || checkout.title || `checkout ${checkout.status}`,
    });

    if (!checkoutSn) {
      await browser.close();
      return {
        ok: false,
        steps,
        failedStep: "cart_checkout",
        error: steps[steps.length - 1].note,
        checkoutStage: "tokenize",
        areaItemNo,
        cartSn,
      };
    }

    // Navigate order details / GE embed
    const sGe = Date.now();
    await page.goto("https://p-bandai.com/au/orderdetails", { waitUntil: "domcontentloaded" }).catch(() => {});
    await page.waitForTimeout(4000);

    // Decline-oriented fake card — never a real PAN from the owner.
    const card = opts.card || {
      number: "4000000000000002", // common decline test PAN
      expMonth: "12",
      expYear: "30",
      cvv: "999",
      holder: "DECLINE TEST",
    };

    // Best-effort: fill visible GE / hosted fields if present. Many GE frames are cross-origin.
    let geNote = "checkoutSn minted — attempting GE decline card fill";
    let paymentStatus = "unknown";
    try {
      const frames = page.frames();
      geNote = `GE frames=${frames.length}`;
      let filled = false;
      for (const frame of frames) {
        const url = frame.url();
        if (!/global-e|globale|payment|checkout/i.test(url) && frame === page.mainFrame()) continue;
        const num = frame.locator('input[name*="card" i], input[autocomplete="cc-number"], input[id*="card" i]').first();
        if (!(await num.count().catch(() => 0))) continue;
        await num.fill(String(card.number).replace(/\s+/g, ""), { timeout: 5000 }).catch(() => {});
        const mm = frame.locator('input[name*="month" i], input[autocomplete="cc-exp-month"], select[name*="month" i]').first();
        const yy = frame.locator('input[name*="year" i], input[autocomplete="cc-exp-year"], select[name*="year" i]').first();
        const cvv = frame.locator('input[name*="cvv" i], input[name*="cvc" i], input[autocomplete="cc-csc"]').first();
        const name = frame.locator('input[name*="name" i], input[autocomplete="cc-name"]').first();
        if (await mm.count().catch(() => 0)) await mm.fill(String(card.expMonth), { timeout: 3000 }).catch(() => {});
        if (await yy.count().catch(() => 0)) await yy.fill(String(card.expYear), { timeout: 3000 }).catch(() => {});
        if (await cvv.count().catch(() => 0)) await cvv.fill(String(card.cvv), { timeout: 3000 }).catch(() => {});
        if (await name.count().catch(() => 0)) await name.fill(String(card.holder), { timeout: 3000 }).catch(() => {});
        filled = true;
        geNote += `; filled frame ${url.slice(0, 60)}`;
        const payBtn = frame
          .locator('button:has-text("Pay"), button:has-text("Place"), button[type="submit"]')
          .first();
        if (await payBtn.count().catch(() => 0)) {
          await payBtn.click({ timeout: 5000 }).catch(() => {});
          await page.waitForTimeout(5000);
          paymentStatus = "submitted_decline_attempt";
        }
        break;
      }
      if (!filled) {
        paymentStatus = "ge_iframe_not_filled";
        geNote += " — no fillable GE card fields (cross-origin or not loaded)";
      }
    } catch (e) {
      paymentStatus = "ge_error";
      geNote = String(e?.message || e).slice(0, 200);
    }

    // Look for decline / error copy
    const bodyText = await page.locator("body").innerText().catch(() => "");
    const declined = /declin|payment failed|not authorised|not authorized|card.*invalid|do not honour/i.test(
      bodyText,
    );
    if (declined) paymentStatus = "declined";

    push("ge_payment", {
      ok: declined || paymentStatus === "submitted_decline_attempt" || paymentStatus === "ge_iframe_not_filled",
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
      ok: declined || Boolean(checkoutSn),
      steps,
      checkoutStage: "tokenize",
      dryRun: false,
      declineTarget: true,
      paymentStatus,
      checkoutSn,
      merchantCartToken,
      areaItemNo,
      cartSn,
      cartItemSn,
      title,
      finalUrl: finalUrl || "https://p-bandai.com/au/orderdetails",
      cookies,
      note: declined
        ? "Payment declined (expected with fake card)"
        : `GE handoff reached checkoutSn; paymentStatus=${paymentStatus}`,
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
