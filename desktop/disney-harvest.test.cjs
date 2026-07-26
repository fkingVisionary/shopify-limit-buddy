const test = require("node:test");
const assert = require("node:assert/strict");
const { createDisneyHarvestPool, toProxyUrl } = require("./disney-harvest.cjs");

test("empty bank take() returns null (cold checkout path)", () => {
  const pool = createDisneyHarvestPool({
    sidecar: { status: () => ({ running: false }) },
    emit: () => {},
  });
  assert.equal(pool.take(), null);
  assert.equal(pool.snapshot().ready, 0);
  assert.equal(pool.snapshot().readyWithCaptcha, 0);
});

test("harvestOne banks session; take prefers captcha and is single-use", async () => {
  const events = [];
  const pool = createDisneyHarvestPool({
    sidecar: {
      status: () => ({ running: true }),
      harvestDisney: async () => ({
        ok: true,
        ms: 12,
        session: {
          id: "dhv_test1",
          proxy: "http://u:p@1.2.3.4:8000",
          proxyHost: "1.2.3.4",
          userAgent: "Mozilla/5.0",
          cookies: { _abck: "aaa~0~bbb", bm_sz: "x" },
          captchaToken: "captcha-tok",
          harvestedAt: Date.now(),
          abckExpiresAt: Date.now() + 180_000,
          captchaExpiresAt: Date.now() + 100_000,
          warmNote: "warm ok",
          captchaNote: "cap ok",
        },
      }),
    },
    emit: (e) => events.push(e),
  });

  pool.configure({ proxyGroupId: "px1", desired: 1, solveCaptcha: true });
  const minted = await pool.harvestOne(["host:8000:u:p"]);
  assert.equal(minted.ok, true);
  assert.equal(pool.snapshot().ready, 1);
  assert.equal(pool.snapshot().readyWithCaptcha, 1);
  assert.ok(events.some((e) => e.type === "disneyHarvest"));

  const claimed = pool.take({ preferCaptcha: true });
  assert.ok(claimed);
  assert.equal(claimed.captchaToken, "captcha-tok");
  assert.match(claimed.cookies._abck, /~0~/);
  assert.equal(pool.take(), null, "single-use — second take is empty (cold path)");
  assert.equal(pool.snapshot().ready, 0);
});

test("stale _abck is not banked; harvest fails closed into cold path", async () => {
  const pool = createDisneyHarvestPool({
    sidecar: {
      status: () => ({ running: true }),
      harvestDisney: async () => ({
        ok: true,
        session: {
          cookies: { _abck: "no-ind-zero" },
          abckExpiresAt: Date.now() + 180_000,
        },
      }),
    },
  });
  const out = await pool.harvestOne(["http://u:p@host:1"]);
  assert.equal(out.ok, false);
  assert.equal(pool.take(), null);
});

test("toProxyUrl normalizes host:port:user:pass", () => {
  const u = toProxyUrl("1.2.3.4:8000:user:p%ass");
  assert.match(u, /^http:\/\//);
  assert.match(u, /1\.2\.3\.4:8000/);
});
