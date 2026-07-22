// Elastic Path Cortex helpers for Pokémon Centre AU (TPCI).
// Wire-proven 2026-07-22 (HTTP + Hyper Reese/DD view=redirect):
//   API base:  https://www.pokemoncenter.com/tpci-ecommweb-api
//   Auth:      POST /auth/get-public-token  (role=CATALOG_BROWSER → PUBLIC token)
//   ATC:       POST /cart/add-product/{epItemId}
//              body { clobber, quantity, dynamicAdd }  — omit empty configuration
//   Scope:     pokemon-au
//   Headers:   X-Store-Locale, X-Store-Scope, Authorization: bearer <token>
//   Cookie:    auth=<json> (HttpOnly from get-public-token Set-Cookie)
//
// Do not call raw /cortex/... through API Gateway with bearer — those routes
// surface AWS IAM parse errors. BFF paths under /tpci-ecommweb-api are correct.

import { PC_ORIGIN } from "./pokemoncentre-session.js";

export const PC_API_BASE = `${PC_ORIGIN}/tpci-ecommweb-api`;
export const PC_CORTEX_SCOPE = "pokemon-au";

/** Default Cortex / storefront entrypoints (robots Disallow + Next wire). */
export const CORTEX_PATHS = {
  api: "/tpci-ecommweb-api",
  authPublic: "/tpci-ecommweb-api/auth/get-public-token",
  authLogin: "/tpci-ecommweb-api/auth/login",
  authGlobaleM2m: "/tpci-ecommweb-api/auth/get-globale-m2m-token",
  addProduct: "/tpci-ecommweb-api/cart/add-product",
  cortex: "/cortex",
  carts: "/carts",
  extcarts: "/extcarts",
  items: "/items",
  itemdefinitions: "/itemdefinitions",
  availabilities: "/availabilities",
  minicarts: "/minicarts",
  orders: "/orders",
  checkout: "/checkout",
  intlCheckout: "/intl-checkout",
};

/** Extract EP item id from product.addToCartForm URI. */
export function epItemIdFromAddForm(formUri) {
  const m = String(formUri || "").match(/\/(?:ext)?carts\/items\/[^/]+\/([^/]+)\/form/i);
  return m?.[1] || null;
}

