/**
 * Global muted SKUs — admin-curated; suppressed from consumer SSE + Discord.
 * One product id / SKU per line in runtime config.
 */

export function normalizeMuteSku(raw) {
  const s = String(raw || "")
    .trim()
    .toUpperCase();
  if (!s) return "";
  const m = s.match(/\b(N\d{7,}[A-Z0-9]*|A\d{7,}[A-Z0-9]*|NAI[A-Z0-9]+)\b/i);
  return (m ? m[1] : s).toUpperCase();
}

/** @param {string|string[]} raw multiline text or array */
export function parseMutedSkus(raw) {
  const text = Array.isArray(raw) ? raw.join("\n") : String(raw || "");
  const out = [];
  const seen = new Set();
  for (const line of text.split(/\r?\n/)) {
    const sku = normalizeMuteSku(line.replace(/[#;].*$/, ""));
    if (!sku || seen.has(sku)) continue;
    seen.add(sku);
    out.push(sku);
  }
  return out;
}

export function mutedSkusText(list) {
  return (Array.isArray(list) ? list : []).map(normalizeMuteSku).filter(Boolean).join("\n");
}

export function isSkuMuted(mutedList, productIdOrSku) {
  const sku = normalizeMuteSku(productIdOrSku);
  if (!sku) return false;
  const muted = Array.isArray(mutedList) ? mutedList : parseMutedSkus(mutedList);
  if (!muted.length) return false;
  if (muted.includes(sku)) return true;
  for (const m of muted) {
    if (sku.includes(m) || m.includes(sku)) return true;
  }
  return false;
}
