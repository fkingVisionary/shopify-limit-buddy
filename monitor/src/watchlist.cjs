const fs = require("fs");
const path = require("path");
const { normalizeKmartPdpUrl } = require("../lib/keyword-parse.cjs");

function watchlistPath() {
  return (
    process.env.MONITOR_WATCHLIST ||
    path.join(__dirname, "..", "watchlist.json")
  );
}

/**
 * @returns {{ skus: { sku: string; url: string }[]; discovery: { query: string }[] }}
 */
function loadWatchlist() {
  const file = watchlistPath();
  let raw = { skus: [], discovery: [] };
  try {
    raw = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    // Fall back to example if present
    try {
      raw = JSON.parse(
        fs.readFileSync(path.join(__dirname, "..", "watchlist.example.json"), "utf8"),
      );
    } catch {
      /* empty */
    }
  }

  const skus = [];
  const seen = new Set();
  for (const row of raw.skus || []) {
    const sku = String(row.sku || "").trim();
    const url =
      normalizeKmartPdpUrl(row.url || sku) ||
      (sku ? `https://www.kmart.com.au/product/item-${sku}/` : null);
    if (!sku || !url || seen.has(sku)) continue;
    seen.add(sku);
    skus.push({ sku, url });
  }

  // Env extras: MONITOR_WATCH_SKUS=123,456
  for (const sku of String(process.env.MONITOR_WATCH_SKUS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)) {
    if (seen.has(sku)) continue;
    seen.add(sku);
    skus.push({
      sku,
      url: `https://www.kmart.com.au/product/item-${sku}/`,
    });
  }

  const discovery = [];
  for (const row of raw.discovery || []) {
    const query = String(row.query || row || "").trim();
    if (query) discovery.push({ query });
  }
  for (const q of String(process.env.MONITOR_DISCOVERY_QUERIES || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)) {
    if (!discovery.some((d) => d.query === q)) discovery.push({ query: q });
  }

  return { skus, discovery };
}

/** Promote a discovered SKU onto the in-memory hot list (not persisted). */
function promoteSku(list, { sku, url }) {
  const s = String(sku || "").trim();
  if (!s) return list;
  if (list.skus.some((x) => x.sku === s)) return list;
  list.skus.push({
    sku: s,
    url: normalizeKmartPdpUrl(url || s) || `https://www.kmart.com.au/product/item-${s}/`,
  });
  return list;
}

module.exports = { loadWatchlist, promoteSku, watchlistPath };
