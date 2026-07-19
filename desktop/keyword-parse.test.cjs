const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const {
  parseKeywords,
  matchKeywords,
  classifyMonitorInput,
  normalizeKmartPdpUrl,
} = require("./keyword-parse.cjs");

describe("parseKeywords", () => {
  it("parses AND positives and negatives", () => {
    const ast = parseKeywords("pokemon,etb,-plush,-sock");
    assert.deepEqual(ast.groups, [["pokemon"], ["etb"]]);
    assert.deepEqual(ast.negatives, ["plush", "sock"]);
  });

  it("parses OR within a slot", () => {
    const ast = parseKeywords("pokemon/pokémon,elite/etb,-plush");
    assert.deepEqual(ast.groups, [
      ["pokemon", "pokémon"],
      ["elite", "etb"],
    ]);
    assert.deepEqual(ast.negatives, ["plush"]);
  });

  it("ignores optional + prefix", () => {
    const ast = parseKeywords("+jordan,+1,-gs");
    assert.deepEqual(ast.groups, [["jordan"], ["1"]]);
    assert.deepEqual(ast.negatives, ["gs"]);
  });
});

describe("matchKeywords", () => {
  it("requires all positive groups", () => {
    const ast = parseKeywords("pokemon,etb,-plush");
    assert.equal(
      matchKeywords(ast, { title: "Pokemon TCG ETB Elite Trainer Box" }).ok,
      true,
    );
    assert.equal(matchKeywords(ast, { title: "Pokemon Plush" }).ok, false);
    assert.equal(matchKeywords(ast, { title: "Random ETB" }).ok, false);
  });

  it("matches sku/url when title lacks tokens", () => {
    const ast = parseKeywords("43671588");
    assert.equal(
      matchKeywords(ast, { title: "Sticker Pad", sku: "43671588" }).ok,
      true,
    );
  });

  it("rejects on negative in title", () => {
    const ast = parseKeywords("pokemon,-plush");
    assert.equal(matchKeywords(ast, { title: "Pokemon Plush Toy" }).ok, false);
  });
});

describe("classifyMonitorInput", () => {
  it("detects url, sku, keywords", () => {
    assert.equal(
      classifyMonitorInput("https://www.kmart.com.au/product/x-12345678/").kind,
      "url",
    );
    assert.equal(classifyMonitorInput("43671588").kind, "sku");
    assert.equal(classifyMonitorInput("pokemon,etb").kind, "keywords");
  });
});

describe("normalizeKmartPdpUrl", () => {
  it("builds url from keycode", () => {
    assert.equal(
      normalizeKmartPdpUrl("43671588"),
      "https://www.kmart.com.au/product/item-43671588/",
    );
  });
});
