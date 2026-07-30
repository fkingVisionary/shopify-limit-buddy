// Smart Action preset catalog — templates × SKU rows → materialized Smart Actions.
// Idempotent: same templateId + store + sku always upserts the same action id.

/**
 * Built-in templates. Placeholders: {{sku}} {{store}} {{title}} {{taskGroup}} {{group}}
 * Keep these opinionated and few — curation is the product.
 */
/** Full Bandai/store checkout task config (place order — not ATC-only). */
function checkoutCreateConfig(labelTemplate) {
  return {
    usePreset: true,
    store: "{{store}}",
    bandaiMode: "checkout",
    bandaiCheckoutMode: "fast",
    placeOrder: true,
    labelTemplate,
    count: 1,
    qty: 1,
    taskGroup: "{{taskGroup}}",
  };
}

function triggerWhenLabel(trigger) {
  const t = String(trigger?.type || "");
  if (t === "product_monitor") return "When the monitor feed restocks a matching SKU";
  if (t === "quicktask") return "When Quick Task fires (Discord button or Feed)";
  if (t === "schedule") {
    const at = String(trigger?.at || "").trim() || "set time";
    const tz = String(trigger?.tz || "Australia/Sydney").trim();
    const repeat = String(trigger?.repeat || "daily");
    return `On schedule · ${at} ${tz}${repeat === "once" ? " (once)" : " daily"}`;
  }
  return "When triggered";
}

function actionStepLabel(action) {
  const type = String(action?.type || "");
  const cfg = action?.config || {};
  if (type === "create_tasks") {
    if (String(cfg.bandaiMode || "") === "monitor") return "Create a watch (monitor) task";
    if (cfg.placeOrder) return "Create checkout task (place order on)";
    return "Create task from Quick Task preset";
  }
  if (type === "start_tasks") {
    const scope = cfg.target?.scope || "created";
    if (scope === "group") return "Start the task group";
    if (scope === "all") return "Start all enabled tasks";
    return "Start the tasks just created";
  }
  if (type === "stop_tasks") return "Stop matching tasks";
  if (type === "delete_tasks") return "Delete matching tasks";
  if (type === "stop_after") {
    const sec =
      (Number(cfg.delayHour) || 0) * 3600 +
      (Number(cfg.delayMin) || 0) * 60 +
      (Number(cfg.delaySec) || 0);
    if (sec >= 3600) return `Stop group after ${Math.round(sec / 3600)}h`;
    if (sec >= 60) return `Stop group after ${Math.round(sec / 60)} min`;
    return `Stop group after ${sec}s`;
  }
  if (type === "wait") {
    const sec = Math.max(0, Number(cfg.delaySec) || 0);
    if (sec >= 60) return `Wait ${Math.round(sec / 60)} min`;
    return `Wait ${sec}s`;
  }
  if (type === "notify_discord") return "Ping Discord";
  if (type === "notify_toast") return "Desktop toast";
  if (type === "create_task_group") return "Create / ensure task group";
  if (type === "goto_task_group") return "Go to task group";
  if (type === "start_harvester") return "Start Bandai harvest bank";
  if (type === "stop_harvester") return "Stop harvest bank";
  if (type === "update_tasks") {
    if (cfg.bandaiMonitorDelayMs === 0 || cfg.bandaiMonitorDelayMs === "0") {
      return "Set monitor start delay → 0 on the group";
    }
    if (cfg.product) return "Point the task group at this SKU";
    return "Patch the task group";
  }
  return type.replace(/_/g, " ");
}

/**
 * Human-readable “what this pack does” for UI (admin SKUs × this pack).
 * @returns {{ when: string, steps: string[], does: string, explain: string, applies: string }}
 */
function describeTemplate(template) {
  const t = template || {};
  const when = triggerWhenLabel(t.trigger);
  const steps = (Array.isArray(t.actions) ? t.actions : []).map(actionStepLabel).filter(Boolean);
  const does =
    String(t.does || "").trim() ||
    String(t.blurb || "").trim() ||
    (steps.length ? `${when} → ${steps.join(" → ")}` : when);
  const explain =
    String(t.explain || "").trim() ||
    (steps.length ? `${when}. Then: ${steps.join(" → ")}.` : when);
  const applies =
    String(t.applies || "").trim() ||
    "Opens in the builder — edit filters and actions, then Save";
  return {
    when,
    steps,
    does,
    explain,
    applies,
    filterCount: Array.isArray(t.filters) ? t.filters.length : 0,
    actionCount: Array.isArray(t.actions) ? t.actions.length : 0,
  };
}

