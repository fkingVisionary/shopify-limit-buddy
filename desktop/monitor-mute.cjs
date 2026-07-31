// Monitor SKU mute / blacklist — suppresses feed noise, Smart Actions, and Watchdog.

function normalizeMuteSku(raw) {
  const s = String(raw || "")
    .trim()
    .toUpperCase();
  if (!s) return "";
  const m = s.match(/\b(N\d{7,}[A-Z0-9]*|A\d{7,}[A-Z0-9]*|NAI[A-Z0-9]+)\b/i);
  return (m ? m[1] : s).toUpperCase();
}

function listMutedSkus(settings = {}) {
  const raw = settings.monitorMutedSkus;
  if (!Array.isArray(raw)) return [];
  const out = [];
  const seen = new Set();
  for (const row of raw) {
    const sku = normalizeMuteSku(row);
    if (!sku || seen.has(sku)) continue;
    seen.add(sku);
    out.push(sku);
  }
  return out;
}

function isMonitorSkuMuted(settings = {}, productIdOrSku = "") {
  const sku = normalizeMuteSku(productIdOrSku);
  if (!sku) return false;
  const muted = listMutedSkus(settings);
  if (!muted.length) return false;
  if (muted.includes(sku)) return true;
  // Also match when hit carries a longer PDP id that embeds a muted NAI/SKU token.
  for (const m of muted) {
    if (sku.includes(m) || m.includes(sku)) return true;
  }
  return false;
}

function setMutedSku(settings = {}, productIdOrSku = "", muted = true) {
  const sku = normalizeMuteSku(productIdOrSku);
  const cur = listMutedSkus(settings);
  if (!sku) return { ...settings, monitorMutedSkus: cur };
  const set = new Set(cur);
  if (muted) set.add(sku);
  else set.delete(sku);
  return { ...settings, monitorMutedSkus: [...set].sort() };
}

function parseMutedSkusText(text = "") {
  const out = [];
  const seen = new Set();
  for (const line of String(text || "").split(/\r?\n/)) {
    const sku = normalizeMuteSku(line.replace(/[#;].*$/, ""));
    if (!sku || seen.has(sku)) continue;
    seen.add(sku);
    out.push(sku);
  }
  return out;
}

module.exports = {
  normalizeMuteSku,
  listMutedSkus,
  isMonitorSkuMuted,
  setMutedSku,
  parseMutedSkusText,
};