/** Parse __NEXT_DATA__ product + cart slice from clear PDP/home HTML. */
export function parseNextData(html) {
  const raw = (String(html || "").match(
    /<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/i,
  ) || [])[1];
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export function productFromNextData(nd) {
  const p = nd?.props?.initialState?.product;
  if (!p || typeof p !== "object") return null;
  return {
    code: p.code || null,
    name: p.name || null,
    availability: p.availability || null,
    addToCartForm: p.addToCartForm || null,
    addToDynamicCartForm: p.addToDynamicCartForm || null,
    epEncodedId: p.epEncodedId || epItemIdFromAddForm(p.addToCartForm),
    epItemId: epItemIdFromAddForm(p.addToCartForm) || p.epEncodedId || null,
    listPrice: p.listPrice || null,
    purchasePrice: p.purchasePrice || null,
    quantityLimit: p.quantityLimit ?? null,
    requireReCaptcha: Boolean(p.requireReCaptcha),
  };
}

export function cartFromNextData(nd) {
  const c = nd?.props?.initialState?.cart;
  if (!c || typeof c !== "object") return null;
  return {
    cartGuid: c.cartGuid || null,
    cartId: c.cartId || null,
    quantity: c.quantity ?? null,
    total: c.total || null,
    subtotal: c.subtotal || null,
    scope: nd?.props?.initialState?.cortex?.scope || PC_CORTEX_SCOPE,
    apiHost: nd?.props?.host || null,
  };
}

export function cortexAuthBody({ scope = PC_CORTEX_SCOPE, userName = "", password = "" } = {}) {
  const role = userName && password ? "REGISTERED" : "CATALOG_BROWSER";
  return new URLSearchParams({
    username: userName,
    password,
    grant_type: "password",
    role,
    scope,
  }).toString();
}

/**
 * Browser device fingerprint headers from Next `_app` (`M=()` device map).
 * Used on sensitive BFF calls alongside locale/scope.
 */
export function cortexDeviceHeaders({
  userAgent,
  language = "en-AU",
  screenHeight = 1080,
  screenWidth = 1920,
  colorDepth = 24,
  timeZoneOffset,
} = {}) {
  const tz =
    timeZoneOffset != null
      ? Number(timeZoneOffset)
      : -Math.round(new Date().getTimezoneOffset()); // AU storefront often -600
  return {
    accept: "*/*",
    "browser-language": language,
    "browser-java-enabled": "false",
    "browser-javascript-enabled": "true",
    "color-depth": String(colorDepth),
    "device-channel": "Browser",
    "ip-address": "",
    "screen-height": String(screenHeight),
    "screen-width": String(screenWidth),
    "time-zone": String(tz),
    ...(userAgent ? { "user-agent": userAgent } : {}),
  };
}

export function cortexApiHeaders({
  accessToken,
  locale = "en-au",
  scope = PC_CORTEX_SCOPE,
  referer,
  origin = PC_ORIGIN,
  // Device map headers are for GE/3DS fingerprint posts — not default on every BFF call.
  includeDevice = false,
  acceptVersion = "1",
  userAgent,
} = {}) {
  const h = {
    accept: "application/json",
    "content-type": "application/json",
    "X-Store-Locale": String(locale).toLowerCase(),
    "X-Store-Scope": scope,
    origin,
  };
  // Next BFF `apiVersion:"1"` — sent when storefront retries version mismatch.
  if (acceptVersion) h["Accept-Version"] = String(acceptVersion);
  if (includeDevice) {
    Object.assign(
      h,
      cortexDeviceHeaders({
        userAgent,
        language: String(locale).toLowerCase() === "en-au" ? "en-AU" : "en",
        // AU AEST offset minutes as browser getTimezoneOffset() would report from Sydney ≈ -600
        timeZoneOffset: -600,
      }),
    );
    // Keep JSON accept for API responses (device map uses accept:"/" for GE only).
    h.accept = "application/json";
  }
  if (referer) h.referer = referer;
  if (accessToken) h.Authorization = `bearer ${accessToken}`;
  return h;
}

/** Pull cartGuid from BFF `/cart/data` JSON (field `cart-guid`). */
export function cartGuidFromCartData(json) {
  if (!json || typeof json !== "object") return null;
  return (
    json.cartGuid ||
    json["cart-guid"] ||
    json._raw?.["cart-guid"] ||
    json.cart?.cartGuid ||
    json.cart?.["cart-guid"] ||
    null
  );
}

/** Cortex cart id from ATC line-item `self.uri` (not GE cartGuid). */
export function cortexCartIdFromAtc(json) {
  const uri = json?.self?.uri || json?.links?.find?.((l) => l.rel === "cart")?.uri || "";
  const m = String(uri).match(/\/carts\/[^/]+\/([^/]+)/i);
  return m?.[1] || null;
}

/**
 * Mint public Cortex token. Sets jar `auth` JSON cookie when Set-Cookie present.
 * @see browser: POST /auth/get-public-token
 */
function looksLikeIncapsulaApiBlock(text, status) {
  if (status !== 403 && status !== 401) return false;
  return /"incidentId"\s*:/i.test(String(text || "")) || /Pardon Our Interruption/i.test(String(text || ""));
}

export async function getPublicToken(session, ctx, { locale = "en-au", scope = PC_CORTEX_SCOPE } = {}) {
  const body = cortexAuthBody({ scope });
  const headers = {
    "content-type": "application/x-www-form-urlencoded;charset=utf-8",
    accept: "application/json",
    "X-Store-Locale": String(locale).toLowerCase(),
    "X-Store-Scope": scope,
    origin: PC_ORIGIN,
    referer: `${session.state.base}/`,
  };
  let res = await session.post(`${PC_API_BASE}/auth/get-public-token`, {
    body,
    api: true,
    contentType: "application/x-www-form-urlencoded;charset=utf-8",
    headers,
  });
  let text = await session.readText(res);
  // Imperva often blocks BFF until a fresh Reese after DD — remint once.
  if (looksLikeIncapsulaApiBlock(text, res.status)) {
    try {
      const { clearIncapsulaReese } = await import("./pokemoncentre-edge.js");
      await clearIncapsulaReese(session, ctx, {
        pageUrl: `${session.state.base}/`,
        html: "",
      });
      res = await session.post(`${PC_API_BASE}/auth/get-public-token`, {
        body,
        api: true,
        contentType: "application/x-www-form-urlencoded;charset=utf-8",
        headers,
      });
      text = await session.readText(res);
    } catch {
      /* keep first response */
    }
  }
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* ignore */
  }
  if (json?.access_token) {
    ctx.jar?.set?.("auth", JSON.stringify(json));
    session.state.cortexAuth = {
      accessToken: json.access_token,
      role: json.role || null,
      scope: json.scope || scope,
      id: json.id || null,
      expiresIn: json.expires_in || null,
    };
  }
  return {
    ok: res.status === 200 && Boolean(json?.access_token),
    status: res.status,
    auth: json,
    incapBlock: looksLikeIncapsulaApiBlock(text, res.status),
    note: json?.access_token
      ? `cortex token role=${json.role} scope=${json.scope}`
      : `auth ${res.status} ${text.slice(0, 80)}`,
  };
}

