const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { taskMatchesEvent } = require("./global-matcher.cjs");

describe("taskMatchesEvent", () => {
  const baseEvt = {
    store: "kmart",
    type: "restock",
    title: "Pokemon TCG ETB",
    url: "https://www.kmart.com.au/product/pokemon-etb-43671588/",
    sku: "43671588",
    inStock: true,
  };

  it("matches global keyword tasks", () => {
    const task = {
      monitorEnabled: true,
      monitorSource: "global",
      monitorInput: "pokemon,etb,-plush",
      lastStatus: "monitoring",
    };
    assert.equal(taskMatchesEvent(task, baseEvt), true);
  });

  it("ignores private tasks", () => {
    const task = {
      monitorEnabled: true,
      monitorSource: "private",
      monitorInput: "pokemon,etb",
      lastStatus: "monitoring",
    };
    assert.equal(taskMatchesEvent(task, baseEvt), false);
  });

  it("matches sku input", () => {
    const task = {
      monitorEnabled: true,
      monitorSource: "global",
      monitorInput: "43671588",
      lastStatus: "monitoring",
    };
    assert.equal(taskMatchesEvent(task, baseEvt), true);
  });
});
