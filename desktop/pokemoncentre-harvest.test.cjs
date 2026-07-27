const test = require("node:test");
const assert = require("node:assert/strict");
const {
  createPokemonCentreHarvestPool,
  toProxyUrl,
} = require("./pokemoncentre-harvest.cjs");

test("empty bank take() returns null (cold checkout path)", () => {
  const pool = createPokemonCentreHarvestPool({
    sidecar: { status: () => ({ running: false }) },
    emit: () => {},
  });
  assert.equal(pool.take(), null);
  assert.equal(pool.snapshot().ready, 0);
  assert.equal(pool.snapshot().paused, false);
});

test("harvestOne banks session; take is single-use; reclaim restores", async () => {
  const events = [];
  const pool = createPokemonCentreHarvestPool({
    sidecar: {
      status: () => ({ running: true }),
      harvestPokemonCentre: async () => ({
        ok: true,
        ms: 12,
        session: {
          id: "pch_test1",
          proxy: "http://u:p@1.2.3.4:8000",
          proxyHost: "1.2.3.4",
          userAgent: "Mozilla/5.0",
          cookies: { reese84: "x".repeat(40), datadome: "ddcookie12" },
          captchaToken: null,
          harvestedAt: Date.now(),
          edgeExpiresAt: Date.now() + 180_000,
          warmNote: "home clear after DD+reese",
        },
      }),
    },
    emit: (e) => events.push(e),
  });

  pool.configure({ proxyGroupId: "px1", desired: 1 });
  const minted = await pool.harvestOne(["host:8000:u:p"]);
  assert.equal(minted.ok, true);
  assert.equal(pool.snapshot().ready, 1);
  assert.ok(events.some((e) => e.type === "pokemoncentreHarvest"));

  const claimed = pool.take();
  assert.ok(claimed);
  assert.match(claimed.cookies.reese84, /x{40}/);
  assert.equal(pool.take(), null, "single-use");
  assert.equal(pool.snapshot().ready, 0);

  pool.reclaim(claimed);
  assert.equal(pool.snapshot().ready, 1);
  assert.ok(pool.take()?.id === "pch_test1");
});

test("pause skips refill while running", async () => {
  let harvestCalls = 0;
  const pool = createPokemonCentreHarvestPool({
    sidecar: {
      status: () => ({ running: true }),
      harvestPokemonCentre: async () => {
        harvestCalls += 1;
        return {
          ok: true,
          session: {
            cookies: { reese84: "r".repeat(40), datadome: "dd" },
            edgeExpiresAt: Date.now() + 180_000,
            harvestedAt: Date.now(),
          },
        };
      },
    },
  });
  pool.start({ desired: 2, getEntries: () => ["h:1:u:p"] });
  // Allow first tick
  await new Promise((r) => setTimeout(r, 30));
  const before = harvestCalls;
  pool.pause();
  assert.equal(pool.snapshot().paused, true);
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(harvestCalls, before, "no refill while paused");
  pool.stop();
});

test("stale edge cookies are not banked", async () => {
  const pool = createPokemonCentreHarvestPool({
    sidecar: {
      status: () => ({ running: true }),
      harvestPokemonCentre: async () => ({
        ok: true,
        session: {
          cookies: { reese84: "short", datadome: "x" },
          edgeExpiresAt: Date.now() + 180_000,
        },
      }),
    },
  });
  const out = await pool.harvestOne(["http://u:p@host:1"]);
  assert.equal(out.ok, false);
  assert.equal(pool.take(), null);
});

test("toProxyUrl normalizes host:port:user:pass", () => {
  const u = toProxyUrl("1.2.3.4:8000:user:pass");
  assert.match(u, /^http:\/\//);
  assert.match(u, /1\.2\.3\.4:8000/);
});
