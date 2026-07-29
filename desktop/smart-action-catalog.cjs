// Smart Action preset catalog — templates × SKU rows → materialized Smart Actions.
// Idempotent: same templateId + store + sku always upserts the same action id.

/**
 * Built-in templates. Placeholders: {{sku}} {{store}} {{title}} {{taskGroup}} {{group}}
 * Keep these opinionated and few — curation is the product.
 */
const DEFAULT_TEMPLATES = [
  {
    id: "monitor_atc",
    name: "{{title}} · Monitor → ATC",
    blurb: "Global monitor restock for this SKU → create + start checkout tasks",
    enabled: true,
    runOnce: false,
    runIntervalMs: 30000,
    notifications: true,
    trigger: { type: "product_monitor" },
    filters: [
      { field: "store", op: "equals", value: "{{store}}" },
      { field: "sku", op: "matches", value: "{{sku}}" },
    ],
    actions: [
      {
        type: "create_tasks",
        config: {
          usePreset: true,
          bandaiMode: "checkout",
          labelTemplate: "{{title}}",
          count: 1,
          qty: 1,
          taskGroup: "{{taskGroup}}",
        },
      },
      { type: "start_tasks", config: { target: { scope: "created", taskGroup: "" } } },
      {
        type: "notify_discord",
        config: { message: "SA Monitor ATC: {{title}} (`{{sku}}`)" },
      },
    ],
  },
  {
    id: "monitor_watch",
    name: "{{title}} · Monitor → Watch task",
    blurb: "On restock, create a Bandai global watch task tagged to the group",
    enabled: true,
    runOnce: false,
    runIntervalMs: 60000,
    notifications: true,
    trigger: { type: "product_monitor" },
    filters: [
      { field: "store", op: "equals", value: "{{store}}" },
      { field: "sku", op: "matches", value: "{{sku}}" },
    ],
    actions: [
      {
        type: "create_tasks",
        config: {
          usePreset: true,
          bandaiMode: "monitor",
          labelTemplate: "Watch {{title}}",
          count: 1,
          qty: 1,
          taskGroup: "{{taskGroup}}",
        },
      },
    ],
  },
  {
    id: "quicktask_atc",
    name: "{{title}} · Quick Task ATC",
    blurb: "When this SKU is quick-tasked (Discord / Feed), create + start checkout",
    enabled: true,
    runOnce: false,
    runIntervalMs: 0,
    notifications: true,
    trigger: { type: "quicktask" },
    filters: [
      { field: "store", op: "equals", value: "{{store}}" },
      { field: "sku", op: "matches", value: "{{sku}}" },
    ],
    actions: [
      {
        type: "create_tasks",
        config: {
          usePreset: true,
          bandaiMode: "checkout",
          labelTemplate: "QT {{title}}",
          count: 1,
          qty: 1,
          taskGroup: "{{taskGroup}}",
        },
      },
      { type: "start_tasks", config: { target: { scope: "created", taskGroup: "" } } },
    ],
  },
  {
    id: "drop_harvest_chain",
    name: "{{title}} · Drop: harvest → start group",
    blurb: "Schedule: start Bandai harvester, wait, then start tasks in this SKU's group",
    enabled: true,
    runOnce: false,
    runIntervalMs: 0,
    notifications: true,
    trigger: {
      type: "schedule",
      at: "06:55",
      tz: "Australia/Sydney",
      repeat: "daily",
    },
    filters: [],
    actions: [
      { type: "start_harvester", config: {} },
      { type: "wait", config: { delaySec: 120 } },
      {
        type: "update_tasks",
        config: {
          target: { scope: "group", taskGroup: "{{taskGroup}}" },
          product: "{{sku}}",
          labelTemplate: "{{title}}",
        },
      },
      {
        type: "start_tasks",
        config: { target: { scope: "group", taskGroup: "{{taskGroup}}" } },
      },
    ],
  },
  {
    id: "monitor_alert",
    name: "{{title}} · Restock alert",
    blurb: "Discord-only ping on monitor restock (no tasks)",
    enabled: true,
    runOnce: false,
    runIntervalMs: 15000,
    notifications: true,
    trigger: { type: "product_monitor" },
    filters: [
      { field: "store", op: "equals", value: "{{store}}" },
      { field: "sku", op: "matches", value: "{{sku}}" },
    ],
    actions: [
      {
        type: "notify_discord",
        config: {
          message: "Restock alert: **{{title}}** (`{{sku}}`) — {{reason}}",
        },
      },
    ],
  },
];

