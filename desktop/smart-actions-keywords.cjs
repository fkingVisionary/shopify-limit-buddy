// Cybersole-style keyword filter syntax (shared by SA filters + QT match helpers).
// Rules: comma = AND groups, "/" = OR within a group, leading "-" = negative group.
// Empty / whitespace-only pattern always matches.

/**
 * @param {string} pattern
 * @returns {{ groups: Array<{ negative: boolean, alts: string[] }> }}
 */
function parseKeywordPattern(pattern) {
  const groups = [];
  const raw = String(pattern || "").trim();
  if (!raw) return { groups };

  for (const part of raw.split(",")) {
    let token = part.trim();
    if (!token) continue;
    let negative = false;
    if (token.startsWith("-")) {
      negative = true;
      token = token.slice(1).trim();
    }
    if (!token) continue;
    const alts = token
      .split("/")
      .map((a) => a.trim().toLowerCase())
      .filter(Boolean);
    if (!alts.length) continue;
    groups.push({ negative, alts });
  }
  return { groups };
}

/**
 * @param {string} text
 * @param {string} pattern
 * @returns {boolean}
 */
function matchKeywordPattern(text, pattern) {
  const { groups } = parseKeywordPattern(pattern);
  if (!groups.length) return true;
  const hay = String(text || "").toLowerCase();
  for (const g of groups) {
    const hit = g.alts.some((a) => a && hay.includes(a));
    if (g.negative) {
      if (hit) return false;
    } else if (!hit) {
      return false;
    }
  }
  return true;
}

function splitCsvValues(value) {
  return String(value || "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

function fieldBlob(field, ctx = {}) {
  switch (String(field || "title").toLowerCase()) {
    case "store":
      return String(ctx.store || "");
    case "title":
    case "product_name":
    case "productname":
      return String(ctx.title || "");
    case "sku":
    case "productid":
    case "product_id":
      return String(ctx.sku || ctx.productId || "");
    case "url":
    case "pdp":
      return String(ctx.url || ctx.pdpUrl || "");
    case "reason":
      return String(ctx.reason || "");
    case "price":
      return String(ctx.price || ctx.meta?.price || "");
    case "producttype":
    case "product_type":
      return String(ctx.productType || ctx.meta?.productType || "");
    case "instock":
    case "in_stock":
      if (ctx.inStock == null && ctx.meta?.inStock == null) return "";
      return String(ctx.inStock ?? ctx.meta?.inStock ? "true" : "false");
    default:
      return `${ctx.title || ""} ${ctx.sku || ""} ${ctx.url || ""} ${ctx.reason || ""} ${ctx.price || ""} ${ctx.productType || ""}`;
  }
}

/**
 * Evaluate a single SA filter against an event context.
 * Empty value ⇒ pass (except inStock boolean-ish compares still need a value).
 *
 * @param {{ field?: string, op?: string, value?: string }} filter
 * @param {object} ctx
 */
function matchFilter(filter, ctx = {}) {
  if (!filter) return true;
  const field = String(filter.field || "title").toLowerCase();
  const value = String(filter.value ?? "").trim();
  if (!value) return true;

  const blob = fieldBlob(field, ctx);
  const op = String(filter.op || "matches").toLowerCase();
  const hay = blob.toLowerCase();
  const needle = value.toLowerCase();

  if (op === "equals" || op === "eq") {
    return hay === needle;
  }
  if (op === "not_equals" || op === "neq" || op === "not equals") {
    return hay !== needle;
  }
  if (op === "contains") {
    return hay.includes(needle);
  }
  if (op === "not_contains" || op === "not contain" || op === "not_contain") {
    return !hay.includes(needle);
  }
  if (op === "equals_any" || op === "equals any") {
    const list = splitCsvValues(value);
    if (!list.length) return true;
    return list.includes(hay);
  }
  if (op === "contains_any" || op === "contains any") {
    const list = splitCsvValues(value);
    if (!list.length) return true;
    return list.some((v) => hay.includes(v));
  }
  if (op === "contains_all" || op === "contains all") {
    const list = splitCsvValues(value);
    if (!list.length) return true;
    return list.every((v) => hay.includes(v));
  }
  if (op === "contains_none" || op === "contains none" || op === "equals_none" || op === "equals none") {
    const list = splitCsvValues(value);
    if (!list.length) return true;
    return list.every((v) => !hay.includes(v));
  }
  // Default / "matches" — Cybersole keyword syntax
  return matchKeywordPattern(blob, value);
}

/**
 * Filters are AND. Empty list = always run.
 * @param {Array<object>} filters
 * @param {object} ctx
 */
function matchAllFilters(filters, ctx) {
  const list = Array.isArray(filters) ? filters : [];
  if (!list.length) return { ok: true, failed: null };
  for (const f of list) {
    if (!matchFilter(f, ctx)) {
      return {
        ok: false,
        failed: {
          field: f.field || "title",
          value: f.value || "",
          op: f.op || "matches",
        },
      };
    }
  }
  return { ok: true, failed: null };
}

const FILTER_FIELDS = [
  { id: "store", label: "Store Name" },
  { id: "title", label: "Product Name" },
  { id: "sku", label: "SKU" },
  { id: "url", label: "URL" },
  { id: "reason", label: "Reason" },
  { id: "price", label: "Price" },
  { id: "productType", label: "Product Type" },
  { id: "inStock", label: "In Stock" },
];

const FILTER_OPS = [
  { id: "equals", label: "equals" },
  { id: "equals_any", label: "equals any" },
  { id: "not_equals", label: "not equals" },
  { id: "contains", label: "contains" },
  { id: "not_contains", label: "not contain" },
  { id: "contains_any", label: "contains any" },
  { id: "contains_all", label: "contains all" },
  { id: "contains_none", label: "contains none" },
  { id: "matches", label: "matches (keywords)" },
];

module.exports = {
  parseKeywordPattern,
  matchKeywordPattern,
  matchFilter,
  matchAllFilters,
  fieldBlob,
  FILTER_FIELDS,
  FILTER_OPS,
};
