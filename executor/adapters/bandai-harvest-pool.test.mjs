import assert from "node:assert/strict";
import {
  takeHarvestSlot,
  takeNextHarvestSlot,
  peekHarvestSlot,
  harvestSnapshot,
  clearHarvestSlots,
  releaseHarvestSlot,
  __test,
} from "../adapters/bandai-harvest-pool.js";

function mockBridge(csrf = "csrf_test_token") {
  let closed = false;
  return {
    closed: () => closed,
    async csrfToken() {
      return csrf;
    },
    async cookies() {
      return { SESSION: "abc", TS01: "xyz" };
    },
    async close() {
      closed = true;
    },
  };
}

async function main() {
  await clearHarvestSlots();
  __test.resetCounts();

  const bridge = mockBridge();
  const id = "bf5_test_1";
  const now = Date.now();
  __test.slots.set(id, {
    id,
    bridge,
    proxy: "http://user:pass@1.2.3.4:8000",
    proxyHost: "1.2.3.4",
    area: "au",
    csrf: "csrf_test_token",
    cookieKeys: ["SESSION", "TS01"],
    harvestedAt: now,
    expiresAt: now + 5 * 60_000,
    settleMs: 1400,
    note: "mock",
  });

  assert.equal(harvestSnapshot().ready, 1);
  assert.ok(peekHarvestSlot(id));

  const claimed = takeHarvestSlot(id);
  assert.ok(claimed?.bridge);
  assert.equal(claimed.meta.id, id);
  assert.equal(harvestSnapshot().ready, 0);
  assert.equal(takeHarvestSlot(id), null, "second take misses");

  // Expired slot closes and returns null
  const bridge2 = mockBridge("csrf2");
  const id2 = "bf5_test_exp";
  __test.slots.set(id2, {
    id: id2,
    bridge: bridge2,
    proxy: "http://x",
    proxyHost: "x",
    area: "au",
    csrf: "csrf2",
    cookieKeys: ["SESSION"],
    harvestedAt: now - 10_000,
    expiresAt: now - 1_000,
    settleMs: 1400,
    note: "expired",
  });
  assert.equal(takeHarvestSlot(id2), null);
  assert.equal(bridge2.closed(), true);

  const bridge3 = mockBridge("csrf3");
  const id3 = "bf5_test_rel";
  __test.slots.set(id3, {
    id: id3,
    bridge: bridge3,
    proxy: "http://y",
    proxyHost: "y",
    area: "au",
    csrf: "csrf3",
    cookieKeys: ["SESSION"],
    harvestedAt: now,
    expiresAt: now + 60_000,
    settleMs: 1400,
    note: "rel",
  });
  const rel = await releaseHarvestSlot(id3);
  assert.equal(rel.ok, true);
  assert.equal(bridge3.closed(), true);

  // takeNextHarvestSlot: claim any ready au slot (exclude burned id)
  const bA = mockBridge("csrfA");
  const bB = mockBridge("csrfB");
  __test.slots.set("bf5_a", {
    id: "bf5_a",
    bridge: bA,
    proxy: "http://a",
    proxyHost: "a",
    area: "au",
    csrf: "csrfA",
    cookieKeys: ["SESSION"],
    harvestedAt: now,
    expiresAt: now + 60_000,
    settleMs: 1400,
    note: "a",
  });
  __test.slots.set("bf5_b", {
    id: "bf5_b",
    bridge: bB,
    proxy: "http://b",
    proxyHost: "b",
    area: "au",
    csrf: "csrfB",
    cookieKeys: ["SESSION"],
    harvestedAt: now,
    expiresAt: now + 60_000,
    settleMs: 1400,
    note: "b",
  });
  const next = takeNextHarvestSlot({ area: "au", excludeIds: ["bf5_a"] });
  assert.ok(next?.bridge);
  assert.equal(next.meta.id, "bf5_b");
  assert.equal(harvestSnapshot().ready, 1);
  assert.ok(peekHarvestSlot("bf5_a"));

  await clearHarvestSlots();
  console.log("bandai-harvest-pool.test.mjs: ok");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
