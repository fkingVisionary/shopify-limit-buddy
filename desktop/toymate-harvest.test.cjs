// Unit tests for Toymate harvest pool (parallel mint + bank claim).
// Run: node --test desktop/toymate-harvest.test.cjs

const { test } = require("node:test");
const assert = require("node:assert/strict");
const {
  createHarvestPool,
  MAX_DESIRED,
  MAX_PARALLEL,
  DEFAULT_PARALLEL,
} = require("./toymate-harvest.cjs");

function fakeSidecar({ delayMs = 20, failNth = 0 } = {}) {
  let n = 0;
  return {
    status: () => ({ running: true }),
    harvestToymate: async ({ proxy }) => {
      n += 1;
      await new Promise((r) => setTimeout(r, delayMs));
      if (failNth && n === failNth) {
        return { ok: false, error: "capsolver flake", ms: delayMs };
      }
      const harvestedAt = Date.now();
      return {
        ok: true,
        ms: delayMs,
        session: {
          id: `hv_test_${n}`,
          proxy,
          proxyHost: "proxy.test",
          userAgent: "ua",
          cookies: { cf_clearance: `c${n}` },
          captchaToken: `spam_${n}`,
          harvestedAt,
          cfExpiresAt: harvestedAt + 25 * 60_000,
          spamExpiresAt: harvestedAt + 100_000,
          cfNote: "ok",
          spamNote: "ok",
        },
      };
    },
  };
}

test("empty bank take() returns null (cold checkout path)", () => {
  const pool = createHarvestPool({ sidecar: fakeSidecar() });
  assert.equal(pool.take(), null);
});

test("configure clamps desired ≤ MAX_DESIRED and parallel ≤ MAX_PARALLEL", () => {
  const pool = createHarvestPool({ sidecar: fakeSidecar() });
  const snap = pool.configure({ desired: 999, parallel: 99 });
  assert.equal(snap.config.desired, MAX_DESIRED);
  assert.equal(snap.config.parallel, MAX_PARALLEL);
  assert.equal(DEFAULT_PARALLEL, 3);
});

test("take prefers spam-ready session and is single-use", () => {
  const pool = createHarvestPool({ sidecar: fakeSidecar() });
  const t = Date.now();
  // Inject via harvestOne with a sidecar that returns known rows — use start+tick.
  // Direct: push through harvest by calling harvestOne twice sequentially.
  return (async () => {
    const entries = ["1.2.3.4:8000:user:pass"];
    await pool.harvestOne(entries);
    await pool.harvestOne(entries);
    const snap = pool.snapshot();
    assert.ok(snap.ready >= 2);
    const a = pool.take({ preferSpam: true });
    assert.ok(a?.captchaToken);
    assert.ok(a.cfExpiresAt > t);
    const b = pool.take({ preferSpam: true });
    assert.ok(b?.id);
    assert.notEqual(a.id, b.id);
  })();
});

test("parallel start fills bank faster than serial (slots > 1)", async () => {
  const events = [];
  const sidecar = fakeSidecar({ delayMs: 40 });
  const pool = createHarvestPool({
    sidecar,
    emit: (e) => events.push(e),
  });
  const t0 = Date.now();
  pool.start({
    desired: 4,
    parallel: 4,
    solveSpam: true,
    getEntries: () => ["10.0.0.1:8000:u:p", "10.0.0.2:8000:u:p", "10.0.0.3:8000:u:p", "10.0.0.4:8000:u:p"],
  });
  // Wait for first tick wave to settle.
  for (let i = 0; i < 40; i++) {
    const s = pool.snapshot();
    if (s.ready >= 4 && s.inflight === 0) break;
    await new Promise((r) => setTimeout(r, 25));
  }
  pool.stop();
  const elapsed = Date.now() - t0;
  const snap = pool.snapshot();
  assert.ok(snap.ready >= 4, `expected ≥4 ready, got ${snap.ready}`);
  // Serial would be ~160ms+; parallel 4×40ms ≈ one wave.
  assert.ok(elapsed < 200, `parallel fill should finish under 200ms, took ${elapsed}ms`);
});

test("pauseRefill blocks tick mints until resume", async () => {
  const sidecar = fakeSidecar({ delayMs: 10 });
  const pool = createHarvestPool({ sidecar });
  pool.configure({ desired: 3, parallel: 2 });
  pool.pauseRefill();
  pool.start({
    desired: 3,
    parallel: 2,
    getEntries: () => ["10.0.0.1:8000:u:p"],
  });
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(pool.snapshot().ready, 0, "paused bank stays empty");
  assert.equal(pool.snapshot().refillPaused, true);
  pool.resumeRefill();
  // Force a tick by waiting for interval or calling start again.
  pool.stop();
  pool.start({
    desired: 2,
    parallel: 2,
    getEntries: () => ["10.0.0.1:8000:u:p", "10.0.0.2:8000:u:p"],
  });
  for (let i = 0; i < 30; i++) {
    if (pool.snapshot().ready >= 2) break;
    await new Promise((r) => setTimeout(r, 20));
  }
  pool.stop();
  assert.ok(pool.snapshot().ready >= 2);
});

test("failed mint increments failedCount and leaves bank usable", async () => {
  const sidecar = fakeSidecar({ delayMs: 5, failNth: 1 });
  const pool = createHarvestPool({ sidecar });
  const a = await pool.harvestOne(["10.0.0.1:8000:u:p"]);
  assert.equal(a.ok, false);
  assert.equal(pool.snapshot().failedCount, 1);
  const b = await pool.harvestOne(["10.0.0.1:8000:u:p"]);
  assert.equal(b.ok, true);
  assert.equal(pool.snapshot().ready, 1);
});
