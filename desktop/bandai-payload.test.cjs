// node --test desktop/bandai-payload.test.cjs
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { resolveDesktopBandaiPayPath } = require("./bandai-pay-path.cjs");

test("Fast placeOrder enables HTTP GE + riskHydrate + undici issuer (bible)", () => {
  const r = resolveDesktopBandaiPayPath(
    { bandaiCheckoutMode: "fast" },
    { mode: "checkout", placeOrder: true },
  );
  assert.equal(r.bandaiCheckoutMode, "fast");
  assert.equal(r.bandaiGeHttpPay, true);
  assert.equal(r.bandaiBrowserCheckout, false);
  assert.equal(r.bandaiGeRiskHydrate, true);
  assert.equal(r.bandaiGeNoPage, false);
  assert.equal(r.bandaiGePreferPageIssuer, false);
  assert.equal(r.bandaiGeUndiciIssuer, true);
});

test("explicit page issuer opt-in", () => {
  const r = resolveDesktopBandaiPayPath(
    { bandaiCheckoutMode: "fast", bandaiGePreferPageIssuer: true },
    { mode: "checkout", placeOrder: true },
  );
  assert.equal(r.bandaiGePreferPageIssuer, true);
  assert.equal(r.bandaiGeUndiciIssuer, false);
});

test("fast_undici A/B keeps undici issuer", () => {
  const r = resolveDesktopBandaiPayPath(
    { bandaiCheckoutMode: "fast_undici" },
    { mode: "checkout", placeOrder: true },
  );
  assert.equal(r.bandaiCheckoutMode, "fast_undici");
  assert.equal(r.bandaiGeHttpPay, true);
  assert.equal(r.bandaiGeRiskHydrate, true);
  assert.equal(r.bandaiGePreferPageIssuer, false);
  assert.equal(r.bandaiGeUndiciIssuer, true);
});

test("Safe placeOrder uses Playwright GE, not HTTP issuer", () => {
  const r = resolveDesktopBandaiPayPath(
    { bandaiCheckoutMode: "safe" },
    { mode: "checkout", placeOrder: true },
  );
  assert.equal(r.bandaiCheckoutMode, "safe");
  assert.equal(r.bandaiGeHttpPay, false);
  assert.equal(r.bandaiBrowserCheckout, true);
  assert.equal(r.bandaiGeRiskHydrate, undefined);
  assert.equal(r.bandaiGeNoPage, undefined);
});

test("dry-run checkout does not enable pay paths", () => {
  const r = resolveDesktopBandaiPayPath(
    { bandaiCheckoutMode: "fast" },
    { mode: "checkout", placeOrder: false },
  );
  assert.equal(r.bandaiGeHttpPay, false);
  assert.equal(r.bandaiBrowserCheckout, false);
  assert.equal(r.bandaiGeRiskHydrate, undefined);
});

test("explicit bandaiGeNoPage opts out of riskHydrate", () => {
  const r = resolveDesktopBandaiPayPath(
    { bandaiCheckoutMode: "fast", bandaiGeNoPage: true },
    { mode: "checkout", placeOrder: true },
  );
  assert.equal(r.bandaiGeNoPage, true);
  assert.equal(r.bandaiGeRiskHydrate, false);
  assert.equal(r.bandaiGeHttpPay, true);
  assert.equal(r.bandaiGePreferPageIssuer, false);
  assert.equal(r.bandaiGeUndiciIssuer, true);
});
