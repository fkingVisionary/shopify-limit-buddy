/**
 * Disney Store AU — CSRF + Cart-AddProduct + minibag/bag probes.
 *
 * Wire (main.js 2026-07-26 via AU ISP):
 *   POST CSRF-Generate → { csrf: { tokenName, token } }
 *   POST Cart-AddProduct data:
 *     { pid, pidsObj, childProducts, quantity, personalization?, [tokenName]: token }
 *   ATC UI path also runs reCAPTCHA Enterprise action "AddToCart" then
 *     POST Google-reCaptchaEnterprise { token } before the cart POST.
 */

import {
  parseCsrfGenerateJson,
  parseDisneyPdp,
  parseMiniCartHtml,
  looksLikeAkamaiDenied,
  DISNEY_RECAPTCHA_ENTERPRISE_SITEKEY,
} from "./disney-session.js";

function formBody(fields) {
  const u = new URLSearchParams();
  for (const [k, v] of Object.entries(fields || {})) {
    if (v == null) continue;
    u.set(k, String(v));
  }
  return u.toString();
}

export function buildAddToCartFields({ pid, quantity = 1, csrf, personalization = "", extra = {} } = {}) {
  // Live HAR (2026-07-26 headed Chrome): browser posts pid + quantity + csrf_token only.
  // Keep optional SFCC fields when explicitly provided (bundles / personalization).
  const fields = {
    pid: String(pid || ""),
    quantity: String(quantity || 1),
  };
  if (extra.pidsObj != null && extra.pidsObj !== "") fields.pidsObj = extra.pidsObj;
  if (extra.childProducts != null && extra.childProducts !== "") fields.childProducts = extra.childProducts;
  if (personalization) fields.personalization = personalization;
  for (const [k, v] of Object.entries(extra || {})) {
    if (k === "csrf" || k === "pidsObj" || k === "childProducts") continue;
    if (v == null || v === "") continue;
    fields[k] = v;
  }
  if (csrf?.tokenName && csrf?.token) {
    fields[csrf.tokenName] = csrf.token;
  }
  return fields;
}

export async function generateDisneyCsrf(session, ctx, opts = {}) {
  const tStep = opts.tStep || (async (_n, fn) => fn());
  const url = session.urls.csrf;
  return tStep("csrf_generate", async () => {
    const res = await session.post(url, "", {
      referer: opts.referer || `${session.state.origin}/`,
      contentType: "application/x-www-form-urlencoded; charset=UTF-8",
    });
    if (looksLikeAkamaiDenied(res.text, res.status)) {
      return {
        ok: false,
        status: res.status,
        note: "CSRF blocked by Akamai — warm sensors first",
        denied: true,
      };
    }
    const csrf = parseCsrfGenerateJson(res.json) || parseCsrfGenerateJson(safeJson(res.text));
    if (!csrf) {
      const msg = res.json?.message || res.text?.slice(0, 160);
      return {
        ok: false,
        status: res.status,
        note: `CSRF missing token status=${res.status} msg=${msg}`,
        raw: res.json,
      };
    }
    session.state.lastCsrf = csrf;
    return {
      ok: true,
      status: res.status,
      note: `csrf tokenName=${csrf.tokenName}`,
      csrf,
    };
  });
}

function safeJson(text) {
  try {
    return JSON.parse(String(text || ""));
  } catch {
    return null;
  }
}

/**
 * Verify Enterprise token with SFCC controller (optional pre-ATC gate).
 * Accepts owner/CapSolver-injected token via opts.token.
 */
export async function verifyDisneyRecaptchaEnterprise(session, token, opts = {}) {
  const tStep = opts.tStep || (async (_n, fn) => fn());
  if (!token) {
    return { ok: false, note: "no reCAPTCHA Enterprise token" };
  }
  const url = opts.verifyUrl || session.urls.recaptchaEnterprise;
  return tStep("recaptcha_enterprise_verify", async () => {
    const res = await session.post(url, formBody({ token }), {
      referer: opts.referer || `${session.state.origin}/`,
      contentType: "application/x-www-form-urlencoded; charset=UTF-8",
    });
    const result = res.json?.result ?? res.json;
    const passed = Boolean(result?.result === true || result?.success === true || res.json?.success === true);
    return {
      ok: res.ok && (passed || opts.acceptAny200 === true),
      status: res.status,
      note: passed
        ? "reCAPTCHA Enterprise verified"
        : `reCAPTCHA verify status=${res.status} body=${String(res.text || "").slice(0, 120)}`,
      raw: res.json,
    };
  });
}

export async function fetchDisneyPdp(session, pdpUrl, opts = {}) {
  const tStep = opts.tStep || (async (_n, fn) => fn());
  return tStep("pdp_fetch", async () => {
    const res = await session.get(pdpUrl, { referer: `${session.state.origin}/` });
    if (looksLikeAkamaiDenied(res.text, res.status)) {
      return {
        ok: false,
        status: res.status,
        note: "PDP Akamai denied",
        denied: true,
      };
    }
    const parsed = parseDisneyPdp(res.text);
    session.state.lastPdp = { url: pdpUrl, ...parsed };
    return {
      ok: res.ok,
      status: res.status,
      note: parsed.note,
      ...parsed,
      htmlBytes: res.text?.length || 0,
    };
  });
}

