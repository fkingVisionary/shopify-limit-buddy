// node --test desktop/desktop-watchdog.test.cjs
const { test } = require("node:test");
const assert = require("node:assert/strict");
const {
  listWatchdogCheckoutTasks,
  planWatchdogStarts,
  createWatchdogCooldown,
  isWatchdogEnabled,
} = require("./desktop-watchdog.cjs");

const hit = {
  productId: "N2890904001",
  inStock: true,
  reason: "restock",
  title: "GUNDAM CARD GAME",
  areaItemNo: "NAI0859145AU",
};

test("isWatchdogEnabled defaults on", () => {
  assert.equal(isWatchdogEnabled({}), true);
  assert.equal(isWatchdogEnabled({ desktopWatchdogEnabled: false }), false);
});

test("listWatchdogCheckoutTasks matches idle Autocheckout by PDP SKU", () => {
  const tasks = [
    {
      id: "c1",
      store: "bandai",
      bandaiMode: "checkout",
      enabled: true,
      pdpUrl: "https://p-bandai.com/au/item/N2890904001",
    },
    {
      id: "a1",
      store: "bandai",
      bandaiMode: "atc",
      enabled: true,
      pdpUrl: "https://p-bandai.com/au/item/N2890904001",
    },
    {
      id: "m1",
      store: "bandai",
      bandaiMode: "monitor",
      bandaiMonitorMode: "global",
      bandaiWatchSku: "N2890904001",
      enabled: true,
    },
    {
      id: "c2",
      store: "bandai",
      bandaiMode: "checkout",
      enabled: true,
      pdpUrl: "https://p-bandai.com/au/item/N9999999999",
    },
    {
      id: "c3",
      store: "bandai",
      bandaiMode: "checkout",
      enabled: true,
      bandaiWatchdog: false,
      pdpUrl: "https://p-bandai.com/au/item/N2890904001",
    },
    {
      id: "c4",
      store: "bandai",
      bandaiMode: "checkout",
      enabled: true,
      lastStatus: "queued",
      pdpUrl: "https://p-bandai.com/au/item/N2890904001",
    },
  ];
  assert.deepEqual(
    listWatchdogCheckoutTasks(tasks, hit, {}).map((t) => t.id),
    ["c1", "a1"],
  );
});

test("listWatchdogCheckoutTasks matches keywords", () => {
  const tasks = [
    {
      id: "k1",
      store: "bandai",
      bandaiMode: "checkout",
      enabled: true,
      bandaiWatchKeywords: "gundam card",
    },
  ];
  assert.equal(listWatchdogCheckoutTasks(tasks, hit, {}).length, 1);
  assert.equal(
    listWatchdogCheckoutTasks(tasks, hit, { desktopWatchdogEnabled: false }).length,
    0,
  );
});

test("listWatchdogCheckoutTasks skips muted SKUs", () => {
  const tasks = [
    {
      id: "c1",
      store: "bandai",
      bandaiMode: "checkout",
      enabled: true,
      pdpUrl: "https://p-bandai.com/au/item/N2890904001",
    },
  ];
  assert.equal(
    listWatchdogCheckoutTasks(tasks, hit, {
      monitorMutedSkus: ["N2890904001"],
    }).length,
    0,
  );
});

test("planWatchdogStarts stamps PDP + NAI and respects cooldown", () => {
  const cooldown = createWatchdogCooldown({ cooldownMs: 60_000 });
  const tasks = [
    {
      id: "c1",
      store: "bandai",
      bandaiMode: "checkout",
      enabled: true,
      bandaiWatchSku: "N2890904001",
      profileId: "p1",
    },
  ];
  const a = planWatchdogStarts({ tasks, hit, settings: {}, cooldown });
  assert.equal(a.length, 1);
  assert.equal(a[0].checkoutTask.bandaiMode, "checkout");
  assert.match(a[0].checkoutTask.pdpUrl, /N2890904001/);
  assert.equal(a[0].checkoutTask.bandaiAreaItemNo, "NAI0859145AU");

  const b = planWatchdogStarts({ tasks, hit, settings: {}, cooldown });
  assert.equal(b.length, 0, "cooldown should suppress second fire");
});

test("oos hits never arm watchdog", () => {
  const tasks = [
    {
      id: "c1",
      store: "bandai",
      bandaiMode: "checkout",
      enabled: true,
      bandaiWatchSku: "N2890904001",
    },
  ];
  assert.equal(
    listWatchdogCheckoutTasks(tasks, { ...hit, inStock: false }, {}).length,
    0,
  );
});

test("planWatchdogStarts preserves ATC-only mode", () => {
  const cooldown = createWatchdogCooldown({ cooldownMs: 60_000 });
  const tasks = [
    {
      id: "a1",
      store: "bandai",
      bandaiMode: "atc",
      enabled: true,
      bandaiWatchSku: "N2890904001",
    },
  ];
  const a = planWatchdogStarts({ tasks, hit, settings: {}, cooldown });
  assert.equal(a.length, 1);
  assert.equal(a[0].checkoutTask.bandaiMode, "atc");
});