export function cortexAddToCartBody(sku, qty = 1, task = {}) {
  if (task.cortexAtcBody && typeof task.cortexAtcBody === "object") {
    return task.cortexAtcBody;
  }
  // Wire-proven shape — do NOT send configuration:{} (triggers DataDome on BFF).
  return {
    clobber: Boolean(task.cortexClobber),
    quantity: Math.max(1, Number(qty) || 1),
    dynamicAdd: Boolean(task.cortexDynamicAdd),
  };
}

/**
 * Resolve EP item id for ATC: task override → PDP Next data → sku fallback none.
 */
export function resolveEpItemId({ product, task, formUri } = {}) {
  return (
    task?.cortexEpItemId ||
    task?.epItemId ||
    product?.epItemId ||
    epItemIdFromAddForm(formUri || product?.addToCartForm) ||
    null
  );
}

/**
 * Guest ATC via BFF. Requires prior getPublicToken (session.state.cortexAuth).
 */
export async function attemptGuestAtc(session, { sku, qty, task, product, pageUrl } = {}) {
  const token = session.state.cortexAuth?.accessToken;
  if (!token) {
    return { ok: false, note: "cortex auth missing — call getPublicToken first", needsAuth: true };
  }
  const epItemId = resolveEpItemId({ product, task });
  if (!epItemId) {
    return {
      ok: false,
      note: "ep item id missing — load clear PDP __NEXT_DATA__ (product.addToCartForm)",
      needsHar: false,
      needsPdp: true,
      sku: sku || product?.code || null,
    };
  }

  const body = cortexAddToCartBody(sku || product?.code, qty, task);
  const url = `${PC_API_BASE}/cart/add-product/${epItemId}`;
  const res = await session.post(url, {
    body,
    headers: cortexApiHeaders({
      accessToken: token,
      locale: session.state.locale || "en-au",
      scope: session.state.cortexAuth?.scope || PC_CORTEX_SCOPE,
      referer: pageUrl || `${session.state.base}/product/${sku || product?.code || ""}`,
    }),
  });
  const text = await session.readText(res);
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* ignore */
  }

  // DataDome JSON challenge on BFF
  if (json?.url && /captcha-delivery\.com/i.test(json.url)) {
    return {
      ok: false,
      status: res.status,
      datadomeChallenge: true,
      captchaUrl: json.url,
      note: "ATC hit DataDome captcha JSON — clear edge/tags; avoid empty configuration body",
      epItemId,
      url,
    };
  }

  const ok = res.status >= 200 && res.status < 300 && Boolean(json?.self || json);
  const cartUri =
    json?.self?.uri?.match(/\/carts\/[^/]+\/[^/]+/)?.[0] ||
    json?.self?.href?.match(/\/carts\/[^/]+\/[^/]+/)?.[0] ||
    null;

  return {
    ok,
    status: res.status,
    epItemId,
    url,
    body,
    json,
    cartUri,
    lineItemUri: json?.self?.uri || null,
    note: ok
      ? `ATC ${res.status} line=${json?.self?.type || "ok"}`
      : `ATC ${res.status} ${text.slice(0, 100).replace(/\s+/g, " ")}`,
    needsHar: false,
  };
}

/**
 * Global-e M2M token after cart has cartGuid (from Next cart state or GE cookie).
 */
