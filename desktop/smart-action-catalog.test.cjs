// node --test desktop/smart-action-catalog.test.cjs
const { test } = require("node:test");
const assert = require("node:assert/strict");
const {
  DEFAULT_TEMPLATES,
  parseCatalogBulk,
  expandCatalog,
  applyCatalog,
  catalogActionId,
  materializeAction,
  removeCatalogActions,
} = require("./smart-action-catalog.cjs");
const { createSmartActionsEngine } = require("./smart-actions-engine.cjs");

test("default templates include full checkout + Bandai +30m", () => {
  assert.ok(DEFAULT_TEMPLATES.length >= 6);
  assert.ok(DEFAULT_TEMPLATES.every((t) => t.id && t.actions?.length));
  const checkout = DEFAULT_TEMPLATES.find((t) => t.id === "monitor_atc");
  assert.equal(checkout.actions[0].config.placeOrder, true);
  assert.equal(checkout.actions[0].config.bandaiMode, "checkout");
  assert.match(checkout.name, /Checkout/i);
  const delay = DEFAULT_TEMPLATES.find((t) => t.id === "monitor_checkout_delay_30m");
  assert.ok(delay);
  assert.equal(delay.actions.find((a) => a.type === "wait")?.config?.delaySec, 1800);
  assert.deepEqual(delay.stores, ["bandai"]);
});

test("complex templates ship user-facing explainers", () => {
  const { describeTemplate } = require("./smart-action-catalog.cjs");
  for (const id of ["drop_harvest_chain", "drop_delay_tighten", "monitor_checkout_delay_30m"]) {
    const t = DEFAULT_TEMPLATES.find((x) => x.id === id);
    assert.ok(t, id);
    assert.ok(String(t.explain || "").length > 40, `${id} explain`);
    const d = describeTemplate(t);
    assert.match(d.explain, /app must be open|App must/i);
  }
  const tighten = describeTemplate(DEFAULT_TEMPLATES.find((t) => t.id === "drop_delay_tighten"));
  assert.match(tighten.explain, /delay/i);
  assert.match(tighten.explain, /12:59:30|T−30|T-30/i);
  const chain = describeTemplate(DEFAULT_TEMPLATES.find((t) => t.id === "drop_harvest_chain"));
  assert.match(chain.explain, /harvest/i);
});

test("parse bulk SKU lines", () => {
  const rows = parseCatalogBulk(`
# comment
N2890904001 Gundam RX-78
bandai N2903432003 ONE PIECE
kmart,SKU123,Kmart Drop
`);
  assert.equal(rows.length, 3);
  assert.equal(rows[0].store, "bandai");
  assert.equal(rows[0].sku, "N2890904001");
  assert.match(rows[0].title, /Gundam/);
  assert.equal(rows[1].sku, "N2903432003");
  assert.equal(rows[2].store, "kmart");
});

test("templates × SKUs expands; Bandai +30m only for bandai rows", () => {
  const allPacks = DEFAULT_TEMPLATES.map((t) => t.id);
  const catalog = {
    rows: [
      {
        id: "r1",
        store: "bandai",
        sku: "N1",
        title: "Alpha",
        taskGroup: "Alpha",
        enabledTemplateIds: allPacks,
      },
      {
        id: "r2",
        store: "bandai",
        sku: "N2",
        title: "Beta",
        taskGroup: "Beta",
        enabledTemplateIds: allPacks,
      },
      {
        id: "r3",
        store: "kmart",
        sku: "K1",
        title: "Kmart",
        taskGroup: "Kmart",
        enabledTemplateIds: allPacks,
      },
    ],
  };
  const a = expandCatalog(catalog);
  // 7 packs × 2 bandai; kmart skips Bandai-only (+30m, delay tighten) → 5 × 1 = 19
  assert.equal(a.templateCount, 7);
  assert.equal(a.rowCount, 3);
  assert.equal(a.pairs, 19);
  assert.ok(a.drafts.every((d) => d.id));
  assert.equal(
    a.drafts.filter((d) => d.catalogTemplateId === "monitor_checkout_delay_30m").length,
    2,
  );
  assert.equal(catalogActionId("monitor_atc", "bandai", "N1"), a.drafts.find((d) => d.catalogTemplateId === "monitor_atc" && d.catalogKey.includes("N1")).id);

  const again = expandCatalog(catalog);
  assert.deepEqual(
    again.drafts.map((d) => d.id).sort(),
    a.drafts.map((d) => d.id).sort(),
  );
});

test("per-SKU packs are opt-in (empty = no actions)", () => {
  const catalog = {
    rows: [
      {
        id: "r1",
        store: "bandai",
        sku: "N1",
        title: "Alpha",
        enabledTemplateIds: ["monitor_atc"],
      },
      { id: "r2", store: "bandai", sku: "N2", title: "Beta", enabledTemplateIds: [] },
    ],
  };
  const a = expandCatalog(catalog);
  assert.equal(a.pairs, 1);
  assert.equal(a.drafts[0].catalogTemplateId, "monitor_atc");
  assert.match(a.drafts[0].catalogKey, /N1/);
});

test("materialize replaces placeholders in filters + task group", () => {
  const tmpl = DEFAULT_TEMPLATES.find((t) => t.id === "monitor_atc");
  const draft = materializeAction(tmpl, {
    id: "r1",
    store: "bandai",
    sku: "N2890904001",
    title: "Gundam",
    taskGroup: "Drop Gundam",
  });
  assert.match(draft.name, /Gundam/);
  assert.equal(draft.filters.find((f) => f.field === "sku").value, "N2890904001");
  assert.equal(draft.actions[0].config.taskGroup, "Drop Gundam");
  assert.equal(draft.catalogTemplateId, "monitor_atc");
});

test("applyCatalog upserts into engine without duplicates", () => {
  let actions = [];
  const engine = createSmartActionsEngine({
    getActions: () => actions,
    saveActions: (next) => {
      actions = next;
    },
    getSettings: () => ({ quickTaskPreset: {} }),
    getTasks: () => [],
    upsertTask: (t) => t,
    startTasks: () => ({ ok: true }),
    idFn: (p) => `${p}_x`,
    emit: () => {},
  });

  const catalog = {
    rows: [
      {
        id: "r1",
        store: "bandai",
        sku: "N9",
        title: "Nine",
        taskGroup: "Nine",
        enabledTemplateIds: ["monitor_atc", "monitor_alert"],
      },
    ],
  };

  const first = applyCatalog({
    catalog,
    upsert: (draft) => engine.upsert(draft),
  });
  assert.equal(first.createdOrUpdated, 2);
  assert.equal(actions.length, 2);

  const second = applyCatalog({
    catalog,
    upsert: (draft) => engine.upsert(draft),
  });
  assert.equal(second.createdOrUpdated, 2);
  assert.equal(actions.length, 2);
  assert.ok(actions.every((a) => a.catalogKey));
});

test("removeCatalogActions selects catalog-owned rows", () => {
  const list = [
    { id: "sa_cat_monitor_atc__bandai__N1", catalogKey: "monitor_atc::bandai::N1", catalogRowId: "r1" },
    { id: "sa_manual", name: "hand built" },
    { id: "sa_cat_x", catalogKey: "x::bandai::N2", catalogRowId: "r2" },
  ];
  assert.deepEqual(removeCatalogActions(list), [
    "sa_cat_monitor_atc__bandai__N1",
    "sa_cat_x",
  ]);
  assert.deepEqual(removeCatalogActions(list, { rowId: "r1" }), [
    "sa_cat_monitor_atc__bandai__N1",
  ]);
});
