// node --test desktop/bandai-global-monitor-client.test.cjs
const { test } = require("node:test");
const assert = require("node:assert/strict");
const {
  createBandaiGlobalMonitorClient,
  listGlobalWatchTasks,
  parseWatch,
  eventMatchesWatch,
} = require("./bandai-global-monitor-client.cjs");
const { bandaiRestockDiscordPayload } = require("./discord-webhook.cjs");

test("parseWatch extracts SKU from PDP URL", () => {
  const w = parseWatch({ pdpUrl: "https://p-bandai.com/au/item/N2890904001" });
  assert.ok(w.productIds.includes("N2890904001"));
});

test("eventMatchesWatch by sku and keyword", () => {
  assert.equal(
    eventMatchesWatch(
      { productId: "N2890904001", inStock: true, title: "Gundam" },
      { productIds: ["N2890904001"], keywords: [] },
    ),
    true,
  );
  assert.equal(
    eventMatchesWatch(
      { productId: "N1", inStock: true, title: "ONE PIECE figure" },
      { productIds: [], keywords: ["one piece"] },
    ),
    true,
  );
  assert.equal(
    eventMatchesWatch({ productId: "N2", inStock: true, title: "x" }, { productIds: ["N9"], keywords: [] }),
    false,
  );
});

test("listGlobalWatchTasks only global bandai monitor", () => {
  const tasks = [
    { id: "1", store: "bandai", bandaiMode: "monitor", bandaiMonitorMode: "global", bandaiWatchSku: "N2890904001", enabled: true },
    { id: "2", store: "bandai", bandaiMode: "monitor", bandaiMonitorMode: "local", bandaiWatchSku: "N1", enabled: true },
    { id: "3", store: "bandai", bandaiMode: "checkout", bandaiWatchSku: "N1", enabled: true },
    { id: "4", store: "bandai", bandaiMode: "monitor", bandaiMonitorMode: "global", bandaiWatchSku: "N2", enabled: false },
  ];
  assert.deepEqual(
    listGlobalWatchTasks(tasks).map((t) => t.id),
    ["1"],
  );
});

test("client inject hit matches watch and enqueues checkout", async () => {
  const enqueued = [];
  const client = createBandaiGlobalMonitorClient({
    getSettings: () => ({
      bandaiGlobalMonitorEnabled: true,
      bandaiGlobalMonitorUrl: "https://example.test",
      discordMonitorWebhook: "",
    }),
    getTasks: () => [
      {
        id: "t1",
        store: "bandai",
        bandaiMode: "monitor",
        bandaiMonitorMode: "global",
        bandaiWatchSku: "N2890904001",
        bandaiCheckoutOnHit: true,
        placeOrder: true,
        enabled: true,
      },
    ],
    onCheckoutTask: async (task) => {
      enqueued.push(task);
    },
    emitLog: () => {},
  });
  await client._injectHit({
    productId: "N2890904001",
    inStock: true,
    reason: "restock",
    title: "Gundam",
    areaItemNo: "NAI0859145AU",
  });
  assert.equal(enqueued.length, 1);
  assert.equal(enqueued[0].bandaiMode, "checkout");
  assert.equal(enqueued[0].bandaiAreaItemNo, "NAI0859145AU");
});

test("discord embed includes sku link", () => {
  const p = bandaiRestockDiscordPayload(
    { productId: "N2890904001", title: "Set", reason: "restock", areaItemNo: "NAI0859145AU" },
    { area: "au" },
  );
  assert.match(p.embeds[0].url, /N2890904001/);
  assert.equal(p.embeds[0].fields[0].value, "N2890904001");
});
