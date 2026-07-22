// Elastic Path Cortex helpers for Pokémon Centre.
// Exact zoom URIs / cart bodies need AU ISP HAR (P0). Paths are from robots.txt
// + Cortex norms — callers may override via task.cortex*.

import { PC_ORIGIN } from "./pokemoncentre-session.js";

/** Default Cortex entrypoints (robots Disallow list). */
export const CORTEX_PATHS = {
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

/**
 * Build a guest cart create URL. Override with task.cortexCartCreateUrl when HAR lands.
 */
export function cortexCartCreateUrl(task = {}) {
  if (task.cortexCartCreateUrl) return String(task.cortexCartCreateUrl);
  // Common EP pattern — may 404 until HAR confirms zoom.
  return `${PC_ORIGIN}/cortex/carts/default?followlocation`;
}

export function cortexItemLookupUrl(sku, task = {}) {
  if (task.cortexItemUrl) {
    return String(task.cortexItemUrl).replace(/\{sku\}/gi, encodeURIComponent(sku));
  }
  return `${PC_ORIGIN}/cortex/items/${encodeURIComponent(sku)}`;
}

export function cortexAvailabilityUrl(sku, task = {}) {
  if (task.cortexAvailabilityUrl) {
    return String(task.cortexAvailabilityUrl).replace(/\{sku\}/gi, encodeURIComponent(sku));
  }
  return `${PC_ORIGIN}/availabilities/${encodeURIComponent(sku)}`;
}

export function cortexAddToCartBody(sku, qty = 1, task = {}) {
  if (task.cortexAtcBody && typeof task.cortexAtcBody === "object") {
    return task.cortexAtcBody;
  }
  // Placeholder shape — replace from HAR.
  return {
    code: String(sku),
    quantity: Math.max(1, Number(qty) || 1),
  };
}

/**
 * Probe Cortex surfaces after edge warm. Returns structured notes for HAR day.
 */
export async function probeCortex(session, { sku, task } = {}) {
  const results = [];
  const probes = [
    { name: "cortex_root", url: `${PC_ORIGIN}${CORTEX_PATHS.cortex}` },
    { name: "carts", url: `${PC_ORIGIN}${CORTEX_PATHS.carts}` },
    sku
      ? { name: "item", url: cortexItemLookupUrl(sku, task) }
      : null,
    sku
      ? { name: "availability", url: cortexAvailabilityUrl(sku, task) }
      : null,
  ].filter(Boolean);

  for (const p of probes) {
    try {
      const res = await session.get(p.url, {
        api: true,
        headers: { referer: `${session.state.base}/` },
      });
      const text = await session.readText(res);
      let json = null;
      try {
        json = JSON.parse(text);
      } catch {
        /* html / empty */
      }
      results.push({
        name: p.name,
        status: res.status,
        ok: res.status >= 200 && res.status < 400 && Boolean(json || text.length > 2),
        bytes: text.length,
        contentType: res.headers?.get?.("content-type") || null,
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
 * Attempt guest ATC. Dry-run friendly — surfaces status for HAR iteration.
 */
export async function attemptGuestAtc(session, { sku, qty, task } = {}) {
  if (!sku) return { ok: false, note: "sku required for Cortex ATC" };
  const createUrl = cortexCartCreateUrl(task);
  const createRes = await session.post(createUrl, {
    api: true,
    body: {},
    headers: { referer: `${session.state.base}/` },
  });
  const createText = await session.readText(createRes);
  let createJson = null;
  try {
    createJson = JSON.parse(createText);
  } catch {
    /* ignore */
  }

  // Prefer Location / self URI from Cortex followlocation.
  const location =
    createRes.headers?.get?.("location") ||
    createJson?.self?.uri ||
    createJson?.cart?.self?.uri ||
    null;

  const lineUrl =
    task.cortexLineItemUrl ||
    (location
      ? location.startsWith("http")
        ? `${location}/lineitems`
        : `${PC_ORIGIN}${location}/lineitems`
      : `${PC_ORIGIN}/carts/default/lineitems`);

  const body = cortexAddToCartBody(sku, qty, task);
  const atcRes = await session.post(lineUrl, {
    api: true,
    body,
    headers: { referer: `${session.state.base}/product/${sku}` },
  });
  const atcText = await session.readText(atcRes);
  let atcJson = null;
  try {
    atcJson = JSON.parse(atcText);
  } catch {
    /* ignore */
  }

  const ok = atcRes.status >= 200 && atcRes.status < 300 && Boolean(atcJson);
  return {
    ok,
    status: atcRes.status,
    createStatus: createRes.status,
    location,
    lineUrl,
    json: atcJson,
    note: ok
      ? `ATC ${atcRes.status}`
      : `ATC ${atcRes.status} create=${createRes.status} — set task.cortex* from HAR`,
    needsHar: !ok,
  };
}

/**
 * Soft stock signal from PDP HTML once edge is clear.
 */
export function parsePdpAvailability(html) {
  const h = String(html || "");
  if (!h || h.length < 40) return { available: null, title: null, note: "html too short" };
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
