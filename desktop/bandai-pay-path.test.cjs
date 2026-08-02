const test = require("node:test");
const assert = require("node:assert/strict");
const { resolveDesktopBandaiPayPath } = require("./bandai-pay-path.cjs");

test("fast default unchanged — page issuer product path", () => {
  const p = resolveDesktopBandaiPayPath({ bandaiCheckoutMode: "fast" }, { placeOrder: true, mode: "checkout" });
  assert.equal(p.bandaiCheckoutMode, "fast");
  assert.equal(p.bandaiGeHttpPay, true);
  assert.equal(p.bandaiGePreferPageIssuer, true);
  assert.equal(p.bandaiGeUndiciIssuer, false);
  assert.notEqual(p.bandaiGeHttpPayTest, true);
});

test("autocheckout_test uses experimental fork flag", () => {
  const p = resolveDesktopBandaiPayPath(
    { bandaiCheckoutMode: "autocheckout_test" },
    { placeOrder: true, mode: "checkout" },
  );
  assert.equal(p.bandaiCheckoutMode, "autocheckout_test");
  assert.equal(p.bandaiGeHttpPay, true);
  assert.equal(p.bandaiGeHttpPayTest, true);
  assert.equal(p.bandaiGeUndiciIssuer, true);
});
