/**
 * Resolve Bandai storefront product images for Action Store cards.
 */

function absolutizeBandaiUrl(fileUrl) {
  const s = String(fileUrl || "").trim();
  if (!s) return "";
  if (/^https?:\/\//i.test(s)) return s.slice(0, 500);
  return `https://p-bandai.com/${s.replace(/^\//, "")}`.slice(0, 500);
}

/** Pick first product image from a Bandai /api/products or search-card payload. */
function pickBandaiImageUrl(json) {
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
    json.image ||
    "";
  return absolutizeBandaiUrl(fileUrl);
}

/**
 * GET p-bandai.com/api/products/{sku} and return absolute image URL.
 * @returns {Promise<string>}
 */
async function fetchBandaiProductImage(sku, opts = {}) {
  const code = String(sku || "").trim();
  if (!code) return "";
  const area = String(opts.area || "au").toLowerCase().slice(0, 2);
  const timeoutMs = Math.max(3_000, Number(opts.timeoutMs) || 10_000);
  const signal =
    typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function"
      ? AbortSignal.timeout(timeoutMs)
      : undefined;
  try {
    const res = await fetch(`https://p-bandai.com/api/products/${encodeURIComponent(code)}`, {
      headers: {
        accept: "application/json, text/plain, */*",
        "accept-language": "en",
        "x-g1-area-code": area,
        "x-requested-with": "XMLHttpRequest",
        origin: "https://p-bandai.com",
        referer: `https://p-bandai.com/${area}/item/${code}`,
        "user-agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
      },
      ...(signal ? { signal } : {}),
    });
    if (!res.ok) return "";
    const json = await res.json().catch(() => null);
    return pickBandaiImageUrl(json);
  } catch {
    return "";
  }
}

/**
 * Fill missing imageUrl on Bandai catalog rows (bounded concurrency).
 * @param {object[]} rows
 * @param {{ concurrency?: number, area?: string }} [opts]
 */
async function enrichRowsWithBandaiImages(rows, opts = {}) {
  const list = Array.isArray(rows) ? rows : [];
  const concurrency = Math.max(1, Math.min(4, Number(opts.concurrency) || 3));
  let cursor = 0;
  let filled = 0;

  async function worker() {
    while (cursor < list.length) {
      const idx = cursor;
      cursor += 1;
      const row = list[idx];
      if (!row || String(row.store || "").toLowerCase() !== "bandai") continue;
      if (String(row.imageUrl || "").trim()) continue;
      const sku = String(row.sku || "").trim();
      if (!sku) continue;
      const imageUrl = await fetchBandaiProductImage(sku, {
        area: row.area || opts.area || "au",
      });
      if (imageUrl) {
        row.imageUrl = imageUrl;
        filled += 1;
      }
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  return { rows: list, filled };
}

module.exports = {
  absolutizeBandaiUrl,
  pickBandaiImageUrl,
  fetchBandaiProductImage,
  enrichRowsWithBandaiImages,
};
