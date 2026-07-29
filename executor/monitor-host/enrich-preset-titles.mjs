/**
 * Fill Action Store preset titles from the live store (Bandai first).
 * Uses monitor undici helpers already baked into the Railway image.
 */

import { createJar, makeDispatcher, request, UA, parseProxy } from "../monitor/http-undici.js";
import { serializePresetCatalogRows } from "./preset-catalog.mjs";

/**
 * @param {object[]} rows
 * @param {{
 *   area?: string,
 *   getProduct?: (sku: string) => { title?: string } | null,
 *   proxyRaw?: string,
 *   enrich?: boolean,
 *   concurrency?: number,
 *   timeoutMs?: number,
 *   fetchTitle?: (sku: string, area: string, proxy: string|null) => Promise<string|null>,
 * }} [opts]
 */
export async function enrichPresetTitles(rows, opts = {}) {
  const list = Array.isArray(rows) ? rows.map((r) => ({ ...r })) : [];
  if (!list.length || opts.enrich === false) {
    return {
      rows: list,
      raw: serializePresetCatalogRows(list),
      resolved: 0,
      failed: 0,
      skipped: list.length,
    };
  }

  const areaDefault = String(opts.area || "au").toLowerCase().slice(0, 2);
  const proxy = firstProxyUrl(opts.proxyRaw);
  const concurrency = Math.max(1, Math.min(5, Number(opts.concurrency) || 3));
  const timeoutMs = Math.max(3_000, Number(opts.timeoutMs) || 12_000);
  const fetchTitle =
    typeof opts.fetchTitle === "function"
      ? opts.fetchTitle
      : (sku, area, prox) => fetchBandaiProductTitle(sku, { area, proxy: prox, timeoutMs });

  let resolved = 0;
  let failed = 0;
  let skipped = 0;
  let cursor = 0;

  async function worker() {
    while (cursor < list.length) {
      const idx = cursor;
      cursor += 1;
      const row = list[idx];
      if (!row?.needsTitle || row.store !== "bandai" || !row.sku) {
        skipped += 1;
        continue;
      }

      const area = String(row.area || areaDefault).toLowerCase().slice(0, 2);
      let title = "";

      try {
        const cached = opts.getProduct?.(row.sku);
        if (cached?.title && String(cached.title).trim()) {
          title = String(cached.title).trim();
        }
      } catch {
        /* ignore */
      }

      if (!title) {
        try {
          title = (await fetchTitle(row.sku, area, proxy)) || "";
        } catch {
          title = "";
        }
      }

      if (title) {
        row.title = title.slice(0, 120);
        row.taskGroup = title.slice(0, 80);
        row.needsTitle = false;
        row.titleSource = "site";
        resolved += 1;
      } else {
        failed += 1;
      }
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => worker()));

  return {
    rows: list,
    raw: serializePresetCatalogRows(list),
    resolved,
    failed,
    skipped,
  };
}

function firstProxyUrl(raw) {
  for (const line of String(raw || "").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const url = parseProxy(trimmed.split(",")[0].trim());
    if (url) return url;
  }
  return null;
}

/** Bandai returns localized `{ en: "…" }` objects for names. */
export function coerceBandaiTitle(value) {
  if (value == null) return "";
  if (typeof value === "string") return value.trim();
  if (typeof value === "object") {
    const v =
      value.en ||
      value["en-AU"] ||
      value["en-US"] ||
      value.fr ||
      value.ja ||
      Object.values(value).find((x) => typeof x === "string" && x.trim());
    return String(v || "").trim();
  }
  return String(value).trim();
}

/**
 * Warm home + product API, then search fallback (same path the poller uses).
 * @returns {Promise<string|null>}
 */
export async function fetchBandaiProductTitle(productCode, opts = {}) {
  const code = String(productCode || "").trim();
  if (!code) return null;

  const area = String(opts.area || "au").toLowerCase().slice(0, 2);
  const timeoutMs = Math.max(3_000, Number(opts.timeoutMs) || 12_000);
  const jar = createJar();
  const dispatcher = makeDispatcher(opts.proxy || null, { forceUndici: true });
  const ctx = { jar, dispatcher };
  const base = `https://p-bandai.com/${area}`;
  const signal =
    typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function"
      ? AbortSignal.timeout(timeoutMs)
      : undefined;

  const apiHeaders = (referer) => ({
    "user-agent": UA,
    accept: "application/json, text/plain, */*",
    "accept-language": "en",
    "x-g1-area-code": area,
    "x-requested-with": "XMLHttpRequest",
    origin: "https://p-bandai.com",
    referer: referer || `${base}/`,
  });

  try {
    const warm = await request(
      `${base}/`,
      {
        method: "GET",
        headers: {
          "user-agent": UA,
          accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          "accept-language": "en-AU,en;q=0.9",
        },
        timeoutMs,
        ...(signal ? { signal } : {}),
      },
      ctx,
    );
    jar.ingest?.(warm.headers);

    if (!/^NAI/i.test(code) && !/^AAI/i.test(code)) {
      try {
        const prod = await request(
          `https://p-bandai.com/api/products/${encodeURIComponent(code)}`,
          {
            method: "GET",
            headers: apiHeaders(`${base}/item/${code}`),
            timeoutMs,
            ...(signal ? { signal } : {}),
          },
          ctx,
        );
        jar.ingest?.(prod.headers);
        const json = await prod.json().catch(() => null);
        const title = coerceBandaiTitle(json?.productName || json?.name);
        if (title) return title;
      } catch {
        /* try search */
      }
    }

    const q = encodeURIComponent(code);
    const search = await request(
      `https://p-bandai.com/api/search?keyword=${q}&offset=0&limit=20`,
      {
        method: "GET",
        headers: apiHeaders(`${base}/search?keyword=${q}`),
        timeoutMs,
        ...(signal ? { signal } : {}),
      },
      ctx,
    );
    jar.ingest?.(search.headers);
    const json = await search.json().catch(() => null);
    const products =
      json?.productResults?.products || json?.products || json?.items || [];
    const upper = code.toUpperCase();
    for (const p of Array.isArray(products) ? products : []) {
      const pid = String(p?.productCode || p?.code || p?.productId || "").trim();
      const nais = [
        ...(Array.isArray(p?.areaItemNos) ? p.areaItemNos : []),
        p?.areaItemNo,
      ]
        .filter(Boolean)
        .map((x) => String(x).toUpperCase());
      if (pid.toUpperCase() !== upper && !nais.includes(upper)) continue;
      const title = coerceBandaiTitle(p?.productName || p?.name || p?.title);
      if (title) return title;
    }
    // Only soft-match when search returned a single card for this keyword
    if (Array.isArray(products) && products.length === 1) {
      const soft = coerceBandaiTitle(
        products[0]?.productName || products[0]?.name || products[0]?.title,
      );
      if (soft) return soft;
    }
    return null;
  } catch {
    return null;
  } finally {
    try {
      await dispatcher?.close?.();
    } catch {
      /* ignore */
    }
  }
}
