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
  const startOpts = [];
  const stopped = [];
  const patched = [];
  const harvest = [];
  const discord = [];
  const gotos = [];
  const toasts = [];
  const basePreset = {
    store: "bandai",
    bandaiMode: "checkout",
    profileId: "prof_1",
    proxyGroupId: "px_1",
    qty: 1,
    quantity: 1,
    placeOrder: true,
    startAfterCreate: true,
  };
  const engine = createSmartActionsEngine({
    getActions: () => actions,
    saveActions: (next) => {
      actions = next;
    },
    getSettings: () => ({
      quickTaskPreset: {
        ...basePreset,
        ...(opts.settings?.quickTaskPreset || {}),
      },
      ...Object.fromEntries(
        Object.entries(opts.settings || {}).filter(([k]) => k !== "quickTaskPreset"),
      ),
    }),
    getTasks: () => tasks,
    getProfiles: () =>
      opts.profiles || [
        { id: "prof_1", name: "P1", profileGroup: "Main" },
        { id: "prof_2", name: "P2", profileGroup: "Main" },
        { id: "prof_3", name: "P3", profileGroup: "Other" },
      ],
    getStoreGroups: () => opts.storeGroups || [],
    idFn: (p) => `${p || "sa"}_${created.length + started.length + 1}`,
    upsertTask: (task) => {
      const row = { ...task, id: task.id || `task_${created.length + 1}`, enabled: true };
      created.push(row);
      const i = tasks.findIndex((t) => t.id === row.id);
      if (i >= 0) tasks[i] = { ...tasks[i], ...row };
      else tasks.push(row);
      return row;
    },
    startTasks: (ids, optsIn = {}) => {
      started.push([...ids]);
      startOpts.push({ ...optsIn });
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
    ensureTaskGroup: ({ taskGroup }) => ({ ok: true, taskGroup, created: true }),
    gotoTaskGroup: ({ taskGroup }) => {
      gotos.push(taskGroup);
    },
    notifyToast: (payload) => {
      toasts.push(payload);
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
    startOpts,
    stopped,
    patched,
    harvest,
    discord,
    gotos,
    toasts,
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

test("create_tasks expands profile group × per profile", async () => {
  const { engine, created, started } = makeEngine();
  engine.upsert({
    id: "sa_pg",
    name: "Group expand",
    enabled: true,
    runIntervalMs: 0,
    trigger: { type: "product_monitor" },
    filters: [],
    actions: [
      {
        type: "create_tasks",
        config: {
          usePreset: true,
          profileGroup: "Main",
          perProfile: 2,
          labelTemplate: "{{title}}",
          taskGroup: "Drop G",
        },
      },
      { type: "start_tasks", config: { target: { scope: "created" } } },
    ],
  });
  const hit = await engine.handleMonitorHit({
    productId: "N1",
    title: "Item",
    reason: "restock",
  });
  assert.equal(hit[0].outcome, OUTCOMES.COMPLETED);
  // Main has prof_1 + prof_2, × 2 each
  assert.equal(created.length, 4);
  assert.deepEqual(
    created.map((t) => t.profileId).sort(),
    ["prof_1", "prof_1", "prof_2", "prof_2"],
  );
  assert.equal(started[0].length, 4);
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

test("update_tasks can slash bandaiMonitorDelayMs for pre-drop tighten", async () => {
  const { engine, patched, tasks } = makeEngine({
    tasks: [
      {
        id: "t_delay",
        store: "bandai",
        taskGroup: "Drop A",
        enabled: true,
        bandaiMonitorDelayMs: 15000,
      },
    ],
  });
  engine.upsert({
    id: "sa_tighten",
    name: "Delay tighten",
    enabled: true,
    runIntervalMs: 0,
    trigger: { type: "schedule", at: "12:59:30", tz: "UTC", repeat: "daily" },
    filters: [],
    actions: [
      {
        type: "update_tasks",
        config: {
          target: { scope: "group", taskGroup: "Drop A" },
          bandaiMonitorDelayMs: 0,
        },
      },
    ],
  });
  const r = await engine.evaluateOne(engine.list()[0], {
    source: "schedule",
    reason: "schedule",
  });
  assert.equal(r.outcome, OUTCOMES.COMPLETED);
  assert.equal(patched.length, 1);
  assert.deepEqual(patched[0].ids, ["t_delay"]);
  assert.equal(patched[0].patch.bandaiMonitorDelayMs, 0);
  assert.equal(tasks.find((t) => t.id === "t_delay").bandaiMonitorDelayMs, 0);
});

test("stop_after waits then stops task group", async () => {
  const ctx = makeEngine({
    tasks: [{ id: "t1", taskGroup: "Drop A", enabled: true, store: "bandai" }],
  });
  ctx.engine.upsert({
    id: "sa_stop_after",
    name: "Stop after",
    enabled: true,
    runIntervalMs: 0,
    trigger: { type: "product_monitor" },
    filters: [],
    actions: [
      {
        type: "stop_after",
        config: {
          delayMs: 5,
          target: { scope: "group", taskGroup: "Drop A" },
        },
      },
    ],
  });
  const r = await ctx.engine.handleMonitorHit({
    productId: "N1",
    title: "Test",
    reason: "restock",
  });
  assert.equal(r[0]?.outcome, OUTCOMES.COMPLETED);
  assert.deepEqual(ctx.stopped, [["t1"]]);
});

test("delete_tasks removes targeted ids", async () => {
  let tasks = [
    { id: "t1", taskGroup: "G", enabled: true },
    { id: "t2", taskGroup: "G", enabled: true },
  ];
  const deleted = [];
  const { engine } = makeEngine({ tasks });
  // Override delete via fresh engine with deleteTasks
  let actions = [];
  const eng = createSmartActionsEngine({
    getActions: () => actions,
    saveActions: (next) => {
      actions = next;
    },
    getSettings: () => ({ quickTaskPreset: {} }),
    getTasks: () => tasks,
    idFn: (p) => `${p}_d`,
    upsertTask: (t) => t,
    startTasks: () => ({ ok: true }),
    deleteTasks: (ids) => {
      deleted.push([...ids]);
      const set = new Set(ids);
      tasks = tasks.filter((t) => !set.has(t.id));
    },
    emit: () => {},
  });
  eng.upsert({
    id: "sa_del",
    name: "Delete",
    enabled: true,
    runIntervalMs: 0,
    trigger: { type: "product_monitor" },
    actions: [
      { type: "delete_tasks", config: { target: { scope: "group", taskGroup: "G" } } },
    ],
  });
  const r = await eng.handleMonitorHit({ productId: "N9", title: "X", reason: "restock" });
  assert.equal(r[0]?.outcome, OUTCOMES.COMPLETED);
  assert.deepEqual(deleted[0].sort(), ["t1", "t2"]);
});

test("tickSchedule honors HH:MM:SS second precision", async () => {
  const { engine, harvest } = makeEngine();
  const now = Date.UTC(2026, 6, 29, 12, 59, 30);
  const parts = clockPartsInTz("UTC", now);
  assert.equal(parts.timeSec, "12:59:30");
  engine.upsert({
    id: "sa_sec",
    name: "T-30",
    enabled: true,
    runIntervalMs: 0,
    trigger: { type: "schedule", at: "12:59:30", tz: "UTC", repeat: "daily" },
    actions: [{ type: "start_harvester", config: {} }],
  });
  const miss = await engine.tickSchedule(now - 1_000);
  assert.equal(miss.length, 0);
  const hit = await engine.tickSchedule(now);
  assert.equal(hit.length, 1);
  assert.equal(hit[0].outcome, OUTCOMES.COMPLETED);
  assert.deepEqual(harvest, ["start"]);
  const again = await engine.tickSchedule(now + 500);
  assert.equal(again.length, 0);
});

test("store_group target resolves tasks by store membership", async () => {
  const tasks = [
    { id: "t_b", store: "bandai", enabled: true, taskGroup: "G" },
    { id: "t_k", store: "kmart", enabled: true, taskGroup: "G" },
    { id: "t_t", store: "toymate", enabled: true, taskGroup: "G" },
  ];
  const { engine, started } = makeEngine({
    tasks,
    storeGroups: [{ id: "sg_tcg", name: "TCG", stores: ["bandai", "toymate"] }],
  });
  engine.upsert({
    id: "sa_sg",
    name: "Store group start",
    enabled: true,
    runIntervalMs: 0,
    trigger: { type: "product_monitor" },
    actions: [
      {
        type: "start_tasks",
        config: { target: { scope: "store_group", storeGroup: "sg_tcg" } },
      },
    ],
  });
  const r = await engine.handleMonitorHit({
    productId: "N1",
    title: "X",
    reason: "restock",
    store: "bandai",
  });
  assert.equal(r[0]?.outcome, OUTCOMES.COMPLETED);
  assert.deepEqual(started[0].sort(), ["t_b", "t_t"]);
});

test("storeGroup filter gates monitor hits", async () => {
  const { engine, started } = makeEngine({
    storeGroups: [{ id: "sg_b", name: "Bandai only", stores: ["bandai"] }],
  });
  engine.upsert({
    id: "sa_fg",
    name: "Filter store group",
    enabled: true,
    runIntervalMs: 0,
    trigger: { type: "product_monitor" },
    filters: [{ field: "storeGroup", op: "is", value: "sg_b" }],
    actions: [
      { type: "create_tasks", config: { usePreset: true, count: 1, labelTemplate: "{{sku}}" } },
      { type: "start_tasks", config: { target: { scope: "created" } } },
    ],
  });
  const miss = await engine.handleMonitorHit({
    productId: "N2",
    title: "Kmart item",
    reason: "restock",
    store: "kmart",
  });
  assert.equal(miss[0]?.outcome, OUTCOMES.FILTERED);
  assert.equal(started.length, 0);

  const hit = await engine.handleMonitorHit({
    productId: "N3",
    title: "Bandai item",
    reason: "restock",
    store: "bandai",
  });
  assert.equal(hit[0]?.outcome, OUTCOMES.COMPLETED);
  assert.equal(started.length, 1);
});

test("stagger_start_tasks passes stagger opts to startTasks", async () => {
  const tasks = [
    { id: "a", store: "bandai", enabled: true, taskGroup: "Drop" },
    { id: "b", store: "bandai", enabled: true, taskGroup: "Drop" },
  ];
  const { engine, started, startOpts } = makeEngine({ tasks });
  engine.upsert({
    id: "sa_stagger",
    name: "Stagger",
    enabled: true,
    runIntervalMs: 0,
    trigger: { type: "product_monitor" },
    actions: [
      {
        type: "stagger_start_tasks",
        config: {
          target: { scope: "group", taskGroup: "Drop" },
          staggerGapMs: 75,
        },
      },
    ],
  });
  const r = await engine.handleMonitorHit({ productId: "N4", title: "X", reason: "restock" });
  assert.equal(r[0]?.outcome, OUTCOMES.COMPLETED);
  assert.deepEqual(started[0].sort(), ["a", "b"]);
  assert.equal(startOpts[0].stagger, true);
  assert.equal(startOpts[0].staggerGapMs, 75);
});

test("stagger_start_task_group forces group scope + stagger", async () => {
  const tasks = [
    { id: "g1", store: "bandai", enabled: true, taskGroup: "Wave" },
    { id: "g2", store: "bandai", enabled: true, taskGroup: "Wave" },
    { id: "other", store: "bandai", enabled: true, taskGroup: "Other" },
  ];
  const { engine, started, startOpts } = makeEngine({ tasks });
  engine.upsert({
    id: "sa_stg",
    name: "Stagger group",
    enabled: true,
    runIntervalMs: 0,
    trigger: { type: "product_monitor" },
    actions: [
      {
        type: "stagger_start_task_group",
        config: {
          target: { scope: "all", taskGroup: "Wave" },
          staggerGapMs: 40,
        },
      },
    ],
  });
  const r = await engine.handleMonitorHit({ productId: "N5", title: "X", reason: "restock" });
  assert.equal(r[0]?.outcome, OUTCOMES.COMPLETED);
  assert.deepEqual(started[0].sort(), ["g1", "g2"]);
  assert.equal(startOpts[0].stagger, true);
  assert.equal(startOpts[0].staggerGapMs, 40);
});

test("create_tasks stamps taskGroup and toasts", async () => {
  const { engine, created, tasks, gotos, toasts } = makeEngine();
  engine.upsert({
    id: "sa_vis",
    name: "Vis",
    enabled: true,
    runIntervalMs: 0,
    trigger: { type: "product_monitor" },
    filters: [{ field: "sku", op: "equals", value: "N77" }],
    actions: [
      {
        type: "create_tasks",
        config: {
          usePreset: true,
          taskGroup: "Drop Vis",
          labelTemplate: "{{title}}",
          count: 1,
        },
      },
    ],
  });
  const r = await engine.handleMonitorHit({
    productId: "N77",
    title: "Vis Title",
    reason: "restock",
  });
  assert.equal(r[0]?.outcome, OUTCOMES.COMPLETED);
  assert.equal(created.length, 1);
  assert.equal(created[0].taskGroup, "Drop Vis");
  assert.equal(tasks[0].taskGroup, "Drop Vis");
  assert.ok(gotos.includes("Drop Vis"));
  assert.ok(toasts.some((t) => /Created 1/.test(String(t.message || ""))));
});

test("create_tasks fails without Quick Task profile", async () => {
  const { engine, created } = makeEngine({
    settings: { quickTaskPreset: { profileId: null, proxyGroupId: null } },
  });
  engine.upsert({
    id: "sa_noprof",
    name: "No profile",
    enabled: true,
    runIntervalMs: 0,
    trigger: { type: "product_monitor" },
    actions: [{ type: "create_tasks", config: { usePreset: true, count: 1 } }],
  });
  const r = await engine.handleMonitorHit({
    productId: "N88",
    title: "X",
    reason: "restock",
  });
  assert.equal(r[0]?.outcome, OUTCOMES.FAILED);
  assert.equal(created.length, 0);
  const logs = engine.getLogs("sa_noprof");
  assert.ok(logs.some((l) => /assign a Quick Task profile/i.test(l.message)));
});

test("disable mid-wait aborts before create_tasks", async () => {
  const { engine, created } = makeEngine();
  engine.upsert({
    id: "sa_abort",
    name: "Abort wait",
    enabled: true,
    runIntervalMs: 0,
    trigger: { type: "product_monitor" },
    actions: [
      { type: "wait", config: { delayMs: 600 } },
      {
        type: "create_tasks",
        config: { usePreset: true, taskGroup: "G", labelTemplate: "{{title}}", count: 1 },
      },
    ],
  });
  const pending = engine.handleMonitorHit({
    productId: "N66",
    title: "Slow",
    reason: "restock",
  });
  await new Promise((r) => setTimeout(r, 120));
  engine.setEnabled("sa_abort", false);
  const r = await pending;
  assert.equal(r[0]?.outcome, OUTCOMES.FAILED);
  assert.equal(created.length, 0);
  const logs = engine.getLogs("sa_abort");
  assert.ok(logs.some((l) => /cancel|Abort|disabled/i.test(l.message)));
});