export async function fetchDisneyMiniCart(session, opts = {}) {
  const tStep = opts.tStep || (async (_n, fn) => fn());
  return tStep("minicart", async () => {
    const res = await session.get(session.urls.miniCart, {
      xhr: true,
      referer: opts.referer || `${session.state.origin}/bag`,
    });
    if (looksLikeAkamaiDenied(res.text, res.status)) {
      return { ok: false, status: res.status, note: "minicart Akamai denied", denied: true };
    }
    const parsed = parseMiniCartHtml(res.text);
    return {
      ok: res.ok,
      status: res.status,
      note: parsed.note,
      ...parsed,
      htmlBytes: res.text?.length || 0,
    };
  });
}

/**
 * Dry-run / live ATC. placeOrder is unused here (GE pays later); dryRun only skips nothing
 * on cart POST — caller sets placeOrder false for bag-only.
 */
export async function addDisneyToCart(session, ctx, opts = {}) {
  const tStep = opts.tStep || (async (_n, fn) => fn());
  const pid = String(opts.pid || "");
  const quantity = Number(opts.quantity || 1);
  const pdpUrl = opts.pdpUrl || `${session.state.origin}/`;
  const addUrl = opts.addToCartUrl?.startsWith("http")
    ? opts.addToCartUrl
    : opts.addToCartUrl
      ? `${session.state.origin}${opts.addToCartUrl}`
      : session.urls.addToCart;

  if (!pid) {
    return { ok: false, note: "pid required for ATC" };
  }

  let csrf = opts.csrf || session.state.lastCsrf;
  if (!csrf) {
    const gen = await generateDisneyCsrf(session, ctx, { tStep, referer: pdpUrl });
    if (!gen.ok) return { ...gen, step: "csrf_generate" };
    csrf = gen.csrf;
  }

  // reCAPTCHA Enterprise — required by storefront JS for primary ATC.
  const sitekey = opts.recaptchaSitekey || DISNEY_RECAPTCHA_ENTERPRISE_SITEKEY;
  let recaptchaToken = opts.recaptchaToken || opts.captchaToken || null;
  if (!recaptchaToken && opts.requireRecaptcha !== false && opts.skipRecaptcha !== true) {
    return {
      ok: false,
      note: `ATC needs reCAPTCHA Enterprise token (sitekey=${sitekey.slice(0, 10)}… action=AddToCart). Pass task.recaptchaToken or solve externally.`,
      needsRecaptcha: true,
      recaptchaSitekey: sitekey,
      csrf,
    };
  }

  if (recaptchaToken && opts.skipRecaptchaVerify !== true) {
    const verified = await verifyDisneyRecaptchaEnterprise(session, recaptchaToken, {
      tStep,
      referer: pdpUrl,
      verifyUrl: opts.recaptchaEnterpriseUrl || session.urls.recaptchaEnterprise,
    });
    if (!verified.ok && opts.requireRecaptchaVerify === true) {
      return { ...verified, needsRecaptcha: true, recaptchaSitekey: sitekey };
    }
  }

  const fields = buildAddToCartFields({
    pid,
    quantity,
    csrf,
    personalization: opts.personalization || "",
    extra: opts.extraFields || {},
  });

  const atc = await tStep("cart_add_product", async () => {
    const res = await session.post(addUrl, formBody(fields), {
      referer: pdpUrl,
      contentType: "application/x-www-form-urlencoded; charset=UTF-8",
    });
    if (looksLikeAkamaiDenied(res.text, res.status)) {
      return {
        ok: false,
        status: res.status,
        note: "Cart-AddProduct Akamai Access Denied — sensor warm incomplete",
        denied: true,
      };
    }
    const err = Boolean(res.json?.error) || /error/i.test(String(res.json?.message || ""));
    const ok = res.ok && !err;
    return {
      ok,
      status: res.status,
      note: ok
        ? `ATC ok pid=${pid} qty=${quantity}`
        : `ATC fail status=${res.status} msg=${String(res.json?.message || res.text).slice(0, 160)}`,
      raw: res.json,
      textBytes: res.text?.length || 0,
    };
  });

  let mini = null;
  if (atc.ok || opts.alwaysCheckMini !== false) {
    mini = await fetchDisneyMiniCart(session, { tStep, referer: pdpUrl });
  }

  const lineOk =
    atc.ok &&
    mini &&
    (mini.linePids?.includes(pid) || (typeof mini.itemCount === "number" && mini.itemCount > 0) || mini.empty === false);

  return {
    ok: Boolean(lineOk || (atc.ok && opts.acceptAtcWithoutMini === true)),
    pid,
    quantity,
    csrf,
    atc,
    mini,
    needsRecaptcha: false,
    recaptchaSitekey: sitekey,
    note: lineOk
      ? `bag has pid=${pid}`
      : atc.ok
        ? `ATC HTTP ok but minibag unclear (${mini?.note || "no mini"})`
        : atc.note,
  };
}

export default {
  buildAddToCartFields,
  generateDisneyCsrf,
  fetchDisneyPdp,
  fetchDisneyMiniCart,
  addDisneyToCart,
  verifyDisneyRecaptchaEnterprise,
};