function defaultCatalogState() {
  return {
    rows: [],
    /** null / empty = all default templates enabled */
    enabledTemplateIds: null,
  };
}

function normalizeCatalogState(raw = {}) {
  const base = defaultCatalogState();
  const rows = Array.isArray(raw.rows)
    ? raw.rows.map(normalizeCatalogRow).filter((r) => r.sku)
    : [];
  let enabledTemplateIds = raw.enabledTemplateIds;
  if (Array.isArray(enabledTemplateIds)) {
    enabledTemplateIds = enabledTemplateIds.map(String).filter(Boolean);
  } else {
    enabledTemplateIds = null;
  }
  return { ...base, rows, enabledTemplateIds };
}

function normalizeCatalogRow(raw = {}, idFn) {
  const store = String(raw.store || "bandai").trim().toLowerCase() || "bandai";
  const sku = String(raw.sku || raw.productId || "").trim();
  const title = String(raw.title || sku || "Product").trim().slice(0, 120);
  const taskGroup = String(raw.taskGroup || raw.group || title || sku)
    .trim()
    .slice(0, 80);
  const id =
    raw.id ||
    (idFn ? idFn("cat") : `cat_${store}_${sku}`.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 80));
  return {
    id,
    store,
    sku,
    title: title || sku,
    taskGroup: taskGroup || sku,
    enabled: raw.enabled !== false,
    notes: String(raw.notes || "").slice(0, 200),
  };
}

/**
 * Parse bulk lines:
 *   N2890… Title here
 *   bandai N2890… Title
 *   store,sku,title
 */
function parseCatalogBulk(text, opts = {}) {
  const defaultStore = String(opts.defaultStore || "bandai").toLowerCase();
  const lines = String(text || "").split(/\r?\n/);
  const rows = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    let store = defaultStore;
    let sku = "";
    let title = "";

    if (trimmed.includes(",")) {
      const parts = trimmed.split(",").map((p) => p.trim());
      if (parts.length >= 2 && /^[a-z]+$/i.test(parts[0]) && parts[0].length < 24) {
        store = parts[0].toLowerCase();
        sku = parts[1];
        title = parts.slice(2).join(", ").trim();
      } else {
        sku = parts[0];
        title = parts.slice(1).join(", ").trim();
      }
    } else {
      const tokens = trimmed.split(/\s+/);
      if (
        tokens.length >= 2 &&
        /^(bandai|kmart|toymate|disney|pokemoncentre|pokemon)$/i.test(tokens[0])
      ) {
        store = tokens[0].toLowerCase();
        sku = tokens[1];
        title = tokens.slice(2).join(" ").trim();
      } else {
        sku = tokens[0];
        title = tokens.slice(1).join(" ").trim();
      }
    }

    if (!sku) continue;
    rows.push(
      normalizeCatalogRow({
        store,
        sku,
        title: title || sku,
        taskGroup: title || sku,
      }),
    );
  }
  return rows;
}

function catalogActionId(templateId, store, sku) {
  const slug = `${templateId}__${store}__${sku}`
    .replace(/[^a-zA-Z0-9_-]+/g, "_")
    .replace(/_+/g, "_")
    .slice(0, 96);
  return `sa_cat_${slug}`;
}

function catalogKey(templateId, store, sku) {
  return `${templateId}::${String(store || "").toLowerCase()}::${String(sku || "").trim()}`;
}

function applyPlaceholders(value, vars) {
  if (typeof value === "string") {
    return value.replace(/\{\{\s*(\w+)\s*\}\}/g, (_, key) => {
      const v = vars[key];
      return v == null ? "" : String(v);
    });
  }
  if (Array.isArray(value)) {
    return value.map((v) => applyPlaceholders(v, vars));
  }
  if (value && typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = applyPlaceholders(v, vars);
    }
    return out;
  }
  return value;
}

