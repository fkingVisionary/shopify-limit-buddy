// Premium Bandai (p-bandai.com) — shared HTTP session helpers (CSRF, headers, warm, login).
// Regions on the same SPA/API/GE stack: au, us, nz, sg, hk, tw, fr.
// JP is a different site — not supported here. Completely separate from Kmart / Toymate.

import { request, UA } from "../http.js";

export const BANDAI_ORIGIN = "https://p-bandai.com";
/** @deprecated use resolveBandaiArea / bandaiBaseFor — kept as AU default */
export const BANDAI_AREA = "au";
/** @deprecated use bandaiBaseFor(area) */
export const BANDAI_BASE = `${BANDAI_ORIGIN}/${BANDAI_AREA}`;
export const GLOBALE_MID = 1925;

/** Live `/api/customerAreas` keys (lowercase path segment). JP not included. */
export const BANDAI_REGIONS = Object.freeze(["au", "us", "nz", "sg", "hk", "tw", "fr"]);

const sleep = (ms, jitter = 0) =>
  new Promise((r) => setTimeout(r, ms + Math.floor(Math.random() * (jitter + 1))));

const AREA_ACCEPT_LANG = {
  au: "en-AU,en;q=0.9",
  us: "en-US,en;q=0.9",
  nz: "en-NZ,en;q=0.9",
  sg: "en-SG,en;q=0.9",
  hk: "en-HK,en;q=0.9",
  tw: "en-TW,en;q=0.9",
  fr: "fr-FR,fr;q=0.9,en;q=0.8",
};

/**
 * Normalize to lowercase path segment (au, us, …). Unknown → null.
 */
