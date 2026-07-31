/**
 * Smart Actions Store Groups — named lists of store IDs for SA filters/targets.
 */

const KNOWN_STORES = Object.freeze([
  "bandai",
  "kmart",
  "toymate",
  "disney",
  "pokemoncentre",
  "pokemon",
]);

const STORE_ALIASES = Object.freeze({
  pokemoncenter: "pokemoncentre",
  pokemon: "pokemoncentre",
});

function normalizeStoreId(raw) {
  let s = String(raw || "")
    .trim()
    .toLowerCase();
  if (!s) return "";
  if (STORE_ALIASES[s]) s = STORE_ALIASES[s];
  if (!KNOWN_STORES.includes(s) && s !== "pokemoncentre") {
    // Allow known list + pokemoncentre canonical
    if (!["bandai", "kmart", "toymate", "disney", "pokemoncentre"].includes(s)) {
      return "";
    }
  }
  return s === "pokemon" ? "pokemoncentre" : s;
}

function normalizeStoreList(raw) {
  const list = Array.isArray(raw)
    ? raw
    : String(raw || "")
        .split(/[\n,]+/)
        .map((s) => s.trim());
  const out = [];
  const seen = new Set();
  for (const item of list) {
    const id = normalizeStoreId(item);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out.slice(0, 20);
}

/**
 * @param {object} raw
 * @param {(prefix?: string) => string} [idFn]
 */
function normalizeStoreGroup(raw = {}, idFn) {
  const now = Date.now();
  const id =
    String(raw.id || "").trim() ||
    (typeof idFn === "function" ? idFn("sg") : `sg_${now.toString(36)}`);
  const name = String(raw.name || "Untitled store group").trim().slice(0, 80) || "Untitled store group";
  const stores = normalizeStoreList(raw.stores);
  const color = String(raw.color || "").trim().slice(0, 32);
  return {
    id,
    name,
    stores,
    color,
    createdAt: raw.createdAt || now,
    updatedAt: now,
  };
}

function cloneStoreGroup(group, idFn) {
  const base = normalizeStoreGroup(group, idFn);
  const name = / \(copy\)$/i.test(base.name) ? base.name : `${base.name} (copy)`;
  return normalizeStoreGroup(
    {
      ...base,
      id: typeof idFn === "function" ? idFn("sg") : `sg_${Date.now().toString(36)}`,
      name: name.slice(0, 80),
      createdAt: Date.now(),
    },
    idFn,
  );
}

function findStoreGroup(groups, key) {
  const k = String(key || "").trim().toLowerCase();
  if (!k) return null;
  const list = Array.isArray(groups) ? groups : [];
  return (
    list.find((g) => String(g.id || "").toLowerCase() === k) ||
    list.find((g) => String(g.name || "").trim().toLowerCase() === k) ||
    null
  );
}

function storeIdsForGroup(groups, key) {
  const g = findStoreGroup(groups, key);
  return new Set((g?.stores || []).map((s) => String(s).toLowerCase()));
}

module.exports = {
  KNOWN_STORES,
  normalizeStoreId,
  normalizeStoreList,
  normalizeStoreGroup,
  cloneStoreGroup,
  findStoreGroup,
  storeIdsForGroup,
};
