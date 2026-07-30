/**
 * Shared Bandai product cache (SKU ↔ backend PID ↔ title).
 * Survives on disk next to monitor runtime state; all Desktop members pull it.
 */

import fs from "node:fs";
import path from "node:path";
import { resolveStateFile } from "./data-dir.mjs";

function defaultCachePath() {
  if (process.env.MONITOR_PRODUCT_CACHE_PATH) return process.env.MONITOR_PRODUCT_CACHE_PATH;
  return resolveStateFile("vanta-product-cache.json").path;
}

export function isBackendPid(code) {
  const s = String(code || "").trim();
  return /^NAI/i.test(s) || /^AAI/i.test(s);
}

export function isFrontendSku(code) {
  const s = String(code || "").trim();
  if (!s || isBackendPid(s)) return false;
  return /^[NA]\d/i.test(s) || /^N\d{7,}/i.test(s) || /^A\d{7,}/i.test(s);
}

export function productCacheKey(area, sku) {
  const a = String(area || "au").toLowerCase().slice(0, 2);
  const s = String(sku || "").trim().toUpperCase();
  return `${a}:${s}`;
}

/**
 * @returns {{ version: number, updatedAt: string|null, entries: Record<string, object> }}
 */
export function emptyProductCache() {
  return { version: 1, updatedAt: null, entries: {} };
}

/**
 * @param {object} raw
 */
export function normalizeProductEntry(raw = {}, opts = {}) {
  const area = String(raw.area || opts.area || "au").toLowerCase().slice(0, 2);
  let sku = String(raw.sku || raw.productId || raw.productCode || "").trim();
  let areaItemNo = String(raw.areaItemNo || raw.bandaiAreaItemNo || "").trim();
  const areaItemNos = Array.isArray(raw.areaItemNos)
    ? raw.areaItemNos.map(String).filter(isBackendPid)
    : [];
  if (!isBackendPid(areaItemNo) && areaItemNos[0]) areaItemNo = areaItemNos[0];
  if (isBackendPid(sku) && !areaItemNo) {
    areaItemNo = sku;
    sku = String(raw.frontendSku || raw.productCode || "").trim();
  }
  if (!isFrontendSku(sku) && !isBackendPid(areaItemNo)) return null;
  if (!isBackendPid(areaItemNo)) areaItemNo = "";

  const title = String(raw.title || "").trim().slice(0, 160);
  const imageUrl = String(raw.imageUrl || raw.image || raw.thumbnailUrl || "")
    .trim()
    .slice(0, 500);
  const key = sku
    ? productCacheKey(area, sku)
    : areaItemNo
      ? productCacheKey(area, areaItemNo)
      : null;
  if (!key) return null;

  return {
    key,
    sku: sku || "",
    areaItemNo: areaItemNo || "",
    areaItemNos: areaItemNos.length ? areaItemNos : areaItemNo ? [areaItemNo] : [],
    title,
    imageUrl,
    area,
    source: String(raw.source || opts.source || "unknown").slice(0, 40),
    updatedAt: Number(raw.updatedAt) || Date.now(),
  };
}

export function loadProductCache(filePath = defaultCachePath()) {
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    const j = JSON.parse(raw);
    const entries = {};
    const src = j?.entries && typeof j.entries === "object" ? j.entries : {};
    for (const [k, v] of Object.entries(src)) {
      const n = normalizeProductEntry({ ...v, key: k });
      if (n) entries[n.key] = n;
    }
    return {
      version: 1,
      updatedAt: j?.updatedAt || null,
      entries,
      _path: filePath,
      _fromDisk: true,
    };
  } catch {
    return { ...emptyProductCache(), _path: filePath, _fromDisk: false };
  }
}

export function saveProductCache(cache, filePath = defaultCachePath()) {
  const entries = {};
  for (const [k, v] of Object.entries(cache?.entries || {})) {
    const n = normalizeProductEntry(v);
    if (!n) continue;
    entries[n.key] = {
      sku: n.sku,
      areaItemNo: n.areaItemNo,
      areaItemNos: n.areaItemNos,
      title: n.title,
      imageUrl: n.imageUrl || "",
      area: n.area,
      source: n.source,
      updatedAt: n.updatedAt,
    };
  }
  const out = {
    version: 1,
    updatedAt: new Date().toISOString(),
    entries,
  };
  const dir = path.dirname(filePath);
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {
    /* ignore */
  }
  fs.writeFileSync(filePath, JSON.stringify(out, null, 2));
  return { ...out, _path: filePath, _fromDisk: true };
}

