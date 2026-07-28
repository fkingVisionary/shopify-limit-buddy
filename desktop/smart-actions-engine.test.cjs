// node --test desktop/smart-actions-engine.test.cjs
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { createSmartActionsEngine, OUTCOMES } = require("./smart-actions-engine.cjs");

function makeEngine(opts = {}) {
  let actions = opts.actions || [];
  const created = [];
  const started = [];
  const discord = [];
  const engine = createSmartActionsEngine({
    getActions: () => actions,
    saveActions: (next) => {
      actions = next;
    },
    getSettings: () => ({
      quickTaskPreset: {
        store: "bandai",
        bandaiMode: "checkout",
        profileId: "prof_1",
        proxyGroupId: "px_1",
        qty: 1,
        quantity: 1,
        placeOrder: true,
        startAfterCreate: true,
      },
      ...(opts.settings || {}),
    }),
    idFn: (p) => `${p || "sa"}_${created.length + started.length + 1}`,
    upsertTask: (task) => {
      const row = { ...task, id: task.id || `task_${created.length + 1}` };
      created.push(row);
      return row;
    },
    startTasks: (ids) => {
      started.push([...ids]);
      return { ok: true, enqueued: ids.length };
    },
    notifyDiscord: async (payload) => {
      discord.push(payload);
      return { ok: true };
    },
    emit: () => {},
  });
  return { engine, get actions() { return actions; }, created, started, discord };
}

test("Product Monitor → filters → Create+Start → Completed", async () => {
  const { engine, created, started, actions } = makeEngine();
  engine.upsert({
    id: "sa_1",
    name: "Gundam ATC",
    enabled: true,
    runIntervalMs: 0,
    trigger: { type: "product_monitor" },
    filters: [{ field: "title", op: "matches", value: "gundam" }],
    actions: [
      { type: "create_tasks", config: { usePreset: true, labelTemplate: "{{title}}" } },
      { type: "start_tasks", config: {} },
    ],
  });

  const miss = await engine.handleMonitorHit({
    productId: "N1",
    title: "ONE PIECE",
    reason: "restock",
  });
  assert.equal(miss[0].outcome, OUTCOMES.FILTERED);
  assert.equal(created.length, 0);

  const hit = await engine.handleMonitorHit({
    productId: "N2890904001",
    title: "Gundam RX-78",
    reason: "restock",
    areaItemNo: "NAI0859145AU",
  });
  assert.equal(hit[0].outcome, OUTCOMES.COMPLETED);
  assert.equal(created.length, 1);
  assert.equal(created[0].bandaiMode, "checkout");
  assert.deepEqual(started[0], [created[0].id]);
  assert.equal(actions[0].lastResult, OUTCOMES.COMPLETED);
});

test("run interval debounce skips duplicate Completed spam", async () => {
  const { engine, created } = makeEngine();
  engine.upsert({
    id: "sa_deb",
    name: "Debounce",
    enabled: true,
    runIntervalMs: 60_000,
    trigger: { type: "product_monitor" },
    filters: [],
    actions: [
      { type: "create_tasks", config: { usePreset: true } },
      { type: "start_tasks", config: {} },
    ],
  });
  const a = await engine.handleMonitorHit({ productId: "N1", title: "X", reason: "restock" });
  assert.equal(a[0].outcome, OUTCOMES.COMPLETED);
  const b = await engine.handleMonitorHit({ productId: "N1", title: "X", reason: "restock" });
  assert.equal(b[0].skipped, true);
  assert.equal(b[0].reason, "run_interval");
  assert.equal(created.length, 1);
});

test("Quicktask trigger only", async () => {
  const { engine, created } = makeEngine();
  engine.upsert({
    id: "sa_qt",
    name: "QT only",
    enabled: true,
    trigger: { type: "quicktask" },
    filters: [{ field: "sku", op: "matches", value: "N9" }],
    actions: [{ type: "create_tasks", config: { usePreset: true } }],
  });
  const mon = await engine.handleMonitorHit({ productId: "N9", title: "T", reason: "restock" });
  assert.equal(mon.length, 0);
  const qt = await engine.handleQuickTaskContext({
    store: "bandai",
    sku: "N9",
    productId: "N9",
    title: "T",
    url: "https://p-bandai.com/au/item/N9",
    reason: "quicktask",
  });
  assert.equal(qt[0].outcome, OUTCOMES.COMPLETED);
  assert.equal(created.length, 1);
});
