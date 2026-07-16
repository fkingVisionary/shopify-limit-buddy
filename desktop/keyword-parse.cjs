// Cyber-style keyword parser for task monitor input.
// Semantics: comma = AND positives; -word = negative; a/b = OR within a slot.
// Optional leading + on positives is ignored (habit).

/**
 * @typedef {{ groups: string[][]; negatives: string[] }} KeywordAst
 */

/**
 * @param {string} raw
 * @returns {KeywordAst}
 */
function parseKeywords(raw) {
  const text = String(raw || "").trim();
  const groups = [];
  const negatives = [];
  if (!text) return { groups, negatives };

  for (const part of text.split(",")) {
    let slot = part.trim();
    if (!slot) continue;

    if (slot.startsWith("-")) {
      const word = slot.slice(1).trim().toLowerCase();
      if (word) negatives.push(word);
      continue;
    }

    if (slot.startsWith("+")) slot = slot.slice(1).trim();
    const alts = slot
      .split("/")
      .map((s) => s.trim().replace(/^\+/, "").toLowerCase())
      .filter(Boolean);
    if (alts.length) groups.push(alts);
  }

  return { groups, negatives };
}

/**
 * Classify monitor input: url | sku | keywords
 * @param {string} raw
 * @returns {{ kind: "url" | "sku" | "keywords"; value: string; keywords?: KeywordAst }}
 */
function classifyMonitorInput(raw) {
  const value = String(raw || "").trim();
  if (!value) return { kind: "keywords", value: "", keywords: { groups: [], negatives: [] } };

  if (/^https?:\/\//i.test(value)) {
    return { kind: "url", value };
  }

  // Bare Kmart keycode / SKU (6–9 digits), optional commas for multi — first wins.
  const skuOnly = value.replace(/\s+/g, "");
  if (/^\d{6,9}$/.test(skuOnly)) {
    return { kind: "sku", value: skuOnly };
  }

  return { kind: "keywords", value, keywords: parseKeywords(value) };
}

/**
 * Match Cyber keywords against title (required) and optional sku/url haystacks.
 * @param {KeywordAst} ast
 * @param {{ title?: string; sku?: string; url?: string }} fields
 */
function matchKeywords(ast, fields) {
  const title = String(fields?.title || "").toLowerCase();
  const sku = String(fields?.sku || "").toLowerCase();
  const url = String(fields?.url || "").toLowerCase();
  const haystacks = [title, sku, url].filter(Boolean);

  if (!ast || (!ast.groups.length && !ast.negatives.length)) {
    return { ok: false, reason: "empty_keywords" };
  }

  for (const neg of ast.negatives || []) {
    if (haystacks.some((h) => h.includes(neg))) {
      return { ok: false, reason: "negative", token: neg };
    }
  }

  for (const group of ast.groups || []) {
    const hit = group.some((alt) => haystacks.some((h) => h.includes(alt)));
    if (!hit) return { ok: false, reason: "missing_positive", group };
  }

  // Prefer title containing at least one positive when title is present —
  // sku/url-only hits still count (SKU-shaped tasks).
  return { ok: true };
}

/**
 * Normalize a Kmart PDP URL or build one from a keycode.
 * @param {string} input
 */
function normalizeKmartPdpUrl(input) {
  const s = String(input || "").trim();
  if (/^\d{6,9}$/.test(s)) {
    return `https://www.kmart.com.au/product/item-${s}/`;
  }
  try {
    const u = new URL(s);
    if (!/\.kmart\.com\.au$/i.test(u.hostname) && u.hostname !== "kmart.com.au") {
      return null;
    }
    // Strip query/hash; keep path
    u.search = "";
    u.hash = "";
    let path = u.pathname;
    if (!path.endsWith("/")) path += "/";
    return `https://www.kmart.com.au${path}`;
  } catch {
    return null;
  }
}

function extractKeycodeFromUrl(url) {
  const m = String(url || "").match(/-(\d{6,9})\/?(?:\?|$)/);
  return m?.[1] || null;
}

module.exports = {
  parseKeywords,
  classifyMonitorInput,
  matchKeywords,
  normalizeKmartPdpUrl,
  extractKeycodeFromUrl,
};
