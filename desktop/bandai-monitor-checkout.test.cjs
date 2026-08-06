/**
 * Unit tests for Bandai monitor → checkout helpers (no network).
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const {
  shouldCheckoutOnMonitorHit,
  checkoutTargetFromHit,
  taskForMonitorCheckout,
} = require("./bandai-monitor-checkout.cjs");

test("shouldCheckoutOnMonitorHit defaults to placeOrder for monitor tasks", () => {
  assert.equal(shouldCheckoutOnMonitorHit({ bandaiMode: "monitor" }, true), true);
  assert.equal(shouldCheckoutOnMonitorHit({ bandaiMode: "monitor" }, false), false);
  assert.equal(shouldCheckoutOnMonitorHit({ bandaiMode: "checkout" }, true), false);
  assert.equal(
    shouldCheckoutOnMonitorHit(
      { bandaiMode: "monitor", lastStatus: "declined", bandaiCheckoutOnHit: true },
      true,
    ),
    false,
  );
  assert.equal(
    shouldCheckoutOnMonitorHit({ bandaiMode: "monitor", bandaiCheckoutOnHit: false }, true),
    false,
  );
  assert.equal(
    shouldCheckoutOnMonitorHit({ bandaiMode: "monitor", bandaiCheckoutOnHit: true }, false),
    true,
  );
});

test("checkoutTargetFromHit builds AU PDP", () => {
  const t = checkoutTargetFromHit({ productId: "N2542159011", title: "Test" }, "au");
  assert.equal(t.ok, true);
  assert.equal(t.pdpUrl, "https://p-bandai.com/au/item/N2542159011");
  assert.equal(checkoutTargetFromHit({}, "au").ok, false);
});

test("taskForMonitorCheckout switches mode and sets pdp", () => {
  const out = taskForMonitorCheckout(
    {
      id: "t1",
      bandaiMode: "monitor",
      bandaiWatchKeywords: "ONE PIECE",
      bandaiArea: "au",
    },
    { productId: "N2903432003", reason: "restock", title: "OP fig" },
  );
  assert.equal(out.ok, true);
  assert.equal(out.task.bandaiMode, "checkout");
  assert.equal(out.task.pdpUrl, "https://p-bandai.com/au/item/N2903432003");
  assert.equal(out.task._monitorHit.productId, "N2903432003");
});
