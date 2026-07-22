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
  // Prefer real keystrokes — DOM value set left Pay enabled but posting nothing
  // after click (Revolut silent). Fall back to fill/DOM if type is flaky.
  try {
    await locator.click({ timeout: 1500 });
    await locator.fill("");
    if (typeof locator.pressSequentially === "function") {
      await locator.pressSequentially(v, { delay: 12 });
    } else {
      await locator.type(v, { delay: 12 });
    }
    const cur = await locator.inputValue().catch(() => "");
    if (cur.replace(/\s/g, "") === v.replace(/\s/g, "")) return true;
  } catch {
    /* fall through */
  }
  await locator.fill(v, { timeout: 2000 }).catch(() => {});
  return true;
}

/** True GE checkout action that can hit the issuer (not WriteContextualLog). */
export function isBandaiGeHandleAction(url) {
  return /webservices\.global-e\.com\/checkoutv2\/handleaction\//i.test(String(url || ""));
}

/** Action id from …/checkoutv2/handleaction/{id}/{guid}/… — 1=init, ≥2 can authorize. */
export function bandaiGeHandleActionId(url) {
  const m = String(url || "").match(/\/checkoutv2\/handleaction\/(\d+)\//i);
  return m ? Number(m[1]) : null;
}

/**
 * Revolut-proven issuer family (pool lab 2026-07-22).
 * Match any HandleCreditCard* under secure-bandai Payments — not handleaction/save.
 */
export function isBandaiGeIssuerPaymentUrl(url) {
  const u = String(url || "");
  return (
    /secure-bandai\.global-e\.com\/\d+\/Payments\/HandleCreditCard/i.test(u) ||
    /secure-bandai\.global-e\.com\/[^?\s]*\/Payments\/HandleCreditCard/i.test(u)
  );
}

/** Broad GE mutating traffic (logging / diagnostics). Prefer issuer URL for guards. */
export function isBandaiGeChargeRequest(method, url) {
  const m = String(method || "GET").toUpperCase();
  if (m === "GET" || m === "OPTIONS" || m === "HEAD") return false;
  const u = String(url || "");
  if (!/global-e\.com/i.test(u)) return false;
  if (
    /prefetcher|\/static\/|includes\/js|includes\/css|\.js(?:\?|$)|\/css\/|fingerprint|forter|GetCartToken|MerchantCartToken|analytics|telemetry|beacon|collect|client-event|WriteContextualLog|collectCheckout|\/log(?:ging)?\b|recaptcha|hcaptcha|checkoutv2\/handleaction|checkoutv2\/save|VerifyAddress/i.test(
      u,
    )
  ) {
    return false;
  }
  if (isBandaiGeIssuerPaymentUrl(u)) return true;
  return /ProcessPayment|Authorize|CompleteOrder|CreatePayment|SubmitPayment|PayOrder|\bCharge\b|HandleCreditCard|SecurePayment|DoPayment|SendPayment/i.test(
    u,
  );
}

const GLOBALE_MID_DEFAULT = "1925";

/** Prefetch GEM bundle + prefetcher while cart UI is open (before Proceed). */
async function warmGemAssets(page, mid = GLOBALE_MID_DEFAULT) {
  await page
    .evaluate((merchantId) => {
      const hubs = [
        "https://gem-bandai.global-e.com",
        "https://webservices.global-e.com",
        "https://secure-bandai.global-e.com",
        "https://web-bandai.global-e.com",
        "https://gepi.global-e.com",
      ];
      for (const href of hubs) {
        for (const rel of ["preconnect", "dns-prefetch"]) {
          const l = document.createElement("link");
          l.rel = rel;
          l.href = href;
          l.crossOrigin = "anonymous";
          document.head.appendChild(l);
        }
      }
      const assets = [
        {
          href: `https://gem-bandai.global-e.com/includes/js/${merchantId}`,
          as: "script",
        },
        {
          href: `https://gem-bandai.global-e.com/includes/css/${merchantId}`,
          as: "style",
        },
        {
          href: `https://web-bandai.global-e.com/shared/prefetcher/${merchantId}/AU`,
          as: "document",
        },
      ];
      for (const a of assets) {
        const l = document.createElement("link");
        l.rel = "preload";
        l.as = a.as;
        l.href = a.href;
        if (a.as !== "document") l.crossOrigin = "anonymous";
        document.head.appendChild(l);
        // Populate HTTP cache — GEM cold boot was ~40s waiting on these.
        // Do NOT inject a live prefetcher iframe here — that can race the SPA's
        // real GEM mount on /orderdetails (lab: checkoutSn ok, frames=1).
        fetch(a.href, { mode: "no-cors", credentials: "omit" }).catch(() => {});
      }
    }, String(mid))
    .catch(() => {});
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
  let chargeReqCount = 0;
  let blockedChargeReqCount = 0;
  let armChargeGuard = false;
  let issuerPaymentSent = false;
  let issuerBodyCapture = null;

  // context.route — page.route can miss service-worker / cross-frame POSTs
  // (lab showed 1 client POST while Revolut still paired). Allow first issuer
  // to network; fulfill 2+ locally so GE does not retry on another URL.
  const issuerRoute = async (route) => {
    const req = route.request();
    const url = req.url();
    const method = req.method();
    if (method === "GET" || method === "OPTIONS" || method === "HEAD") {
      await route.continue();
      return;
    }
    if (!isBandaiGeIssuerPaymentUrl(url)) {
      await route.continue();
      return;
    }
    chargeReqCount += 1;
    let postData = null;
    try {
      postData = req.postData();
    } catch {
      /* ignore */
    }
    geNet.push({
      t: Date.now(),
      kind: "req",
      method,
      url: url.slice(0, 220),
      issuer: true,
      chargeN: chargeReqCount,
      armed: armChargeGuard,
      bodyBytes: postData ? String(postData).length : 0,
    });
    if (chargeReqCount > 1) {
      blockedChargeReqCount += 1;
      mark("issuer_req_fulfilled_local", {
        n: chargeReqCount,
        url: url.slice(0, 140),
        bodyBytes: postData ? String(postData).length : 0,
      });
      // Soft success — abort caused GE to hunt another charge path.
      await route.fulfill({
        status: 200,
        contentType: "application/json; charset=utf-8",
        body: JSON.stringify({
          Success: true,
          success: true,
          IsSuccess: true,
          j1m: "duplicate_issuer_suppressed",
        }),
      });
      return;
    }
    issuerPaymentSent = true;
    if (postData && !issuerBodyCapture) {
      issuerBodyCapture = {
        url,
        method,
        contentType: req.headers()["content-type"] || null,
        body: String(postData).slice(0, 50_000),
        at: new Date().toISOString(),
      };
      try {
        const fs = await import("node:fs");
        fs.writeFileSync(
          "/tmp/bandai-ge-issuer-capture.json",
          JSON.stringify(issuerBodyCapture, null, 2),
        );
      } catch {
        /* ignore */
      }
    }
    mark("issuer_req_allowed", {
      url: url.slice(0, 140),
      bodyBytes: postData ? String(postData).length : 0,
    });
    await route.continue();
  };
  // One predicate route only — dual patterns can double-count / fulfill the real 1st POST.
  // Keep the same function reference for unroute().
  const issuerUrlMatch = (url) => isBandaiGeIssuerPaymentUrl(url.href);
  await context.route(issuerUrlMatch, issuerRoute);

  // In-page single-flight (each frame). Catches fetch/XHR doubles even if a
  // request somehow slips past context.route. Cross-origin GE frames get their
  // own counter; Playwright route remains source of truth for the wire.
  await context
    .addInitScript(() => {
      const KEY = "__j1mHandleCreditCardN";
      const isIssuer = (u) => /HandleCreditCard/i.test(String(u || ""));
      const bump = () => {
        const n = (Number(window[KEY]) || 0) + 1;
        window[KEY] = n;
        return n;
      };
      const fakeOk = () =>
        Promise.resolve(
          new Response(
            JSON.stringify({ Success: true, success: true, IsSuccess: true, j1m: "dup_inpage" }),
            { status: 200, headers: { "content-type": "application/json" } },
          ),
        );
      const origFetch = window.fetch.bind(window);
      window.fetch = function (input, init) {
        const url = typeof input === "string" ? input : input && input.url;
        const method = String(init?.method || (input && input.method) || "GET").toUpperCase();
        if (isIssuer(url) && method !== "GET" && method !== "HEAD" && method !== "OPTIONS") {
          if (bump() > 1) return fakeOk();
        }
        return origFetch(input, init);
      };
      const XO = XMLHttpRequest.prototype.open;
      const XS = XMLHttpRequest.prototype.send;
      XMLHttpRequest.prototype.open = function (method, url, ...rest) {
        this.__j1mMethod = String(method || "GET").toUpperCase();
        this.__j1mUrl = String(url || "");
        return XO.call(this, method, url, ...rest);
      };
      XMLHttpRequest.prototype.send = function (...args) {
        if (
          isIssuer(this.__j1mUrl) &&
          this.__j1mMethod &&
          this.__j1mMethod !== "GET" &&
          this.__j1mMethod !== "HEAD" &&
          this.__j1mMethod !== "OPTIONS"
        ) {
          if (bump() > 1) {
            Object.defineProperty(this, "status", { get: () => 200 });
            Object.defineProperty(this, "responseText", {
              get: () =>
                JSON.stringify({ Success: true, success: true, IsSuccess: true, j1m: "dup_inpage" }),
            });
            setTimeout(() => {
              this.onload && this.onload();
              this.onreadystatechange && this.onreadystatechange();
            }, 0);
            return;
          }
        }
        return XS.apply(this, args);
      };
    })
    .catch(() => {});

  const onReq = (req) => {
    const method = req.method();
    const u = req.url();
    if (method === "GET" || method === "OPTIONS" || method === "HEAD") return;
    if (isBandaiGeIssuerPaymentUrl(u)) return; // logged in issuerRoute
    const isGe =
      /global-e\.com|globale|CreditCard|payments\/|Checkout\/|3ds|acs|Authorize|ProcessPayment/i.test(u);
    const noise =
      /WriteContextualLog|collectCheckout|prefetcher|\/static\/|\.js(?:\?|$)|\/css\/|google|facebook|hotjar|sentry|datadog|forter|clarity\.ms/i.test(
        u,
      );
    if (armChargeGuard) {
      const handleAction = isBandaiGeHandleAction(u);
      const actionId = handleAction ? bandaiGeHandleActionId(u) : null;
      const row = {
        t: Date.now(),
        kind: "req",
        method,
        url: u.slice(0, 220),
        armed: true,
        postPay: true,
        noise,
        handleAction,
        actionId,
      };
      if (!noise) mark("post_pay_req", { method, url: u.slice(0, 140) });
      geNet.push(row);
      return;
    }
    if (!isGe || noise) return;
    const handleAction = isBandaiGeHandleAction(u);
    const actionId = handleAction ? bandaiGeHandleActionId(u) : null;
    const row = {
      t: Date.now(),
      kind: "req",
      method,
      url: u.slice(0, 200),
      handleAction,
      actionId,
      armed: false,
    };
    if (handleAction) mark("ge_post", { actionId, armed: false, url: u.slice(0, 120) });
    geNet.push(row);
  };
  const onRes = (res) => {
    const u = res.url();
    const method = res.request().method();
    if (method === "GET" && !/ProcessPayment|Authorize|3ds|acs|Pay|handleaction/i.test(u)) return;
    if (!/global-e\.com|globale|CreditCard|payments\/|Checkout\/|3ds|acs|Authorize|ProcessPayment/i.test(u)) {
      return;
    }
    if (/WriteContextualLog|collectCheckout|prefetcher|\/static\//i.test(u) && !armChargeGuard) return;
    const row = {
      t: Date.now(),
      kind: "res",
      status: res.status(),
      method,
      url: u.slice(0, 200),
    };
    if (isBandaiGeHandleAction(u)) {
      res
        .text()
        .then((body) => {
          row.bodySnippet = String(body || "").replace(/\s+/g, " ").slice(0, 180);
          mark("ge_post_res", {
            actionId: bandaiGeHandleActionId(u),
            status: res.status(),
            bodySnippet: row.bodySnippet,
          });
        })
        .catch(() => {});
    }
    geNet.push(row);
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

    // Start GEM warm as soon as cart paints — overlaps checkbox / Proceed enable wait.
    await warmGemAssets(page, GLOBALE_MID_DEFAULT);
    mark("gem_warm_started");

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

    // Refresh warm right before Proceed (cache may have filled during checkbox wait).
    await warmGemAssets(page, GLOBALE_MID_DEFAULT);

    mark("proceed_click");
    const geFrameRe =
      /Checkout\/v2|CreditCardForm|secure-bandai\.global-e|webservices\.global-e\.com\/Checkout/i;
    let earlyFrameUrl = null;
    const onFrame = (frame) => {
      const u = frame.url() || "";
      if (geFrameRe.test(u) && !earlyFrameUrl) {
        earlyFrameUrl = u;
        mark("ge_frame_event", { url: u.slice(0, 100) });
      }
    };
    page.on("frameattached", onFrame);
    page.on("framenavigated", onFrame);

    // Do NOT block on waitForURL — prior tip burned ~28s here while GEM hadn't
    // attached yet; listeners died at 28s and poll had to catch up (~18s more).
    const urlWait = page
      .waitForURL(/orderdetails|Global-e|global-e/i, { timeout: 20_000 })
      .catch(() => null);
    await proceed.click({ timeout: 8_000, noWaitAfter: true }).catch(() => {});
    void dismissCookieBanner(page);

    let geIframeReady = false;
    let frameUrls = [];
    let gemVia = "timeout";
    // Cold GEM can land just past 45s (lab: event @58948ms after 45s deadline).
    const gemDeadline = Date.now() + 60_000;
    let pollI = 0;
    while (Date.now() < gemDeadline) {
      checkoutSn =
        checkoutSn ||
        (await page.evaluate(() => sessionStorage.getItem("bsp_checkout_sn")).catch(() => null));
      frameUrls = page.frames().map((f) => f.url());
      if (earlyFrameUrl || frameUrls.some((u) => geFrameRe.test(u))) {
        geIframeReady = true;
        gemVia = earlyFrameUrl ? (pollI === 0 ? "event" : `event+poll${pollI}`) : `poll${pollI}`;
        break;
      }
      if (pollI === 0 || pollI % 10 === 0) await dismissCookieBanner(page);
      if (pollI === 5 || pollI === 12 || pollI === 20) {
        await page
          .locator(
            'label:has-text("Credit Card"), button:has-text("Credit Card"), text=Credit Card',
          )
          .first()
          .click({ timeout: 800 })
          .catch(() => {});
      }
      await page.waitForTimeout(150);
      pollI += 1;
    }
    await urlWait;
    await dismissCookieBanner(page);

    checkoutSn =
      checkoutSn ||
      (await page.evaluate(() => sessionStorage.getItem("bsp_checkout_sn")).catch(() => null));
    // Re-check after wait — frameattached can win the race against loop exit.
    frameUrls = page.frames().map((f) => f.url());
    if (!geIframeReady && (earlyFrameUrl || frameUrls.some((u) => geFrameRe.test(u)))) {
      geIframeReady = true;
      gemVia = earlyFrameUrl ? "event-late" : "poll-late";
    }
    page.off("frameattached", onFrame);
    page.off("framenavigated", onFrame);
    mark("after_proceed", { checkoutSn, gemPoll: pollI, earlyFrame: Boolean(earlyFrameUrl) });
    if (geIframeReady) {
      mark("ge_iframe_ready", { frames: frameUrls.length, via: gemVia, pollI });
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

    // Card iframe trails Checkout/v2 — cold GEM often needs 15–25s + Credit Card click.
    for (let i = 0; i < 100; i++) {
      const hasCard = page
        .frames()
        .some((f) => /CreditCardForm|secure-bandai\.global-e\.com\/payments/i.test(f.url() || ""));
      if (hasCard) {
        mark("card_iframe_ready", { pollI: i });
        break;
      }
      if (i % 5 === 0) {
        for (const frame of page.frames()) {
          if (!isBandaiGeCheckoutPayFrame(frame.url())) continue;
          await frame
            .locator(
              'label:has-text("Credit Card"), label:has-text("Card"), button:has-text("Credit Card")',
            )
            .first()
            .click({ timeout: 600 })
            .catch(() => {});
        }
        await page
          .locator(
            'label:has-text("Credit Card"), button:has-text("Credit Card"), text=Credit Card',
          )
          .first()
          .click({ timeout: 600 })
          .catch(() => {});
      }
      await page.waitForTimeout(200);
    }

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

        // Do NOT kill card-iframe submit/listeners — that made Checkout Pay a
        // no-op after 14:09 (UI click ok, zero issuer POSTs, Revolut silent).

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

        await frame.evaluate(() => document.activeElement?.blur?.()).catch(() => {});

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
        // Named GE consent boxes first (payDiag: CheckoutData_TnCConsent unchecked).
        await frame
          .evaluate(() => {
            const names = [
              "CheckoutData_TnCConsent",
              "CheckoutData.TnCConsent0",
              "CheckoutData.TnCConsent",
              "TnCConsent",
            ];
            for (const name of names) {
              const el =
                document.querySelector(`input[name="${name}"]`) ||
                document.querySelector(`#${CSS.escape(name)}`);
              if (el && !el.checked) {
                el.checked = true;
                el.dispatchEvent(new Event("input", { bubbles: true }));
                el.dispatchEvent(new Event("change", { bubbles: true }));
                el.click?.();
              }
            }
          })
          .catch(() => {});
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
            const payLabel = (b) => (b.innerText || b.value || b.getAttribute("aria-label") || "").replace(/\s+/g, " ").trim();
            const isPay = (b) => /^(pay|place order|pay now)\b/i.test(payLabel(b)) || /^pay$/i.test(payLabel(b));
            const pay = [...document.querySelectorAll("button, input[type=submit], a[role=button]")].find(isPay);
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
          armChargeGuard = true;
          mark("charge_guard_armed");
          await tickTerms();
          // Atomic single click inside the frame — disable in the same turn so
          // GE cannot queue a second Pay (Revolut still paired with 1 route hit).
          const clicked = await frame.evaluate(() => {
            const payLabel = (b) =>
              (b.innerText || b.value || b.getAttribute("aria-label") || "").replace(/\s+/g, " ").trim();
            const isPay = (b) => /^(pay|place order|pay now)\b/i.test(payLabel(b)) || /^pay$/i.test(payLabel(b));
            const buttons = [
              ...document.querySelectorAll("button, input[type=submit], a[role=button]"),
            ].filter(isPay);
            const btn =
              buttons.find((b) => !b.disabled && b.getAttribute("aria-disabled") !== "true") ||
              buttons[0];
            if (!btn || btn.dataset.j1mPaid === "1") return false;
            btn.dataset.j1mPaid = "1";
            // Disable BEFORE click so GE/handlers cannot queue a second Pay.
            for (const b of buttons) {
              b.setAttribute("disabled", "true");
              b.setAttribute("aria-disabled", "true");
              b.style.pointerEvents = "none";
            }
            btn.click();
            return true;
          });
          if (!clicked) {
            await payBtn.click({ timeout: 5_000, noWaitAfter: true, force: true });
          }
          payClickCount += 1;
          paymentStatus = "pay_clicked";
          geNote += `; clicked pay#${payClickCount} on ${url.slice(0, 50)} via=${clicked ? "eval1" : "locator"}`;
          paid = true;
          mark("pay_clicked", {
            payClickCount,
            frame: url.slice(0, 80),
            enableMs: Date.now() - sGe,
            via: clicked ? "eval1" : "locator",
            payDiag,
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
        chargeReqCount,
        blockedChargeReqCount,
        geNetTail: geNet.slice(-20),
        ...meta,
        via: "http+ge",
        elapsedMs: Date.now() - t0,
      };
    }

    // Issuer often lands 5–8s after Pay — don't fail-closed on an 800ms poll.
    await page.waitForTimeout(800);

    // Issuer wire = HandleCreditCardRequestV2 only (bank ground truth).
    const authReqs = () =>
      geNet.filter((n) => n.kind === "req" && (n.issuer || isBandaiGeIssuerPaymentUrl(n.url)));
    const payNet = geNet.filter((n) => n.kind === "req" && n.armed && !n.noise);
    let payNetHot = authReqs();
    geNote += `; payNet=${payNet.length}/${payNetHot.length} payClicks=${payClickCount} issuerReqs=${chargeReqCount} blocked=${blockedChargeReqCount}`;
    if (payClickCount > 1) geNote += "; WARN multi_pay_click";

    if (paymentStatus === "pay_clicked" || paymentStatus === "pay_clicked_no_payment_request") {
      // Always wait for issuer POST (lab: ~7s after click) before labeling no_payment.
      const hardDeadline = Date.now() + wait3dsMs;
      sawAuthWire = issuerPaymentSent || authReqs().length > 0;
      const wireSeenAt = { t: sawAuthWire ? Date.now() : 0 };
      const postWireObserveMs = Math.min(16_000, Math.max(10_000, wait3dsMs));

      while (Date.now() < hardDeadline && !reached3ds && !orderNumber) {
        if (!sawAuthWire) {
          payNetHot = authReqs();
          if (issuerPaymentSent || payNetHot.length > 0) {
            sawAuthWire = true;
            wireSeenAt.t = Date.now();
            geNote += `; issuerWire=${payNetHot.length || 1}`;
            mark("auth_wire", { issuerReqs: chargeReqCount });
            if (paymentStatus === "pay_clicked_no_payment_request") {
              paymentStatus = "pay_clicked";
            }
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
      sawAuthWire = sawAuthWire || issuerPaymentSent || authReqs().length > 0;
      if (paymentStatus === "pay_clicked") {
        paymentStatus = reached3ds
          ? "reached_3ds"
          : sawAuthWire
            ? "pay_submitted_no_3ds_seen"
            : "pay_clicked_no_payment_request";
      } else if (paymentStatus === "pay_clicked_no_payment_request" && sawAuthWire) {
        paymentStatus = "pay_submitted_no_3ds_seen";
      }
      if (!sawAuthWire) geNote += "; WARN no HandleCreditCardRequestV2 after Pay click";
      else geNote += "; issuer_HandleCreditCardRequestV2_on_wire";
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
      chargeReqCount,
      blockedChargeReqCount,
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
    await context.unroute(issuerUrlMatch, issuerRoute).catch(() => {});
  }
}

export default { browserBandaiGeFromCart };
