const test = require("node:test");
const assert = require("node:assert/strict");
const {
  shouldCheckoutOnMonitorHit,
  taskForMonitorCheckout,
} = require("./pokemoncentre-monitor-checkout.cjs");

test("shouldCheckoutOnMonitorHit defaults to placeOrder", () => {
  assert.equal(
    shouldCheckoutOnMonitorHit({ pcMode: "monitor" }, true),
    true,
  );
  assert.equal(
    shouldCheckoutOnMonitorHit({ pcMode: "monitor" }, false),
    false,
  );
  assert.equal(
    shouldCheckoutOnMonitorHit({ pcMode: "monitor", pcCheckoutOnHit: false }, true),
    false,
  );
  assert.equal(
    shouldCheckoutOnMonitorHit({ pcMode: "checkout" }, true),
    false,
  );
});

test("taskForMonitorCheckout switches to checkout", () => {
  const out = taskForMonitorCheckout(
    { store: "pokemoncentre", pcMode: "monitor", pdpUrl: "https://www.pokemoncenter.com/en-au/product/abc" },
    { sku: "abc", title: "Pikachu", purchaseAvailable: true },
  );
  assert.equal(out.ok, true);
  assert.equal(out.task.pcMode, "checkout");
  assert.equal(out.task.sku, "abc");
  assert.equal(out.target.sku, "abc");
});
