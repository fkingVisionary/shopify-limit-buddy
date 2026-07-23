/**
 * Pokémon Centre AU — Global-e Pay over HTTP (product / scale path).
 *
 * Mid 1634 · encoded merchant 8u22 · secure.ges.global-e.com
 * Do NOT use Bandai mid 1925 / 8urc / secure-bandai.
 *
 * Playbook (Bandai Fast, adapted — Bandai modules are NOT edited):
 *   GetCartToken → Checkout/v2 → riskHydrate (iovation+Forter, GE POSTs muted)
 *   → handleaction 1/2/3 → checkoutv2/save → CreditCardForm
 *   → exactly one HandleCreditCardRequestV2 → score CCPaymentRedirect JWT
 *
 * Browser is ONLY for inline riskHydrate mint on the same run (then drop).
 * No Safe/Playwright pay ladder — PC carts do not hold like Bandai.
 *
 * Reuses pure builders from bandai-ge-http.js (read-only import). Bandai keeps
 * its own orchestrator; we do not call runBandaiGeHttpPay.
 */

import { request } from "../http.js";
import fs from "node:fs";
import {
  extractGeCheckoutGuid,
  parseJsonp,
  buildGetCartTokenUrl,
  extractUrlStructureToken,
  extractMachineId,
  parseCheckoutV2Form,
  buildHandleActionBodies,
  buildCheckoutSaveBody,
  pickShippingMethodId,
  buildIssuerFormBody,
  decodeCcPaymentRedirectData,
  mapCcPaymentRedirect,
  isBandaiGePaymentRedirectSignal,
  isBandaiGeRedirectDecline,
  mintIovationBlackbox,
} from "./bandai-ge-http.js";

export const PC_GLOBALE_MID = 1634;
export const PC_GLOBALE_SCRIPT = "https://gepi.global-e.com/includes/js/1634";
export const PC_GE_MERCHANT_CODE = "8u22";
export const PC_GE_GEPI = "https://gepi.global-e.com";
export const PC_GE_WEBSERVICES = "https://webservices.global-e.com";
/** PC card form / issuer host (wire 2026-07-22). */
export const PC_GE_SECURE = "https://secure.ges.global-e.com";
export const PC_ORIGIN = "https://www.pokemoncenter.com";

const DEFAULT_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

const DEFAULT_GUEST = {
  email: "decline.test@example.com",
  phone: "0412345678",
  firstName: "Test",
  lastName: "User",
  address1: "1 George Street",
  city: "Sydney",
  zip: "2000",
  // GE AU StateId for NSW — scraped from Checkout/v2 when possible.
  stateId: null,
  countryId: 14,
};

export function isPcGeIssuerPaymentUrl(url) {
  const u = String(url || "");
  return (
    /secure\.ges\.global-e\.com\/\d+\/Payments\/HandleCreditCard/i.test(u) ||
    /secure\.ges\.global-e\.com\/[^?\s]*\/Payments\/HandleCreditCard/i.test(u)
  );
}

function cookieHeaderFromJar(jar) {
  if (!jar) return "";
  if (typeof jar.header === "function") return jar.header() || "";
  const dump = jar.dump?.() || {};
  return Object.entries(dump)
    .map(([k, v]) => `${k}=${v}`)
    .join("; ");
}

async function httpText(url, opts = {}) {
  const ctx = opts.ctx;
  if (!ctx?.jar || !ctx?.dispatcher) {
    throw new Error("httpText requires ctx.jar + ctx.dispatcher");
  }
  const method = opts.method || "GET";
  const headers = {
    "user-agent": opts.userAgent || DEFAULT_UA,
    accept: opts.accept || "*/*",
    "accept-language": "en-AU,en;q=0.9",
    ...(opts.headers || {}),
  };
  if (opts.cookieHeader) headers.cookie = opts.cookieHeader;
  const t0 = Date.now();
  const res = await request(url, { method, headers, body: opts.body, retry: false }, ctx);
  try {
    ctx.jar?.ingest?.(res.headers);
  } catch {
    /* ignore */
  }
  const text = await res.text();
  return {
    ok: res.status >= 200 && res.status < 300,
    status: res.status,
    ms: Date.now() - t0,
    text,
    url,
    headers: res.headers,
    undiciAttempts: Number(res.undiciAttempts || 1),
  };
}

function redact(s) {
  return String(s ?? "")
    .replace(/\b\d{13,19}\b/g, "[REDACTED_PAN]")
    .replace(/(cvv|cvd|cvc|cardNum|PaymentData\.cardNum)=([^&\s]+)/gi, "$1=[REDACTED]");
}