const DEFAULT_TEMPLATES = [
  {
    id: "monitor_atc", // stable id (was named ATC; now full checkout)
    name: "{{title}} · Monitor → Checkout",
    displayName: "Instant Checkout",
    category: "Bandai",
    glyph: "IC",
    accent: "silver",
    blurb: "Restock → checkout now",
    does: "On restock for that SKU: create a live checkout task, start it immediately, then Discord.",
    explain:
      "Best default for drops. When Monitor sees this SKU back in stock, Vanta creates a checkout task from your Quick Task preset, starts it right away, and pings Discord. Keep the app open.",
    applies: "One action per library SKU — fires whenever that SKU restocks",
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
      { type: "create_tasks", config: checkoutCreateConfig("{{title}}") },
      { type: "start_tasks", config: { target: { scope: "created", taskGroup: "" } } },
      {
        type: "notify_discord",
        config: { message: "SA Monitor Checkout: {{title}} (`{{sku}}`)" },
      },
    ],
  },
  {
    id: "monitor_checkout_delay_30m",
    name: "{{title}} · Monitor → Checkout +30m",
    displayName: "Checkout +30m",
    category: "Bandai",
    glyph: "+30",
    accent: "steel",
    blurb: "Restock → wait 30m → checkout",
    does: "On restock: Discord “armed”, wait 30 min (cart-expiry window), then create + start checkout.",
    explain:
      "For Bandai unpaid cart holds. First restock ping arms the action and waits 30 minutes (typical cart-expiry window). Then it creates and starts checkout — catching the second wave when carts expire. App must stay open for the wait.",
    applies: "Bandai SKUs only · one delayed checkout action per SKU",
    /** Only materialize for these stores (Bandai cart-hold expiry pattern). */
    stores: ["bandai"],
    enabled: true,
    runOnce: false,
    runIntervalMs: 0,
    notifications: true,
    trigger: { type: "product_monitor" },
    filters: [
      { field: "store", op: "equals", value: "bandai" },
      { field: "sku", op: "matches", value: "{{sku}}" },
    ],
    actions: [
      {
        type: "notify_discord",
        config: {
          message: "SA +30m armed: **{{title}}** (`{{sku}}`) — waiting 30m for cart-expiry restock",
        },
      },
      { type: "wait", config: { delaySec: 1800 } },
      {
        type: "create_tasks",
        config: checkoutCreateConfig("{{title}} +30m"),
      },
      { type: "start_tasks", config: { target: { scope: "created", taskGroup: "" } } },
      {
        type: "notify_discord",
        config: { message: "SA +30m Checkout firing: {{title}} (`{{sku}}`)" },
      },
    ],
  },
  {
    id: "monitor_watch",
    name: "{{title}} · Monitor → Watch task",
    displayName: "Watch Task",
    category: "Monitor",
    glyph: "WT",
    accent: "graphite",
    blurb: "Restock → create a watch task",
    does: "On restock: create a Bandai Monitor task for that SKU (does not checkout by itself).",
    explain:
      "Spawns a Monitor task aimed at this SKU when it restocks. Useful if you want a dedicated watch lane without auto-buying. Pair with Instant Checkout or start the task yourself later.",
    applies: "One watch-task action per library SKU",
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
          store: "{{store}}",
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
    id: "quicktask_atc", // stable id; full checkout
    name: "{{title}} · Quick Task Checkout",
    displayName: "Quick Task",
    category: "Discord",
    glyph: "QT",
    accent: "silver",
    blurb: "Manual Quick Task → checkout",
    does: "When you hit Quick Task for that SKU: create checkout from your preset and start it.",
    explain:
      "Fires only when you press Quick Task (Monitor row or Discord). Creates and starts a checkout from your Quick Task preset for that SKU — good for manual confirmations without auto-arming restocks.",
    applies: "One Quick Task handler per library SKU",
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
      { type: "create_tasks", config: checkoutCreateConfig("QT {{title}}") },
      { type: "start_tasks", config: { target: { scope: "created", taskGroup: "" } } },
    ],
  },
  {
    id: "drop_harvest_chain",
    name: "{{title}} · Drop: harvest → checkout group",
    displayName: "Drop Chain",
    category: "Schedule",
    glyph: "DC",
    accent: "steel",
    blurb: "Scheduled harvest → aim group → start",
    does: "Daily at schedule: start harvest, wait 2 min, point the task group at this SKU, then start the group.",
    explain:
      "Drop prep on a clock. At the set time (default 06:55 Australia/Sydney): start the Bandai harvest bank, wait 2 minutes for sessions to warm, retarget this SKU’s task group at the product, then start that whole group. Edit the schedule/time before Save. App must be open at fire time. Pair with Delay Tighten if monitor tasks use a start delay.",
    applies: "One scheduled drop chain per library SKU (uses that SKU’s task group)",
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
    id: "drop_delay_tighten",
    name: "{{title}} · Pre-drop delay tighten",
    displayName: "Delay Tighten",
    category: "Schedule",
    glyph: "DT",
    accent: "steel",
    blurb: "T−30s: zero monitor start delay",
    does: "Daily at 12:59:30 AEST: set monitor start delay to 0 on this SKU’s task group (pre-drop tighten).",
    explain:
      "Pre-drop timing trick. Keep monitor tasks with a long start delay during the day (safer / less spam), then at T−30s (default 12:59:30 Australia/Sydney) this action sets that group’s monitor start delay to 0 so the next poll fires tight. Does not create or start tasks by itself — it only patches delay. Change the schedule to match your drop time. Bandai only · app must be open.",
    applies: "Bandai SKUs only · one schedule action per SKU/group",
    enabled: true,
    runOnce: false,
    runIntervalMs: 0,
    notifications: true,
    trigger: {
      type: "schedule",
      at: "12:59:30",
      tz: "Australia/Sydney",
      repeat: "daily",
    },
    filters: [],
    actions: [
      {
        type: "update_tasks",
        config: {
          target: { scope: "group", taskGroup: "{{taskGroup}}" },
          bandaiMonitorDelayMs: 0,
        },
      },
    ],
    stores: ["bandai"],
  },
  {
    id: "monitor_alert",
    name: "{{title}} · Restock alert",
    displayName: "Restock Alert",
    category: "Notify",
    glyph: "RA",
    accent: "graphite",
    blurb: "Restock → Discord only",
    does: "On restock for that SKU: Discord alert only — no tasks created or started.",
    explain:
      "Heads-up only. When this SKU restocks, send a Discord ping — no tasks created or started. Use when you want visibility without auto-checkout.",
    applies: "One alert action per library SKU",
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
    /** null = all packs on; [] = all off; string[] = allow-list */
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
  const areaItemNo = String(raw.areaItemNo || raw.bandaiAreaItemNo || "").trim();
  const areaItemNos = Array.isArray(raw.areaItemNos)
    ? raw.areaItemNos.map(String).filter(Boolean)
    : areaItemNo
      ? [areaItemNo]
      : [];
  const id =
    raw.id ||
    (idFn ? idFn("cat") : `cat_${store}_${sku}`.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 80));
  // Per-SKU packs (opt-in). Empty = no Smart Actions for this product.
  const enabledTemplateIds = Array.isArray(raw.enabledTemplateIds)
    ? [...new Set(raw.enabledTemplateIds.map(String).filter(Boolean))]
    : [];
  const imageUrl = String(raw.imageUrl || raw.image || raw.thumbnailUrl || "")
    .trim()
    .slice(0, 500);
  return {
    id,
    store,
    sku,
    title: title || sku,
    taskGroup: taskGroup || sku,
    area: String(raw.area || "au").toLowerCase().slice(0, 2),
    areaItemNo: /^NAI|^AAI/i.test(areaItemNo) ? areaItemNo : "",
    areaItemNos,
    imageUrl,
    enabledTemplateIds,
    enabled: raw.enabled !== false,
    notes: String(raw.notes || "").slice(0, 200),
  };
}