/**
 * Upsert one or many entries. Prefer keeping an existing backend PID if the
 * incoming row lacks one (titles-only updates shouldn't wipe NAI).
 * @returns {{ cache: object, changed: number, entry?: object }}
 */
export function upsertProductEntries(cache, incoming, opts = {}) {
  const next = {
    version: 1,
    updatedAt: cache?.updatedAt || null,
    entries: { ...(cache?.entries || {}) },
    _path: cache?._path,
  };
  const list = Array.isArray(incoming) ? incoming : [incoming];
  let changed = 0;
  let last = null;
  for (const raw of list) {
    const n = normalizeProductEntry(raw, opts);
    if (!n) continue;
    const prev = next.entries[n.key];
    if (prev) {
      const merged = {
        ...prev,
        ...n,
        areaItemNo: n.areaItemNo || prev.areaItemNo || "",
        areaItemNos:
          n.areaItemNos?.length ? n.areaItemNos : prev.areaItemNos || [],
        title: n.title || prev.title || "",
        imageUrl: n.imageUrl || prev.imageUrl || "",
        source: n.source || prev.source,
        updatedAt: Date.now(),
      };
      const same =
        merged.sku === prev.sku &&
        merged.areaItemNo === prev.areaItemNo &&
        merged.title === prev.title &&
        merged.imageUrl === prev.imageUrl &&
        merged.area === prev.area;
      if (same) {
        last = prev;
        continue;
      }
      next.entries[n.key] = merged;
      last = merged;
      changed += 1;
    } else {
      next.entries[n.key] = n;
      last = n;
      changed += 1;
    }
  }
  if (changed) next.updatedAt = new Date().toISOString();
  return { cache: next, changed, entry: last };
}

export function lookupProduct(cache, { sku, area = "au" } = {}) {
  const code = String(sku || "").trim();
  if (!code) return null;
  const areaNorm = String(area || "au").toLowerCase().slice(0, 2);
  const key = productCacheKey(areaNorm, code);
  if (cache?.entries?.[key]) return cache.entries[key];
  const upper = code.toUpperCase();
  for (const e of Object.values(cache?.entries || {})) {
    if (String(e.area || "").toLowerCase() !== areaNorm) continue;
    if (String(e.sku || "").toUpperCase() === upper) return e;
    if (String(e.areaItemNo || "").toUpperCase() === upper) return e;
    if ((e.areaItemNos || []).some((x) => String(x).toUpperCase() === upper)) return e;
  }
  return null;
}

/** Stamp areaItemNo/title from cache onto Action Store rows. */
export function mergeRowsWithProductCache(rows, cache, area = "au") {
  return (Array.isArray(rows) ? rows : []).map((row) => {
    if (String(row.store || "").toLowerCase() !== "bandai") return row;
    const hit = lookupProduct(cache, { sku: row.sku, area: row.area || area });
    if (!hit) return row;
    return {
      ...row,
      title: row.needsTitle && hit.title ? hit.title : row.title || hit.title || row.sku,
      taskGroup:
        row.needsTitle && hit.title
          ? String(hit.title).slice(0, 80)
          : row.taskGroup || row.title || hit.title || row.sku,
      areaItemNo: hit.areaItemNo || row.areaItemNo || "",
      areaItemNos: hit.areaItemNos?.length ? hit.areaItemNos : row.areaItemNos || [],
      imageUrl: row.imageUrl || hit.imageUrl || "",
      needsTitle: hit.title ? false : row.needsTitle,
      titleSource: hit.title && row.needsTitle ? "cache" : row.titleSource,
    };
  });
}

export function listProductCache(cache) {
  return Object.values(cache?.entries || {}).sort(
    (a, b) => Number(b.updatedAt || 0) - Number(a.updatedAt || 0),
  );
}

export { defaultCachePath };
