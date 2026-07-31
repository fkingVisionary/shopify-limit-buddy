/* Cybersole-style Smart Actions gallery + full-screen builder (Vanta).
 * Loaded after app.js — overrides openSaEditor / closeSaEditor / filter+action renderers.
 */

const SA_TRIGGERS = [
  {
    id: "product_monitor",
    title: "Product Monitor",
    desc: "When the product monitor sees a restock or new listing",
  },
  {
    id: "quicktask",
    title: "Quick Task",
    desc: "When you run Quick Task from the feed or Discord",
  },
  {
    id: "schedule",
    title: "Schedule",
    desc: "At a set time while the app stays open",
  },
];

const SA_FILTER_FIELDS = [
  { id: "store", label: "Store Name" },
  { id: "storeGroup", label: "Store Group" },
  { id: "title", label: "Product Name" },
  { id: "sku", label: "SKU" },
  { id: "url", label: "URL" },
  { id: "reason", label: "Reason" },
  { id: "price", label: "Price" },
  { id: "productType", label: "Product Type" },
  { id: "inStock", label: "In Stock" },
];

const SA_FILTER_OPS = [
  { id: "equals", label: "equals" },
  { id: "is", label: "is" },
  { id: "in", label: "in" },
  { id: "equals_any", label: "equals any" },
  { id: "not_equals", label: "not equals" },
  { id: "contains", label: "contains" },
  { id: "not_contains", label: "not contain" },
  { id: "contains_any", label: "contains any" },
  { id: "contains_all", label: "contains all" },
  { id: "contains_none", label: "contains none" },
  { id: "matches", label: "matches (keywords)" },
];

/** Fields with a fixed option set → value control is a <select> (not free text). */
const SA_FILTER_CHOICES = {
  store: [
    { value: "bandai", label: "Bandai" },
    { value: "kmart", label: "Kmart" },
    { value: "toymate", label: "Toymate" },
    { value: "disney", label: "Disney" },
    { value: "pokemoncentre", label: "Pokémon Centre" },
  ],
  reason: [
    { value: "restock", label: "Restock" },
    { value: "oos", label: "Out of stock" },
    { value: "new", label: "New listing" },
    { value: "inject", label: "Inject / test" },
  ],
  inStock: [
    { value: "true", label: "In stock" },
    { value: "false", label: "Out of stock" },
  ],
  productType: [
    { value: "Sale", label: "Sale" },
    { value: "PreOrder", label: "Pre-order" },
    { value: "Lottery", label: "Lottery / Chance" },
    { value: "Limited", label: "Limited" },
  ],
};

function saStoreGroupChoices() {
  return (state?.storeGroups || []).map((g) => ({
    value: g.id,
    label: `${g.name} (${(g.stores || []).length})`,
  }));
}

function saFilterChoices(field) {
  const f = String(field || "").toLowerCase();
  if (f === "storegroup" || f === "store_group") return saStoreGroupChoices();
  return SA_FILTER_CHOICES[f] || null;
}

function saFilterMultiOp(op) {
  const o = String(op || "").toLowerCase();
  return (
    o === "in" ||
    o === "equals_any" ||
    o === "contains_any" ||
    o === "contains_all" ||
    o === "contains_none"
  );
}

function saOpsForField(field) {
  const f = String(field || "").toLowerCase();
  if (f === "instock") {
    return SA_FILTER_OPS.filter((o) => o.id === "equals" || o.id === "not_equals");
  }
  if (f === "storegroup" || f === "store_group") {
    return SA_FILTER_OPS.filter((o) => ["is", "in", "equals", "not_equals"].includes(o.id));
  }
  if (saFilterChoices(f)) {
    return SA_FILTER_OPS.filter((o) =>
      ["equals", "not_equals", "equals_any", "contains_any", "contains_none"].includes(o.id),
    );
  }
  return SA_FILTER_OPS;
}