/** Scrape AU state option id (prefer NSW) from Checkout/v2 HTML. */
export function pickAuStateIdFromHtml(html, prefer = /New South Wales|NSW/i) {
  const h = String(html || "");
  const sel =
    h.match(
      /<select[^>]*name=["']CheckoutData\.(?:Shipping|Billing)StateID["'][^>]*>([\s\S]*?)<\/select>/i,
    ) ||
    h.match(/<select[^>]*StateID["'][^>]*>([\s\S]*?)<\/select>/i);
  const body = sel?.[1] || "";
  if (!body) return null;
  const opts = [...body.matchAll(/<option[^>]*value=["']([^"']+)["'][^>]*>([^<]*)</gi)];
  for (const m of opts) {
    if (prefer.test(m[2] || "") && m[1] && m[1] !== "0") return String(m[1]);
  }
  for (const m of opts) {
    if (m[1] && m[1] !== "0" && m[1] !== "") return String(m[1]);
  }
  return null;
}

function applyGuestAddress(form, guest = {}, v2Html = "") {
  const g = { ...DEFAULT_GUEST, ...guest };
  const stateId = g.stateId || pickAuStateIdFromHtml(v2Html) || form.shipping?.StateId || null;
  const phone = String(g.phone || DEFAULT_GUEST.phone);
  const addr = {
    Address1: g.address1 || DEFAULT_GUEST.address1,
    Address2: g.address2 || "",
    City: g.city || DEFAULT_GUEST.city,
    Zip: g.zip || DEFAULT_GUEST.zip,
    StateId: stateId,
    CountryId: Number(g.countryId || 14),
    Email: g.email || DEFAULT_GUEST.email,
    FirstName: g.firstName || DEFAULT_GUEST.firstName,
    LastName: g.lastName || DEFAULT_GUEST.lastName,
    Phone: phone,
    PhonePrefix: g.phonePrefix || "",
    PhonePrefixCountryId: Number(g.countryId || 14),
  };
  form.merchantId = PC_GLOBALE_MID;
  form.countryId = addr.CountryId;
  form.cultureId = form.cultureId || 3081; // en-AU when present
  form.email = addr.Email;
  form.shippingType = "ShippingSameAsBilling";
  form.shipping = { ...form.shipping, ...addr };
  form.billing = { ...form.billing, ...addr };
  form.hasAddress = Boolean(addr.Address1 && addr.City && addr.Zip);
  return form;
}

/**
 * GetCartToken for PC — MerchantCartToken = Cortex cartGuid (not Bandai formula).
 */
export async function getPcGeCartToken(opts = {}) {
  const mid = String(opts.merchantId || PC_GLOBALE_MID);
  const cartGuid = opts.cartGuid || opts.merchantCartToken;
  const m2m =
    opts.m2mAccessToken ||
    opts.geM2m?.json?.["access-token"] ||
    opts.geM2m?.json?.access_token ||
    opts.cartToken ||
    "";
  if (!cartGuid && !m2m) {
    return { ok: false, error: "cartGuid_or_m2m_required", cartToken: null };
  }

  const referer = opts.referer || `${PC_ORIGIN}/en-au/intl-checkout`;
  const attempts = [];

  // Classic GEM GetCartToken (Bandai-proven query shape, PC mid/store).
  const classicUrl = buildGetCartTokenUrl({
    merchantId: mid,
    merchantCartToken: cartGuid || m2m,
    cartToken: m2m && cartGuid ? m2m : "",
    countryCode: "AU",
    currencyCode: "AUD",
    cultureCode: "en-AU",
    preferedCultureCode: "en-AU",
    webStoreCode: "www.pokemoncenter.com",
    webStoreInstanceCode: "en-au",
    customerEmail: opts.customerEmail || "",
    gepiBase: PC_GE_GEPI,
  });

  const gem2 = new URL(`${PC_GE_GEPI}/api/v1/checkout/cart-token`);
  gem2.searchParams.set("merchantId", mid);
  if (cartGuid) gem2.searchParams.set("merchantCartToken", cartGuid);
  if (m2m) gem2.searchParams.set("cartToken", m2m);

  for (const url of [classicUrl, gem2.toString()]) {
    try {
      const res = await httpText(url, {
        ctx: opts.ctx,
        userAgent: opts.userAgent,
        accept: "application/javascript, application/json, */*",
        headers: {
          referer,
          origin: PC_ORIGIN,
        },
      });
      const json = parseJsonp(res.text);
      const cartToken =
        json?.CartToken ||
        json?.cartToken ||
        extractGeCheckoutGuid(res.text) ||
        null;
      const isCaptcha = Boolean(json?.IsCaptcha || json?.isCaptcha);
      attempts.push({
        url: url.split("?")[0],
        status: res.status,
        ok: Boolean(cartToken),
        isCaptcha,
        body: redact(String(res.text || "").replace(/\s+/g, " ")).slice(0, 220),
      });
      if (res.ok && cartToken && json?.Success !== false) {
        return {
          ok: true,
          status: res.status,
          ms: res.ms,
          cartToken,
          isCaptcha,
          json,
          attempts,
          url: url.slice(0, 260),
          note: `CartToken via ${url.split("?")[0]}`,
        };
      }
    } catch (e) {
      attempts.push({ url: url.split("?")[0], error: String(e?.message || e) });
    }
  }

  return {
    ok: false,
    cartToken: null,
    attempts,
    error: "ge_get_cart_token_failed",
    note: "PC GetCartToken failed — check mid/cartGuid/m2m mapping",
  };
}

/** Exactly one issuer POST — never retry on proxy RST (Bandai Revolut dual-rail lesson). */
export async function postPcGeIssuerHttp(opts = {}) {
  const url = String(opts.url || "");
  if (!isPcGeIssuerPaymentUrl(url)) {
    return { ok: false, error: "not_issuer_url", note: "Expected secure.ges …/HandleCreditCard*" };
  }
  const body = opts.body != null ? String(opts.body) : "";
  if (!body) return { ok: false, error: "body_required" };

  const headers = {
    accept: "text/html,application/xhtml+xml,application/json,*/*",
    "content-type": opts.contentType || "application/x-www-form-urlencoded; charset=UTF-8",
    origin: PC_GE_SECURE,
    referer: opts.referer || `${PC_GE_SECURE}/payments/CreditCardForm/`,
    "user-agent": opts.userAgent || DEFAULT_UA,
    ...(opts.headers || {}),
  };
  const cookie = opts.cookieHeader || cookieHeaderFromJar(opts.ctx?.jar);
  if (cookie) headers.cookie = cookie;

  const timeoutMs = Math.max(60_000, Math.min(300_000, Number(opts.timeoutMs) || 180_000));
  const t0 = Date.now();
  try {
    const res = await request(
      url,
      {
        method: "POST",
        headers,
        body,
        retry: false,
        timeoutMs,
        headersTimeout: timeoutMs,
        bodyTimeout: timeoutMs,
      },
      opts.ctx || {},
    );
    const undiciAttempts = Number(res.undiciAttempts || 1);
    try {
      opts.ctx?.jar?.ingest?.(res.headers);
    } catch {
      /* ignore */
    }
    const text = await res.text();
    const locHeader =
      (typeof res.headers?.get === "function" &&
        (res.headers.get("location") || res.headers.get("Location"))) ||
      "";
    const locHtml = (String(text || "").match(
      /href=["']([^"']*CCPaymentRedirect[^"']*)["']/i,
    ) || [])[1];
    const redirectUrl = locHeader || locHtml || null;
    const isPaymentRedirect = /CCPaymentRedirect/i.test(String(redirectUrl || ""));
    const redirectPayload = isPaymentRedirect
      ? decodeCcPaymentRedirectData(redirectUrl)
      : null;
    const bankSignal = isBandaiGePaymentRedirectSignal(redirectUrl || "", "");
    const declineOnRedirect = isBandaiGeRedirectDecline(redirectUrl || "", "");
    const ok = Boolean(isPaymentRedirect && (bankSignal || declineOnRedirect));
    return {
      ok,
      status: res.status,
      ms: Date.now() - t0,
      bodySnippet: redact(String(text || "").replace(/\s+/g, " ")).slice(0, 240),
      redirectUrl: redirectUrl ? String(redirectUrl).slice(0, 320) : null,
      redirectUrlFull: redirectUrl,
      redirectPayload,
      isPaymentRedirect,
      reloadOnly: Boolean(isPaymentRedirect && !bankSignal && !declineOnRedirect),
      bankSignal: Boolean(bankSignal || declineOnRedirect),
      declineOnRedirect,
      sawAuthWire: Boolean(ok),
      undiciAttempts,
      via: "http-ge",
      error: ok
        ? null
        : isPaymentRedirect
          ? "ge_reload_only_no_bank"
          : "issuer_http_no_redirect",
    };
  } catch (e) {
    return {
      ok: false,
      error: e?.message || "issuer_http_failed",
      ms: Date.now() - t0,
      undiciAttempts: 1,
      responseLost: true,
      timedOut: /timeout|aborted/i.test(String(e?.message || "")),
      via: "http-ge",
    };
  }
}

function parseProxyRaw(raw) {
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
  return null;
}

/** Brief headless page for riskHydrate only — never used for Pay. */
async function openRiskHydratePage(opts = {}) {
  const { chromium } = await import("playwright");
  const proxy = parseProxyRaw(opts.proxyRaw);
  const browser = await chromium.launch({
    headless: opts.headless !== false,
    proxy: proxy || undefined,
  });
  const context = await browser.newContext({
    userAgent: opts.userAgent || DEFAULT_UA,
    locale: "en-AU",
    viewport: { width: 1280, height: 800 },
  });
  if (opts.cookies && typeof opts.cookies === "object") {
    const list = [];
    for (const [name, value] of Object.entries(opts.cookies)) {
      list.push({
        name,
        value: String(value),
        domain: name === "reese84" ? "www.pokemoncenter.com" : ".pokemoncenter.com",
        path: "/",
      });
      if (/globale|GlobalE|forter/i.test(name)) {
        list.push({ name, value: String(value), domain: ".global-e.com", path: "/" });
      }
    }
    await context.addCookies(list).catch(() => {});
  }
  const page = await context.newPage();
  return {
    page,
    async close() {
      try {
        await page.close();
      } catch {
        /* ignore */
      }
      try {
        await context.close();
      } catch {
        /* ignore */
      }
      try {
        await browser.close();
      } catch {
        /* ignore */
      }
    },
  };
}

/**
 * Product HTTP GE pay for Pokémon Centre.
 *
 * @param {object} opts
 * @param {object} opts.ctx — { jar, dispatcher }
 * @param {string} opts.cartGuid — Cortex cart-guid (MerchantCartToken)
 * @param {object} [opts.geM2m]
 * @param {object} [opts.card]
 * @param {boolean} [opts.placeOrder]
 * @param {boolean} [opts.riskHydrate=true] — inline iovation/Forter mint
 * @param {object} [opts.page] — optional existing Playwright page for mint
 * @param {string} [opts.proxyRaw] — for mint browser if page not supplied
 */
export async function runGlobalEPayHttp(opts = {}) {
  const steps = [];
  const timeline = [];
  const t0 = Date.now();
  const mark = (event, extra = {}) => {
    const row = { t: new Date().toISOString(), elapsedMs: Date.now() - t0, event, ...extra };
    timeline.push(row);
    try {
      opts.onProgress?.(event, row.note || event);
    } catch {
      /* ignore */
    }
    return row;
  };
  const push = (step, row) => {
    const out = { step, ok: row.ok !== false, ...row };
    steps.push(out);
    mark(step, { ok: out.ok, note: out.note, ms: out.ms, status: out.status });
    return out;
  };

  const ctx = opts.ctx || (opts.session ? { jar: opts.session?.jar || opts.ctx?.jar, dispatcher: opts.ctx?.dispatcher } : null);
  const session = opts.session;
  const jar = ctx?.jar;
  const dispatcher = ctx?.dispatcher || opts.dispatcher;
  const payCtx = { jar, dispatcher };
  if (!jar || !dispatcher) {
    return {
      ok: false,
      steps,
      error: "ctx.jar + ctx.dispatcher required",
      checkoutStage: "tokenize",
      engine: "http",
      paymentStatus: "ge_ctx_missing",
    };
  }

  const mid = Number(opts.globaleMid || opts.merchantId || PC_GLOBALE_MID);
  const encodedMerchant = opts.encodedMerchantId || PC_GE_MERCHANT_CODE;
  const placeOrder = opts.placeOrder === true;
  const cartGuid = opts.cartGuid;
  const ua = opts.userAgent || session?.state?.userAgent || DEFAULT_UA;
  const referer = opts.referer || `${PC_ORIGIN}/en-au/intl-checkout`;
  const guest = {
    email: opts.email || opts.profile?.email || DEFAULT_GUEST.email,
    phone: opts.phone || opts.profile?.phone || DEFAULT_GUEST.phone,
    firstName: opts.firstName || opts.profile?.firstName || DEFAULT_GUEST.firstName,
    lastName: opts.lastName || opts.profile?.lastName || DEFAULT_GUEST.lastName,
    address1: opts.address1 || opts.profile?.address1 || DEFAULT_GUEST.address1,
    city: opts.city || opts.profile?.city || DEFAULT_GUEST.city,
    zip: opts.zip || opts.profile?.zip || DEFAULT_GUEST.zip,
    stateId: opts.stateId || null,
  };

  push("ge_http_start", {
    ok: true,
    note: `mid=${mid} merchant=${encodedMerchant} cartGuid=${cartGuid ? "yes" : "no"} placeOrder=${placeOrder}`,
  });

  // GEM warm
  await httpText(PC_GLOBALE_SCRIPT, {
    ctx: payCtx,
    userAgent: ua,
    headers: { referer: `${PC_ORIGIN}/en-au/` },
  }).catch(() => null);

  const tokenOut = await getPcGeCartToken({
    ctx: payCtx,
    cartGuid,
    geM2m: opts.geM2m,
    m2mAccessToken: opts.m2mAccessToken,
    merchantId: mid,
    customerEmail: guest.email,
    userAgent: ua,
    referer,
  });
  push("ge_get_cart_token", {
    ok: tokenOut.ok,
    status: tokenOut.status,
    ms: tokenOut.ms,
    note: tokenOut.ok
      ? `CartToken ${String(tokenOut.cartToken).slice(0, 8)}… captcha=${Boolean(tokenOut.isCaptcha)}`
      : redact(tokenOut.note || tokenOut.error || "token_fail"),
    attempts: tokenOut.attempts?.slice?.(0, 4),
  });

  if (!tokenOut.ok || !tokenOut.cartToken) {
    return {
      ok: false,
      steps,
      timeline,
      engine: "http",
      globaleMid: mid,
      failedStep: "ge_get_cart_token",
      error: tokenOut.isCaptcha ? "ge_cart_token_captcha" : "ge_get_cart_token_failed",
      paymentStatus: tokenOut.isCaptcha ? "ge_captcha_required" : "ge_token_failed",
      checkoutStage: "tokenize",
      note: tokenOut.note || "GetCartToken failed",
    };
  }

  let guid = tokenOut.cartToken;

  if (!placeOrder) {
    return {
      ok: true,
      steps,
      timeline,
      dryRun: true,
      engine: "http",
      globaleMid: mid,
      geCartToken: guid,
      cartToken: guid,
      checkoutStage: "tokenize",
      paymentStatus: "dry_run",
      note: `HTTP GE CartToken ok — placeOrder=false guid=${String(guid).slice(0, 8)}…`,
    };
  }

  const v2Url = `${PC_GE_WEBSERVICES}/Checkout/v2/${encodedMerchant}/${guid}`;
  const v2 = await httpText(v2Url, {
    ctx: payCtx,
    userAgent: ua,
    accept: "text/html,application/xhtml+xml,*/*",
    headers: { referer },
  });
  let urlStructureToken = extractUrlStructureToken(v2.text);
  let machineId = opts.machineId || extractMachineId(v2.text) || null;
  let form = parseCheckoutV2Form(v2.text);
  form = applyGuestAddress(form, guest, v2.text);
  let shippingMethodId = form.selectedShippingOptionId || "";
  let forterToken = opts.forterToken || null;

  push("ge_checkout_v2", {
    ok: v2.ok,
    status: v2.status,
    ms: v2.ms,
    note: `Checkout/v2 ${v2.status}; jwt=${Boolean(urlStructureToken)} machineId=${Boolean(machineId)} addr=${form.hasAddress} bytes=${(v2.text || "").length}`,
  });

  // riskHydrate: brief live Checkout/v2 with GE POSTs muted → ioBlackBox + Forter → drop.
  const riskHydrate = opts.riskHydrate !== false && opts.noPage !== true;
  let ownedMint = null;
  let mintPage = opts.page || null;

  try {
    if (riskHydrate && !mintPage) {
      ownedMint = await openRiskHydratePage({
        proxyRaw: opts.proxyRaw || opts.proxy,
        userAgent: ua,
        cookies: jar.dump?.() || opts.cookies || {},
        headless: opts.headless !== false,
      });
      mintPage = ownedMint.page;
    }

    if (riskHydrate && mintPage) {
      const pctx = mintPage.context?.();
      const geMuteMatch = (url) => /global-e\.com/i.test(url.href || String(url));
      const geMuteRoute = async (route) => {
        const method = String(route.request().method() || "GET").toUpperCase();
        if (method === "GET" || method === "HEAD" || method === "OPTIONS") {
          await route.continue();
          return;
        }
        await route.fulfill({ status: 204, contentType: "text/plain", body: "" });
      };
      if (pctx?.route) await pctx.route(geMuteMatch, geMuteRoute);
      let mint;
      try {
        mint = await mintIovationBlackbox({
          page: mintPage,
          checkoutV2Url: v2Url,
          timeoutMs: opts.iovationTimeoutMs || 20_000,
          settleMs: opts.iovationSettleMs || 4_000,
          jar,
        });
      } finally {
        if (pctx?.unroute) {
          try {
            await pctx.unroute(geMuteMatch, geMuteRoute);
          } catch {
            /* ignore */
          }
        }
      }
      push("ge_iovation_mint", {
        ok: mint.ok,
        ms: mint.ms,
        note: mint.ok
          ? `ioBlackBox bytes=${String(mint.machineId || "").length} riskHydrate forter=${Boolean(mint.forterToken || mint.cookies?.forterToken)}`
          : `iovation fail ${mint.error || ""}`.slice(0, 160),
      });
      if (mint.machineId) machineId = mint.machineId;
      if (mint.forterToken) forterToken = mint.forterToken;
      else if (mint.cookies?.forterToken) forterToken = mint.cookies.forterToken;
      if (mint.cookies && jar?.load) {
        try {
          const merged = { ...jar.dump(), ...mint.cookies };
          if (forterToken) merged.forterToken = forterToken;
          jar.load(merged);
        } catch {
          /* ignore */
        }
      }
      try {
        await mintPage.goto("about:blank", { waitUntil: "commit", timeout: 5_000 });
      } catch {
        /* ignore */
      }
      mark("ge_page_dropped_after_iovation", { riskHydrate: true, liveGuid: guid });
    } else if (machineId) {
      push("ge_iovation_mint", {
        ok: true,
        ms: 0,
        note: `reused machineId bytes=${String(machineId).length} via=noPage`,
      });
    } else {
      push("ge_iovation_mint", {
        ok: false,
        ms: 0,
        note: "no machineId and riskHydrate skipped/failed — fraud risk high",
      });
    }
  } finally {
    if (ownedMint) await ownedMint.close().catch(() => {});
  }

  // handleaction 1/2/3 (rich bodies — no thin {})
  let hydrateShippingOk = false;
  for (const actionId of [1, 2, 3]) {
    const bodies = buildHandleActionBodies(form, {
      cartToken: guid,
      merchantId: mid,
      shippingMethodId,
      paymentMethodId: form.selectedPaymentMethodId || "1",
    });
    const haUrl = `${PC_GE_WEBSERVICES}/checkoutv2/handleaction/${actionId}/${guid}/${encodedMerchant}`;
    const ha = await httpText(haUrl, {
      ctx: payCtx,
      method: "POST",
      userAgent: ua,
      accept: "application/json, text/plain, */*",
      headers: {
        origin: PC_GE_WEBSERVICES,
        referer: v2Url,
        "content-type": "application/json",
        "x-requested-with": "XMLHttpRequest",
        "X-merchantId": String(mid),
      },
      body: JSON.stringify(opts.handleActionBodies?.[actionId] || bodies[actionId]),
    });
    let haJson = null;
    try {
      haJson = JSON.parse(String(ha.text || ""));
    } catch {
      haJson = null;
    }
    if (actionId === 1) {
      const picked = pickShippingMethodId(haJson);
      if (picked) shippingMethodId = picked;
      hydrateShippingOk = Boolean(
        ha.ok &&
          (haJson?.success === true ||
            haJson?.Success === true ||
            haJson?.exists === true ||
            (Array.isArray(haJson?.shippingOptions) && haJson.shippingOptions.length > 0)),
      );
    }
    if (!urlStructureToken) urlStructureToken = extractUrlStructureToken(ha.text);
    push(`ge_handleaction_${actionId}`, {
      ok: ha.ok && (actionId !== 1 || hydrateShippingOk || haJson?.success !== false),
      status: ha.status,
      ms: ha.ms,
      note: (
        actionId === 1
          ? `shipOk=${hydrateShippingOk} method=${shippingMethodId || "none"} ${String(ha.text || "").replace(/\s+/g, " ")}`
          : String(ha.text || "").replace(/\s+/g, " ")
      ).slice(0, 200),
    });
  }

  let paymentMethodId = String(opts.paymentMethodId || form.selectedPaymentMethodId || "1");
  let gatewayId = String(opts.gatewayId || form.gatewayId || "2");

  const saveBody = buildCheckoutSaveBody(
    { ...form, merchantId: mid },
    {
      cartToken: guid,
      shippingMethodId,
      paymentMethodId,
      gatewayId,
      machineId,
      forterToken,
      selectedTaxOption: /^\d+$/.test(String(form.selectedTaxOption || ""))
        ? form.selectedTaxOption
        : "",
    },
  );
  const saveRes = await httpText(
    `${PC_GE_WEBSERVICES}/checkoutv2/save/${encodedMerchant}/${guid}`,
    {
      ctx: payCtx,
      method: "POST",
      userAgent: ua,
      accept: "application/json, text/plain, */*",
      headers: {
        origin: PC_GE_WEBSERVICES,
        referer: v2Url,
        "content-type": "application/x-www-form-urlencoded; charset=UTF-8",
        "x-requested-with": "XMLHttpRequest",
        "X-merchantId": String(mid),
      },
      body: saveBody,
    },
  ).catch((e) => ({ ok: false, status: 0, ms: 0, text: "", error: e?.message }));
  let saveOk = false;
  try {
    const sj = JSON.parse(String(saveRes?.text || ""));
    saveOk = Boolean(saveRes?.ok && (sj?.Success === true || sj?.success === true));
  } catch {
    saveOk = Boolean(saveRes?.ok);
  }
  push("ge_checkout_save", {
    ok: saveOk,
    status: saveRes?.status,
    ms: saveRes?.ms,
    note: (
      saveOk
        ? `save ok gw=${gatewayId} pm=${paymentMethodId} ship=${shippingMethodId || "none"} io=${Boolean(machineId)} forter=${Boolean(forterToken)}`
        : `save fail ${String(saveRes?.text || saveRes?.error || "").replace(/\s+/g, " ")}`
    ).slice(0, 200),
  });

  const ccUrl = `${PC_GE_SECURE}/payments/CreditCardForm/${guid}/${gatewayId}`;
  const cc = await httpText(ccUrl, {
    ctx: payCtx,
    userAgent: ua,
    accept: "text/html,application/xhtml+xml,*/*",
    headers: { referer: v2Url },
  });
  urlStructureToken =
    extractUrlStructureToken(cc.text) || urlStructureToken;
  const formMachineId = extractMachineId(cc.text);
  if (formMachineId) machineId = formMachineId;
  push("ge_credit_card_form", {
    ok: cc.ok,
    status: cc.status,
    ms: cc.ms,
    note: `CreditCardForm ${cc.status}; jwt=${Boolean(urlStructureToken)} machineId=${Boolean(machineId)} gw=${gatewayId}`,
  });

  const card = opts.card || {};
  const blockers = [];
  if (!urlStructureToken) blockers.push("urlStructureToken");
  if (!machineId) blockers.push("machineId");
  if (!card?.number || !card?.cvv) blockers.push("card");
  if (!hydrateShippingOk) blockers.push("hydrate_shipping");
  if (!form.hasAddress) blockers.push("checkout_address");

  mark("ge_http_hydrate_done", { guid, blockers });

  if (opts.stopBeforeIssuer === true || (blockers.length && opts.forceIssuer !== true)) {
    return {
      ok: false,
      steps,
      timeline,
      engine: "http",
      globaleMid: mid,
      cartToken: guid,
      failedStep: blockers[0] || "ge_http_stop",
      error: blockers.length ? `http_ge_blockers:${blockers.join(",")}` : "stop_before_issuer",
      paymentStatus: "http_ge_hydrated",
      checkoutStage: "tokenize",
      blockers,
      possibleFraudDetected: null,
      note: `HTTP GE hydrated guid=${guid}; blockers=${blockers.join(",") || "none"}`,
    };
  }

  const issuerUrl =
    opts.issuerUrl ||
    `${PC_GE_SECURE}/1/Payments/HandleCreditCardRequestV2/${encodedMerchant}/${guid}?mode=${opts.issuerMode || "13534"}`;
  const body = buildIssuerFormBody({
    card,
    cartToken: guid,
    machineId,
    urlStructureToken,
    gatewayId,
    paymentMethodId,
    createTransaction: opts.createTransaction,
  });

  // Hard-lock: exactly one issuer POST (retry:false inside postPcGeIssuerHttp).
  const issuer = await postPcGeIssuerHttp({
    url: issuerUrl,
    body,
    ctx: payCtx,
    userAgent: ua,
    referer: ccUrl,
    timeoutMs: Number(opts.issuerTimeoutMs) || 180_000,
  });

  const txMap = mapCcPaymentRedirect(issuer?.redirectPayload || issuer?.redirectUrlFull || "");
  const fraudDetected = /^(true|1)$/i.test(String(txMap.PossibleFraudDetected || ""));
  const statusType = String(txMap.TransactionStatusType || "");
  const transactionId =
    txMap.TransactionId && txMap.TransactionId !== "0"
      ? txMap.TransactionId
      : txMap.MerchantReference && txMap.MerchantReference !== "0"
        ? txMap.MerchantReference
        : null;
  const bankHit = Boolean(
    issuer?.sawAuthWire ||
      issuer?.declineOnRedirect ||
      issuer?.bankSignal ||
      transactionId,
  );
  const chargeReqCount = Math.max(1, Number(issuer?.undiciAttempts || 1));

  push("ge_issuer_http", {
    ok: Boolean(issuer?.ok || bankHit || issuer?.responseLost),
    status: issuer?.status,
    ms: issuer?.ms,
    note: (
      issuer?.responseLost
        ? `RESPONSE_LOST posts=${chargeReqCount} — check bank`
        : issuer?.reloadOnly && !bankHit
          ? `RELOAD_ONLY ${issuer.status}`
          : `redirect ${issuer?.status} bank=${bankHit} tx=${transactionId || "-"} fraud=${fraudDetected} status=${statusType || "-"} posts=${chargeReqCount}`
    ).slice(0, 280),
  });

  const paymentStatus = fraudDetected
    ? "ge_fraud_refused"
    : issuer?.declineOnRedirect ||
        (bankHit && /Auth|Decline|Fail|Refuse/i.test(statusType))
      ? "declined_or_auth_failed"
      : bankHit && transactionId
        ? "declined_or_auth_failed"
        : issuer?.responseLost
          ? "pay_submitted_no_response"
          : issuer?.reloadOnly
            ? "ge_reload_only_no_bank"
            : issuer?.ok
              ? "pay_submitted_http"
              : "issuer_http_failed";

  // Soft decline / fraud diagnosis count as wire success for labs (bank or JWT).
  const wireOk =
    paymentStatus === "declined_or_auth_failed" ||
    paymentStatus === "ge_fraud_refused" ||
    paymentStatus === "pay_submitted_http" ||
    paymentStatus === "pay_submitted_no_response";

  try {
    const outDir = opts.debugDir || process.env.PC_CAPTURE_DIR;
    if (outDir) {
      fs.mkdirSync(outDir, { recursive: true });
      fs.writeFileSync(
        `${outDir}/ge-http-issuer.json`,
        JSON.stringify(
          {
            at: new Date().toISOString(),
            paymentStatus,
            possibleFraudDetected: fraudDetected,
            transactionStatusType: statusType || null,
            transactionId,
            success: txMap.Success ?? null,
            isSameCartToken: txMap.IsTheSameCartToken ?? null,
            chargeReqCount,
            redirectUrl: issuer?.redirectUrl || null,
            redirectPayload: issuer?.redirectPayload || null,
            forterTokenPresent: Boolean(forterToken),
            machineIdPresent: Boolean(machineId),
            guid,
            mid,
            encodedMerchant,
          },
          null,
          2,
        ),
      );
    }
  } catch {
    /* ignore */
  }

  return {
    ok: wireOk,
    steps,
    timeline,
    engine: "http",
    globaleMid: mid,
    cartToken: guid,
    paymentStatus,
    possibleFraudDetected: fraudDetected,
    transactionStatusType: statusType || null,
    transactionId,
    forterTokenPresent: Boolean(forterToken),
    chargeReqCount,
    undiciAttempts: Number(issuer?.undiciAttempts || 1),
    responseLost: Boolean(issuer?.responseLost),
    sawAuthWire: Boolean(bankHit),
    redirectUrl: issuer?.redirectUrl || null,
    redirectPayload: issuer?.redirectPayload || null,
    checkoutStage:
      paymentStatus === "declined_or_auth_failed" || paymentStatus === "ge_fraud_refused"
        ? "payment"
        : "tokenize",
    reached3ds: /3ds|challenge/i.test(statusType),
    failedStep: wireOk ? null : "ge_issuer_http",
    error: wireOk ? null : issuer?.error || issuer?.bodySnippet,
    via: "http-ge",
    elapsedMs: Date.now() - t0,
    note:
      paymentStatus === "ge_fraud_refused"
        ? `HTTP issuer FRAUD_REFUSED tx=${transactionId || "?"} status=${statusType || "?"} posts=${chargeReqCount}`
        : paymentStatus === "declined_or_auth_failed"
          ? `HTTP issuer AUTH_FAILED/DECLINE tx=${transactionId || "?"} fraud=False posts=${chargeReqCount}`
          : `HTTP issuer ${paymentStatus} tx=${transactionId || "-"} posts=${chargeReqCount}`,
  };
}

/** @deprecated alias — use getPcGeCartToken */
export async function getGeCartTokenHttp(session, ctx, opts = {}) {
  return getPcGeCartToken({
    ...opts,
    ctx: ctx || { jar: session?.jar, dispatcher: opts.dispatcher },
    session,
  });
}

export default {
  PC_GLOBALE_MID,
  PC_GE_MERCHANT_CODE,
  PC_GE_SECURE,
  getPcGeCartToken,
  runGlobalEPayHttp,
  postPcGeIssuerHttp,
  isPcGeIssuerPaymentUrl,
};
