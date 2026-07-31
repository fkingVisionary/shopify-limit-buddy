/**
 * Action Store catalog filters — TCG-first, set/store/search, slop blocklist.
 * Shared by app.js (browser) and optional node tests via duplicate require path.
 */
(function (root) {
  const TCG_ALLOW =
    /\b(CARD\s*GAME|TCG|PLAYMAT|PREMIUM\s+CARD|STARTER\s+SET|ASSEMBLE|BOOSTER|STRUCTURE\s+DECK|CARD\s+COLLECTION|OFFICIAL\s+SLEEVE|DECK\s+CASE|BATTLE\s+SPIRITS|FUSION\s+WORLD)\b/i;

  const SLOP_BLOCK =
    /\b(T-?SHIRTS?|TEE\b|ACRYLIC|STANDEES?|STAND\b|CHARMS?|PINS?\b|BRIEF|BOXER|HAT\b|CAP\b|NEW\s+ERA|COSTUME|KEYCHAINS?|TOWELS?|MUGS?|BAGS?\b|POUCH|WALLET|SOCKS?|JACKETS?|HOODIES?|MA-1|FIGURES?|NENDOROID|POSTER|BADGE|LANYARD|UMBRELLA|CUSHION|BLANKET)\b/i;

  const SET_DEFS = [
    { id: "gundam", label: "Gundam Card Game", re: /GUNDAM\s+CARD\s+GAME|GUNDAM\s+ASSEMBLE/i },
    { id: "onepiece", label: "One Piece Card Game", re: /ONE\s+PIECE\s+CARD\s+GAME/i },
    { id: "digimon", label: "Digimon Card Game", re: /DIGIMON\s+CARD\s+GAME/i },
    { id: "dragonball", label: "Dragon Ball", re: /DRAGON\s+BALL.*(CARD|FUSION\s+WORLD)|FUSION\s+WORLD/i },
    { id: "battle_spirits", label: "Battle Spirits", re: /BATTLE\s+SPIRITS/i },
  ];

  function coerceTitle(value) {
    if (value == null) return "";
    if (typeof value === "string") {
      const t = value.trim();
      if (!t || t === "[object Object]") return "";
      return t;
    }
    if (typeof value === "object") {
      const v =
        value.en ||
        value["en-AU"] ||
        value["en-US"] ||
        value.fr ||
        value.ja ||
        Object.values(value).find((x) => typeof x === "string" && x.trim());
      return String(v || "").trim();
    }
    const s = String(value).trim();
    return s === "[object Object]" ? "" : s;
  }

  function rowTitle(row) {
    return coerceTitle(row?.title) || String(row?.sku || "").trim();
  }

  function isTcgTitle(title) {
    const t = coerceTitle(title);
    if (!t) return false;
    if (SLOP_BLOCK.test(t) && !TCG_ALLOW.test(t)) return false;
    return TCG_ALLOW.test(t);
  }

  function isSlopTitle(title) {
    const t = coerceTitle(title);
    if (!t) return true;
    if (isTcgTitle(t)) return false;
    return SLOP_BLOCK.test(t) || t === "[object Object]";
  }

  function inferSet(title) {
    const t = coerceTitle(title);
    for (const def of SET_DEFS) {
      if (def.re.test(t)) return def.id;
    }
    if (isTcgTitle(t)) return "other_tcg";
    return "other";
  }

  function setLabel(id) {
    if (id === "other_tcg") return "Other TCG";
    if (id === "other") return "Other";
    const hit = SET_DEFS.find((d) => d.id === id);
    return hit ? hit.label : id;
  }

  function parseKeywordList(raw) {
    return String(raw || "")
      .split(/[\n,]+/)
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean)
      .slice(0, 40);
  }

  function matchesKeywords(hay, keywords, mode) {
    if (!keywords.length) return mode === "block" ? true : true;
    const h = String(hay || "").toLowerCase();
    const hit = keywords.some((k) => h.includes(k));
    if (mode === "block") return !hit;
    if (mode === "require") return hit;
    return true;
  }

  /**
   * @param {object[]} rows
   * @param {{
   *   search?: string,
   *   store?: string,
   *   set?: string,
   *   tcgOnly?: boolean,
   *   blockKeywords?: string,
   *   requireKeywords?: string,
   * }} filters
   */
  function filterCatalogRows(rows, filters = {}) {
    const list = Array.isArray(rows) ? rows : [];
    const search = String(filters.search || "").trim().toLowerCase();
    const store = String(filters.store || "").trim().toLowerCase();
    const set = String(filters.set || "").trim().toLowerCase();
    const tcgOnly = filters.tcgOnly !== false;
    const block = parseKeywordList(filters.blockKeywords);
    const require = parseKeywordList(filters.requireKeywords);

    return list.filter((r) => {
      if (r?.enabled === false) return false;
      const title = rowTitle(r);
      const sku = String(r?.sku || "");
      const hay = `${title} ${sku}`;

      if (tcgOnly && !isTcgTitle(title)) return false;
      if (!matchesKeywords(hay, block, "block")) return false;
      if (require.length && !matchesKeywords(hay, require, "require")) return false;

      if (store && String(r?.store || "bandai").toLowerCase() !== store) return false;
      if (set && inferSet(title) !== set) return false;

      if (search) {
        const tokens = search.split(/\s+/).filter(Boolean);
        if (!tokens.every((tok) => hay.toLowerCase().includes(tok))) return false;
      }
      return true;
    });
  }

  function uniqueStores(rows) {
    const s = new Set();
    for (const r of rows || []) {
      if (r?.enabled === false) continue;
      s.add(String(r.store || "bandai").toLowerCase());
    }
    return [...s].sort();
  }

  function uniqueSets(rows, { tcgOnly = true } = {}) {
    const counts = new Map();
    for (const r of rows || []) {
      if (r?.enabled === false) continue;
      const title = rowTitle(r);
      if (tcgOnly && !isTcgTitle(title)) continue;
      const id = inferSet(title);
      counts.set(id, (counts.get(id) || 0) + 1);
    }
    return [...counts.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([id, count]) => ({ id, label: setLabel(id), count }));
  }

  const api = {
    TCG_ALLOW,
    SLOP_BLOCK,
    SET_DEFS,
    coerceTitle,
    rowTitle,
    isTcgTitle,
    isSlopTitle,
    inferSet,
    setLabel,
    parseKeywordList,
    filterCatalogRows,
    uniqueStores,
    uniqueSets,
  };

  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
  root.CatalogFilters = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
