/**
 * Persist PKC catalog snapshot (SKU → availability) so redeploys keep soft→live diffs
 * and don't re-baseline Discord / re-burn Hyper classifying the same set.
 */
import fs from "node:fs";
import path from "node:path";
import { resolveStateFile } from "./data-dir.mjs";

function defaultCachePath() {
  if (process.env.PC_CATALOG_CACHE_PATH) return process.env.PC_CATALOG_CACHE_PATH;
  return resolveStateFile("vanta-pc-catalog.json").path;
}

export function emptyPcCatalogCache() {
  return { version: 1, updatedAt: null, locale: "en-au", entries: {} };
}

export function loadPcCatalogCache(filePath = defaultCachePath()) {
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    const j = JSON.parse(raw);
    const entries = {};
    const src = j?.entries && typeof j.entries === "object" ? j.entries : {};
    for (const [k, v] of Object.entries(src)) {
      if (!v || typeof v !== "object") continue;
      const id = String(k || v.productId || "").toUpperCase();
      if (!id) continue;
      entries[id] = {
        productId: id,
        inStock: Boolean(v.inStock),
        softListed: Boolean(v.softListed) && !v.inStock,
        availability: v.availability || null,
        title: v.title || null,
        slug: v.slug || null,
        pdpUrl: v.pdpUrl || null,
        imageUrl: v.imageUrl || null,
        price: v.price || null,
        source: v.source || null,
        updatedAt: Number(v.updatedAt) || Date.now(),
      };
    }
    return {
      version: 1,
      updatedAt: j?.updatedAt || null,
      locale: j?.locale || "en-au",
      entries,
      _path: filePath,
      _fromDisk: true,
    };
  } catch {
    return { ...emptyPcCatalogCache(), _path: filePath, _fromDisk: false };
  }
}

export function savePcCatalogCache(cache, filePath = defaultCachePath()) {
  const entries = {};
  const src = cache?.entries && typeof cache.entries === "object" ? cache.entries : {};
  for (const [k, v] of Object.entries(src)) {
    if (!v) continue;
    const id = String(k || v.productId || "").toUpperCase();
    if (!id) continue;
    entries[id] = {
      productId: id,
      inStock: Boolean(v.inStock),
      softListed: Boolean(v.softListed) && !v.inStock,
      availability: v.availability || null,
      title: v.title || null,
      slug: v.slug || null,
      pdpUrl: v.pdpUrl || null,
      imageUrl: v.imageUrl || null,
      price: v.price || null,
      source: v.source || null,
      updatedAt: Number(v.updatedAt) || Date.now(),
    };
  }
  const out = {
    version: 1,
    updatedAt: new Date().toISOString(),
    locale: cache?.locale || "en-au",
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

/** @param {Map<string, object>|Iterable} catalog */
export function catalogMapToEntries(catalog) {
  const entries = {};
  const rows =
    catalog instanceof Map
      ? [...catalog.values()]
      : Array.isArray(catalog)
        ? catalog
        : Object.values(catalog || {});
  for (const row of rows) {
    const id = String(row?.productId || "").toUpperCase();
    if (!id) continue;
    entries[id] = {
      productId: id,
      inStock: Boolean(row.inStock),
      softListed: Boolean(row.softListed) && !row.inStock,
      availability: row.availability || null,
      title: row.title || null,
      slug: row.slug || null,
      pdpUrl: row.pdpUrl || null,
      imageUrl: row.imageUrl || null,
      price: row.price || null,
      source: row.source || null,
      updatedAt: Date.now(),
    };
  }
  return entries;
}

export function entriesToCatalogMap(entries) {
  const map = new Map();
  for (const [k, v] of Object.entries(entries || {})) {
    const id = String(k || v?.productId || "").toUpperCase();
    if (!id || !v) continue;
    map.set(id, { ...v, productId: id });
  }
  return map;
}
