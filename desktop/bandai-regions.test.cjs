// node --test desktop/bandai-regions.test.cjs
const { test } = require("node:test");
const assert = require("node:assert/strict");
const {
  BANDAI_REGIONS,
  parseBandaiStoreSelection,
  bandaiStoreSelectValue,
  rewriteBandaiPdpArea,
  normalizeBandaiAreaCode,
  isBandaiStoreId,
} = require("./bandai-regions.cjs");

test("supported regions exclude jp", () => {
  assert.deepEqual([...BANDAI_REGIONS], ["au", "us", "nz", "sg", "hk", "tw", "fr"]);
  assert.equal(normalizeBandaiAreaCode("jp"), null);
  assert.equal(normalizeBandaiAreaCode("US"), "us");
});

test("parseBandaiStoreSelection normalizes modules", () => {
  assert.deepEqual(parseBandaiStoreSelection("bandai-us"), {
    store: "bandai",
    bandaiArea: "us",
  });
  assert.deepEqual(parseBandaiStoreSelection("bandai", "fr"), {
    store: "bandai",
    bandaiArea: "fr",
  });
  assert.equal(parseBandaiStoreSelection("toymate").store, "toymate");
  assert.equal(isBandaiStoreId("bandai-hk"), true);
  assert.equal(isBandaiStoreId("toymate"), false);
});

test("bandaiStoreSelectValue + PDP rewrite", () => {
  assert.equal(
    bandaiStoreSelectValue({ store: "bandai", bandaiArea: "sg" }),
    "bandai-sg",
  );
  assert.equal(
    rewriteBandaiPdpArea("https://p-bandai.com/au/item/N1", "us"),
    "https://p-bandai.com/us/item/N1",
  );
});