function saSplitFilterValues(value) {
  return String(value || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function saFilterValueControlHtml(field, op, value, i) {
  const choices = saFilterChoices(field);
  if (!choices) {
    return `<input class="sa-filter-value" data-sa-fv="${i}" value="${esc(value || "")}" placeholder="${esc(
      saFilterPlaceholder(field),
    )}" aria-label="Value" />`;
  }
  const multi = saFilterMultiOp(op);
  const selected = new Set(saSplitFilterValues(value).map((v) => v.toLowerCase()));
  // Preserve unknown saved values so edits don't drop them.
  const extras = saSplitFilterValues(value).filter(
    (v) => !choices.some((c) => String(c.value).toLowerCase() === v.toLowerCase()),
  );
  const opts = [
    ...(!multi ? [`<option value="">Select…</option>`] : []),
    ...choices.map((c) => {
      const on = selected.has(String(c.value).toLowerCase());
      return `<option value="${esc(c.value)}" ${on ? "selected" : ""}>${esc(c.label)}</option>`;
    }),
    ...extras.map(
      (v) => `<option value="${esc(v)}" selected>${esc(v)}</option>`,
    ),
  ].join("");
  if (multi) {
    return `<select class="sa-filter-value sa-filter-value-multi" data-sa-fv="${i}" multiple size="${Math.min(
      4,
      Math.max(2, choices.length + extras.length),
    )}" aria-label="Values (multi)">${opts}</select>`;
  }
  // Single-select: only the first CSV token counts for equals / not equals.
  const single = saSplitFilterValues(value)[0] || "";
  const singleOpts = [
    `<option value="">Select…</option>`,
    ...choices.map((c) => {
      const on = String(c.value).toLowerCase() === single.toLowerCase();
      return `<option value="${esc(c.value)}" ${on ? "selected" : ""}>${esc(c.label)}</option>`;
    }),
    ...extras.map((v) => `<option value="${esc(v)}" selected>${esc(v)}</option>`),
  ].join("");
  return `<select class="sa-filter-value" data-sa-fv="${i}" aria-label="Value">${singleOpts}</select>`;
}

function saTaskGroupSelectHtml(attr, selected, { emptyLabel = "No group", allowEmpty = true } = {}) {
  const names =
    typeof taskGroupNames === "function"
      ? taskGroupNames([selected])
      : [
          ...new Set(
            (state?.tasks || [])
              .map((t) => String(t.taskGroup || "").trim())
              .filter(Boolean),
          ),
        ].sort((a, b) => a.localeCompare(b));
  const want = String(selected || "");
  const list = [...names];
  if (want && !list.includes(want)) list.push(want);
  return `<select ${attr}>
    ${allowEmpty ? `<option value="">${esc(emptyLabel)}</option>` : ""}
    ${list.map((n) => `<option value="${esc(n)}" ${n === want ? "selected" : ""}>${esc(n)}</option>`).join("")}
  </select>`;
}

const SA_ACTION_META = [
  {
    type: "create_tasks",
    glyph: "CT",
    title: "Create Tasks",
    desc: "Creates checkout or monitor tasks from your Quick Task preset",
    input: "Mode, Task Group, Count, Qty",
    output: "Tasks",
  },
  {
    type: "update_tasks",
    glyph: "UT",
    title: "Update Tasks",
    desc: "Patches product, qty, or monitor delay on matching tasks",
    input: "Target, Product, Delay",
    output: "Tasks",
  },
  {
    type: "start_tasks",
    glyph: "ST",
    title: "Start Tasks",
    desc: "Starts tasks created above, in a group, or all enabled",
    input: "Target",
    output: "Jobs",
  },
  {
    type: "stagger_start_tasks",
    glyph: "SS",
    title: "Stagger Start Tasks",
    desc: "Starts matching tasks with a gap between each enqueue (drop-safe)",
    input: "Target, Gap ms",
    output: "Jobs",
  },
  {
    type: "stagger_start_task_group",
    glyph: "SG",
    title: "Stagger Start Task Group",
    desc: "Starts every enabled task in a task group with staggered gaps",
    input: "Task Group, Gap ms",
    output: "Jobs",
  },
  {
    type: "stop_tasks",
    glyph: "SP",
    title: "Stop Tasks",
    desc: "Soft-stops matching tasks",
    input: "Target",
    output: "None",
  },
  {
    type: "delete_tasks",
    glyph: "DT",
    title: "Delete Tasks",
    desc: "Deletes matching tasks from Desktop",
    input: "Target",
    output: "None",
  },
  {
    type: "wait",
    glyph: "WT",
    title: "Wait",
    desc: "Pauses the pipeline for a duration (max 30 minutes)",
    input: "Seconds",
    output: "None",
  },
  {
    type: "stop_after",
    glyph: "SA",
    title: "Stop Task Group After",
    desc: "Waits, then stops the selected task group",
    input: "Task Group, Seconds, Minutes, Hours",
    output: "None",
  },
  {
    type: "create_task_group",
    glyph: "CG",
    title: "Create Task Group",
    desc: "Ensures a named task group exists for following steps",
    input: "Group Name",
    output: "Task Group",
  },
  {
    type: "goto_task_group",
    glyph: "GT",
    title: "Go To Task Group",
    desc: "Navigates the Tasks tab to the specified group",
    input: "Task Group",
    output: "None",
  },
  {
    type: "start_harvester",
    glyph: "HS",
    title: "Start Harvester",
    desc: "Starts the harvest bank (engine + proxy group required)",
    input: "None",
    output: "Harvest",
  },
  {
    type: "stop_harvester",
    glyph: "HH",
    title: "Stop Harvester",
    desc: "Stops the harvest bank",
    input: "None",
    output: "None",
  },
  {
    type: "notify_discord",
    glyph: "DC",
    title: "Notify Discord",
    desc: "Posts a message to your Success webhook",
    input: "Message",
    output: "None",
  },
  {
    type: "notify_toast",
    glyph: "NT",
    title: "Desktop Toast",
    desc: "Shows an in-app toast notification",
    input: "Message",
    output: "None",
  },
];

let saFilterEditIndex = null;
let saBuilderProductRow = null;

function saApplyTpl(str, ctx) {
  return String(str || "").replace(/\{\{\s*(\w+)\s*\}\}/g, (_, key) => {
    const v = ctx?.[key];
    return v == null ? "" : String(v);
  });
}

function saDeepTpl(value, ctx) {
  if (typeof value === "string") return saApplyTpl(value, ctx);
  if (Array.isArray(value)) return value.map((v) => saDeepTpl(v, ctx));
  if (value && typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = saDeepTpl(v, ctx);
    return out;
  }
  return value;
}

function saBlankAction(type) {
  const t = String(type || "create_tasks");
  if (t === "create_tasks") {
    return {
      type: t,
      config: {
        usePreset: true,
        store: "bandai",
        bandaiMode: "checkout",
        qty: 1,
        quantity: 1,
        placeOrder: true,
        labelTemplate: "{{title}}",
        count: 1,
        taskGroup: "",
      },
    };
  }
  if (t === "notify_discord") {
    return { type: t, config: { message: "Smart Action: {{title}} ({{sku}})" } };
  }
  if (t === "notify_toast") {
    return { type: t, config: { message: "Smart Action: {{title}} ({{sku}})", level: "ok" } };
  }
  if (t === "wait") return { type: t, config: { delaySec: 60 } };
  if (t === "stop_after") {
    return {
      type: t,
      config: {
        delaySec: 60,
        delayMin: 0,
        delayHour: 0,
        target: { scope: "group", taskGroup: "" },
      },
    };
  }
  if (t === "create_task_group" || t === "goto_task_group") {
    return { type: t, config: { taskGroup: "{{taskGroup}}" } };
  }
  if (t === "update_tasks") {
    return {
      type: t,
      config: {
        target: { scope: "created", taskGroup: "" },
        product: "{{sku}}",
        pdpUrl: "",
        qty: null,
        quantity: null,
        bandaiMonitorDelayMs: null,
        bandaiMonitorIntervalMs: null,
        labelTemplate: "",
      },
    };
  }
  if (t === "start_tasks" || t === "stop_tasks" || t === "delete_tasks") {
    return { type: t, config: { target: { scope: "created", taskGroup: "" } } };
  }
  if (t === "stagger_start_tasks") {
    return {
      type: t,
      config: {
        target: { scope: "created", taskGroup: "", storeGroup: "" },
        staggerGapMs: 50,
      },
    };
  }
  if (t === "stagger_start_task_group") {
    return {
      type: t,
      config: {
        target: { scope: "group", taskGroup: "" },
        staggerGapMs: 50,
      },
    };
  }
  return { type: t, config: {} };
}

function saGalleryCategory(t) {
  if (t.galleryCategory) return t.galleryCategory;
  const c = String(t.category || "").toLowerCase();
  const trig = String(t.trigger?.type || "").toLowerCase();
  if (c === "schedule" || trig === "schedule") return "Schedule";
  if (c === "discord" || trig === "quicktask") return "Quicktask";
  if (c === "notify") return "Notify";
  return "Product Monitor";
}

function openSaTemplateGallery(opts = {}) {
  saBuilderProductRow = opts.row || null;
  const body = $("saTemplateDialogBody");
  if (!body) return;
  const templates = (saCatalogState().templates || []).filter((t) => t.enabled !== false);
  const byCat = new Map();
  for (const t of templates) {
    const cat = saGalleryCategory(t);
    if (!byCat.has(cat)) byCat.set(cat, []);
    byCat.get(cat).push(t);
  }
  const order = ["Product Monitor", "Schedule", "Quicktask", "Notify"];
  const cats = [...order.filter((c) => byCat.has(c)), ...[...byCat.keys()].filter((c) => !order.includes(c))];

  body.innerHTML = `
    <section class="sa-gallery-section">
      <h4>Start from scratch</h4>
      <button type="button" class="sa-gallery-blank" data-sa-gallery-blank>+</button>
      <div class="sa-gallery-blank-label">Blank</div>
    </section>
    <section class="sa-gallery-section">
      <h4>Or from a template</h4>
      ${cats
        .map((cat) => {
          const tiles = byCat.get(cat) || [];
          return `<h5>${esc(cat)}</h5>
            <div class="sa-gallery-grid">
              ${tiles
                .map((t) => {
                  const fCount = Number(t.filterCount) || (t.filters || []).length || 0;
                  const aCount = Number(t.actionCount) || (t.actions || []).length || 0;
                  const blurb = t.blurb || t.does || "";
                  const explain = t.explain || t.does || "";
                  return `<button type="button" class="sa-gallery-tile" data-sa-gallery-tmpl="${esc(t.id)}" title="${esc(explain)}">
                    <div class="sa-gallery-pipe">
                      <span title="Trigger">TR</span>
                      <span title="Filters">FL${fCount ? `<i>${fCount}</i>` : ""}</span>
                      <span title="Actions">AC${aCount ? `<i>${aCount}</i>` : ""}</span>
                    </div>
                    <div class="sa-gallery-copy">
                      <strong>${esc(saCatalogDisplayName(t))}</strong>
                      ${blurb ? `<p class="sa-gallery-blurb">${esc(blurb)}</p>` : ""}
                      ${
                        explain && explain !== blurb
                          ? `<p class="sa-gallery-explain">${esc(explain)}</p>`
                          : ""
                      }
                    </div>
                  </button>`;
                })
                .join("")}
            </div>`;
        })
        .join("")}
    </section>
  `;
  openDialog("saTemplateDialog");
}

function closeSaTemplateGallery() {
  closeDialog("saTemplateDialog");
}

function draftFromTemplate(tmpl, row) {
  const ctx = {
    sku: row?.sku || "",
    store: row?.store || "bandai",
    title: row?.title || row?.sku || "",
    taskGroup: row?.taskGroup || row?.title || row?.sku || "",
    group: row?.taskGroup || row?.title || row?.sku || "",
  };
  const preset = state?.settings?.quickTaskPreset || {};
  const filters = Array.isArray(tmpl?.filters)
    ? tmpl.filters.map((f) => saDeepTpl({ ...f }, ctx))
    : [];
  if (row?.sku && !filters.some((f) => String(f.field).toLowerCase() === "sku" && String(f.value || "").trim())) {
    filters.unshift({ field: "sku", op: "equals", value: String(row.sku) });
  }
  if (row?.store && !filters.some((f) => String(f.field).toLowerCase() === "store")) {
    filters.unshift({ field: "store", op: "equals", value: String(row.store) });
  }
  const actions = Array.isArray(tmpl?.actions) && tmpl.actions.length
    ? tmpl.actions.map((a) => {
        const config = saDeepTpl({ ...(a.config || {}) }, ctx);
        if (a.type === "create_tasks") {
          if (!config.profileId && preset.profileId) config.profileId = preset.profileId;
          if (!config.proxyGroupId && preset.proxyGroupId) config.proxyGroupId = preset.proxyGroupId;
          if (!config.labelTemplate) config.labelTemplate = "{{title}}";
        }
        return { type: a.type, config };
      })
    : [saBlankAction("create_tasks"), saBlankAction("start_tasks")];
  return {
    id: undefined,
    name: saApplyTpl(tmpl?.name || tmpl?.displayName || "Untitled action", ctx),
    enabled: true,
    runOnce: tmpl?.runOnce === true,
    notifications: tmpl?.notifications !== false,
    runIntervalMs: tmpl?.runIntervalMs ?? 30000,
    trigger: tmpl?.trigger ? { ...tmpl.trigger } : { type: "product_monitor" },
    filters,
    actions,
    catalogTemplateId: tmpl?.id || null,
    catalogRowId: row?.id || null,
  };
}

function findExistingCatalogAction(templateId, row) {
  if (!templateId || !row?.sku) return null;
  const store = String(row.store || "bandai").toLowerCase();
  const sku = String(row.sku);
  const key = `${templateId}::${store}::${sku}`;
  const rows = state?.smartActions?.actions || [];
  // Prefer user-saved actions over legacy silent `sa_cat_*` materializations.
  return (
    rows.find(
      (a) =>
        !String(a.id || "").startsWith("sa_cat_") &&
        (a.catalogKey === key ||
          (a.catalogTemplateId === templateId && a.catalogRowId === row.id)),
    ) || null
  );
}

function openSaBuilderFromTemplate(templateId, row) {
  const tmpl = (saCatalogState().templates || []).find((t) => t.id === templateId);
  if (!tmpl) {
    openSaEditor({
      filters: row?.sku
        ? [
            { field: "store", op: "equals", value: row.store || "bandai" },
            { field: "sku", op: "equals", value: row.sku },
          ]
        : [],
    });
    return;
  }
  const existing = findExistingCatalogAction(templateId, row);
  if (existing) {
    openSaEditor(existing);
    return;
  }
  openSaEditor(draftFromTemplate(tmpl, row));
}

function renderSaTriggerList() {
  const el = $("saTriggerList");
  if (!el) return;
  const cur = $("saTrigger")?.value || "product_monitor";
  el.innerHTML = SA_TRIGGERS.map(
    (t) => `<button type="button" class="sa-trigger-card ${cur === t.id ? "is-on" : ""}" data-sa-trig="${esc(t.id)}">
      <strong>${esc(t.title)}</strong>
      <span>${esc(t.desc)}</span>
    </button>`,
  ).join("");
  syncSaScheduleVisibility();
  refreshSaBuilderStatus();
}

function refreshSaBuilderStatus() {
  const trig = $("saTrigger")?.value || "";
  const status = $("saBuilderStatus");
  const stepTrig = $("saStepTriggerHint");
  const stepFilt = $("saStepFilterHint");
  const stepAct = $("saStepActionHint");
  if (status) {
    if (!trig) status.textContent = "Missing Trigger";
    else if (!saDraftActions.length) status.textContent = "Missing Actions";
    else status.textContent = "Ready to save";
  }
  if (stepTrig) stepTrig.textContent = trig ? SA_TRIGGERS.find((t) => t.id === trig)?.title || trig : "Required";
  if (stepFilt) stepFilt.textContent = saDraftFilters.length ? `${saDraftFilters.length} filter(s)` : "No Filters";
  if (stepAct) stepAct.textContent = saDraftActions.length ? `${saDraftActions.length} action(s)` : "No Actions";
  const emptyF = $("saFiltersEmpty");
  const emptyA = $("saActionsEmpty");
  if (emptyF) emptyF.hidden = saDraftFilters.length > 0;
  if (emptyA) emptyA.hidden = saDraftActions.length > 0;
}

function syncSaFilterDialogValueControl() {
  const field = $("saFilterField")?.value || "sku";
  const op = $("saFilterOp")?.value || "equals";
  const wrap = $("saFilterValue")?.parentElement;
  const curVal = $("saFilterValue")?.value || "";
  if (!wrap) return;
  // Replace free-text input with a select when the field has fixed choices.
  const next = document.createElement("div");
  next.innerHTML = saFilterValueControlHtml(field, op, curVal, "dlg").replace(
    /data-sa-fv="dlg"/g,
    'id="saFilterValue"',
  );
  const control = next.firstElementChild;
  if (!control) return;
  control.id = "saFilterValue";
  control.removeAttribute("data-sa-fv");
  const old = $("saFilterValue");
  if (old) old.replaceWith(control);
}

function openSaFilterDialog(index = null) {
  saFilterEditIndex = index;
  const field = $("saFilterField");
  const op = $("saFilterOp");
  if (!field || !op || !$("saFilterValue")) return;
  field.innerHTML = SA_FILTER_FIELDS.map(
    (f) => `<option value="${esc(f.id)}">${esc(f.label)}</option>`,
  ).join("");
  const cur = index != null ? saDraftFilters[index] : null;
  field.value = cur?.field || "sku";
  const allowed = saOpsForField(field.value);
  op.innerHTML = allowed
    .map((o) => `<option value="${esc(o.id)}">${esc(o.label)}</option>`)
    .join("");
  op.value = allowed.some((o) => o.id === cur?.op) ? cur.op : allowed[0]?.id || "equals";
  // Ensure a value node exists, then sync control type + value.
  let val = $("saFilterValue");
  if (val && val.tagName !== "INPUT") {
    const input = document.createElement("input");
    input.id = "saFilterValue";
    input.placeholder = "Value";
    val.replaceWith(input);
    val = input;
  }
  if (val) val.value = cur?.value || "";
  syncSaFilterDialogValueControl();
  if ($("saFilterValue") && cur?.value != null) {
    const node = $("saFilterValue");
    if (node.multiple) {
      const set = new Set(saSplitFilterValues(cur.value).map((v) => v.toLowerCase()));
      [...node.options].forEach((o) => {
        o.selected = set.has(String(o.value).toLowerCase());
      });
    } else {
      node.value = saSplitFilterValues(cur.value)[0] || cur.value || "";
    }
  }
  const saveBtn = $("btnSaFilterSave");
  if (saveBtn) saveBtn.textContent = index != null ? "Save Filter" : "Add Filter";
  openDialog("saFilterDialog");
}

$("saFilterField")?.addEventListener("change", () => {
  const op = $("saFilterOp");
  const allowed = saOpsForField($("saFilterField")?.value);
  if (op) {
    const cur = op.value;
    op.innerHTML = allowed
      .map((o) => `<option value="${esc(o.id)}">${esc(o.label)}</option>`)
      .join("");
    op.value = allowed.some((o) => o.id === cur) ? cur : allowed[0]?.id || "equals";
  }
  syncSaFilterDialogValueControl();
});
$("saFilterOp")?.addEventListener("change", () => syncSaFilterDialogValueControl());

function openSaActionPicker() {
  const q = String($("saActionSearch")?.value || "")
    .trim()
    .toLowerCase();
  const list = $("saActionPickList");
  if (!list) return;
  const rows = SA_ACTION_META.filter(
    (a) =>
      !q ||
      a.title.toLowerCase().includes(q) ||
      a.desc.toLowerCase().includes(q) ||
      a.type.includes(q),
  );
  list.innerHTML = rows
    .map(
      (a) => `<button type="button" class="sa-action-pick-item" data-sa-pick="${esc(a.type)}">
        <span class="sa-action-pick-glyph">${esc(a.glyph)}</span>
        <span>
          <strong>${esc(a.title)}</strong>
          <span class="desc">${esc(a.desc)}</span>
          <span class="io">Input: ${esc(a.input)} · Output: ${esc(a.output)}</span>
        </span>
      </button>`,
    )
    .join("");
  openDialog("saActionDialog");
}

function openSaEditor(action) {
  const builder = $("saBuilder");
  if (!builder) return;
  closeSaTemplateGallery();
  builder.hidden = false;
  $("saId").value = action?.id || "";
  $("saName").value = action?.name || "";
  $("saEnabled").checked = action?.enabled !== false;
  $("saRunOnce").checked = action?.runOnce === true;
  $("saNotifications").checked = action?.notifications !== false;
  $("saRunInterval").value = action?.runIntervalMs ?? 30000;
  const trigType = action?.trigger?.type || "product_monitor";
  if ($("saTrigger")) {
    $("saTrigger").value = ["quicktask", "schedule", "product_monitor"].includes(trigType)
      ? trigType
      : "product_monitor";
  }
  if ($("saScheduleAt")) $("saScheduleAt").value = action?.trigger?.at || "07:00";
  if ($("saScheduleRepeat"))
    $("saScheduleRepeat").value = action?.trigger?.repeat === "once" ? "once" : "daily";
  if ($("saScheduleTz")) $("saScheduleTz").value = action?.trigger?.tz || "Australia/Sydney";
  saDraftFilters = Array.isArray(action?.filters) ? action.filters.map((f) => ({ ...f })) : [];
  saDraftActions = Array.isArray(action?.actions)
    ? action.actions.map((a) => ({ type: a.type, config: { ...(a.config || {}) } }))
    : [saBlankAction("create_tasks"), saBlankAction("start_tasks")];
  // Preserve catalog provenance on save via dataset
  builder.dataset.catalogTemplateId = action?.catalogTemplateId || "";
  builder.dataset.catalogRowId = action?.catalogRowId || "";
  builder.dataset.catalogKey = action?.catalogKey || "";
  renderSaBuilderExplain(action);
  renderSaTriggerList();
  renderSaFiltersEditor();
  renderSaActionsEditor();
  refreshSaBuilderStatus();
}

function renderSaBuilderExplain(action) {
  const el = $("saBuilderExplain");
  if (!el) return;
  const tmplId = action?.catalogTemplateId || "";
  const tmpl = tmplId
    ? (saCatalogState().templates || []).find((t) => t.id === tmplId)
    : null;
  const text = tmpl?.explain || tmpl?.does || "";
  if (!text) {
    el.hidden = true;
    el.textContent = "";
    return;
  }
  el.hidden = false;
  el.innerHTML = `<strong>${esc(saCatalogDisplayName(tmpl))}</strong> — ${esc(text)}`;
}

function closeSaEditor() {
  const builder = $("saBuilder");
  if (builder) {
    builder.hidden = true;
    delete builder.dataset.catalogTemplateId;
    delete builder.dataset.catalogRowId;
    delete builder.dataset.catalogKey;
  }
  const explain = $("saBuilderExplain");
  if (explain) {
    explain.hidden = true;
    explain.textContent = "";
  }
  saDraftFilters = [];
  saDraftActions = [];
  saBuilderProductRow = null;
}

function saFilterPlaceholder(field) {
  const f = String(field || "").toLowerCase();
  if (f === "sku") return "SKU or keywords";
  if (f === "store") return "Select store…";
  if (f === "title") return "Product name";
  if (f === "url") return "Product URL";
  if (f === "price") return "e.g. 99";
  if (f === "reason") return "Select reason…";
  if (f === "instock") return "Select…";
  if (f === "producttype") return "Select type…";
  return "Value";
}

function renderSaFiltersEditor() {
  const el = $("saFilters");
  if (!el) return;
  if (!saDraftFilters.length) {
    el.innerHTML = "";
    refreshSaBuilderStatus();
    return;
  }
  el.innerHTML = saDraftFilters
    .map((f, i) => {
      const field = f.field || "sku";
      let op = f.op || "equals";
      const allowedOps = saOpsForField(field);
      if (!allowedOps.some((o) => o.id === op)) op = allowedOps[0]?.id || "equals";
      const fieldOpts = SA_FILTER_FIELDS.map(
        (x) =>
          `<option value="${esc(x.id)}" ${field === x.id ? "selected" : ""}>${esc(x.label)}</option>`,
      ).join("");
      const opOpts = allowedOps
        .map(
          (x) =>
            `<option value="${esc(x.id)}" ${op === x.id ? "selected" : ""}>${esc(x.label)}</option>`,
        )
        .join("");
      const multi = Boolean(saFilterChoices(field) && saFilterMultiOp(op));
      return `<div class="sa-filter-row ${multi ? "is-multi" : ""}" data-sa-filter-row="${i}">
        <select class="sa-filter-field" data-sa-ff="${i}" aria-label="Field">${fieldOpts}</select>
        <select class="sa-filter-op" data-sa-fo="${i}" aria-label="Condition">${opOpts}</select>
        ${saFilterValueControlHtml(field, op, f.value || "", i)}
        <button type="button" class="sa-icon-remove" data-sa-fdel="${i}" title="Remove filter" aria-label="Remove filter">✕</button>
      </div>`;
    })
    .join("");
  refreshSaBuilderStatus();
}

function renderSaActionsEditor() {
  const el = $("saActions");
  if (!el) return;
  if (!saDraftActions.length) {
    el.innerHTML = "";
    refreshSaBuilderStatus();
    return;
  }
  el.innerHTML = saDraftActions
    .map((a, i) => {
      const cfg = a.config || {};
      const meta = SA_ACTION_META.find((m) => m.type === a.type);
      const title = meta?.title || a.type;
      let body = "";
      if (a.type === "create_tasks") {
        const preset = state?.settings?.quickTaskPreset || {};
        const profileId = cfg.profileId || (cfg.usePreset !== false ? preset.profileId : "") || "";
        const profileGroup = cfg.profileGroup || "";
        const perProfile = cfg.perProfile != null ? cfg.perProfile : cfg.count != null ? cfg.count : 1;
        const proxyGroupId =
          cfg.proxyGroupId || (cfg.usePreset !== false ? preset.proxyGroupId : "") || "";
        const profOpts =
          `<option value="">Select profile…</option>` +
          (state?.profiles || [])
            .map(
              (p) =>
                `<option value="${esc(p.id)}" ${String(p.id) === String(profileId) ? "selected" : ""}>${esc(
                  p.name || p.email || p.id,
                )}</option>`,
            )
            .join("");
        const pgNames =
          typeof profileGroupNames === "function"
            ? profileGroupNames([profileGroup])
            : [
                ...new Set(
                  (state?.profiles || [])
                    .map((p) => String(p.profileGroup || "").trim())
                    .filter(Boolean),
                ),
              ].sort((a, b) => a.localeCompare(b));
        const pgOpts =
          `<option value="">Single profile (below)</option>` +
          pgNames
            .map(
              (n) =>
                `<option value="${esc(n)}" ${n === profileGroup ? "selected" : ""}>${esc(n)}</option>`,
            )
            .join("");
        const pxOpts =
          `<option value="">Direct (no proxy)</option>` +
          (state?.proxyGroups || [])
            .map(
              (g) =>
                `<option value="${esc(g.id)}" ${String(g.id) === String(proxyGroupId) ? "selected" : ""}>${esc(
                  g.name,
                )} (${g.entries?.length || 0})</option>`,
            )
            .join("");
        body = `
          <div class="sa-field-grid">
            <div class="sa-field">
              <label>Mode</label>
              <select data-sa-ac="${i}" data-k="bandaiMode">
                <option value="checkout" ${!cfg.bandaiMode || cfg.bandaiMode === "checkout" ? "selected" : ""}>Autocheckout</option>
                <option value="atc" ${cfg.bandaiMode === "atc" ? "selected" : ""}>ATC only</option>
                <option value="monitor" ${cfg.bandaiMode === "monitor" ? "selected" : ""}>Monitor</option>
              </select>
            </div>
            <div class="sa-field sa-field-span">
              <label>Task name</label>
              <input data-sa-ac="${i}" data-k="labelTemplate" value="${esc(
                cfg.labelTemplate || "{{title}}",
              )}" placeholder="{{title}} or a custom name" />
            </div>
            <div class="sa-field sa-field-span">
              <label>Task group</label>
              ${saTaskGroupSelectHtml(
                `data-sa-ac="${i}" data-k="taskGroup"`,
                cfg.taskGroup || "",
                { emptyLabel: "No group" },
              )}
            </div>
            <div class="sa-field sa-field-span">
              <label>Profile group</label>
              <select data-sa-ac="${i}" data-k="profileGroup">${pgOpts}</select>
            </div>
            <div class="sa-field">
              <label>Profile</label>
              <select data-sa-ac="${i}" data-k="profileId">${profOpts}</select>
            </div>
            <div class="sa-field">
              <label>Proxy</label>
              <select data-sa-ac="${i}" data-k="proxyGroupId">${pxOpts}</select>
            </div>
            <div class="sa-field">
              <label>Per profile</label>
              <input type="number" min="1" max="20" data-sa-ac="${i}" data-k="perProfile" value="${perProfile}" title="Tasks created for each profile" />
            </div>
            <div class="sa-field">
              <label>Qty</label>
              <input type="number" min="1" max="20" data-sa-ac="${i}" data-k="qty" value="${cfg.qty ?? 1}" />
            </div>
          </div>
          <p class="field-hint">Profile group expands to every profile in that group × Per profile. Leave group empty to use a single Profile.</p>
          <label class="check sa-quiet-check"><input type="checkbox" data-sa-ac="${i}" data-k="usePreset" ${
            cfg.usePreset !== false ? "checked" : ""
          } /> Use Quick Task preset defaults</label>`;
      } else if (a.type === "update_tasks") {
        body = `${saTargetEditorHtml(i, cfg)}
          <label>Product SKU / URL</label>
          <input data-sa-ac="${i}" data-k="product" value="${esc(cfg.product || "{{sku}}")}" />
          <div class="grid2">
            <div><label>Monitor delay ms</label><input type="number" min="0" data-sa-ac="${i}" data-k="bandaiMonitorDelayMs" value="${
              cfg.bandaiMonitorDelayMs != null && cfg.bandaiMonitorDelayMs !== "" ? cfg.bandaiMonitorDelayMs : ""
            }" /></div>
            <div><label>Poll interval ms</label><input type="number" min="2000" data-sa-ac="${i}" data-k="bandaiMonitorIntervalMs" value="${
              cfg.bandaiMonitorIntervalMs != null && cfg.bandaiMonitorIntervalMs !== ""
                ? cfg.bandaiMonitorIntervalMs
                : ""
            }" /></div>
          </div>
          <label>Task name</label>
          <input data-sa-ac="${i}" data-k="labelTemplate" value="${esc(cfg.labelTemplate || "")}" placeholder="blank = keep" />`;
      } else if (a.type === "start_tasks" || a.type === "stop_tasks" || a.type === "delete_tasks") {
        body = saTargetEditorHtml(i, cfg);
      } else if (a.type === "stagger_start_tasks") {
        body = `${saTargetEditorHtml(i, cfg)}
          <div class="sa-field">
            <label>Stagger gap (ms)</label>
            <input type="number" min="0" max="500" data-sa-ac="${i}" data-k="staggerGapMs" value="${
              cfg.staggerGapMs ?? 50
            }" />
          </div>
          <p class="field-hint">Each task enqueues this many ms after the previous — same path as drop T0 stagger.</p>`;
      } else if (a.type === "stagger_start_task_group") {
        body = `<div class="sa-field-grid">
            <div class="sa-field sa-field-span">
              <label>Task group</label>
              ${saTaskGroupSelectHtml(`data-sa-ac="${i}" data-k="target.taskGroup"`, cfg.target?.taskGroup || "", {
                emptyLabel: "Select group…",
              })}
            </div>
            <div class="sa-field">
              <label>Stagger gap (ms)</label>
              <input type="number" min="0" max="500" data-sa-ac="${i}" data-k="staggerGapMs" value="${
                cfg.staggerGapMs ?? 50
              }" />
            </div>
          </div>
          <input type="hidden" data-sa-ac="${i}" data-k="target.scope" value="group" />
          <p class="field-hint">Starts every enabled task in the group with staggered gaps.</p>`;
      } else if (a.type === "wait") {
        body = `<label>Delay (seconds)</label>
          <input type="number" min="0" max="1800" data-sa-ac="${i}" data-k="delaySec" value="${cfg.delaySec ?? 60}" />`;
      } else if (a.type === "stop_after") {
        body = `${saTargetEditorHtml(i, cfg, { allowCreated: false })}
          <div class="grid2">
            <div><label>Seconds</label><input type="number" min="0" data-sa-ac="${i}" data-k="delaySec" value="${cfg.delaySec ?? 0}" /></div>
            <div><label>Minutes</label><input type="number" min="0" data-sa-ac="${i}" data-k="delayMin" value="${cfg.delayMin ?? 0}" /></div>
          </div>
          <label>Hours</label>
          <input type="number" min="0" data-sa-ac="${i}" data-k="delayHour" value="${cfg.delayHour ?? 0}" />`;
      } else if (a.type === "create_task_group" || a.type === "goto_task_group") {
        body = `<label>Task group</label>
          ${saTaskGroupSelectHtml(`data-sa-ac="${i}" data-k="taskGroup"`, cfg.taskGroup || "", {
            emptyLabel: "Select group…",
          })}`;
      } else if (a.type === "notify_discord" || a.type === "notify_toast") {
        body = `<label>Message</label>
          <input data-sa-ac="${i}" data-k="message" value="${esc(cfg.message || "Smart Action: {{title}} ({{sku}})")}" />`;
      } else if (a.type === "start_harvester" || a.type === "stop_harvester") {
        body = `<p class="field-hint">${esc(meta?.desc || "")}</p>`;
      } else {
        body = `<p class="field-hint">${esc(a.type)}</p>`;
      }
      return `<div class="sa-action-row">
        <div class="sa-action-head">
          <strong>${esc(title)}</strong>
          <button type="button" class="sa-icon-remove" data-sa-adel="${i}" title="Remove action" aria-label="Remove action">✕</button>
        </div>
        ${body}
      </div>`;
    })
    .join("");
  refreshSaBuilderStatus();
}

async function saveSaBuilder() {
  syncSaDraftFromForm();
  const trigType = $("saTrigger")?.value || "product_monitor";
  const trigger =
    trigType === "schedule"
      ? {
          type: "schedule",
          at: $("saScheduleAt")?.value || "07:00",
          repeat: $("saScheduleRepeat")?.value || "daily",
          tz: $("saScheduleTz")?.value || "Australia/Sydney",
        }
      : { type: trigType };
  const builder = $("saBuilder");
  const payload = {
    id: $("saId").value || undefined,
    name: $("saName").value.trim() || "Untitled action",
    enabled: $("saEnabled").checked,
    runOnce: $("saRunOnce").checked,
    notifications: $("saNotifications").checked,
    runIntervalMs: Number($("saRunInterval").value) || 0,
    trigger,
    filters: saDraftFilters.filter((f) => String(f.value || "").trim()),
    actions: saDraftActions,
  };
  // Keep catalog provenance for “is-on” chips, but never hide user-saved actions.
  if (builder?.dataset.catalogTemplateId) payload.catalogTemplateId = builder.dataset.catalogTemplateId;
  if (builder?.dataset.catalogRowId) payload.catalogRowId = builder.dataset.catalogRowId;
  // Drop silent materialization keys so the action stays visible in Your Smart Actions.
  payload.catalogKey = null;
  if (!payload.actions.length) {
    toast("Add at least one action", "err");
    return;
  }
  if (!window.desktop?.smartActionUpsert) {
    toast("Save unavailable — restart the app", "err");
    return;
  }
  let res;
  try {
    res = await window.desktop.smartActionUpsert(payload);
  } catch (err) {
    toast(String(err?.message || err || "Save failed"), "err");
    return;
  }
  if (!res?.ok) {
    toast(res?.error || "Save failed", "err");
    appendLog(esc(res?.error || "Smart Action save failed"), "err");
    return;
  }
  if (res.snapshot) applyState(res.snapshot);
  else if (res.action && state) {
    const cur = state.smartActions?.actions || [];
    const next = cur.some((a) => a.id === res.action.id)
      ? cur.map((a) => (a.id === res.action.id ? res.action : a))
      : [res.action, ...cur];
    state.smartActions = { ...(state.smartActions || {}), actions: next };
    renderSmartActions();
  } else {
    try {
      applyState(await window.desktop.getState());
    } catch {
      /* ignore */
    }
  }
  closeSaEditor();
  appendLog(`Smart Action saved — ${esc(res.action?.name || payload.name)}`, "ok");
  toast("Smart Action saved", "ok");
  requestAnimationFrame(() => {
    const block = $("saSavedBlock") || $("saList");
    try {
      block?.scrollIntoView?.({ behavior: "smooth", block: "start" });
    } catch {
      /* ignore */
    }
    const sid = String(res.action?.id || "").replace(/\\/g, "\\\\").replace(/"/g, '\\"');
    const row = sid ? document.querySelector(`[data-sa-edit="${sid}"]`) : null;
    row?.closest?.(".item")?.classList?.add("sa-just-saved");
    setTimeout(() => row?.closest?.(".item")?.classList?.remove("sa-just-saved"), 1600);
  });
}

// —— Wire UI ——
if ($("btnSaNew")) {
  $("btnSaNew").onclick = () => openSaTemplateGallery();
}
$("saTemplateDialogClose")?.addEventListener("click", () => closeSaTemplateGallery());
$("btnSaBuilderClose")?.addEventListener("click", () => closeSaEditor());
$("btnSaCancel")?.addEventListener("click", () => closeSaEditor());
$("btnSaBuilderSave")?.addEventListener("click", () => void saveSaBuilder());
$("btnSaAddFilter")?.addEventListener("click", () => {
  syncSaDraftFromForm();
  saDraftFilters.push({ field: "sku", op: "equals", value: "" });
  renderSaFiltersEditor();
  const last = document.querySelector(`[data-sa-fv="${saDraftFilters.length - 1}"]`);
  try {
    last?.focus?.();
  } catch {
    /* ignore */
  }
});
$("btnSaAddAction")?.addEventListener("click", () => {
  syncSaDraftFromForm();
  if ($("saActionSearch")) $("saActionSearch").value = "";
  openSaActionPicker();
});
$("saFilterDialogClose")?.addEventListener("click", () => closeDialog("saFilterDialog"));
$("btnSaFilterCancel")?.addEventListener("click", () => closeDialog("saFilterDialog"));
$("btnSaFilterSave")?.addEventListener("click", () => {
  const field = $("saFilterField")?.value || "sku";
  const op = $("saFilterOp")?.value || "equals";
  const node = $("saFilterValue");
  let value = "";
  if (node?.multiple) {
    value = [...node.selectedOptions].map((o) => o.value).filter(Boolean).join(", ");
  } else {
    value = node?.value || "";
  }
  const row = { field, op, value };
  if (saFilterEditIndex != null && saDraftFilters[saFilterEditIndex]) {
    saDraftFilters[saFilterEditIndex] = row;
  } else {
    saDraftFilters.push(row);
  }
  saFilterEditIndex = null;
  closeDialog("saFilterDialog");
  renderSaFiltersEditor();
});
$("saActionDialogClose")?.addEventListener("click", () => closeDialog("saActionDialog"));
$("saActionSearch")?.addEventListener("input", () => openSaActionPicker());

document.body.addEventListener("click", (e) => {
  const t = e.target instanceof HTMLElement ? e.target : null;
  if (!t) return;

  const blank = t.closest("[data-sa-gallery-blank]");
  if (blank) {
    e.preventDefault();
    const row = saBuilderProductRow;
    closeSaTemplateGallery();
    openSaEditor({
      name: row ? `${row.title || row.sku}` : "",
      filters: row?.sku
        ? [
            { field: "store", op: "equals", value: row.store || "bandai" },
            { field: "sku", op: "equals", value: row.sku },
          ]
        : [],
      actions: [saBlankAction("create_tasks"), saBlankAction("start_tasks")],
    });
    return;
  }

  const tmplBtn = t.closest("[data-sa-gallery-tmpl]");
  if (tmplBtn) {
    e.preventDefault();
    const id = tmplBtn.getAttribute("data-sa-gallery-tmpl");
    const row = saBuilderProductRow;
    closeSaTemplateGallery();
    openSaBuilderFromTemplate(id, row);
    return;
  }

  const trig = t.closest("[data-sa-trig]");
  if (trig) {
    e.preventDefault();
    if ($("saTrigger")) $("saTrigger").value = trig.getAttribute("data-sa-trig");
    renderSaTriggerList();
    return;
  }

  const pick = t.closest("[data-sa-pick]");
  if (pick) {
    e.preventDefault();
    const type = pick.getAttribute("data-sa-pick");
    saDraftActions.push(saBlankAction(type));
    closeDialog("saActionDialog");
    renderSaActionsEditor();
    return;
  }

});

// Live filter edits — re-render when field/op changes so value control swaps (select vs text)
document.body.addEventListener("change", (e) => {
  const t = e.target instanceof HTMLElement ? e.target : null;
  if (!t || !t.closest?.("#saFilters")) return;
  const fieldOrOp = t.hasAttribute("data-sa-ff") || t.hasAttribute("data-sa-fo");
  syncSaDraftFromForm();
  if (fieldOrOp) {
    // Clear value when switching to a choice field if the old value isn't valid.
    if (t.hasAttribute("data-sa-ff")) {
      const i = Number(t.getAttribute("data-sa-ff"));
      const row = saDraftFilters[i];
      if (row) {
        const choices = saFilterChoices(row.field);
        if (choices) {
          const ok = saSplitFilterValues(row.value).every((v) =>
            choices.some((c) => String(c.value).toLowerCase() === v.toLowerCase()),
          );
          if (!ok) row.value = choices[0]?.value || "";
          const ops = saOpsForField(row.field);
          if (!ops.some((o) => o.id === row.op)) row.op = ops[0]?.id || "equals";
        }
      }
    }
    renderSaFiltersEditor();
  } else {
    refreshSaBuilderStatus();
  }
});
document.body.addEventListener("input", (e) => {
  const t = e.target instanceof HTMLElement ? e.target : null;
  if (!t || !t.closest?.("#saFilters")) return;
  if (t.hasAttribute("data-sa-fv") || t.hasAttribute("data-sa-ff") || t.hasAttribute("data-sa-fo")) {
    syncSaDraftFromForm();
  }
});

// SKU pack chips → builder (override earlier toggle handler by capturing later)
document.body.addEventListener(
  "click",
  (e) => {
    const t = e.target instanceof HTMLElement ? e.target : null;
    if (!t) return;
    const packBtn = t.closest("[data-sa-row-pack][data-sa-pack]");
    if (packBtn) {
      e.preventDefault();
      e.stopImmediatePropagation();
      const rowId = packBtn.getAttribute("data-sa-row-pack");
      const packId = packBtn.getAttribute("data-sa-pack");
      const row = (saCatalogState().rows || []).find((r) => r.id === rowId);
      openSaBuilderFromTemplate(packId, row);
      return;
    }
    const openBtn = t.closest("[data-sa-sku-open]");
    if (openBtn && !t.closest("[data-sa-row-pack]")) {
      e.preventDefault();
      e.stopImmediatePropagation();
      const rowId = openBtn.getAttribute("data-sa-sku-open");
      const row = (saCatalogState().rows || []).find((r) => r.id === rowId);
      openSaTemplateGallery({ row });
    }
  },
  true,
);