/** Packs that should materialize for a single catalog row. */
function packsForRow(row, templates, globalEnabledIds) {
  const allIds = (templates || []).filter((t) => t.enabled !== false).map((t) => t.id);
  if (Array.isArray(row?.enabledTemplateIds)) {
    // Explicit per-SKU list (including empty = none).
    return allIds.filter((id) => row.enabledTemplateIds.includes(id));
  }
  // Legacy: no per-SKU field → honor global pack allow-list.
  if (globalEnabledIds == null) return allIds;
  if (!globalEnabledIds.length) return [];
  return allIds.filter((id) => globalEnabledIds.includes(id));
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
 * Expand per-SKU packs (or legacy global packs) into Smart Action drafts.
 * @returns {{ drafts: object[], skipped: number, pairs: number }}
 */
function expandCatalog(catalog, opts = {}) {
  const state = normalizeCatalogState(catalog);
  const templates = listTemplates(opts.templates);
  const rows = state.rows.filter((r) => r.enabled !== false && r.sku);
  const drafts = [];
  const packIdsUsed = new Set();
  for (const row of rows) {
    const packIds = packsForRow(row, templates, state.enabledTemplateIds);
    for (const tmpl of templates) {
      if (tmpl.enabled === false) continue;
      if (!packIds.includes(tmpl.id)) continue;
      if (Array.isArray(tmpl.stores) && tmpl.stores.length) {
        const allowed = tmpl.stores.map((s) => String(s).toLowerCase());
        if (!allowed.includes(String(row.store || "").toLowerCase())) continue;
      }
      packIdsUsed.add(tmpl.id);
      drafts.push(materializeAction(tmpl, row));
    }
  }
  return {
    drafts,
    skipped: 0,
    pairs: drafts.length,
    templateCount: packIdsUsed.size,
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

/** Featured quick-toggle packs shown on SKU cards (order = UI order). */
const QUICK_PACK_IDS = [
  "monitor_atc",
  "monitor_checkout_delay_30m",
  "monitor_alert",
  "quicktask_atc",
];

module.exports = {
  DEFAULT_TEMPLATES,
  QUICK_PACK_IDS,
  defaultCatalogState,
  normalizeCatalogState,
  normalizeCatalogRow,
  parseCatalogBulk,
  catalogActionId,
  catalogKey,
  materializeAction,
  listTemplates,
  packsForRow,
  expandCatalog,
  applyCatalog,
  removeCatalogActions,
  applyPlaceholders,
  describeTemplate,
  triggerWhenLabel,
  actionStepLabel,
};
