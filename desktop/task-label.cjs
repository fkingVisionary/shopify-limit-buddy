// Shared task label helpers for Desktop UI, Quick Task, and Smart Actions.
// Goal: scannable product-first names without leaking internal recipe jargon.

/** @type {Record<string, string>} */
const STORE_SHORT = {
  bandai: "Bandai",
  toymate: "Toymate",
  pokemoncentre: "Pokémon",
  pokemon: "Pokémon",
  pokemoncenter: "Pokémon",
  kmart: "Kmart",
  disney: "Disney",
};

/** Default Smart Actions / catalog label template (product-first). */
const DEFAULT_LABEL_TEMPLATE = "{{sku}} · {{title}}";

function storeShortName(storeId) {
  const key = String(storeId || "").toLowerCase();
  return STORE_SHORT[key] || (key ? key.charAt(0).toUpperCase() + key.slice(1) : "Store");
}

function modeShortName(task = {}) {
  const store = String(task.store || "").toLowerCase();
  if (store === "bandai") {
    const mode = String(task.bandaiMode || "checkout").toLowerCase();
    if (mode === "atc") return "ATC only";
    if (mode === "monitor") return "Monitor";
    if (mode === "account_gen") return "Account gen";
    if (mode === "login_check") return "Login check";
    return "Autocheckout";
  }
  if (store === "toymate") {
    const mode = String(task.toymateMode || "checkout").toLowerCase();
    if (mode === "account_gen") return "Account gen";
    if (mode === "monitor") return "Monitor";
    return "Autocheckout";
  }
  if (store === "pokemoncentre" || store === "pokemon" || store === "pokemoncenter") {
    const mode = String(task.pcMode || "monitor").toLowerCase();
    if (mode === "checkout") return "Autocheckout";
    return mode.charAt(0).toUpperCase() + mode.slice(1);
  }
  return "Task";
}

/**
 * Best product id / SKU from a task-shaped object.
 */
function extractSku(task = {}) {
  const candidates = [
    task.bandaiWatchSku,
    task.productId,
    task.sku,
    task.input,
    task.bandaiAreaItemNo,
    task.areaItemNo,
  ];
  for (const c of candidates) {
    const s = String(c || "").trim();
    if (!s) continue;
    if (/^https?:\/\//i.test(s)) continue;
    return s.slice(0, 40);
  }
  const url = String(task.pdpUrl || "").trim();
  if (!url) return "";
  const bandai = url.match(/\/item\/([A-Za-z0-9_-]+)/i);
  if (bandai?.[1]) return bandai[1].slice(0, 40);
  const nSku = url.match(/\b(N\d{7,}[A-Za-z0-9]*|A\d{7,}[A-Za-z0-9]*)\b/i);
  if (nSku?.[1]) return nSku[1].slice(0, 40);
  return "";
}

function shortTitle(task = {}, max = 48) {
  const raw = String(task.title || task.productName || task.label || "").trim();
  if (!raw) return "";
  // Don't treat a bare SKU / "Task" as a title.
  const sku = extractSku(task);
  if (sku && raw.toLowerCase() === sku.toLowerCase()) return "";
  if (/^task$/i.test(raw)) return "";
  if (raw.length <= max) return raw;
  return `${raw.slice(0, max - 1)}…`;
}

/**
 * Build a default label when the user left Label blank.
 * Prefer SKU · title; fall back to store · mode.
 */
function defaultTaskLabel(task = {}) {
  const sku = extractSku(task);
  const title = shortTitle({ ...task, label: task.title || task.productName || "" });
  if (sku && title && !title.toLowerCase().includes(sku.toLowerCase())) {
    return `${sku} · ${title}`.slice(0, 120);
  }
  if (sku) return sku.slice(0, 120);
  if (title) return title.slice(0, 120);
  const store = storeShortName(task.store);
  const mode = modeShortName(task);
  return `${store} · ${mode}`.slice(0, 120);
}

/**
 * Resolve label for persistence: keep user text; fill empty / "Task".
 */
function resolveTaskLabel(task = {}) {
  const raw = String(task.label || "").trim();
  if (raw && !/^task$/i.test(raw)) return raw.slice(0, 120);
  return defaultTaskLabel(task);
}

/**
 * Secondary line under the task name (SKU / short URL).
 */
function taskSubline(task = {}) {
  const sku = extractSku(task);
  if (sku) return sku;
  const url = String(task.pdpUrl || "").trim();
  if (!url) return "";
  return url.length > 64 ? `${url.slice(0, 64)}…` : url;
}

/**
 * Friendlier store column: Bandai · Autocheckout · watchdog
 */
function taskStoreModeLabel(task = {}) {
  const store = storeShortName(task.store);
  const mode = modeShortName(task);
  const storeId = String(task.store || "").toLowerCase();
  if (storeId === "bandai") {
    const bandaiMode = String(task.bandaiMode || "checkout").toLowerCase();
    const speed =
      bandaiMode === "checkout" || bandaiMode === "atc"
        ? ` · ${String(task.bandaiCheckoutMode || "fast")}`
        : "";
    const wd =
      (bandaiMode === "checkout" || bandaiMode === "atc") &&
      task.bandaiWatchdog !== false &&
      (task.bandaiWatchSku || task.pdpUrl || task.bandaiWatchKeywords)
        ? " · watchdog"
        : "";
    return `${store} · ${mode}${speed}${wd}`;
  }
  return `${store} · ${mode}`;
}

module.exports = {
  DEFAULT_LABEL_TEMPLATE,
  storeShortName,
  modeShortName,
  extractSku,
  shortTitle,
  defaultTaskLabel,
  resolveTaskLabel,
  taskSubline,
  taskStoreModeLabel,
};
