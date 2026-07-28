// node --test desktop/smart-actions-keywords.test.cjs
const { test } = require("node:test");
const assert = require("node:assert/strict");
const {
  parseKeywordPattern,
  matchKeywordPattern,
  matchFilter,
  matchAllFilters,
} = require("./smart-actions-keywords.cjs");

test("comma AND + slash OR + negative", () => {
  assert.equal(matchKeywordPattern("Gundam RX-78", "gundam"), true);
  assert.equal(matchKeywordPattern("Gundam RX-78", "gundam, rx"), true);
  assert.equal(matchKeywordPattern("Gundam RX-78", "gundam, zz"), false);
  assert.equal(matchKeywordPattern("Gundam HG kit", "gundam, hg/mg"), true);
  assert.equal(matchKeywordPattern("Gundam PG kit", "gundam, hg/mg"), false);
  assert.equal(matchKeywordPattern("Gundam RG kit", "gundam, -rg"), false);
  assert.equal(matchKeywordPattern("Gundam MG kit", "gundam, -rg/hg"), true);
});

test("empty pattern always matches", () => {
  assert.equal(matchKeywordPattern("anything", ""), true);
  assert.equal(matchKeywordPattern("anything", "   "), true);
  assert.deepEqual(parseKeywordPattern("").groups, []);
});

test("filters AND; empty list always runs", () => {
  const ctx = {
    store: "bandai",
    title: "ONE PIECE figure",
    sku: "N2890904001",
    url: "https://p-bandai.com/au/item/N2890904001",
    reason: "restock",
  };
  assert.equal(matchAllFilters([], ctx).ok, true);
  assert.equal(
    matchAllFilters([{ field: "sku", op: "matches", value: "N2890904001" }], ctx).ok,
    true,
  );
  assert.equal(
    matchAllFilters(
      [
        { field: "sku", op: "matches", value: "N2890904001" },
        { field: "title", op: "matches", value: "gundam" },
      ],
      ctx,
    ).ok,
    false,
  );
  assert.equal(matchFilter({ field: "reason", op: "equals", value: "restock" }, ctx), true);
  assert.equal(matchFilter({ field: "title", value: "" }, ctx), true);
});
