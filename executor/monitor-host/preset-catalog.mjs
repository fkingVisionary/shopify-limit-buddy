/**
 * Admin-curated Action Store SKU list (shared with Desktop).
 * Same line formats as desktop/smart-action-catalog.cjs parseCatalogBulk:
 *   N2890… Title
 *   bandai N2890… Title
 *   store,sku,title
 */

/**
 * @param {string} text
 * @param {{ defaultStore?: string }} [opts]
 */
export function parsePresetCatalogBulk(text, opts = {}) {
  const defaultStore = String(opts.defaultStore || "bandai").toLowerCase();
  const lines = String(text || "").split(/\r?\n/);
  const rows = [];
  const seen = new Set();

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    let store = defaultStore;
    let sku = "";
    let title = "";

    if (trimmed.includes(",")) {
      const parts = trimmed.split(",").map((p) => p.trim());
      if (parts.length >= 2 && /^[a-z]+$/i.test(parts[0]) && parts[0].length < 24) {
        store = parts[0].toLowerCase();
        sku = parts[1];
        title = parts.slice(2).join(", ").trim();
      } else {
        sku = parts[0];
        title = parts.slice(1).join(", ").trim();
      }
    } else {
      const tokens = trimmed.split(/\s+/);
      if (
        tokens.length >= 2 &&
        /^(bandai|kmart|toymate|disney|pokemoncentre|pokemon)$/i.test(tokens[0])
      ) {
        store = tokens[0].toLowerCase();
        sku = tokens[1];
        title = tokens.slice(2).join(" ").trim();
      } else {
        sku = tokens[0];
        title = tokens.slice(1).join(" ").trim();
      }
    }

    if (!sku) continue;
    const key = `${store}::${sku}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const label = title || sku;
    rows.push({
      id: `cat_${store}_${sku}`.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 80),
      store,
      sku,
      title: String(label).slice(0, 120),
      taskGroup: String(label).slice(0, 80),
      enabled: true,
    });
  }
  return rows;
}

export function normalizePresetCatalogRaw(raw) {
  return String(raw || "").replace(/\r\n/g, "\n").trim();
}
