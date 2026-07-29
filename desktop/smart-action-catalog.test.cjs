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

test("default templates are five curated packs", () => {
  assert.equal(DEFAULT_TEMPLATES.length, 5);
  assert.ok(DEFAULT_TEMPLATES.every((t) => t.id && t.actions?.length));
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

test("5 templates × 2 SKUs = 10 actions; idempotent ids", () => {
  const catalog = {
    rows: [
      { id: "r1", store: "bandai", sku: "N1", title: "Alpha", taskGroup: "Alpha" },
      { id: "r2", store: "bandai", sku: "N2", title: "Beta", taskGroup: "Beta" },
    ],
  };
  const a = expandCatalog(catalog);
  assert.equal(a.pairs, 10);
  assert.equal(a.templateCount, 5);
  assert.equal(a.rowCount, 2);

  const ids = a.drafts.map((d) => d.id);
  assert.equal(new Set(ids).size, 10);
  assert.equal(catalogActionId("monitor_atc", "bandai", "N1"), a.drafts[0].id);

  const again = expandCatalog(catalog);
  assert.deepEqual(
    again.drafts.map((d) => d.id).sort(),
    ids.slice().sort(),
  );
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
    rows: [{ id: "r1", store: "bandai", sku: "N9", title: "Nine", taskGroup: "Nine" }],
    enabledTemplateIds: ["monitor_atc", "monitor_alert"],
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