function materializeAction(template, row) {
  const vars = {
    sku: row.sku,
    store: row.store,
    title: row.title || row.sku,
    taskGroup: row.taskGroup || row.title || row.sku,
    group: row.taskGroup || row.title || row.sku,
    reason: "restock",
  };
  const drafted = applyPlaceholders(
    {
      name: template.name,
      enabled: template.enabled !== false && row.enabled !== false,
      runOnce: template.runOnce === true,
      runIntervalMs: template.runIntervalMs,
      notifications: template.notifications !== false,
      trigger: template.trigger,
      filters: template.filters || [],
      actions: template.actions || [],
    },
    vars,
  );
  const key = catalogKey(template.id, row.store, row.sku);
  return {
    ...drafted,
    id: catalogActionId(template.id, row.store, row.sku),
    name: String(drafted.name || `${template.id} · ${row.sku}`).slice(0, 120),
    catalogKey: key,
    catalogTemplateId: template.id,
    catalogRowId: row.id,
  };
}

function listTemplates(overrides = []) {
  const byId = new Map(DEFAULT_TEMPLATES.map((t) => [t.id, { ...t }]));
  for (const t of overrides || []) {
    if (t?.id) byId.set(t.id, { ...byId.get(t.id), ...t, id: t.id });
  }
  return [...byId.values()];
}

/**
 * Expand enabled templates × enabled rows into Smart Action drafts.
 * @returns {{ drafts: object[], skipped: number, pairs: number }}
 */
function expandCatalog(catalog, opts = {}) {
  const state = normalizeCatalogState(catalog);
  const templates = listTemplates(opts.templates);
  const enabledIds = state.enabledTemplateIds;
  const activeTemplates = templates.filter((t) => {
    if (t.enabled === false) return false;
    if (!enabledIds || !enabledIds.length) return true;
    return enabledIds.includes(t.id);
  });
  const rows = state.rows.filter((r) => r.enabled !== false && r.sku);
  const drafts = [];
  for (const row of rows) {
    for (const tmpl of activeTemplates) {
      drafts.push(materializeAction(tmpl, row));
    }
  }
  return {
    drafts,
    skipped: 0,
    pairs: drafts.length,
    templateCount: activeTemplates.length,
    rowCount: rows.length,
  };
}

/**
 * Apply catalog into the Smart Actions engine (idempotent upsert).
 * @param {{ catalog: object, upsert: (action: object) => object, remove?: (id: string) => void, pruneMissing?: boolean }} opts
 */
function applyCatalog(opts = {}) {
  const { drafts, templateCount, rowCount, pairs } = expandCatalog(opts.catalog, {
    templates: opts.templates,
  });
  const upserted = [];
  for (const draft of drafts) {
    const row = opts.upsert?.(draft);
    upserted.push(row || draft);
  }

  let pruned = 0;
  if (opts.pruneMissing && typeof opts.list === "function" && typeof opts.remove === "function") {
    const keep = new Set(drafts.map((d) => d.id));
    for (const sa of opts.list() || []) {
      if (sa?.catalogKey && !keep.has(sa.id)) {
        opts.remove(sa.id);
        pruned += 1;
      }
    }
  }

  return {
    ok: true,
    createdOrUpdated: upserted.length,
    pairs,
    templateCount,
    rowCount,
    pruned,
    actions: upserted,
  };
}

function removeCatalogActions(list, opts = {}) {
  const actions = list || [];
  const rowId = opts.rowId || null;
  const templateId = opts.templateId || null;
  const removed = [];
  for (const sa of actions) {
    if (!sa?.catalogKey && !String(sa?.id || "").startsWith("sa_cat_")) continue;
    if (rowId && sa.catalogRowId !== rowId) continue;
    if (templateId && sa.catalogTemplateId !== templateId) continue;
    removed.push(sa.id);
  }
  return removed;
}

module.exports = {
  DEFAULT_TEMPLATES,
  defaultCatalogState,
  normalizeCatalogState,
  normalizeCatalogRow,
  parseCatalogBulk,
  catalogActionId,
  catalogKey,
  materializeAction,
  listTemplates,
  expandCatalog,
  applyCatalog,
  removeCatalogActions,
  applyPlaceholders,
};
