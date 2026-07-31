const test = require("node:test");
const assert = require("node:assert/strict");
const {
  coerceTitle,
  isTcgTitle,
  isSlopTitle,
  inferSet,
  filterCatalogRows,
} = require("./renderer/catalog-filters.js");

test("coerceTitle reads Bandai localized objects", () => {
  assert.equal(coerceTitle({ en: "ONE PIECE CARD GAME Set" }), "ONE PIECE CARD GAME Set");
  assert.equal(coerceTitle("[object Object]"), "");
});

test("TCG vs slop", () => {
  assert.equal(isTcgTitle("GUNDAM CARD GAME 1st Anniversary Set"), true);
  assert.equal(isTcgTitle("DIGIMON CARD GAME Premium Heroines Set Ver. 2"), true);
  assert.equal(isTcgTitle("Mobile Suit Gundam Hathaway Acrylic Standees"), false);
  assert.equal(isSlopTitle("STRICT-G x NEW ERA Cap"), true);
});

test("inferSet", () => {
  assert.equal(inferSet("ONE PIECE CARD GAME Playmat"), "onepiece");
  assert.equal(inferSet("GUNDAM CARD GAME ASSEMBLE Starter"), "gundam");
});

test("filterCatalogRows tcg + search + block", () => {
  const rows = [
    { id: "1", store: "bandai", sku: "A", title: "GUNDAM CARD GAME Set", enabled: true },
    { id: "2", store: "bandai", sku: "B", title: "Acrylic Standee", enabled: true },
    { id: "3", store: "toymate", sku: "C", title: "ONE PIECE CARD GAME Playmat", enabled: true },
  ];
  const tcg = filterCatalogRows(rows, { tcgOnly: true });
  assert.equal(tcg.length, 2);
  const blocked = filterCatalogRows(rows, {
    tcgOnly: true,
    blockKeywords: "playmat",
  });
  assert.equal(blocked.length, 1);
  assert.equal(blocked[0].sku, "A");
  const store = filterCatalogRows(rows, { tcgOnly: true, store: "toymate" });
  assert.equal(store.length, 1);
  const search = filterCatalogRows(rows, { tcgOnly: true, search: "gundam" });
  assert.equal(search.length, 1);
});
