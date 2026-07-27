/**
 * Integration: monitor handoff helpers + harvest claim shape (no Electron).
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const {
  shouldCheckoutOnMonitorHit,
  taskForMonitorCheckout,
} = require("./bandai-monitor-checkout.cjs");

test("monitor handoff builds checkout task ready for harvest claim", () => {
  const monTask = {
    id: "t-mon",
    store: "bandai",
    bandaiMode: "monitor",
    bandaiWatchSku: "N2542159011",
    bandaiCheckoutOnHit: true,
    bandaiArea: "au",
  };
  assert.equal(shouldCheckoutOnMonitorHit(monTask, true), true);

  const hit = { productId: "N2542159011", inStock: true, reason: "restock" };
  const switched = taskForMonitorCheckout(monTask, hit, "au");
  assert.equal(switched.ok, true);

  const harvestSession = {
    id: "bf5_test",
    proxy: "http://u:p@proxy.example:8000",
    proxyHost: "proxy.example",
    harvestedAt: Date.now() - 1000,
  };
  switched.task.harvestedBridgeId = harvestSession.id;
  switched.task.harvestedProxy = harvestSession.proxy;

  assert.equal(switched.task.bandaiMode, "checkout");
  assert.equal(switched.task.harvestedBridgeId, "bf5_test");
  assert.ok(switched.task.pdpUrl.includes("N2542159011"));
});
