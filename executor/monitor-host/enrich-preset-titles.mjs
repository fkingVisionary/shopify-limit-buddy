/**
 * Fill Action Store preset titles + backend PIDs from the live store (Bandai).
 * Uses monitor undici helpers already baked into the Railway image.
 */

import { createJar, makeDispatcher, request, UA, parseProxy } from "../monitor/http-undici.js";
import { serializePresetCatalogRows } from "./preset-catalog.mjs";
import { isBackendPid } from "./product-cache.mjs";

function absolutizeBandaiUrl(fileUrl) {
  const s = String(fileUrl || "").trim();
  if (!s) return "";
  if (/^https?:\/\//i.test(s)) return s.slice(0, 500);
  return `https://p-bandai.com/${s.replace(/^\//, "")}`.slice(0, 500);
}

/** First storefront image from PDP / search-card JSON. */
export function pickBandaiImageUrl(json) {
  if (!json || typeof json !== "object") return "";
  const media = Array.isArray(json.mediaSection?.images)
    ? json.mediaSection.images
    : Array.isArray(json.productImages)
      ? json.productImages
      : [];
  const fileUrl =
    media.find((i) => i?.fileUrl)?.fileUrl ||
    json.imageUrl ||
    json.thumbnailUrl ||
    "";
  return absolutizeBandaiUrl(fileUrl);
}

/**
 * @param {object[]} rows
 * @param {{
 *   area?: string,
 *   getProduct?: (sku: string) => { title?: string, areaItemNo?: string } | null,
 *   lookupCache?: (sku: string, area: string) => { title?: string, areaItemNo?: string } | null,
 *   proxyRaw?: string,
 *   enrich?: boolean,
 *   concurrency?: number,
 *   timeoutMs?: number,
 *   fetchMeta?: (sku: string, area: string, proxy: string|null) => Promise<object|null>,
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
      cacheEntries: [],
    };
  }

  const areaDefault = String(opts.area || "au").toLowerCase().slice(0, 2);
  const proxy = firstProxyUrl(opts.proxyRaw);
  const concurrency = Math.max(1, Math.min(5, Number(opts.concurrency) || 3));
  const timeoutMs = Math.max(3_000, Number(opts.timeoutMs) || 12_000);
  const fetchMeta =
    typeof opts.fetchMeta === "function"
      ? opts.fetchMeta
      : (sku, area, prox) => fetchBandaiProductMeta(sku, { area, proxy: prox, timeoutMs });

  let resolved = 0;
  let failed = 0;
  let skipped = 0;
  let cursor = 0;
  /** @type {object[]} */
  const cacheEntries = [];

  async function worker() {
    while (cursor < list.length) {
      const idx = cursor;
      cursor += 1;
      const row = list[idx];
      if (row.store !== "bandai" || !row.sku) {
        skipped += 1;
        continue;
      }

      const area = String(row.area || areaDefault).toLowerCase().slice(0, 2);
      const needsTitle = Boolean(row.needsTitle) || !row.title || row.title === row.sku;
      const needsPid = !isBackendPid(row.areaItemNo);
      const needsImage = !String(row.imageUrl || "").trim();
      if (!needsTitle && !needsPid && !needsImage) {
        skipped += 1;
        if (isBackendPid(row.areaItemNo)) {
          cacheEntries.push({
            sku: row.sku,
            areaItemNo: row.areaItemNo,
            title: row.title,
            imageUrl: row.imageUrl || "",
            area,
            source: "preset",
          });
        }
        continue;
      }

      let title = needsTitle ? "" : String(row.title || "");
      let areaItemNo = isBackendPid(row.areaItemNo) ? row.areaItemNo : "";
      let areaItemNos = Array.isArray(row.areaItemNos) ? row.areaItemNos.filter(isBackendPid) : [];
      let imageUrl = String(row.imageUrl || "").trim();

      try {
        const cached =
          opts.lookupCache?.(row.sku, area) ||
          opts.getProduct?.(row.sku) ||
          null;
        if (cached) {
          if (!title && cached.title) title = String(cached.title).trim();
          if (!areaItemNo && isBackendPid(cached.areaItemNo)) {
            areaItemNo = String(cached.areaItemNo).trim();
          }
          if (!imageUrl && cached.imageUrl) imageUrl = String(cached.imageUrl).trim();
        }
      } catch {
        /* ignore */
      }

      if ((needsTitle && !title) || (needsPid && !areaItemNo) || (needsImage && !imageUrl)) {
        try {
          const meta = await fetchMeta(row.sku, area, proxy);
          if (meta?.title && !title) title = String(meta.title).trim();
          if (isBackendPid(meta?.areaItemNo) && !areaItemNo) {
            areaItemNo = String(meta.areaItemNo).trim();
          }
          if (Array.isArray(meta?.areaItemNos) && meta.areaItemNos.length) {
            areaItemNos = meta.areaItemNos.filter(isBackendPid);
          }
          if (meta?.imageUrl && !imageUrl) imageUrl = String(meta.imageUrl).trim();
        } catch {
          /* ignore */
        }
      }

      let got = false;
      if (title) {
        row.title = title.slice(0, 120);
        row.taskGroup = title.slice(0, 80);
        row.needsTitle = false;
        row.titleSource = row.titleSource === "manual" ? "manual" : "site";
        got = true;
      }
      if (areaItemNo) {
        row.areaItemNo = areaItemNo;
        row.areaItemNos = areaItemNos.length ? areaItemNos : [areaItemNo];
        got = true;
      }
      if (imageUrl) {
        row.imageUrl = imageUrl.slice(0, 500);
        got = true;
      }

      if (got) {
        resolved += 1;
        cacheEntries.push({
          sku: row.sku,
          areaItemNo: row.areaItemNo || "",
          areaItemNos: row.areaItemNos || [],
          title: row.title || "",
          imageUrl: row.imageUrl || "",
          area,
          source: "enrich",
        });
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
    cacheEntries,
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

function pickBackendPids(json, card) {
  const fromJson = [
    ...(Array.isArray(json?.areaItemNos) ? json.areaItemNos : []),
    ...Object.keys(json?.areaItemInventoryInfoMap || {}),
  ];
  const fromCard = [
    ...(Array.isArray(card?.areaItemNos) ? card.areaItemNos : []),
    card?.areaItemNo,
  ];
  const all = [...fromJson, ...fromCard]
    .map((x) => String(x || "").trim())
    .filter(isBackendPid);
  const uniq = [...new Set(all)];
  return { areaItemNo: uniq[0] || "", areaItemNos: uniq };
}

/**
 * Warm home + product API, then search fallback.
 * @returns {Promise<{ title: string, areaItemNo: string, areaItemNos: string[] }|null>}
 */
export async function fetchBandaiProductMeta(productCode, opts = {}) {
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

    let title = "";
    let areaItemNo = "";
    let areaItemNos = [];
    let imageUrl = "";

    if (!isBackendPid(code)) {
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
        title = coerceBandaiTitle(
          json?.infoSection?.productName || json?.productName || json?.name,
        );
        const pids = pickBackendPids(json, null);
        areaItemNo = pids.areaItemNo;
        areaItemNos = pids.areaItemNos;
        imageUrl = pickBandaiImageUrl(json);
        if (title || areaItemNo || imageUrl) {
          return { title, areaItemNo, areaItemNos, imageUrl };
        }
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
      title = coerceBandaiTitle(p?.productName || p?.name || p?.title);
      const pids = pickBackendPids(null, p);
      areaItemNo = pids.areaItemNo;
      areaItemNos = pids.areaItemNos;
      imageUrl = pickBandaiImageUrl(p);
      if (title || areaItemNo || imageUrl) {
        return { title, areaItemNo, areaItemNos, imageUrl };
      }
    }
    if (Array.isArray(products) && products.length === 1) {
      const p = products[0];
      title = coerceBandaiTitle(p?.productName || p?.name || p?.title);
      const pids = pickBackendPids(null, p);
      imageUrl = pickBandaiImageUrl(p);
      if (title || pids.areaItemNo || imageUrl) {
        return {
          title,
          areaItemNo: pids.areaItemNo,
          areaItemNos: pids.areaItemNos,
          imageUrl,
        };
      }
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

/** @deprecated prefer fetchBandaiProductMeta */
export async function fetchBandaiProductTitle(productCode, opts = {}) {
  const meta = await fetchBandaiProductMeta(productCode, opts);
  return meta?.title || null;
}
