// Pokémon Centre (TPCI) — locale / URL / header helpers.
// Canonical AU: https://www.pokemoncenter.com/en-au
// JP pokemoncenter-online.com is OUT OF SCOPE (SFCC + F5).

import { request, UA as DEFAULT_UA } from "../http.js";

export const PC_ORIGIN = "https://www.pokemoncenter.com";

/** Locales on the same TPCI host. AU/NZ → Global-e; US/UK may be domestic Cortex. */
export const PC_LOCALES = ["en-au", "en-nz", "en-ca", "en-gb", "en-us"];

export function normalizePcLocale(raw) {
  if (raw == null || raw === "") return null;
  let s = String(raw).trim().toLowerCase().replace(/_/g, "-");
  if (s === "au" || s === "enau") s = "en-au";
  if (s === "nz" || s === "ennz") s = "en-nz";
  if (s === "ca" || s === "enca") s = "en-ca";
  if (s === "gb" || s === "uk" || s === "engb") s = "en-gb";
  if (s === "us" || s === "en" || s === "enus") s = "en-us";
  if (PC_LOCALES.includes(s)) return s;
  return null;
}

export function pcBaseFor(locale) {
  const loc = normalizePcLocale(locale) || "en-au";
  // US storefront historically lives at `/` — keep `/en-us` path for nav consistency.
  return `${PC_ORIGIN}/${loc}`;
}

/**
 * Prefer task.pcLocale / locale, then /en-xx/ in URL, else en-au.
 */
export function resolvePcLocale(task = {}) {
  const explicit =
    normalizePcLocale(task.pcLocale) ||
    normalizePcLocale(task.locale) ||
    normalizePcLocale(task.region);
  if (explicit) return explicit;
  const url = String(task.pdpUrl || task.storeUrl || task.input || "");
  const m = url.match(/pokemoncenter\.com\/(en-[a-z]{2})(?:\/|$)/i);
  if (m) return normalizePcLocale(m[1]) || "en-au";
  return "en-au";
}

/** AU/NZ hand off to Global-e (`/intl-checkout`). */
export function localeUsesGlobalE(locale) {
  const loc = normalizePcLocale(locale) || "en-au";
  return loc === "en-au" || loc === "en-nz";
}

/**
 * Parse PDP URL → { locale, sku, slug, productUrl }.
 * Pattern: /{locale}/product/{sku}/{seo-slug}
 */
export function parseProductUrl(raw) {
  const s = String(raw || "").trim();
  if (!s) return null;
  try {
    const u = new URL(s.startsWith("http") ? s : `${PC_ORIGIN}${s.startsWith("/") ? "" : "/"}${s}`);
    if (!/pokemoncenter\.com$/i.test(u.hostname.replace(/^www\./, "")) && u.hostname !== "www.pokemoncenter.com") {
      // allow bare www
      if (!/pokemoncenter\.com$/i.test(u.hostname)) return null;
    }
    const parts = u.pathname.split("/").filter(Boolean);
    // [en-au, product, sku, slug...] or [product, sku, slug] on US
    let locale = "en-us";
    let idx = 0;
    if (parts[0] && /^en-[a-z]{2}$/i.test(parts[0])) {
      locale = normalizePcLocale(parts[0]) || "en-au";
      idx = 1;
    }
    if (parts[idx] !== "product") return { locale, sku: null, slug: null, productUrl: u.toString() };
    const sku = parts[idx + 1] || null;
    const slug = parts.slice(idx + 2).join("/") || null;
    return { locale, sku, slug, productUrl: u.toString() };
  } catch {
    return null;
  }
}

/** Extract SKU from task fields / URL. */
export function resolveSku(task = {}) {
  const fromFields = String(task.sku || task.variantId || task.productCode || "").trim();
  if (fromFields && !/^https?:/i.test(fromFields) && fromFields !== "1") return fromFields;
  const parsed = parseProductUrl(task.pdpUrl || task.storeUrl || task.input);
  return parsed?.sku || null;
}

export function pcNavHeaders({ referer, userAgent, locale } = {}) {
  const loc = normalizePcLocale(locale) || "en-au";
  const lang =
    loc === "en-au"
      ? "en-AU,en;q=0.9"
      : loc === "en-gb"
        ? "en-GB,en;q=0.9"
        : loc === "en-ca"
          ? "en-CA,en;q=0.9"
          : loc === "en-nz"
            ? "en-NZ,en;q=0.9"
            : "en-US,en;q=0.9";
  return {
    accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
    "accept-language": lang,
    "cache-control": "no-cache",
    pragma: "no-cache",
    "upgrade-insecure-requests": "1",
    "user-agent": userAgent || DEFAULT_UA,
    ...(referer ? { referer } : {}),
  };
}

export function pcApiHeaders({ referer, userAgent, locale, contentType } = {}) {
  const base = pcNavHeaders({ referer, userAgent, locale });
  return {
    ...base,
    accept: "application/json, text/plain, */*",
    "x-requested-with": "XMLHttpRequest",
    origin: PC_ORIGIN,
    ...(contentType ? { "content-type": contentType } : {}),
  };
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

export function createPcSession(ctx, { locale, userAgent } = {}) {
  const loc = normalizePcLocale(locale) || "en-au";
  const base = pcBaseFor(loc);
  const nav = pcNavHeaders({ locale: loc });
  const state = {
    locale: loc,
    base,
    origin: PC_ORIGIN,
    userAgent: userAgent || DEFAULT_UA,
    acceptLanguage: nav["accept-language"],
    reeseCleared: false,
    datadomeCleared: false,
    edgeNote: null,
  };

  async function get(url, { headers, api } = {}) {
    const h = api
      ? pcApiHeaders({
          referer: headers?.referer || `${base}/`,
          userAgent: state.userAgent,
          locale: loc,
          contentType: headers?.["content-type"],
        })
      : pcNavHeaders({
          referer: headers?.referer,
          userAgent: state.userAgent,
          locale: loc,
        });
    const res = await request(url, { method: "GET", headers: { ...h, ...(headers || {}) } }, ctx);
    ctx.jar?.ingest?.(res.headers);
    return res;
  }

  async function post(url, { body, headers, api, contentType } = {}) {
    const h = api
      ? pcApiHeaders({
          referer: headers?.referer || `${base}/`,
          userAgent: state.userAgent,
          locale: loc,
          contentType: contentType || "application/json",
        })
      : pcNavHeaders({
          referer: headers?.referer,
          userAgent: state.userAgent,
          locale: loc,
        });
    const res = await request(
      url,
      {
        method: "POST",
        headers: { ...h, ...(headers || {}) },
        body: body == null ? undefined : typeof body === "string" ? body : JSON.stringify(body),
      },
      ctx,
    );
    ctx.jar?.ingest?.(res.headers);
    return res;
  }

  return {
    state,
    get,
    post,
    readText,
    readJson,
  };
}

export default {
  PC_ORIGIN,
  PC_LOCALES,
  normalizePcLocale,
  pcBaseFor,
  resolvePcLocale,
  localeUsesGlobalE,
  parseProductUrl,
  resolveSku,
  createPcSession,
};
