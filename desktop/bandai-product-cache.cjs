/**
 * Local + shared Bandai product cache (SKU ↔ NAI ↔ title).
 * Populated from Railway monitor /product-cache; used to skip public resolve.
 */

function isBackendPid(code) {
  const s = String(code || "").trim();
  return /^NAI/i.test(s) || /^AAI/i.test(s);
}

function cacheKey(area, sku) {
  return `${String(area || "au").toLowerCase().slice(0, 2)}:${String(sku || "")
    .trim()
    .toUpperCase()}`;
}

function emptyCache() {
  return { entries: {}, pulledAt: null, updatedAt: null };
}

function normalizeCacheState(raw) {
  const base = emptyCache();
  if (!raw || typeof raw !== "object") return base;
  const entries = {};
  const src = raw.entries && typeof raw.entries === "object" ? raw.entries : {};
  for (const [k, v] of Object.entries(src)) {
    const n = normalizeEntry(v);
    if (n) entries[n.key || k] = n;
  }
  // Also accept array form from GET /product-cache
  if (Array.isArray(raw.entries)) {
    for (const v of raw.entries) {
      const n = normalizeEntry(v);
      if (n) entries[n.key] = n;
    }
  }
  if (Array.isArray(raw)) {
    for (const v of raw) {
      const n = normalizeEntry(v);
      if (n) entries[n.key] = n;
    }
  }
  return {
    entries,
    pulledAt: raw.pulledAt || null,
    updatedAt: raw.updatedAt || null,
  };
}

function normalizeEntry(raw = {}) {
  const area = String(raw.area || "au").toLowerCase().slice(0, 2);
  const sku = String(raw.sku || raw.productId || raw.productCode || "").trim();
  const areaItemNo = String(raw.areaItemNo || raw.bandaiAreaItemNo || "").trim();
  if (!sku && !isBackendPid(areaItemNo)) return null;
  const key = sku ? cacheKey(area, sku) : cacheKey(area, areaItemNo);
  return {
    key,
    sku,
    areaItemNo: isBackendPid(areaItemNo) ? areaItemNo : "",
    areaItemNos: Array.isArray(raw.areaItemNos)
      ? raw.areaItemNos.map(String).filter(isBackendPid)
      : isBackendPid(areaItemNo)
        ? [areaItemNo]
        : [],
    title: String(raw.title || "").trim().slice(0, 160),
    area,
    source: String(raw.source || "").slice(0, 40),
    updatedAt: Number(raw.updatedAt) || Date.now(),
  };
}

function mergeEntries(cache, incoming) {
  const next = normalizeCacheState(cache);
  const list = Array.isArray(incoming) ? incoming : [incoming];
  let changed = 0;
  for (const raw of list) {
    const n = normalizeEntry(raw);
    if (!n) continue;
    const prev = next.entries[n.key];
    if (
      prev &&
      prev.sku === n.sku &&
      prev.areaItemNo === n.areaItemNo &&
      prev.title === n.title
    ) {
      continue;
    }
    next.entries[n.key] = prev
      ? {
          ...prev,
          ...n,
          areaItemNo: n.areaItemNo || prev.areaItemNo || "",
          title: n.title || prev.title || "",
          updatedAt: Date.now(),
        }
      : n;
    changed += 1;
  }
  if (changed) next.updatedAt = new Date().toISOString();
  return { cache: next, changed };
}

function lookup(cache, { sku, area = "au" } = {}) {
  const state = normalizeCacheState(cache);
  const code = String(sku || "").trim();
  if (!code) return null;
  const key = cacheKey(area, code);
  if (state.entries[key]) return state.entries[key];
  const upper = code.toUpperCase();
  const areaNorm = String(area || "au").toLowerCase().slice(0, 2);
  for (const e of Object.values(state.entries)) {
    if (String(e.area || "").toLowerCase() !== areaNorm) continue;
    if (String(e.sku || "").toUpperCase() === upper) return e;
    if (isBackendPid(e.areaItemNo) && String(e.areaItemNo).toUpperCase() === upper) return e;
  }
  return null;
}

module.exports = {
  emptyCache,
  normalizeCacheState,
  normalizeEntry,
  mergeEntries,
  lookup,
  cacheKey,
  isBackendPid,
};
