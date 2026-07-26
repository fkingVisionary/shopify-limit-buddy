/**
 * Disney Store AU/NZ — SFCC session / URL / parse helpers.
 *
 * Canonical: https://www.disneystore.com.au/
 * SFCC: Sites-DisneyStoreAUNZ-Site / en_AU / realm BGSX
 * GE mid: 1696 (never Bandai 1925)
 *
 * NZ PDPs live under /nz/... on the same host + site.
 */

import { request, UA as DEFAULT_UA } from "../http.js";

export const DISNEY_ORIGIN = "https://www.disneystore.com.au";
export const DISNEY_SITE = "Sites-DisneyStoreAUNZ-Site";
export const DISNEY_LOCALE = "en_AU";
export const DISNEY_SITE_ID = "DisneyStoreAUNZ";
export const DISNEY_GE_MID = "1696";
export const DISNEY_GE_MERCHANT_HASHED = "mZ25";
export const DISNEY_GE_CLIENT_SDK = `https://web.global-e.com/merchant/clientsdk/${DISNEY_GE_MID}`;
export const DISNEY_RECAPTCHA_ENTERPRISE_SITEKEY =
  "6LfTl6ApAAAAADNDby7y07sX55wM7B47VUFx7TFW";
/** Widget sitekey seen on PDP `#g-recaptch` (classic + enterprise verify URLs). */
export const DISNEY_RECAPTCHA_WIDGET_SITEKEY = "6LeKIIIpAAAAACr83L-GXCHa48lp6LMUSPfRWokW";
export const DISNEY_ONEID_CLIENT = "WDI-SHOPDISNEYAUNZ.WEB-PROD";
export const DISNEY_OCAPI_CLIENT_ID = "0f4bc909-824c-445f-af00-7f4fb28cdb21";

export const DISNEY_DEFAULT_PDP_PID = "050368983992";
export const DISNEY_DEFAULT_PDP_PATH =
  "/disney-lorcana-trading-card-game-by-ravensburger-gateway-050368983992.html";

