/**
 * Disney Store AU — Global-e HTTP pay (Checkout/v2 → issuer).
 *
 * Research-only from Bandai / PKC GE HTTP modules (those files are never edited).
 * Disney constants: mid 1696 · encoded 8u87 · secure.ges.global-e.com
 *
 * Flow after bag + SFCC cartToken GUID:
 *   Checkout/v2 → guest AU address → handleaction 1..3 → save →
 *   CreditCardForm → exactly one HandleCreditCard POST → score decline JWT
 *
 * Default card is a known fake PAN for decline labs. Never place a live order
 * unless caller passes a real card + placeOrder=true (still one issuer POST).
 */

import { request, makeDispatcher } from "../http.js";
import {
  buildHandleActionBodies,
  buildCheckoutSaveBody,
  buildIssuerFormBody,
  extractUrlStructureToken,
  extractMachineId,
  parseCheckoutV2Form,
  pickShippingMethodId,
  mapCcPaymentRedirect,
  isBandaiGePaymentRedirectSignal,
  isBandaiGeRedirectDecline,
  decodeCcPaymentRedirectData,
  mintIovationBlackbox,
} from "./bandai-ge-http.js";
import {
  DISNEY_GLOBALE_MID,
  DISNEY_GE_ENCODED_MERCHANT,
  DISNEY_GE_SECURE,
  DISNEY_GE_WEBSERVICES,
  DISNEY_GE_ISSUER_ACTION,
  DISNEY_GE_CREDIT_CARD_FORM,
  fetchDisneyCheckoutV2,
} from "./disney-ge.js";

const DEFAULT_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

/** Fake Visa used for decline / auth-fail labs (not a live charge path). */
export const DISNEY_FAKE_DECLINE_CARD = {
  number: "4000000000000002",
  expMonth: "12",
  expYear: "2030",
  cvv: "123",
  name: "TEST USER",
};

const DEFAULT_GUEST = {
  email: "disney.decline.test@example.com",
  phone: "0412345678",
  firstName: "Test",
  lastName: "Decline",
  address1: "1 George Street",
  city: "Sydney",
  zip: "2000",
  stateId: "49179", // NSW from Disney Checkout/v2 HTML
  countryId: 14,
};

export function isDisneyGeIssuerPaymentUrl(url) {
  const u = String(url || "");
  return (
    /secure\.ges\.global-e\.com\/payments\/handlecreditcardrequestV2/i.test(u) ||
    /secure\.ges\.global-e\.com\/payments\/HandleCreditCardRequestV2/i.test(u) ||
    /secure\.ges\.global-e\.com\/\d+\/Payments\/HandleCreditCard/i.test(u) ||
    /secure\.ges\.global-e\.com\/[^?\s]*\/Payments\/HandleCreditCard/i.test(u)
  );
}

/** Disney / GE shipping option id from HandleAction=1 JSON (several shapes). */
export function pickDisneyShippingMethodId(shippingJson) {
  const direct = pickShippingMethodId(shippingJson);
  if (direct) return direct;
  const nested =
    shippingJson?.Data ||
    shippingJson?.Result ||
    shippingJson?.result ||
    shippingJson?.ShippingOptionsResult ||
    shippingJson;
  const again = pickShippingMethodId(nested);
  if (again) return again;
  const options =
    nested?.shippingOptions ||
    nested?.ShippingOptions ||
    nested?.Options ||
    nested?.DeliveryOptions ||
    [];
  if (!Array.isArray(options)) return "";
  for (const o of options) {
    const id = o?.ID ?? o?.Id ?? o?.id ?? o?.OptionId ?? o?.ShippingMethodID;
    if (id != null && String(id) !== "" && String(id) !== "0") return String(id);
  }
  return "";
}

