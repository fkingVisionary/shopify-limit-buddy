// node --test desktop/store-groups.test.cjs
const { test } = require("node:test");
const assert = require("node:assert/strict");
const {
  normalizeStoreGroup,
  cloneStoreGroup,
  findStoreGroup,
  storeIdsForGroup,
  normalizeStoreId,
} = require("./store-groups.cjs");

test("normalizeStoreGroup coerces stores + aliases", () => {
  const g = normalizeStoreGroup(
    { name: "TCG", stores: ["bandai", "POKEMON", "pokemoncentre", "nope"] },
    () => "sg_1",
  );
  assert.equal(g.id, "sg_1");
  assert.deepEqual(g.stores, ["bandai", "pokemoncentre"]);
});

test("cloneStoreGroup copies with (copy) suffix", () => {
  let n = 0;
  const src = normalizeStoreGroup(
    { id: "sg_a", name: "Main", stores: ["bandai", "kmart"] },
    () => "sg_a",
  );
  const copy = cloneStoreGroup(src, () => `sg_c${++n}`);
  assert.notEqual(copy.id, src.id);
  assert.equal(copy.name, "Main (copy)");
  assert.deepEqual(copy.stores, ["bandai", "kmart"]);
});

test("findStoreGroup + storeIdsForGroup by id or name", () => {
  const groups = [
    normalizeStoreGroup({ id: "sg_1", name: "AU TCG", stores: ["bandai", "toymate"] }, () => "sg_1"),
  ];
  assert.equal(findStoreGroup(groups, "sg_1")?.name, "AU TCG");
  assert.equal(findStoreGroup(groups, "au tcg")?.id, "sg_1");
  const set = storeIdsForGroup(groups, "AU TCG");
  assert.equal(set.has("bandai"), true);
  assert.equal(set.has("kmart"), false);
});

test("normalizeStoreId", () => {
  assert.equal(normalizeStoreId("Bandai"), "bandai");
  assert.equal(normalizeStoreId("pokemoncenter"), "pokemoncentre");
  assert.equal(normalizeStoreId("xyz"), "");
});
