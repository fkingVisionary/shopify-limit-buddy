/** Live Bandai Premium regions (executor BANDAI_REGIONS). JP not supported. */
const BANDAI_REGIONS = Object.freeze(["au", "us", "nz", "sg", "hk", "tw", "fr"]);

const BANDAI_REGION_LABELS = Object.freeze({
  au: "AU",
  us: "US",
  nz: "NZ",
  sg: "SG",
  hk: "HK",
  tw: "TW",
  fr: "FR",
});

function isBandaiStoreId(storeId) {
  const s = String(storeId || "").toLowerCase();
  return s === "bandai" || /^bandai-[a-z]{2}$/.test(s);
}

function normalizeBandaiAreaCode(raw) {
  const a = String(raw || "")
    .trim()
    .toLowerCase();
  return BANDAI_REGIONS.includes(a) ? a : null;
}

/** UI select value `bandai-us` → { store: "bandai", bandaiArea: "us" }. */
function parseBandaiStoreSelection(storeValue, areaHint) {
  const raw = String(storeValue || "").trim();
  const m = raw.match(/^bandai-([a-z]{2})$/i);
  if (m || raw.toLowerCase() === "bandai") {
    const area =
      normalizeBandaiAreaCode(m?.[1]) ||
      normalizeBandaiAreaCode(areaHint) ||
      "au";
    return { store: "bandai", bandaiArea: area };
  }
  return { store: raw || "bandai", bandaiArea: undefined };
}

function bandaiStoreSelectValue(task) {
  if (!isBandaiStoreId(task?.store) && task?.store !== "bandai") return task?.store || "bandai-au";
  const area =
    normalizeBandaiAreaCode(task?.bandaiArea) ||
    normalizeBandaiAreaCode(
      (String(task?.pdpUrl || "").match(/p-bandai\.com\/([a-z]{2})(?:\/|$)/i) || [])[1],
    ) ||
    "au";
  return `bandai-${area}`;
}

function rewriteBandaiPdpArea(url, area) {
  const a = normalizeBandaiAreaCode(area) || "au";
  const s = String(url || "").trim();
  if (!s) return s;
  if (/p-bandai\.com\/[a-z]{2}\//i.test(s)) {
    return s.replace(/p-bandai\.com\/[a-z]{2}\//i, `p-bandai.com/${a}/`);
  }
  if (/^[A-Za-z0-9_-]+$/.test(s)) return s; // bare product code
  return s;
}

module.exports = {
  BANDAI_REGIONS,
  BANDAI_REGION_LABELS,
  isBandaiStoreId,
  normalizeBandaiAreaCode,
  parseBandaiStoreSelection,
  bandaiStoreSelectValue,
  rewriteBandaiPdpArea,
};
