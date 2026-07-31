// node --test desktop/bandai-global-monitor-client.test.cjs
const { test } = require("node:test");
const assert = require("node:assert/strict");
const {
  createBandaiGlobalMonitorClient,
  listGlobalWatchTasks,
  parseWatch,
  eventMatchesWatch,
  parseAdminWatchlistFromHealth,
  formatMonitorFeedStatusLine,
} = require("./bandai-global-monitor-client.cjs");

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
  const feed = client.getFeed();
  assert.equal(feed.length, 1);
  assert.equal(feed[0].productId, "N2890904001");
  assert.ok(feed[0].receivedAt);
});

test("checkout result discord embed", () => {
  const { checkoutResultDiscordPayload } = require("./discord-webhook.cjs");
  const ok = checkoutResultDiscordPayload(
    { ok: true, orderNumber: "ABC", checkoutStage: "complete", account: { email: "a@b.com" } },
    { store: "bandai", label: "lane1" },
  );
  assert.match(ok.embeds[0].title, /OK/);
  const fail = checkoutResultDiscordPayload(
    { ok: false, failedStep: "login", error: "login 401" },
    { store: "bandai" },
  );
  assert.match(fail.embeds[0].title, /failed/);
});

test("parseAdminWatchlistFromHealth counts keywords", () => {
  const w = parseAdminWatchlistFromHealth({
    area: "au",
    keywords: ["GUNDAM", "ONE PIECE", "N2890904001", ""],
  });
  assert.equal(w.adminArea, "au");
  assert.equal(w.adminWatchCount, 3);
  assert.deepEqual(w.adminKeywords, ["GUNDAM", "ONE PIECE", "N2890904001"]);
});

test("client snapshot includes admin watchlist from /health", async () => {
  const calls = [];
  const client = createBandaiGlobalMonitorClient({
    getSettings: () => ({
      bandaiGlobalMonitorEnabled: true,
      bandaiGlobalMonitorUrl: "https://example.test",
    }),
    getTasks: () => [],
    emitLog: () => {},
    fetchImpl: async (url) => {
      calls.push(String(url));
      assert.match(String(url), /\/health$/);
      return {
        ok: true,
        json: async () => ({
          ok: true,
          area: "au",
          keywords: ["GUNDAM", "N2890904001", "ONE PIECE"],
        }),
      };
    },
  });
  const ok = await client.refreshAdminWatchlist();
  assert.equal(ok, true);
  const snap = client.snapshot();
  assert.equal(snap.adminWatchCount, 3);
  assert.equal(snap.adminArea, "au");
  assert.deepEqual(snap.adminKeywords, ["GUNDAM", "N2890904001", "ONE PIECE"]);
  assert.equal(snap.watchTasks, 0);
  assert.equal(calls.length, 1);

  client._setAdminWatchlistFromHealth({ area: "nz", keywords: ["A"] });
  assert.equal(client.snapshot().adminWatchCount, 1);
  assert.equal(client.snapshot().adminArea, "nz");
});

test("mergeRemoteHits fills feed without firing onFeedHit", async () => {
  let liveHits = 0;
  const client = createBandaiGlobalMonitorClient({
    getSettings: () => ({
      bandaiGlobalMonitorEnabled: true,
      bandaiGlobalMonitorUrl: "https://example.test",
    }),
    getTasks: () => [],
    onFeedHit: () => {
      liveHits += 1;
    },
    emitLog: () => {},
  });
  const { merged } = client.mergeRemoteHits([
    {
      productId: "N2890904001",
      reason: "restock",
      title: "Gundam",
      at: "2026-07-30T02:33:00.000Z",
      inStock: true,
    },
    {
      productId: "N2890904001",
      reason: "restock",
      title: "Gundam",
      at: "2026-07-30T02:33:00.000Z",
      inStock: true,
    },
  ]);
  assert.equal(merged, 1);
  assert.equal(liveHits, 0);
  assert.equal(client.getFeed().length, 1);
  assert.equal(client.getFeed()[0].productId, "N2890904001");
});

test("initialFeed hydrates persisted rows", () => {
  const client = createBandaiGlobalMonitorClient({
    getSettings: () => ({ bandaiGlobalMonitorEnabled: true }),
    getTasks: () => [],
    initialFeed: [
      {
        productId: "N2903432003",
        title: "ONE PIECE",
        reason: "restock",
        at: "2026-07-30T01:00:00.000Z",
        receivedAt: Date.parse("2026-07-30T01:00:00.000Z"),
      },
    ],
    emitLog: () => {},
  });
  assert.equal(client.getFeed().length, 1);
  assert.equal(client.snapshot().feed[0].productId, "N2903432003");
});

test("formatMonitorFeedStatusLine hides host and admin wording", () => {
  const line = formatMonitorFeedStatusLine({
    connected: true,
    running: true,
    url: "https://j1ms-bandai-monitor-production.up.railway.app",
    hits: 2,
    adminWatchCount: 3,
    watchTasks: 0,
    engineRunning: true,
  });
  assert.match(line, /connected/);
  assert.match(line, /3 watched/);
  assert.equal(line.includes("railway"), false);
  assert.equal(line.includes("admin"), false);
  assert.equal(line.includes("0 watch task"), false);
  assert.equal(line.includes("watch task"), false);

  const noAdmin = formatMonitorFeedStatusLine({
    connected: true,
    hits: 0,
    adminWatchCount: null,
    watchTasks: 0,
  });
  assert.equal(noAdmin.includes("watch task"), false);
  assert.equal(noAdmin.includes("admin"), false);

  const advanced = formatMonitorFeedStatusLine({
    connected: true,
    adminWatchCount: 5,
    watchTasks: 2,
  });
  assert.match(advanced, /5 watched/);
  assert.match(advanced, /2 local monitor/);
});
