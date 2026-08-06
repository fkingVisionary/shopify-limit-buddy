// node --test desktop/quick-task.test.cjs
const { test } = require("node:test");
const assert = require("node:assert/strict");
const {
  parseBandaiProductInput,
  targetFromMonitorHit,
  buildQuickTaskDraft,
  normalizeQuickTaskPreset,
  resolveQuickTaskProfiles,
  contextFromMonitorHit,
} = require("./quick-task.cjs");

test("parse Bandai URL and SKU", () => {
  const u = parseBandaiProductInput("https://p-bandai.com/au/item/N2890904001");
  assert.equal(u.ok, true);
  assert.equal(u.productId, "N2890904001");
  assert.match(u.pdpUrl, /N2890904001/);

  const s = parseBandaiProductInput("N2890904001");
  assert.equal(s.ok, true);
  assert.equal(s.productId, "N2890904001");

  const nai = parseBandaiProductInput("NAI0859145AU");
  assert.equal(nai.ok, true);
  assert.equal(nai.areaItemNo, "NAI0859145AU");
});

test("build draft from preset + hit", () => {
  const preset = normalizeQuickTaskPreset({
    store: "bandai-us",
    paymentMethod: "paypal_guest",
    profileId: "prof_1",
    proxyGroupId: "px_1",
    bandaiMode: "checkout",
    qty: 2,
  });
  assert.equal(preset.store, "bandai");
  assert.equal(preset.bandaiArea, "us");
  assert.equal(preset.paymentMethod, "paypal_guest");
  const target = targetFromMonitorHit(
    {
      productId: "N2890904001",
      title: "Gundam",
      areaItemNo: "NAI0859145AU",
    },
    { area: "us" },
  );
  const built = buildQuickTaskDraft(preset, target);
  assert.equal(built.ok, true);
  assert.equal(built.task.profileId, "prof_1");
  assert.equal(built.task.bandaiMode, "checkout");
  assert.equal(built.task.qty, 2);
  assert.equal(built.task.bandaiArea, "us");
  assert.equal(built.task.paymentMethod, "paypal_guest");
  assert.equal(built.task.bandaiAreaItemNo, "NAI0859145AU");
  assert.match(built.task.pdpUrl, /N2890904001/);
  assert.match(built.task.pdpUrl, /\/us\//);
});

test("contextFromMonitorHit shape", () => {
  const ctx = contextFromMonitorHit({
    productId: "N1",
    title: "T",
    reason: "new_in_stock",
  });
  assert.equal(ctx.store, "bandai");
  assert.equal(ctx.sku, "N1");
  assert.equal(ctx.source, "product_monitor");
});

test("resolveQuickTaskProfiles supports group and multi", () => {
  const profiles = [
    { id: "a", name: "A", profileGroup: "Main" },
    { id: "b", name: "B", profileGroup: "Main" },
    { id: "c", name: "C", profileGroup: "Other" },
  ];
  const group = resolveQuickTaskProfiles(
    { profileSource: "group", profileGroup: "Main" },
    profiles,
  );
  assert.deepEqual(
    group.map((s) => s.profileId),
    ["a", "b"],
  );

  const multi = resolveQuickTaskProfiles(
    { profileSource: "multi", profileIds: ["c", "a", "missing"] },
    profiles,
  );
  assert.deepEqual(
    multi.map((s) => s.profileId),
    ["c", "a"],
  );

  const single = resolveQuickTaskProfiles(
    { profileSource: "single", profileId: "b" },
    profiles,
  );
  assert.deepEqual(
    single.map((s) => s.profileId),
    ["b"],
  );

  const legacy = normalizeQuickTaskPreset({ profileId: "a" });
  assert.equal(legacy.profileSource, "single");
  assert.equal(legacy.profileId, "a");
});
