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

/**
 * Evaluate a single SA filter against an event context.
 * Empty value ⇒ pass. Unknown field ⇒ fail closed only if value set.
 *
 * @param {{ field?: string, op?: string, value?: string }} filter
 * @param {{ store?: string, title?: string, sku?: string, url?: string, reason?: string }} ctx
 */
function matchFilter(filter, ctx = {}) {
  if (!filter) return true;
  const field = String(filter.field || "title").toLowerCase();
  const value = String(filter.value ?? "").trim();
  if (!value) return true;

  const blob = (() => {
    switch (field) {
      case "store":
        return String(ctx.store || "");
      case "title":
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
      default:
        return `${ctx.title || ""} ${ctx.sku || ""} ${ctx.url || ""} ${ctx.reason || ""}`;
    }
  })();

  const op = String(filter.op || "matches").toLowerCase();
  if (op === "equals" || op === "eq") {
    return blob.toLowerCase() === value.toLowerCase();
  }
  if (op === "contains") {
    return blob.toLowerCase().includes(value.toLowerCase());
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

module.exports = {
  parseKeywordPattern,
  matchKeywordPattern,
  matchFilter,
  matchAllFilters,
};