function pickAuStateIdFromHtml(html, prefer = /New South Wales|NSW/i) {
  const h = String(html || "");
  const sel =
    h.match(
      /<select[^>]*name=["']CheckoutData\.(?:Shipping|Billing)StateID["'][^>]*>([\s\S]*?)<\/select>/i,
    ) || h.match(/<select[^>]*StateID["'][^>]*>([\s\S]*?)<\/select>/i);
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
  const stateId =
    g.stateId || pickAuStateIdFromHtml(v2Html) || form.shipping?.StateId || DEFAULT_GUEST.stateId;
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
    Phone: phone.startsWith("0") ? `+61${phone.slice(1)}` : phone,
    PhonePrefix: "+61",
    PhonePrefixCountryId: 14,
  };
  form.shipping = { ...form.shipping, ...addr };
  form.billing = { ...form.billing, ...addr };
  form.email = addr.Email;
  form.countryId = addr.CountryId;
  form.shippingType = "ShippingSameAsBilling";
  form.hasAddress = Boolean(addr.Address1 && addr.City && addr.Zip);
  form.merchantId = DISNEY_GLOBALE_MID;
  return form;
}

async function httpTextOnce(url, opts, ctx) {
  const method = opts.method || "GET";
  const headers = {
    "user-agent": opts.userAgent || DEFAULT_UA,
    accept: opts.accept || "*/*",
    "accept-language": "en-AU,en;q=0.9",
    ...(opts.headers || {}),
  };
  const t0 = Date.now();
  const res = await request(
    url,
    {
      method,
      headers,
      body: opts.body,
      retry: opts.retry === true,
      timeoutMs: opts.timeoutMs,
      headersTimeout: opts.timeoutMs,
      bodyTimeout: opts.timeoutMs,
    },
    ctx,
  );
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
    via: opts._via || "session",
  };
}

/**
 * GE webservices / secure.ges often CF-429 or CONNECT-fail on sticky ISP after
 * TLS ATC. Prefer proxy undici, then fall back to direct undici (same jar).
 */
async function httpText(url, opts = {}) {
  const ctx = opts.ctx;
  if (!ctx?.jar) throw new Error("httpText requires ctx.jar");
  const allowDirect = opts.allowDirect !== false;
  const attempts = [];
  const dispatchers = [];
  if (ctx.dispatcher) dispatchers.push({ label: "session", dispatcher: ctx.dispatcher });
  let ownedDirect = null;
  if (allowDirect) {
    ownedDirect = makeDispatcher(null, { forceUndici: true });
    dispatchers.push({ label: "direct-undici", dispatcher: ownedDirect });
  }
  try {
    let lastErr = null;
    for (const { label, dispatcher } of dispatchers) {
      try {
        const out = await httpTextOnce(url, { ...opts, _via: label }, { jar: ctx.jar, dispatcher });
        attempts.push({ via: label, status: out.status, ok: out.ok, ms: out.ms });
        // Soft-fail empty / 5xx → try next dispatcher
        if (out.ok || (out.status > 0 && out.status < 500 && (out.text || "").length > 0)) {
          return { ...out, attempts };
        }
        lastErr = out;
      } catch (e) {
        attempts.push({ via: label, ok: false, err: e?.message || String(e) });
        lastErr = {
          ok: false,
          status: 0,
          ms: 0,
          text: "",
          url,
          error: e?.message || String(e),
          via: label,
        };
      }
    }
    return { ...(lastErr || { ok: false, status: 0, text: "", url }), attempts };
  } finally {
    await ownedDirect?.close?.();
  }
}

function makeGeCtx(baseCtx, opts = {}) {
  // Prefer undici for webservices / secure.ges — tls-client often CF-429s after ATC.
  if (opts.forceSessionTransport) return { ctx: baseCtx, owned: [] };
  const proxy =
    baseCtx.dispatcher?.proxy ||
    (typeof opts.proxyRaw === "string" ? opts.proxyRaw : null);
  const ownedProxy = makeDispatcher(proxy, { forceUndici: true });
  return {
    ctx: { jar: baseCtx.jar, dispatcher: ownedProxy, egressIp: baseCtx.egressIp },
    owned: [ownedProxy],
  };
}

export async function postDisneyGeIssuerHttp(opts = {}) {
  const url = String(opts.url || "");
  if (!isDisneyGeIssuerPaymentUrl(url)) {
    return {
      ok: false,
      error: "not_issuer_url",
      note: "Expected secure.ges …/handlecreditcardrequestV2 or …/Payments/HandleCreditCard*",
    };
  }
  const body = opts.body != null ? String(opts.body) : "";
  if (!body) return { ok: false, error: "body_required" };

  const timeoutMs = Math.max(60_000, Math.min(300_000, Number(opts.timeoutMs) || 180_000));
  const t0 = Date.now();
  try {
    const res = await request(
      url,
      {
        method: "POST",
        headers: {
          accept: "text/html,application/xhtml+xml,application/json,*/*",
          "content-type":
            opts.contentType || "application/x-www-form-urlencoded; charset=UTF-8",
          origin: DISNEY_GE_SECURE,
          referer: opts.referer || `${DISNEY_GE_SECURE}/payments/CreditCardForm/`,
          "user-agent": opts.userAgent || DEFAULT_UA,
          ...(opts.headers || {}),
        },
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
    const ms = Date.now() - t0;
    const locHeader =
      (typeof res.headers?.get === "function" &&
        (res.headers.get("location") || res.headers.get("Location"))) ||
      res.headers?.location ||
      res.headers?.Location ||
      "";
    const locHtml =
      (String(text || "").match(
        /href=["']([^"']*CCPaymentRedirect[^"']*)["']/i,
      ) || [])[1] ||
      (String(text || "").match(
        /Object moved to <a href=["']([^"']+)["']/i,
      ) || [])[1] ||
      "";
    const redirectUrl = locHeader || locHtml || null;
    const redirectUrlFull = redirectUrl ? String(redirectUrl) : null;
    const isPaymentRedirect = /CCPaymentRedirect/i.test(String(redirectUrl || ""));
    const redirectPayload = isPaymentRedirect
      ? decodeCcPaymentRedirectData(redirectUrlFull)
      : null;
    const bankSignal = isBandaiGePaymentRedirectSignal(redirectUrlFull || "", text);
    const declineOnRedirect = isBandaiGeRedirectDecline(redirectUrlFull || "", text);
    // Soft HTML declines (no JWT redirect)
    const htmlDecline =
      /declined|not authorised|not authorized|autherizationfailed|authorizationfailed|payment.*fail/i.test(
        text,
      ) && !/DataCorruption/i.test(text);

    return {
      ok: Boolean(
        (res.status >= 200 && res.status < 400) ||
          bankSignal ||
          declineOnRedirect ||
          htmlDecline ||
          isPaymentRedirect,
      ),
      status: res.status,
      ms,
      undiciAttempts,
      redirectUrl,
      redirectUrlFull,
      redirectPayload,
      isPaymentRedirect,
      bankSignal: Boolean(bankSignal || declineOnRedirect || htmlDecline),
      declineOnRedirect: Boolean(declineOnRedirect || htmlDecline),
      sawAuthWire: Boolean(bankSignal || declineOnRedirect || htmlDecline),
      bodySnippet: String(text || "").replace(/\s+/g, " ").slice(0, 280),
      textBytes: text.length,
    };
  } catch (e) {
    return {
      ok: false,
      error: e?.message || String(e),
      ms: Date.now() - t0,
      responseLost: /fetch failed|aborted|timeout|UND_ERR/i.test(String(e?.message || e)),
      note: "issuer POST threw — bank may still have moved",
    };
  }
}

/**
 * Hydrate Checkout/v2 + optional issuer POST with fake/real card.
 *
 * @param {object} opts
 * @param {object} opts.ctx — jar + dispatcher (Disney ATC session)
 * @param {string} opts.checkoutGuid — SFCC Globale-GetCartToken GUID
 * @param {object} [opts.card] — defaults to DISNEY_FAKE_DECLINE_CARD
 * @param {boolean} [opts.forceIssuer=true] — post issuer even if soft blockers
 * @param {boolean} [opts.riskHydrate=true] — Playwright iovation mint when available
 */
export async function runDisneyGeHttpPay(opts = {}) {
  const steps = opts.steps || [];
  const push = (step, row = {}) => {
    const r = { step, ok: row.ok !== false, ...row };
    steps.push(r);
    opts.onStep?.(r);
    return r;
  };
  const tStep = opts.tStep || (async (name, fn) => {
    const t0 = Date.now();
    try {
      const out = await fn();
      push(name, { ...out, ms: out?.ms ?? Date.now() - t0 });
      return out;
    } catch (e) {
      push(name, { ok: false, ms: Date.now() - t0, note: e?.message || String(e) });
      return { ok: false, note: e?.message || String(e) };
    }
  });

  const guid = opts.checkoutGuid || opts.cartToken || opts.guid;
  if (!guid) {
    return { ok: false, steps, error: "checkoutGuid_required", failedStep: "ge_guid" };
  }

  const mid = String(opts.merchantId || DISNEY_GLOBALE_MID);
  const encodedMerchant = opts.encodedMerchantId || DISNEY_GE_ENCODED_MERCHANT;
  const ua = opts.userAgent || DEFAULT_UA;
  const card = { ...DISNEY_FAKE_DECLINE_CARD, ...(opts.card || {}) };
  const refererBag = opts.referer || "https://www.disneystore.com.au/bag";

  const { ctx: geCtx, owned: ownedGeList } = makeGeCtx(opts.ctx, opts);
  const closeOwned = async () => {
    for (const d of ownedGeList || []) {
      try {
        await d?.close?.();
      } catch {
        /* ignore */
      }
    }
  };
  try {
    // 1) Checkout/v2
    const v2 = await fetchDisneyCheckoutV2(geCtx, {
      tStep,
      checkoutGuid: guid,
      referer: refererBag,
      userAgent: ua,
      allowDirect: opts.allowDirectCheckout !== false,
      includeHtml: true,
      encodedMerchant,
    });
    if (!v2.ok || !v2.html) {
      return {
        ok: false,
        steps,
        failedStep: "ge_checkout_v2",
        error: "checkout_v2_failed",
        paymentStatus: "ge_checkout_failed",
        note: v2.note,
        checkoutGuid: guid,
      };
    }

    const v2Url = v2.url || `${DISNEY_GE_WEBSERVICES}/Checkout/v2/${guid}`;
    let form = parseCheckoutV2Form(v2.html);
    form.merchantId = mid;
    form = applyGuestAddress(form, opts.guest || opts.profile || {}, v2.html);
    let shippingMethodId = form.selectedShippingOptionId || "";
    let urlStructureToken = extractUrlStructureToken(v2.html);
    let machineId = opts.machineId || extractMachineId(v2.html) || null;
    let forterToken = opts.forterToken || null;

    // 2) Optional iovation risk hydrate (Playwright) — improves bank reach rate.
    if (opts.riskHydrate !== false && opts.noPage !== true && !machineId) {
      await tStep("ge_iovation_mint", async () => {
        try {
          const { chromium } = await import("playwright");
          const browser = await chromium.launch({
            headless: opts.headless !== false,
            channel: "chrome",
            args: ["--disable-blink-features=AutomationControlled", "--no-sandbox"],
          });
          const context = await browser.newContext({
            userAgent: ua,
            locale: "en-AU",
            viewport: { width: 1280, height: 900 },
          });
          // Seed cookies if jar has GE/Disney cookies
          try {
            const dump = geCtx.jar?.dump?.() || {};
            const cookies = Object.entries(dump).map(([name, value]) => ({
              name,
              value,
              domain: String(name).startsWith("_") || /bm_|ak_bmsc|GlobalE/i.test(name)
                ? ".global-e.com"
                : ".disneystore.com.au",
              path: "/",
            }));
            // Also set webservices domain variants for GE
            const geCookies = Object.entries(dump)
              .filter(([n]) => /GlobalE|forter|io_/i.test(n))
              .flatMap(([name, value]) => [
                { name, value, domain: ".global-e.com", path: "/" },
                { name, value, domain: "webservices.global-e.com", path: "/" },
              ]);
            await context.addCookies([...cookies, ...geCookies]);
          } catch {
            /* ignore cookie seed */
          }
          const page = await context.newPage();
          const pctx = page.context();
          const geMuteMatch = (url) => /global-e\.com/i.test(url.href || String(url));
          const geMuteRoute = async (route) => {
            const method = String(route.request().method() || "GET").toUpperCase();
            if (method === "GET" || method === "HEAD" || method === "OPTIONS") {
              await route.continue();
              return;
            }
            await route.fulfill({ status: 204, contentType: "text/plain", body: "" });
          };
          await pctx.route(geMuteMatch, geMuteRoute);
          let mint;
          try {
            mint = await mintIovationBlackbox({
              page,
              checkoutV2Url: v2Url,
              timeoutMs: opts.iovationTimeoutMs || 45_000,
              settleMs: opts.iovationSettleMs || 5_000,
              jar: geCtx.jar,
            });
          } finally {
            try {
              await pctx.unroute(geMuteMatch, geMuteRoute);
            } catch {
              /* ignore */
            }
            await browser.close().catch(() => {});
          }
          if (mint?.machineId) machineId = mint.machineId;
          if (mint?.forterToken) forterToken = mint.forterToken;
          return {
            ok: Boolean(mint?.machineId),
            note: mint?.machineId
              ? `ioBlackBox bytes=${String(mint.machineId).length}`
              : `iovation fail ${mint?.error || "no blackbox"}`,
          };
        } catch (e) {
          return { ok: false, note: `iovation skip: ${e?.message || e}` };
        }
      });
    } else if (machineId) {
      push("ge_iovation_mint", {
        ok: true,
        note: `reused machineId bytes=${String(machineId).length}`,
      });
    } else {
      push("ge_iovation_mint", {
        ok: true,
        note: "skipped — will attempt issuer without blackbox",
      });
    }

    // 3) handleaction 1/2/3 — action 1 must yield a shipping method id for save.
    let hydrateShippingOk = false;
    for (const actionId of [1, 2, 3]) {
      const haUrl = `${DISNEY_GE_WEBSERVICES}/checkoutv2/handleaction/${actionId}/${guid}/${encodedMerchant}`;
      const maxTries = actionId === 1 ? 3 : 1;
      await tStep(`ge_handleaction_${actionId}`, async () => {
        let last = null;
        for (let tryN = 0; tryN < maxTries; tryN++) {
          const bodies = buildHandleActionBodies(form, {
            cartToken: guid,
            merchantId: mid,
            shippingMethodId,
            paymentMethodId: form.selectedPaymentMethodId || "1",
          });
          const ha = await httpText(haUrl, {
            ctx: geCtx,
            method: "POST",
            userAgent: ua,
            accept: "application/json, text/plain, */*",
            allowDirect: opts.allowDirectCheckout !== false,
            headers: {
              origin: DISNEY_GE_WEBSERVICES,
              referer: v2Url,
              "content-type": "application/json",
              "x-requested-with": "XMLHttpRequest",
              "X-merchantId": String(mid),
            },
            body: JSON.stringify(bodies[actionId]),
          });
          last = ha;
          let haJson = null;
          try {
            haJson = JSON.parse(String(ha.text || ""));
          } catch {
            haJson = null;
          }
          if (actionId === 1) {
            const picked = pickDisneyShippingMethodId(haJson);
            if (picked) shippingMethodId = picked;
            hydrateShippingOk = Boolean(ha.ok && shippingMethodId);
            if (hydrateShippingOk) break;
            // Keep last JSON snippet for note even when id missing
            if (ha.error || !ha.ok) continue; // retry on transport flake
            // 200 but no options yet — retry once more (address bind lag)
            continue;
          } else {
            break;
          }
        }
        let haJson = null;
        try {
          haJson = JSON.parse(String(last?.text || ""));
        } catch {
          haJson = null;
        }
        if (!urlStructureToken) urlStructureToken = extractUrlStructureToken(last?.text);
        let keysNote = "";
        if (actionId === 1 && !shippingMethodId && last?.text) {
          try {
            const j = JSON.parse(String(last.text));
            keysNote = ` keys=${Object.keys(j).slice(0, 12).join(",")}`;
          } catch {
            /* ignore */
          }
        }
        return {
          ok:
            Boolean(last?.ok) &&
            (actionId !== 1 || hydrateShippingOk || Boolean(shippingMethodId)),
          status: last?.status,
          ms: last?.ms,
          note: (
            actionId === 1
              ? `shipOk=${hydrateShippingOk} method=${shippingMethodId || "none"} via=${last?.via || "?"}${keysNote} ${String(last?.text || last?.error || "").replace(/\s+/g, " ")}`
              : `via=${last?.via || "?"} ${String(last?.text || last?.error || "").replace(/\s+/g, " ")}`
          ).slice(0, 240),
        };
      });
    }

    // If action1 still flaked, one more dedicated shipping probe on direct.
    if (!shippingMethodId) {
      await tStep("ge_handleaction_1_retry", async () => {
        const bodies = buildHandleActionBodies(form, {
          cartToken: guid,
          merchantId: mid,
          shippingMethodId: "",
          paymentMethodId: form.selectedPaymentMethodId || "1",
        });
        const ha = await httpText(
          `${DISNEY_GE_WEBSERVICES}/checkoutv2/handleaction/1/${guid}/${encodedMerchant}`,
          {
            ctx: geCtx,
            method: "POST",
            userAgent: ua,
            accept: "application/json, text/plain, */*",
            allowDirect: true,
            headers: {
              origin: DISNEY_GE_WEBSERVICES,
              referer: v2Url,
              "content-type": "application/json",
              "x-requested-with": "XMLHttpRequest",
              "X-merchantId": String(mid),
            },
            body: JSON.stringify(bodies[1]),
          },
        );
        let haJson = null;
        try {
          haJson = JSON.parse(String(ha.text || ""));
        } catch {
          haJson = null;
        }
        const picked = pickDisneyShippingMethodId(haJson);
        if (picked) {
          shippingMethodId = picked;
          hydrateShippingOk = true;
        }
        return {
          ok: Boolean(shippingMethodId),
          status: ha.status,
          note: `retry ship method=${shippingMethodId || "none"} via=${ha.via || "?"} ${String(ha.text || ha.error || "").replace(/\s+/g, " ")}`.slice(
            0,
            220,
          ),
        };
      });
    }

    // 4) save
    const paymentMethodId = String(opts.paymentMethodId || form.selectedPaymentMethodId || "1");
    const gatewayId = String(opts.gatewayId || form.gatewayId || "2");
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
    await tStep("ge_checkout_save", async () => {
      const saveRes = await httpText(
        `${DISNEY_GE_WEBSERVICES}/checkoutv2/save/${encodedMerchant}/${guid}`,
        {
          ctx: geCtx,
          method: "POST",
          userAgent: ua,
          accept: "application/json, text/plain, */*",
          allowDirect: opts.allowDirectCheckout !== false,
          headers: {
            origin: DISNEY_GE_WEBSERVICES,
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
      return {
        ok: saveOk,
        status: saveRes?.status,
        ms: saveRes?.ms,
        note: (
          saveOk
            ? `save ok gw=${gatewayId} pm=${paymentMethodId} ship=${shippingMethodId || "none"} io=${Boolean(machineId)}`
            : `save fail ${String(saveRes?.text || saveRes?.error || "").replace(/\s+/g, " ")}`
        ).slice(0, 200),
      };
    });

    // 5) CreditCardForm — mint JWT / machineId + real form action
    const ccUrls = [
      `${DISNEY_GE_CREDIT_CARD_FORM}/${guid}/${gatewayId}`,
      `${DISNEY_GE_CREDIT_CARD_FORM}/${guid}`,
      `${DISNEY_GE_SECURE}/payments/CreditCardForm/${guid}/${gatewayId}`,
    ];
    let ccText = "";
    let ccUrl = ccUrls[0];
    let formIssuerAction = null;
    await tStep("ge_credit_card_form", async () => {
      let last = null;
      for (const u of ccUrls) {
        const cc = await httpText(u, {
          ctx: geCtx,
          userAgent: ua,
          accept: "text/html,application/xhtml+xml,*/*",
          allowDirect: opts.allowDirectCheckout !== false,
          headers: { referer: v2Url },
        }).catch((e) => ({ ok: false, status: 0, text: "", error: e?.message }));
        last = cc;
        if (cc.ok && (cc.text || "").length > 500) {
          ccText = cc.text;
          ccUrl = u;
          break;
        }
      }
      urlStructureToken = extractUrlStructureToken(ccText) || urlStructureToken;
      const formMachineId = extractMachineId(ccText);
      if (formMachineId) machineId = formMachineId;
      const actionPath = (String(ccText).match(/<form[^>]*action=["']([^"']+)["']/i) || [])[1];
      if (actionPath) {
        try {
          formIssuerAction = new URL(actionPath, DISNEY_GE_SECURE).href;
        } catch {
          formIssuerAction = actionPath.startsWith("http")
            ? actionPath
            : `${DISNEY_GE_SECURE}${actionPath.startsWith("/") ? "" : "/"}${actionPath}`;
        }
      }
      return {
        ok: Boolean(ccText),
        status: last?.status,
        note: `CreditCardForm ${last?.status}; jwt=${Boolean(urlStructureToken)} machineId=${Boolean(machineId)} action=${(formIssuerAction || "").replace(guid, "{guid}") || "none"}`,
      };
    });

    const blockers = [];
    if (!form.hasAddress) blockers.push("checkout_address");
    if (!hydrateShippingOk) blockers.push("hydrate_shipping");
    if (!card?.number || !card?.cvv) blockers.push("card");
    // jwt / machineId are soft for decline labs — forceIssuer default true

    if (opts.stopBeforeIssuer === true) {
      return {
        ok: false,
        steps,
        checkoutGuid: guid,
        encodedMerchantId: encodedMerchant,
        paymentStatus: "http_ge_hydrated",
        checkoutStage: "tokenize",
        blockers,
        note: `hydrated; stopBeforeIssuer blockers=${blockers.join(",") || "none"}`,
        failedStep: "stop_before_issuer",
      };
    }

    const forceIssuer = opts.forceIssuer !== false;
    if (blockers.length && !forceIssuer) {
      return {
        ok: false,
        steps,
        checkoutGuid: guid,
        blockers,
        paymentStatus: "http_ge_blockers",
        failedStep: blockers[0],
        note: `blockers=${blockers.join(",")}`,
      };
    }

    // 6) Issuer — CreditCardForm action is authoritative:
    //    /1/Payments/HandleCreditCardRequestV2/{encoded}/{guid}?mode=13534
    // Bare /payments/handlecreditcardrequestV2 returns empty 200 — do not stop on that.
    const issuerMode = opts.issuerMode || "13534";
    const issuerCandidates = [
      opts.issuerUrl,
      formIssuerAction,
      `${DISNEY_GE_SECURE}/1/Payments/HandleCreditCardRequestV2/${encodedMerchant}/${guid}?mode=${issuerMode}`,
      `${DISNEY_GE_SECURE}/payments/HandleCreditCardRequestV2/${encodedMerchant}/${guid}?mode=${issuerMode}`,
      DISNEY_GE_ISSUER_ACTION,
    ].filter((u, i, arr) => u && arr.indexOf(u) === i);

    const body = buildIssuerFormBody({
      card,
      cartToken: guid,
      machineId: machineId || "",
      urlStructureToken: urlStructureToken || "",
      gatewayId,
      paymentMethodId,
      createTransaction: opts.createTransaction !== false,
    });

    let issuer = null;
    for (const issuerUrl of issuerCandidates) {
      // Try proxy jar ctx first, then bare direct undici (same cookies).
      const issuerContexts = [geCtx];
      let ownedIssuerDirect = null;
      if (opts.allowDirectCheckout !== false) {
        ownedIssuerDirect = makeDispatcher(null, { forceUndici: true });
        issuerContexts.push({
          jar: geCtx.jar,
          dispatcher: ownedIssuerDirect,
          egressIp: geCtx.egressIp,
        });
      }
      try {
        for (const ictx of issuerContexts) {
          const via = ictx.dispatcher?.proxy ? "proxy-undici" : "direct-undici";
          issuer = await tStep("ge_issuer_http", async () => {
            const r = await postDisneyGeIssuerHttp({
              url: issuerUrl,
              body,
              ctx: ictx,
              userAgent: ua,
              referer: ccUrl,
              timeoutMs: Number(opts.issuerTimeoutMs) || 180_000,
            });
            const txMap = mapCcPaymentRedirect(r.redirectPayload || r.redirectUrlFull || "");
            const fraudDetected = /^(true|1)$/i.test(String(txMap.PossibleFraudDetected || ""));
            const statusType = String(txMap.TransactionStatusType || "");
            const transactionId =
              txMap.TransactionId && txMap.TransactionId !== "0"
                ? txMap.TransactionId
                : txMap.MerchantReference && txMap.MerchantReference !== "0"
                  ? txMap.MerchantReference
                  : null;
            const bankHit = Boolean(
              r.sawAuthWire || r.declineOnRedirect || r.bankSignal || transactionId,
            );
            const emptyOk = Boolean(r.ok && Number(r.textBytes || 0) === 0 && !bankHit && !r.redirectUrl);
            // Instant CONNECT/fetch fail is transport, not "bank may have moved".
            const slowLost =
              Boolean(r.responseLost) && Number(r.ms || 0) >= 5_000;
            const authFailed = /Auth|Decline|Fail|Refuse/i.test(statusType);
            const paymentStatus = fraudDetected
              ? "ge_fraud_refused"
              : r.declineOnRedirect || (bankHit && authFailed)
                ? "declined_or_auth_failed"
                : bankHit && transactionId
                  ? "declined_or_auth_failed"
                  : emptyOk
                    ? "issuer_empty_response"
                    : slowLost
                      ? "pay_submitted_no_response"
                      : /DataCorruption/i.test(String(txMap.RedirectErrorType || r.bodySnippet || ""))
                        ? "ge_data_corruption"
                        : r.ok && (bankHit || Number(r.textBytes || 0) > 0 || r.redirectUrl)
                          ? "pay_submitted_http"
                          : "issuer_http_failed";

            const isSameCartToken = /^(true|1)$/i.test(String(txMap.IsTheSameCartToken || ""));
            const willCaptcha = /^(true|1)$/i.test(
              String(txMap.WillCaptchaBeRequiredOnNextFailedPaymentAttempt || ""),
            );
            const fraudFlags = {
              possibleFraudDetected: fraudDetected,
              isSameCartToken,
              // GE often returns IsTheSameCartToken=False on HTTP issuer even when bank moved;
              // treat False as a soft risk signal (Bandai: silent Revolut / DataCorruption gap).
              sameCartMismatch: !isSameCartToken && Boolean(transactionId || bankHit),
              willCaptchaOnNextFail: willCaptcha,
              transactionStatusType: statusType || null,
              success: /^(true|1)$/i.test(String(txMap.Success || "")),
              paymentErrorBody: txMap.PaymentErrorBody
                ? String(txMap.PaymentErrorBody).slice(0, 240)
                : null,
              machineIdPresent: Boolean(machineId),
              forterTokenPresent: Boolean(forterToken),
              jwtPresent: Boolean(urlStructureToken),
            };

            return {
              ...r,
              ok: Boolean(
                paymentStatus === "declined_or_auth_failed" ||
                  paymentStatus === "ge_fraud_refused" ||
                  paymentStatus === "pay_submitted_http" ||
                  paymentStatus === "pay_submitted_no_response",
              ),
              issuerUrl: issuerUrl.replace(guid, "{guid}"),
              via,
              paymentStatus,
              possibleFraudDetected: fraudDetected,
              transactionStatusType: statusType || null,
              transactionId,
              txMap,
              fraudFlags,
              isSameCartToken,
              note: (
                paymentStatus === "declined_or_auth_failed" || paymentStatus === "ge_fraud_refused"
                  ? `DECLINE/AUTH wire status=${r.status} payStatus=${paymentStatus} tx=${transactionId || "-"} fraud=${fraudDetected} sameCart=${txMap.IsTheSameCartToken || "?"} type=${statusType || "-"} via=${via}`
                  : `issuer ${r.status} payStatus=${paymentStatus} bank=${bankHit} fraud=${fraudDetected} sameCart=${txMap.IsTheSameCartToken || "?"} via=${via} ${String(r.bodySnippet || r.error || "").slice(0, 100)}`
              ).slice(0, 320),
            };
          });
          if (
            issuer?.paymentStatus === "declined_or_auth_failed" ||
            issuer?.paymentStatus === "ge_fraud_refused" ||
            issuer?.paymentStatus === "pay_submitted_no_response"
          ) {
            break;
          }
          // Empty 200 / wrong path → try next dispatcher or URL shape
          if (issuer?.paymentStatus === "pay_submitted_http" && issuer?.bankSignal) {
            break;
          }
        }
      } finally {
        await ownedIssuerDirect?.close?.();
      }

      if (
        issuer?.paymentStatus === "declined_or_auth_failed" ||
        issuer?.paymentStatus === "ge_fraud_refused"
      ) {
        break;
      }
      // Try next URL shape on empty / DataCorruption / hard fail
    }

    const decline = /decline|auth_failed|fraud_refused/i.test(String(issuer?.paymentStatus || ""));
    const wireOk = Boolean(issuer?.ok && (decline || issuer?.paymentStatus === "pay_submitted_http" || issuer?.paymentStatus === "pay_submitted_no_response"));
    const fraudFlags = issuer?.fraudFlags || {
      possibleFraudDetected: issuer?.possibleFraudDetected ?? null,
      isSameCartToken: issuer?.isSameCartToken ?? null,
      sameCartMismatch: null,
      willCaptchaOnNextFail: null,
      transactionStatusType: issuer?.transactionStatusType || null,
      success: null,
      paymentErrorBody: issuer?.txMap?.PaymentErrorBody
        ? String(issuer.txMap.PaymentErrorBody).slice(0, 240)
        : null,
      machineIdPresent: Boolean(machineId),
      forterTokenPresent: Boolean(forterToken),
      jwtPresent: Boolean(urlStructureToken),
    };
    return {
      ok: wireOk,
      steps,
      engine: "http",
      globaleMid: mid,
      encodedMerchantId: encodedMerchant,
      checkoutGuid: guid,
      cartToken: guid,
      paymentStatus: issuer?.paymentStatus || "issuer_http_failed",
      possibleFraudDetected: fraudFlags.possibleFraudDetected,
      isSameCartToken: fraudFlags.isSameCartToken,
      fraudFlags,
      transactionStatusType: issuer?.transactionStatusType || null,
      transactionId: issuer?.transactionId || null,
      decline,
      issuer,
      checkoutV2Url: v2Url,
      creditCardFormUrl: ccUrl,
      issuerAction: issuer?.issuerUrl || formIssuerAction || DISNEY_GE_ISSUER_ACTION,
      machineIdPresent: Boolean(machineId),
      jwtPresent: Boolean(urlStructureToken),
      hydrateShippingOk: hydrateShippingOk || Boolean(shippingMethodId),
      shippingMethodId: shippingMethodId || null,
      cardLast4: String(card.number || "").replace(/\s+/g, "").slice(-4),
      fakeCard: String(card.number || "").replace(/\s+/g, "") === DISNEY_FAKE_DECLINE_CARD.number,
      stoppedBeforePay: false,
      checkoutStage: decline ? "order" : wireOk ? "tokenize" : "tokenize",
      note: issuer?.note || "issuer failed",
      failedStep: decline
        ? null
        : fraudFlags.possibleFraudDetected
          ? "ge_fraud_refused"
          : issuer?.paymentStatus || "ge_issuer",
    };
  } finally {
    await closeOwned();
  }
}

export default {
  DISNEY_FAKE_DECLINE_CARD,
  isDisneyGeIssuerPaymentUrl,
  postDisneyGeIssuerHttp,
  runDisneyGeHttpPay,
};
