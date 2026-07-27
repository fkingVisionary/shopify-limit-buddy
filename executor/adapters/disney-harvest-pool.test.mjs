import test from "node:test";
import assert from "node:assert/strict";
import {
  mintDisneyHarvestSlot,
  takeDisneyHarvestSlot,
  clearDisneyHarvestSlots,
  disneyHarvestSnapshot,
  __test,
} from "./disney-harvest-pool.js";
import { isDisneyHarvestFresh } from "./disney-harvest-session.js";

test("isDisneyHarvestFresh requires ~0~ abck and ttl", () => {
  const now = Date.now();
  assert.equal(isDisneyHarvestFresh(null), false);
  assert.equal(
    isDisneyHarvestFresh({
      cookies: { _abck: "xxx~0~yyy" },
      abckExpiresAt: now + 60_000,
    }),
    true,
  );
  assert.equal(
    isDisneyHarvestFresh({
      cookies: { _abck: "not-solved" },
      abckExpiresAt: now + 60_000,
    }),
    false,
  );
  assert.equal(
    isDisneyHarvestFresh({
      cookies: { _abck: "xxx~0~yyy" },
      abckExpiresAt: now - 1,
    }),
    false,
  );
  assert.equal(
    isDisneyHarvestFresh(
      {
        cookies: { _abck: "xxx~0~yyy" },
        abckExpiresAt: now + 60_000,
        captchaToken: "t",
        captchaExpiresAt: now - 1,
      },
      { requireCaptcha: true },
    ),
    false,
  );
});

test("pool take claims once then misses", async () => {
  clearDisneyHarvestSlots();
  __test.resetCounts();
  const id = `dhv_test_${Date.now()}`;
  const session = {
    id,
    cookies: { _abck: "a~0~b", sid: "1" },
    proxy: "1.2.3.4:1:u:p",
    proxyHost: "1.2.3.4",
    harvestedAt: Date.now(),
    abckExpiresAt: Date.now() + 120_000,
    abckValid: true,
    captchaToken: "tok",
    captchaExpiresAt: Date.now() + 90_000,
  };
  __test.slots.set(id, session);
  const snap = disneyHarvestSnapshot();
  assert.equal(snap.ready, 1);
  assert.equal(snap.readyWithCaptcha, 1);
  const claimed = takeDisneyHarvestSlot(id);
  assert.ok(claimed?.session);
  assert.equal(claimed.session.id, id);
  assert.equal(takeDisneyHarvestSlot(id), null);
  assert.equal(disneyHarvestSnapshot().ready, 0);
  clearDisneyHarvestSlots();
});

test("mint without proxy fails fast", async () => {
  const out = await mintDisneyHarvestSlot({ proxy: "" });
  assert.equal(out.ok, false);
  assert.match(String(out.error || ""), /proxy/i);
});
