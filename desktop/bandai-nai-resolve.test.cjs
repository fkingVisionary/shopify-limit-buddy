/**
 * Unit tests for Bandai NAI pick / monitor handoff (no network).
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const {
  pickAreaItemNo,
  isBackendAreaItemNo,
  isFrontendProductCode,
  areaItemNoFromHit,
} = require("./bandai-nai-resolve.cjs");
const {
  taskForMonitorCheckout,
  checkoutTargetFromHit,
} = require("./bandai-monitor-checkout.cjs");
const { createBandaiHarvestPool } = require("./bandai-harvest.cjs");

test("isBackendAreaItemNo / isFrontendProductCode", () => {
  assert.equal(isBackendAreaItemNo("NAI0868879AU"), true);
  assert.equal(isBackendAreaItemNo("N2542159011"), false);
  assert.equal(isFrontendProductCode("N2542159011"), true);
  assert.equal(isFrontendProductCode("NAI0868879AU"), false);
});

test("pickAreaItemNo prefers explicit backend PID", () => {
  assert.equal(
    pickAreaItemNo({
      bandaiAreaItemNo: "NAI0868879AU",
      areaItemNos: ["NAI999"],
    }),
    "NAI0868879AU",
  );
  assert.equal(
    pickAreaItemNo({
      hitAreaItemNo: "NAI0859145AU",
    }),
    "NAI0859145AU",
  );
});

test("areaItemNoFromHit reads meta / top-level", () => {
  assert.equal(
    areaItemNoFromHit({
      productId: "N2542159011",
      areaItemNos: ["NAI0868879AU"],
    }),
    "NAI0868879AU",
  );
  assert.equal(
    areaItemNoFromHit({
      productId: "N2542159011",
      meta: { areaItemNo: "NAI0868879AU" },
    }),
    "NAI0868879AU",
  );
});

test("taskForMonitorCheckout carries pre-resolved NAI", () => {
  const out = taskForMonitorCheckout(
    {
      id: "t1",
      bandaiMode: "monitor",
      bandaiAreaItemNo: "NAI0868879AU",
      bandaiArea: "au",
    },
    { productId: "N2542159011", reason: "restock" },
  );
  assert.equal(out.ok, true);
  assert.equal(out.task.bandaiMode, "checkout");
  assert.equal(out.task.bandaiAreaItemNo, "NAI0868879AU");
  assert.equal(out.target.areaItemNo, "NAI0868879AU");
});

test("checkoutTargetFromHit includes hit areaItemNo", () => {
  const t = checkoutTargetFromHit(
    { productId: "N2542159011", areaItemNo: "NAI0868879AU" },
    "au",
  );
  assert.equal(t.areaItemNo, "NAI0868879AU");
});

test("harvest pauseRefill / resumeRefill depth", () => {
  const pool = createBandaiHarvestPool({
    sidecar: { status: () => ({ running: false }) },
  });
  assert.equal(pool.snapshot().refillPaused, false);
  pool.pauseRefill();
  pool.pauseRefill();
  assert.equal(pool.snapshot().refillPaused, true);
  assert.equal(pool.snapshot().refillPauseDepth, 2);
  pool.resumeRefill();
  assert.equal(pool.snapshot().refillPauseDepth, 1);
  pool.resumeRefill();
  assert.equal(pool.snapshot().refillPaused, false);
  pool.resumeRefill(); // underflow guard
  assert.equal(pool.snapshot().refillPauseDepth, 0);
});
