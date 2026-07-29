// node --test desktop/smart-actions-engine.test.cjs
const { test } = require("node:test");
const assert = require("node:assert/strict");
const {
  createSmartActionsEngine,
  OUTCOMES,
  clockPartsInTz,
} = require("./smart-actions-engine.cjs");

function makeEngine(opts = {}) {
  let actions = opts.actions || [];
  let tasks = opts.tasks || [];
  const created = [];
  const started = [];
  const stopped = [];
  const patched = [];
  const harvest = [];
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
    getTasks: () => tasks,
    idFn: (p) => `${p || "sa"}_${created.length + started.length + 1}`,
    upsertTask: (task) => {
      const row = { ...task, id: task.id || `task_${created.length + 1}`, enabled: true };
      created.push(row);
      const i = tasks.findIndex((t) => t.id === row.id);
      if (i >= 0) tasks[i] = { ...tasks[i], ...row };
      else tasks.push(row);
      return row;
    },
    startTasks: (ids) => {
      started.push([...ids]);
      return { ok: true, enqueued: ids.length };
    },
    stopTasks: (ids) => {
      stopped.push([...ids]);
    },
    patchTasks: (ids, patch) => {
      patched.push({ ids: [...ids], patch: { ...patch } });
      for (const id of ids) {
        const t = tasks.find((x) => x.id === id);
        if (t) Object.assign(t, patch);
      }
      return { ok: true, updated: ids.length };
    },
    startHarvester: async () => {
      harvest.push("start");
      return { ok: true };
    },
    stopHarvester: () => {
      harvest.push("stop");
      return { ok: true };
    },
    notifyDiscord: async (payload) => {
      discord.push(payload);
      return { ok: true };
    },
    emit: () => {},
  });
  return {
    engine,
    get actions() {
      return actions;
    },
    get tasks() {
      return tasks;
    },
    created,
    started,
    stopped,
    patched,
    harvest,
    discord,
  };
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
      { type: "create_tasks", config: { usePreset: true, labelTemplate: "{{title}}", taskGroup: "Drop A" } },
      { type: "start_tasks", config: { target: { scope: "created" } } },
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
  assert.equal(created[0].taskGroup, "Drop A");
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

test("Start/Update by task group + Wait + Harvester chain", async () => {
  const { engine, started, patched, harvest, tasks } = makeEngine({
    tasks: [
      {
        id: "t1",
        store: "bandai",
        taskGroup: "Drop A",
        enabled: true,
        pdpUrl: "https://p-bandai.com/au/item/OLD",
      },
      {
        id: "t2",
        store: "bandai",
        taskGroup: "Other",
        enabled: true,
        pdpUrl: "https://p-bandai.com/au/item/X",
      },
    ],
  });
  engine.upsert({
    id: "sa_chain",
    name: "Harvest then drop",
    enabled: true,
    runIntervalMs: 0,
    trigger: { type: "schedule", at: "07:00", tz: "UTC", repeat: "daily" },
    filters: [],
    actions: [
      { type: "start_harvester", config: {} },
      { type: "wait", config: { delayMs: 5 } },
      {
        type: "update_tasks",
        config: {
          target: { scope: "group", taskGroup: "Drop A" },
          product: "N2890904001",
        },
      },
      {
        type: "start_tasks",
        config: { target: { scope: "group", taskGroup: "Drop A" } },
      },
    ],
  });

  // Force schedule fire by aligning clock — stub via evaluateOne context instead
  const r = await engine.evaluateOne(engine.list()[0], {
    source: "schedule",
    reason: "schedule",
    sku: "N2890904001",
    productId: "N2890904001",
    title: "Forced",
  });
  assert.equal(r.outcome, OUTCOMES.COMPLETED);
  assert.deepEqual(harvest, ["start"]);
  assert.equal(patched.length, 1);
  assert.deepEqual(patched[0].ids, ["t1"]);
  assert.match(String(patched[0].patch.pdpUrl || ""), /N2890904001/);
  assert.deepEqual(started[0], ["t1"]);
  const t1 = tasks.find((t) => t.id === "t1");
  assert.ok(
    t1.bandaiWatchSku === "N2890904001" || String(t1.pdpUrl || "").includes("N2890904001"),
  );
});

test("tickSchedule fires once per minute slot", async () => {
  const { engine, harvest, actions } = makeEngine();
  const now = Date.UTC(2026, 6, 29, 7, 0, 10); // 07:00 UTC
  const parts = clockPartsInTz("UTC", now);
  engine.upsert({
    id: "sa_sched",
    name: "Morning",
    enabled: true,
    runIntervalMs: 0,
    trigger: { type: "schedule", at: parts.time, tz: "UTC", repeat: "daily" },
    actions: [{ type: "start_harvester", config: {} }],
  });
  const a = await engine.tickSchedule(now);
  assert.equal(a.length, 1);
  assert.equal(a[0].outcome, OUTCOMES.COMPLETED);
  assert.deepEqual(harvest, ["start"]);
  assert.equal(actions[0].lastScheduleKey, `${parts.date}T${parts.time}`);

  const b = await engine.tickSchedule(now + 5_000);
  assert.equal(b.length, 0);
  assert.equal(harvest.length, 1);
});
