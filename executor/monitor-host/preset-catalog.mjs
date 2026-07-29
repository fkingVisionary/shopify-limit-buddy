/**
 * Admin-curated Action Store SKU list (shared with Desktop).
 *
 * Accepted lines (title optional — site resolve fills it on save):
 *   N2890…
 *   bandai N2890…
 *   https://p-bandai.com/au/item/N2890…
 *   bandai https://p-bandai.com/au/item/N2890…
 *   store,sku[,title]
 *   N2890… Optional manual title
 */

const STORE_TOKEN =
  /^(bandai|kmart|toymate|disney|pokemoncentre|pokemon)$/i;
const BANDAI_ITEM_URL =
  /(?:https?:\/\/)?(?:www\.)?p-bandai\.com\/([a-z]{2})\/item\/([A-Za-z0-9_-]+)/i;
const BANDAI_CODE =
  /\b(N\d{7,}[A-Za-z0-9]*|A\d{7,}[A-Za-z0-9]*|NAI[A-Za-z0-9]+|AAI[A-Za-z0-9]+)\b/i;

/**
 * @param {string} text
 * @param {{ defaultStore?: string, defaultArea?: string }} [opts]
 */
export function parsePresetCatalogBulk(text, opts = {}) {
  const defaultStore = String(opts.defaultStore || "bandai").toLowerCase();
  const defaultArea = String(opts.defaultArea || "au").toLowerCase().slice(0, 2);
  const lines = String(text || "").split(/\r?\n/);
  const rows = [];
  const seen = new Set();

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const parsed = parsePresetLine(trimmed, { defaultStore, defaultArea });
    if (!parsed?.sku) continue;

    const key = `${parsed.store}::${parsed.sku}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const manualTitle = cleanManualTitle(parsed.title, parsed.sku);
    const label = manualTitle || parsed.sku;
    rows.push({
      id: `cat_${parsed.store}_${parsed.sku}`.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 80),
      store: parsed.store,
      sku: parsed.sku,
      title: String(label).slice(0, 120),
      taskGroup: String(label).slice(0, 80),
      area: parsed.area || defaultArea,
      enabled: true,
      needsTitle: !manualTitle,
      titleSource: manualTitle ? "manual" : "sku",
    });
  }
  return rows;
}

/**
 * @param {string} trimmed
 * @param {{ defaultStore: string, defaultArea: string }} opts
 */
export function parsePresetLine(trimmed, opts) {
  let store = opts.defaultStore;
  let area = opts.defaultArea;
  let sku = "";
  let title = "";

  const urlMatch = trimmed.match(BANDAI_ITEM_URL);
  if (urlMatch) {
    store = "bandai";
    area = urlMatch[1].toLowerCase();
    sku = urlMatch[2];
    const withoutUrl = trimmed
      .replace(BANDAI_ITEM_URL, " ")
      .replace(STORE_TOKEN, " ")
      .replace(/\s+/g, " ")
      .trim();
    title = withoutUrl;
    return { store, area, sku, title };
  }

  if (trimmed.includes(",")) {
    const parts = trimmed.split(",").map((p) => p.trim()).filter(Boolean);
    if (parts.length >= 2 && STORE_TOKEN.test(parts[0]) && parts[0].length < 24) {
      store = parts[0].toLowerCase();
      sku = parts[1];
      title = parts.slice(2).join(", ").trim();
    } else {
      sku = parts[0];
      title = parts.slice(1).join(", ").trim();
    }
    const codeInSku = String(sku).match(BANDAI_CODE);
    if (codeInSku && (store === "bandai" || opts.defaultStore === "bandai")) {
      sku = codeInSku[1];
      if (store !== "bandai" && !STORE_TOKEN.test(parts[0] || "")) store = "bandai";
    }
    return { store, area, sku, title };
  }

  const tokens = trimmed.split(/\s+/);
  let i = 0;
  if (tokens.length >= 1 && STORE_TOKEN.test(tokens[0])) {
    store = tokens[0].toLowerCase();
    i = 1;
  }
  if (i >= tokens.length) return null;
  sku = tokens[i];
  title = tokens.slice(i + 1).join(" ").trim();

  const code = String(sku).match(BANDAI_CODE) || trimmed.match(BANDAI_CODE);
  if (code && (store === "bandai" || !STORE_TOKEN.test(tokens[0] || ""))) {
    if (store !== "kmart" && store !== "toymate" && store !== "disney" && store !== "pokemoncentre" && store !== "pokemon") {
      store = "bandai";
    }
    // If first token after store wasn't the code, prefer the matched Bandai code
    if (!BANDAI_CODE.test(sku)) {
      sku = code[1];
      title = trimmed
        .replace(STORE_TOKEN, "")
        .replace(code[0], "")
        .replace(/\s+/g, " ")
        .trim();
    } else {
      sku = code[1];
    }
  }

  return { store, area, sku, title };
}

function cleanManualTitle(title, sku) {
  const t = String(title || "").trim();
  if (!t) return "";
  if (t.toLowerCase() === String(sku || "").toLowerCase()) return "";
  if (BANDAI_ITEM_URL.test(t)) return "";
  if (BANDAI_CODE.test(t) && t.replace(/\s+/g, "") === String(sku)) return "";
  return t;
}

/** Persist rows as `store sku Title` lines (stable for Desktop pull + re-edit). */
export function serializePresetCatalogRows(rows) {
  return (Array.isArray(rows) ? rows : [])
    .filter((r) => r?.sku)
    .map((r) => {
      const store = String(r.store || "bandai").toLowerCase();
      const sku = String(r.sku).trim();
      const title = String(r.title || "").trim();
      if (title && title.toLowerCase() !== sku.toLowerCase()) {
        return `${store} ${sku} ${title}`;
      }
      return `${store} ${sku}`;
    })
    .join("\n");
}

export function normalizePresetCatalogRaw(raw) {
  return String(raw || "").replace(/\r\n/g, "\n").trim();
}