export function disneyController(action, { origin = DISNEY_ORIGIN, locale = DISNEY_LOCALE } = {}) {
  const a = String(action || "").replace(/^\//, "");
  return `${origin}/on/demandware.store/${DISNEY_SITE}/${locale}/${a}`;
}

export function disneyUrls(opts = {}) {
  const origin = opts.origin || DISNEY_ORIGIN;
  const locale = opts.locale || DISNEY_LOCALE;
  return {
    origin,
    home: `${origin}/`,
    bag: `${origin}/bag`,
    sitemapIndex: `${origin}/sitemap_index.xml`,
    sitemap0: `${origin}/sitemap_0.xml`,
    csrf: disneyController("CSRF-Generate", { origin, locale }),
    addToCart: disneyController("Cart-AddProduct", { origin, locale }),
    miniCart: disneyController("Cart-MiniCartShow", { origin, locale }),
    geCartToken: disneyController("Globale-GetCartToken", { origin, locale }),
    geScriptLoader: disneyController("Globale-ScriptLoaderData", { origin, locale }),
    geConvertPrice: disneyController("Globale-ConvertPrice", { origin, locale }),
    geSiteRedirect: disneyController("Globale-GetSiteRedirectUrl", { origin, locale }),
    recaptcha: disneyController("Google-reCaptcha", { origin, locale }),
    recaptchaEnterprise: disneyController("Google-reCaptchaEnterprise", { origin, locale }),
    oneIdResponder: disneyController("OneID-Responder", { origin, locale }),
    loginBridge: `${origin}/ocapi/cc/login`,
    loginRefresh: disneyController("Login-Refresh", { origin, locale }),
    suggest: disneyController("SearchServices-GetSuggestions", { origin, locale }),
  };
}

/**
 * Parse Disney PDP URL → { pid, slug, isNz, productUrl }.
 * Shape: /{seo-slug}-{pid}.html or /nz/{seo-slug}-{pid}.html
 */
export function parseDisneyProductUrl(raw) {
  const s = String(raw || "").trim();
  if (!s) return null;
  try {
    const u = new URL(s.startsWith("http") ? s : `${DISNEY_ORIGIN}${s.startsWith("/") ? "" : "/"}${s}`);
    const host = u.hostname.toLowerCase().replace(/^www\./, "");
    if (host !== "disneystore.com.au" && host !== "shopdisney.com.au") return null;
    const parts = u.pathname.split("/").filter(Boolean);
    let isNz = false;
    let file = parts[parts.length - 1] || "";
    if (parts[0] === "nz") isNz = true;
    if (!file.endsWith(".html")) {
      return { pid: null, slug: null, isNz, productUrl: u.toString() };
    }
    const base = file.replace(/\.html$/i, "");
    const m = base.match(/-(\d{6,})$/);
    const pid = m?.[1] || null;
    const slug = pid ? base.slice(0, -(pid.length + 1)) : base;
    return { pid, slug, isNz, productUrl: u.toString() };
  } catch {
    return null;
  }
}

/** Resolve pid from task fields / PDP URL. */
export function resolveDisneyPid(task = {}) {
  const fromFields = String(task.pid || task.sku || task.variantId || task.productCode || "").trim();
  if (fromFields && !/^https?:/i.test(fromFields) && /^\d{6,}$/.test(fromFields)) return fromFields;
  const parsed = parseDisneyProductUrl(task.pdpUrl || task.storeUrl || task.input || "");
  return parsed?.pid || null;
}

export function resolveDisneyPdpUrl(task = {}) {
  const parsed = parseDisneyProductUrl(task.pdpUrl || task.storeUrl || task.input || "");
  if (parsed?.productUrl && parsed.pid) return parsed.productUrl;
  const pid = resolveDisneyPid(task);
  if (pid && parsed?.slug) {
    const prefix = parsed.isNz ? "/nz/" : "/";
    return `${DISNEY_ORIGIN}${prefix}${parsed.slug}-${pid}.html`;
  }
  if (task.pdpUrl && String(task.pdpUrl).includes("disneystore.com.au")) {
    return String(task.pdpUrl);
  }
  // Research default Lorcana Gateway SKU when nothing provided (dry/monitor labs).
  if (task.useDefaultPdp !== false && !pid) {
    return `${DISNEY_ORIGIN}${DISNEY_DEFAULT_PDP_PATH}`;
  }
  if (pid) return `${DISNEY_ORIGIN}${DISNEY_DEFAULT_PDP_PATH.replace(DISNEY_DEFAULT_PDP_PID, pid)}`;
  return `${DISNEY_ORIGIN}${DISNEY_DEFAULT_PDP_PATH}`;
}

export function disneyNavHeaders({ referer, userAgent } = {}) {
  return {
    "user-agent": userAgent || DEFAULT_UA,
    accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
    "accept-language": "en-AU,en;q=0.9",
    "accept-encoding": "gzip, deflate, br",
    "upgrade-insecure-requests": "1",
    "sec-fetch-dest": "document",
    "sec-fetch-mode": "navigate",
    "sec-fetch-site": referer ? "same-origin" : "none",
    "sec-fetch-user": "?1",
    ...(referer ? { referer } : {}),
  };
}

export function disneyXhrHeaders({ referer, userAgent, contentType } = {}) {
  const h = {
    "user-agent": userAgent || DEFAULT_UA,
    accept: "application/json, text/javascript, */*; q=0.01",
    "accept-language": "en-AU,en;q=0.9",
    "accept-encoding": "gzip, deflate, br",
    "x-requested-with": "XMLHttpRequest",
    "sec-fetch-dest": "empty",
    "sec-fetch-mode": "cors",
    "sec-fetch-site": "same-origin",
    ...(referer ? { referer } : {}),
  };
  if (contentType) h["content-type"] = contentType;
  return h;
}

/** Soft SFCC / Akamai denial detectors. */
export function looksLikeAkamaiDenied(html, status) {
  if (Number(status) === 403) return true;
  const h = String(html || "");
  return /Access Denied/i.test(h) && /edgesuite|Reference&#32;|Reference #/i.test(h);
}

export function parseCsrfGenerateJson(json) {
  const csrf = json?.csrf;
  if (!csrf?.token || !csrf?.tokenName) return null;
  return { tokenName: String(csrf.tokenName), token: String(csrf.token) };
}

/**
 * PDP stock / ATC markers from HTML (research 2026-07-26).
 * Button carries data-pid + data-sitekey; analytics may say online - in_stock.
 */
export function parseDisneyPdp(html) {
  const h = String(html || "");
  const title = h.match(/<title[^>]*>([^<]+)/i)?.[1]?.trim() || null;
  const pids = [...h.matchAll(/data-pid=["'](\d{6,})["']/gi)].map((m) => m[1]);
  const pid = pids.find((p) => p !== "null") || null;
  const addUrl =
    h.match(/class=["']add-to-cart-url["'][^>]*value=["']([^"']+)["']/i)?.[1] ||
    h.match(/value=["']([^"']*Cart-AddProduct[^"']*)["']/i)?.[1] ||
    null;
  const sitekey =
    h.match(/primary-add-to-cart[^>]*data-sitekey=["']([^"']+)["']/i)?.[1] ||
    h.match(/data-sitekey=["'](6L[^"']+)["']/i)?.[1] ||
    DISNEY_RECAPTCHA_ENTERPRISE_SITEKEY;
  const enterpriseVerify =
    h.match(/data-recaptcha-enterprise-url=["']([^"']+)["']/i)?.[1] || null;
  const classicVerify = h.match(/data-recaptcha-url=["']([^"']+)["']/i)?.[1] || null;
  const comingSoon = /add-to-cart-release[^>]*>\s*Coming Soon/i.test(h);
  const soldOutBtn = /class=["'][^"']*add-to-cart[^"']*sold-out/i.test(h);
  const inStockMarker = /online\s*-\s*in_stock/i.test(h);
  const availability =
    h.match(/itemprop=["']availability["'][^>]*href=["']([^"']+)["']/i)?.[1] ||
    h.match(/"availability"\s*:\s*"([^"]+)"/i)?.[1] ||
    null;
  const available = Boolean(pid && addUrl && !soldOutBtn && (inStockMarker || !comingSoon));
  return {
    title,
    pid,
    pids: [...new Set(pids.filter((p) => p && p !== "null"))],
    addToCartUrl: addUrl,
    recaptchaSitekey: sitekey,
    recaptchaEnterpriseUrl: enterpriseVerify,
    recaptchaUrl: classicVerify,
    comingSoon,
    soldOut: soldOutBtn,
    inStockMarker,
    availability,
    available,
    note: available
      ? `in_stock pid=${pid}`
      : comingSoon
        ? `coming_soon pid=${pid || "?"}`
        : soldOutBtn
          ? `sold_out pid=${pid || "?"}`
          : `parsed pid=${pid || "none"}`,
  };
}

/** Minibag empty/lines probe. */
export function parseMiniCartHtml(html) {
  const h = String(html || "");
  const empty = /minibag__empty/i.test(h) || /cart_total_items&quot;:0/.test(h) || /cart_total_items":0/.test(h);
  const qtyMatch = h.match(/cart_total_items(?:&quot;|")\s*:\s*(?:&quot;|")?(\d+)/i);
  const itemCount = qtyMatch ? Number(qtyMatch[1]) : empty ? 0 : null;
  const linePids = [...h.matchAll(/data-pid=["'](\d{6,})["']/gi)].map((m) => m[1]);
  return {
    empty: empty || itemCount === 0,
    itemCount,
    linePids: [...new Set(linePids)],
    note: empty || itemCount === 0 ? "minibag empty" : `minibag items=${itemCount ?? "?"} pids=${linePids.join(",") || "n/a"}`,
  };
}

/** Heuristic Akamai BM script path (Hyper `parseAkamaiPath` preferred in disney-akamai.js). */
export function extractAkamaiScriptPath(html) {
  const srcs = [...String(html || "").matchAll(/<script[^>]+src=["']([^"']+)["']/gi)].map((m) => m[1]);
  const hit = srcs.find(
    (s) =>
      s.startsWith("/") &&
      !/demandware|static\.cloudflare|google|newrelic|cquotient|registerdisney|tealium/i.test(s) &&
      s.split("/").length >= 4,
  );
  return hit || null;
}

export async function disneyFetch(ctx, url, opts = {}) {
  const method = opts.method || "GET";
  const headers = { ...(opts.headers || {}) };
  const res = await request(
    url,
    {
      method,
      headers,
      body: opts.body,
      retry: opts.retry !== false,
    },
    ctx,
  );
  const text = await res.text().catch(() => "");
  let json = null;
  const ct = String(res.headers?.get?.("content-type") || res.headers?.["content-type"] || "");
  if (/json/i.test(ct) || (text.startsWith("{") && text.endsWith("}"))) {
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
  }
  return {
    ok: res.status >= 200 && res.status < 300,
    status: res.status,
    text,
    json,
    headers: res.headers,
    url,
  };
}

export function createDisneySession(ctx, opts = {}) {
  const origin = opts.origin || DISNEY_ORIGIN;
  const locale = opts.locale || DISNEY_LOCALE;
  const urls = disneyUrls({ origin, locale });
  const userAgent = opts.userAgent || ctx.userAgent || DEFAULT_UA;
  const state = {
    origin,
    locale,
    urls,
    userAgent,
    geMid: DISNEY_GE_MID,
    warmed: false,
    abckValid: false,
    lastCsrf: null,
    lastPdp: null,
  };

  return {
    state,
    urls,
    get base() {
      return origin;
    },
    navHeaders(referer) {
      return disneyNavHeaders({ referer, userAgent });
    },
    xhrHeaders(referer, contentType) {
      return disneyXhrHeaders({ referer, userAgent, contentType });
    },
    async get(url, opts = {}) {
      return disneyFetch(ctx, url, {
        method: "GET",
        headers: opts.xhr
          ? this.xhrHeaders(opts.referer || `${origin}/`)
          : this.navHeaders(opts.referer),
        ...opts,
      });
    },
    async post(url, body, opts = {}) {
      const contentType =
        opts.contentType ||
        (typeof body === "string" && body.includes("=")
          ? "application/x-www-form-urlencoded; charset=UTF-8"
          : "application/json");
      return disneyFetch(ctx, url, {
        method: "POST",
        headers: {
          ...this.xhrHeaders(opts.referer || `${origin}/`, contentType),
          origin,
          ...(opts.headers || {}),
        },
        body,
        ...opts,
      });
    },
  };
}

export default {
  DISNEY_ORIGIN,
  DISNEY_GE_MID,
  disneyUrls,
  parseDisneyProductUrl,
  resolveDisneyPid,
  resolveDisneyPdpUrl,
  parseDisneyPdp,
  parseMiniCartHtml,
  createDisneySession,
};
