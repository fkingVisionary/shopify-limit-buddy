// Premium Bandai AU — shared HTTP session helpers (CSRF, headers, warm, login).
// Completely separate from Kmart / Toymate. No Hyper / Akamai.

import { request, UA } from "../http.js";

export const BANDAI_ORIGIN = "https://p-bandai.com";
export const BANDAI_AREA = "au";
export const BANDAI_BASE = `${BANDAI_ORIGIN}/${BANDAI_AREA}`;
export const GLOBALE_MID = 1925;

const sleep = (ms, jitter = 0) =>
  new Promise((r) => setTimeout(r, ms + Math.floor(Math.random() * (jitter + 1))));

export function bandaiNavHeaders({ referer, userAgent } = {}) {
  return {
    "user-agent": userAgent || UA,
    accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
    "accept-language": "en-AU,en;q=0.9",
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

export function bandaiApiHeaders({ csrfToken, referer, userAgent, contentType } = {}) {
  const h = {
    "user-agent": userAgent || UA,
    accept: "application/json, text/plain, */*",
    "accept-language": "en",
    "x-g1-area-code": BANDAI_AREA,
    "x-requested-with": "XMLHttpRequest",
    origin: BANDAI_ORIGIN,
    referer: referer || `${BANDAI_BASE}/`,
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
  const m =
    h.match(/globaleMerchantCartTokenSuffix["']?\s*[:=]\s*["']([^"']+)["']/i) ||
    h.match(/PRELOAD_DATA\s*=\s*\{[\s\S]*?globaleMerchantCartTokenSuffix["']?\s*:\s*["']([^"']+)["']/i);
  return m?.[1] || null;
}

/**
 * Create a Bandai session bound to ctx (dispatcher + jar).
 */
export function createBandaiSession(ctx, { userAgent } = {}) {
  const state = {
    csrfToken: null,
    userAgent: userAgent || UA,
    restrictedType: null,
    lastLoginStatus: null,
  };

  async function warm() {
    const home = await request(`${BANDAI_BASE}/`, {
      headers: bandaiNavHeaders({ userAgent: state.userAgent }),
    }, ctx);
    const html = await readText(home);
    ctx.jar?.ingest?.(home.headers);
    const fromHtml = extractCsrfFromHtml(html);

    const member = await request(`${BANDAI_ORIGIN}/api/context/member`, {
      headers: bandaiApiHeaders({
        csrfToken: fromHtml,
        referer: `${BANDAI_BASE}/`,
        userAgent: state.userAgent,
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
      note: csrf ? `csrf ok (${String(csrf).slice(0, 8)}…)` : `no csrf (member ${member.status})`,
      loadTime: json?.loadTime ?? null,
    };
  }

  async function api(method, path, { body, referer, form } = {}) {
    if (!state.csrfToken) {
      const w = await warm();
      if (!w.ok) throw Object.assign(new Error(w.note || "bandai_warm_failed"), { code: "warm_failed" });
    }
    const url = path.startsWith("http")
      ? path
      : `${BANDAI_ORIGIN}${path.startsWith("/") ? "" : "/"}${path}`;
    const isForm = form === true || (body != null && typeof body === "string");
    const headers = bandaiApiHeaders({
      csrfToken: state.csrfToken,
      referer: referer || `${BANDAI_BASE}/`,
      userAgent: state.userAgent,
      contentType: isForm
        ? "application/x-www-form-urlencoded"
        : body != null
          ? "application/json"
          : undefined,
    });
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

  /**
   * Password login. memberId = email.
   */
  async function loginPassword(email, password) {
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
          referer: `${BANDAI_BASE}/login`,
          userAgent: state.userAgent,
          contentType: "application/x-www-form-urlencoded",
        }),
        // login also sends x-csrf-token per research
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
          ? "login ok"
          : `login ${res.status}`,
    };
  }

  return {
    state,
    warm,
    api,
    apiJson,
    loginPassword,
    sleep,
  };
}

export function profileFromTask(task) {
  const p = task?.profile || {};
  return {
    email: p.email || task?.email || null,
    first_name: p.first_name || p.firstName || "Alex",
    last_name: p.last_name || p.lastName || "Buyer",
    address1: p.address1 || "1 George Street",
    city: p.city || "Sydney",
    province: p.province || p.state || "NSW",
    zip: p.zip || p.postcode || "2000",
    phone: p.phone || null,
    country: "AU",
  };
}

export function parseAreaItemNo(task) {
  const url = String(task?.pdpUrl || task?.storeUrl || "");
  // Direct SKU / areaItemNo
  if (task?.areaItemNo) return String(task.areaItemNo);
  if (task?.sku) return String(task.sku);
  // Product code in path: /au/item/N2903432003 or /item/...
  const m =
    url.match(/\/item\/([A-Za-z0-9_-]+)/i) ||
    url.match(/\/products?\/([A-Za-z0-9_-]+)/i) ||
    url.match(/\b(N\d{7,}[A-Z0-9]*)\b/i) ||
    url.match(/\b(NAI[A-Z0-9]+)\b/i);
  return m?.[1] || String(task?.productCode || "").trim() || null;
}

export default {
  createBandaiSession,
  BANDAI_BASE,
  BANDAI_ORIGIN,
  GLOBALE_MID,
};