export function normalizeBandaiArea(raw) {
  const a = String(raw || "")
    .trim()
    .toLowerCase()
    .replace(/^\//, "")
    .split(/[/?#]/)[0];
  if (!a) return null;
  if (BANDAI_REGIONS.includes(a)) return a;
  return null;
}

export function bandaiBaseFor(area) {
  const a = normalizeBandaiArea(area) || "au";
  return `${BANDAI_ORIGIN}/${a}`;
}

/**
 * Resolve region from task / URL. Defaults to au.
 * Prefers explicit task.bandaiArea / areaCode, then /{area}/ in pdp/store URL.
 */
export function resolveBandaiArea(task = {}) {
  const explicit =
    normalizeBandaiArea(task.bandaiArea) ||
    normalizeBandaiArea(task.areaCode) ||
    normalizeBandaiArea(task.area) ||
    normalizeBandaiArea(task.shippingAreaCode);
  if (explicit) return explicit;

  const url = String(task.pdpUrl || task.storeUrl || task.input || "");
  const m = url.match(/p-bandai\.com\/([a-z]{2})(?:\/|$)/i);
  if (m) {
    const fromUrl = normalizeBandaiArea(m[1]);
    if (fromUrl) return fromUrl;
  }
  return "au";
}

export function bandaiNavHeaders({ referer, userAgent, area } = {}) {
  const a = normalizeBandaiArea(area) || "au";
  return {
    "user-agent": userAgent || UA,
    accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
    "accept-language": AREA_ACCEPT_LANG[a] || "en,en;q=0.9",
    "cache-control": "no-cache",
    pragma: "no-cache",
    "upgrade-insecure-requests": "1",
    "sec-ch-ua": `"Google Chrome";v="131", "Chromium";v="131", "Not_A Brand";v="24"`,
    "sec-ch-ua-mobile": "?0",
    "sec-ch-ua-platform": `"macOS"`,
    "sec-fetch-dest": "document",
    "sec-fetch-mode": "navigate",
    "sec-fetch-site": referer ? "same-origin" : "none",
    "sec-fetch-user": "?1",
    ...(referer ? { referer } : {}),
  };
}

export function bandaiApiHeaders({ csrfToken, referer, userAgent, contentType, area } = {}) {
  const a = normalizeBandaiArea(area) || "au";
  const base = bandaiBaseFor(a);
  const h = {
    "user-agent": userAgent || UA,
    accept: "application/json, text/plain, */*",
    "accept-language": a === "fr" ? "fr" : "en",
    "x-g1-area-code": a,
    "x-requested-with": "XMLHttpRequest",
    origin: BANDAI_ORIGIN,
    referer: referer || `${base}/`,
    "sec-ch-ua": `"Google Chrome";v="131", "Chromium";v="131", "Not_A Brand";v="24"`,
    "sec-ch-ua-mobile": "?0",
    "sec-ch-ua-platform": `"macOS"`,
    "sec-fetch-dest": "empty",
    "sec-fetch-mode": "cors",
    "sec-fetch-site": "same-origin",
  };
  if (csrfToken) h["x-csrf-token"] = csrfToken;
  if (contentType) h["content-type"] = contentType;
  return h;
}

export async function readText(res) {
  try {
    return await res.text();
  } catch {
    return "";
  }
}

export async function readJson(res) {
  try {
    return await res.json();
  } catch {
    return null;
  }
}

export function extractCsrfFromHtml(html) {
  const h = String(html || "");
  const m =
    h.match(/csrfToken["']?\s*[:=]\s*["']([^"']+)["']/i) ||
    h.match(/USER_DATA\s*=\s*\{[\s\S]*?csrfToken["']?\s*:\s*["']([^"']+)["']/i) ||
    h.match(/name=["']csrf-token["']\s+content=["']([^"']+)["']/i);
  return m?.[1] || null;
}

export function extractPreloadSuffix(html) {
  const h = String(html || "");
  const patterns = [
    /globaleMerchantCartTokenSuffix["']?\s*[:=]\s*["']([^"']+)["']/i,
    /PRELOAD_DATA\s*=\s*\{[\s\S]*?globaleMerchantCartTokenSuffix["']?\s*:\s*["']([^"']+)["']/i,
    /"globaleMerchantCartTokenSuffix"\s*:\s*"([^"]+)"/i,
    /merchantCartTokenSuffix["']?\s*[:=]\s*["']([^"']+)["']/i,
    /_Checkout_([A-Za-z0-9_-]{6,})/i,
  ];
  for (const re of patterns) {
    const m = h.match(re);
    if (m?.[1]) return m[1];
  }
  return null;
}

/**
 * Create a Bandai session bound to ctx (dispatcher + jar) for one region.
 */
export function createBandaiSession(ctx, { userAgent, area } = {}) {
  const region = normalizeBandaiArea(area) || "au";
  const base = bandaiBaseFor(region);
  const state = {
    area: region,
    base,
    csrfToken: null,
    userAgent: userAgent || UA,
    restrictedType: null,
    lastLoginStatus: null,
  };

  async function warm() {
    const home = await request(`${base}/`, {
      headers: bandaiNavHeaders({ userAgent: state.userAgent, area: region }),
    }, ctx);
    const html = await readText(home);
    ctx.jar?.ingest?.(home.headers);
    const fromHtml = extractCsrfFromHtml(html);

    const member = await request(`${BANDAI_ORIGIN}/api/context/member`, {
      headers: bandaiApiHeaders({
        csrfToken: fromHtml,
        referer: `${base}/`,
        userAgent: state.userAgent,
        area: region,
      }),
    }, ctx);
    ctx.jar?.ingest?.(member.headers);
    const json = await readJson(member);
    const csrf =
      json?.csrfToken ||
      member.headers?.get?.("x-csrf-token") ||
      fromHtml ||
      null;
    state.csrfToken = csrf;
    return {
      ok: member.status === 200 && Boolean(csrf),
      status: member.status,
      csrfToken: csrf,
      homeStatus: home.status,
      area: region,
      note: csrf
        ? `csrf ok area=${region} (${String(csrf).slice(0, 8)}…)`
        : `no csrf area=${region} (member ${member.status})`,
      loadTime: json?.loadTime ?? null,
    };
  }

  async function api(method, path, { body, referer, form, extraHeaders } = {}) {
    if (!state.csrfToken) {
      const w = await warm();
      if (!w.ok) throw Object.assign(new Error(w.note || "bandai_warm_failed"), { code: "warm_failed" });
    }
    const url = path.startsWith("http")
      ? path
      : `${BANDAI_ORIGIN}${path.startsWith("/") ? "" : "/"}${path}`;
    const isForm = form === true || (body != null && typeof body === "string" && !extraHeaders?.["content-type"]);
    const headers = {
      ...bandaiApiHeaders({
        csrfToken: state.csrfToken,
        referer: referer || `${base}/`,
        userAgent: state.userAgent,
        area: region,
        contentType: isForm
          ? "application/x-www-form-urlencoded"
          : body != null
            ? "application/json"
            : undefined,
      }),
      ...(extraHeaders || {}),
    };
    const res = await request(url, {
      method: method || "GET",
      headers,
      body:
        body == null
          ? undefined
          : typeof body === "string"
            ? body
            : JSON.stringify(body),
    }, ctx);
    ctx.jar?.ingest?.(res.headers);
    const newCsrf = res.headers?.get?.("x-csrf-token");
    if (newCsrf) state.csrfToken = newCsrf;
    const restricted = res.headers?.get?.("x-restricted-type");
    if (restricted) state.restrictedType = restricted;
    return res;
  }

  async function apiJson(method, path, opts = {}) {
    const res = await api(method, path, opts);
    const json = await readJson(res);
    return { res, json, status: res.status };
  }

  async function loginPassword(email, password, { extraHeaders } = {}) {
    const body = new URLSearchParams({
      grantType: "password",
      memberId: String(email || "").trim(),
      password: String(password || ""),
      saveLoginId: "false",
      autoLogin: "false",
    }).toString();

    const res = await request(`${BANDAI_ORIGIN}/login`, {
      method: "POST",
      headers: {
        ...bandaiApiHeaders({
          csrfToken: state.csrfToken,
          referer: `${base}/login`,
          userAgent: state.userAgent,
          area: region,
          contentType: "application/x-www-form-urlencoded;charset=utf-8",
        }),
        ...(extraHeaders || {}),
      },
      body,
    }, ctx);
    ctx.jar?.ingest?.(res.headers);
    const newCsrf = res.headers?.get?.("x-csrf-token");
    if (newCsrf) state.csrfToken = newCsrf;
    const restricted = res.headers?.get?.("x-restricted-type") || null;
    state.restrictedType = restricted;
    state.lastLoginStatus = res.status;
    const text = await readText(res);
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
    const blocking =
      restricted &&
      !/^NoRestriction$/i.test(restricted) &&
      restricted !== "null" &&
      restricted !== "";
    return {
      ok: res.status >= 200 && res.status < 300 && !blocking,
      status: res.status,
      restrictedType: restricted,
      blocking: Boolean(blocking),
      json,
      note: blocking
        ? `restricted:${restricted}`
        : res.status >= 200 && res.status < 300
          ? `login ok area=${region}`
          : `login ${res.status}`,
    };
  }

  return {
    state,
    area: region,
    base,
    warm,
    api,
    apiJson,
    loginPassword,
    sleep,
  };
}

export function profileFromTask(task) {
  const area = resolveBandaiArea(task);
  const p = task?.profile || {};
  const defaults = {
    au: { city: "Sydney", province: "NSW", zip: "2000", country: "AU", address1: "1 George Street" },
    us: { city: "Los Angeles", province: "CA", zip: "90012", country: "US", address1: "100 S Main St" },
    nz: { city: "Auckland", province: "AUK", zip: "1010", country: "NZ", address1: "1 Queen Street" },
    sg: { city: "Singapore", province: "", zip: "018956", country: "SG", address1: "1 Raffles Place" },
    hk: { city: "Hong Kong", province: "", zip: "", country: "HK", address1: "1 Queen's Road Central" },
    tw: { city: "Taipei", province: "", zip: "100", country: "TW", address1: "1 Zhongxiao E Rd" },
    fr: { city: "Paris", province: "", zip: "75001", country: "FR", address1: "1 Rue de Rivoli" },
  }[area] || { city: "Sydney", province: "NSW", zip: "2000", country: "AU", address1: "1 George Street" };

  return {
    email: p.email || task?.email || null,
    first_name: p.first_name || p.firstName || "Alex",
    last_name: p.last_name || p.lastName || "Buyer",
    address1: p.address1 || defaults.address1,
    city: p.city || defaults.city,
    province: p.province || p.state || defaults.province,
    zip: p.zip || p.postcode || defaults.zip,
    phone: p.phone || null,
    country: p.country || defaults.country,
    area,
  };
}

export function parseAreaItemNo(task) {
  const url = String(task?.pdpUrl || task?.storeUrl || "");
  if (task?.areaItemNo) return String(task.areaItemNo);
  if (task?.sku) return String(task.sku);
  const m =
    url.match(/\/item\/([A-Za-z0-9_-]+)/i) ||
    url.match(/\/products?\/([A-Za-z0-9_-]+)/i) ||
    url.match(/\b(N\d{7,}[A-Z0-9]*)\b/i) ||
    url.match(/\b(NAI[A-Z0-9]+)\b/i) ||
    url.match(/\b(A\d{7,}[A-Z0-9]*)\b/i);
  return m?.[1] || String(task?.productCode || "").trim() || null;
}

export default {
  createBandaiSession,
  resolveBandaiArea,
  normalizeBandaiArea,
  bandaiBaseFor,
  BANDAI_REGIONS,
  BANDAI_BASE,
  BANDAI_ORIGIN,
  GLOBALE_MID,
};
