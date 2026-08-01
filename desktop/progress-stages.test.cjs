const test = require("node:test");
const assert = require("node:assert/strict");

test("Bandai steps map to live stages", async () => {
  const { stageForStep, stageMeta } = await import("../executor/progress.js");
  assert.equal(stageForStep("login"), "login");
  assert.equal(stageForStep("f5_bridge"), "login");
  assert.equal(stageForStep("product_get"), "product");
  assert.equal(stageForStep("addToCart"), "cart");
  assert.equal(stageForStep("cart_detail"), "details");
  assert.equal(stageForStep("ge_payment"), "tokenize");
  assert.equal(stageMeta("login").label, "Logging in");
  assert.equal(stageMeta("details").label, "Checking out");
});

test("consumer progress prefers Bandai labels", () => {
  const { consumerProgressMessage, LIVE } = require("./consumer-status.cjs");
  assert.equal(consumerProgressMessage({ stage: "login", label: "Logging in" }), LIVE.login);
  assert.equal(
    consumerProgressMessage({ stage: "warm", label: "Rotating proxy" }),
    LIVE.switching,
  );
  assert.equal(consumerProgressMessage({ stage: "details" }), LIVE.details);
});