export async function getGlobaleM2mToken(session, { cartGuid, scope } = {}) {
  const token = session.state.cortexAuth?.accessToken;
  if (!token) return { ok: false, note: "cortex auth missing" };
  if (!cartGuid) return { ok: false, note: "cartGuid required for GE m2m token" };
  const res = await session.post(`${PC_API_BASE}/auth/get-globale-m2m-token`, {
    body: { cartGuid },
    headers: cortexApiHeaders({
      accessToken: token,
      locale: session.state.locale || "en-au",
      scope: scope || session.state.cortexAuth?.scope || PC_CORTEX_SCOPE,
      referer: `${session.state.base}/`,
    }),
  });
  const text = await session.readText(res);
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* ignore */
  }
  return {
    ok: res.status === 200 && Boolean(json),
    status: res.status,
    json,
    note: res.status === 200 ? "GE m2m token ok" : `GE m2m ${res.status} ${text.slice(0, 80)}`,
  };
}

/**
 * Probe BFF surfaces after edge warm + public token.
 */
export async function probeCortex(session, { sku, task } = {}) {
  const token = session.state.cortexAuth?.accessToken;
  const headers = cortexApiHeaders({
    accessToken: token,
    locale: session.state.locale || "en-au",
    referer: `${session.state.base}/`,
  });
  const results = [];
  const probes = [
    { name: "auth_public", url: `${PC_API_BASE}/auth/get-public-token`, skip: true },
    { name: "search", url: `${PC_API_BASE}/search?q=pokemon&rows=1` },
    sku
      ? {
          name: "product_status",
          url: `${PC_API_BASE}/product/status/${encodeURIComponent(sku)}`,
        }
      : null,
  ].filter(Boolean);

  for (const p of probes) {
    if (p.skip) continue;
    try {
      const res = await session.get(p.url, { headers });
      const text = await session.readText(res);
      let json = null;
      try {
        json = JSON.parse(text);
      } catch {
        /* ignore */
      }
      results.push({
        name: p.name,
        status: res.status,
        ok: res.status >= 200 && res.status < 500,
        bytes: text.length,
        isJson: Boolean(json),
        note: json
          ? `json keys=${Object.keys(json).slice(0, 8).join(",")}`
          : `body=${text.slice(0, 60).replace(/\s+/g, " ")}`,
      });
    } catch (e) {
      results.push({ name: p.name, ok: false, note: e?.message || String(e) });
    }
  }
  return results;
}

/**
 * Soft stock signal from PDP HTML / Next product once edge is clear.
 */
export function parsePdpAvailability(html) {
  const h = String(html || "");
  if (!h || h.length < 40) return { available: null, title: null, note: "html too short" };
  const nd = parseNextData(h);
  const product = productFromNextData(nd);
  if (product) {
    const avail = String(product.availability || "").toUpperCase();
    return {
      available: avail === "AVAILABLE" || avail === "AVAILABLE_FOR_PRE_ORDER" ? true : avail === "NOT_AVAILABLE" || avail === "SOLD_OUT" ? false : null,
      title: product.name,
      code: product.code,
      epItemId: product.epItemId,
      addToCartForm: product.addToCartForm,
      note: product.availability || "next_product",
      product,
      cart: cartFromNextData(nd),
    };
  }
  const title =
    (h.match(/<h1[^>]*>([^<]+)<\/h1>/i) || [])[1]?.trim() ||
    (h.match(/property=["']og:title["']\s+content=["']([^"']+)/i) || [])[1]?.trim() ||
    null;
  const soldOut = /sold\s*out|out\s*of\s*stock|unavailable|coming\s*soon/i.test(h);
  const addBtn = /add\s*to\s*(bag|cart)|data-testid=["']add-to-cart/i.test(h);
  return {
    available: soldOut ? false : addBtn ? true : null,
    title,
    note: soldOut ? "sold_out_signal" : addBtn ? "atc_signal" : "unknown",
  };
}

// Legacy helpers kept for task overrides / HAR experiments
export function cortexCartCreateUrl(task = {}) {
  if (task.cortexCartCreateUrl) return String(task.cortexCartCreateUrl);
  return `${PC_API_BASE}/cart/add-product/{epItemId}`;
}

export function cortexItemLookupUrl(sku, task = {}) {
  if (task.cortexItemUrl) {
    return String(task.cortexItemUrl).replace(/\{sku\}/gi, encodeURIComponent(sku));
  }
  return `${PC_API_BASE}/product/status/${encodeURIComponent(sku)}`;
}

export function cortexAvailabilityUrl(sku, task = {}) {
  if (task.cortexAvailabilityUrl) {
    return String(task.cortexAvailabilityUrl).replace(/\{sku\}/gi, encodeURIComponent(sku));
  }
  return `${PC_ORIGIN}/en-au/product/${encodeURIComponent(sku)}`;
}
