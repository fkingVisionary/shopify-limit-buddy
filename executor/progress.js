// In-memory checkout progress for live UI polling.
// Keyed by taskId. Entries expire after TTL so Fly memory stays bounded.

export const WORKFLOW_STAGES = [
  { id: "warm", label: "Starting", hint: "" },
  { id: "product", label: "Loading product", hint: "" },
  { id: "cart", label: "Adding to cart", hint: "" },
  { id: "details", label: "Proceeding to checkout", hint: "" },
  { id: "tokenize", label: "Processing payment", hint: "" },
  { id: "threeds", label: "Waiting for bank approval", hint: "" },
  { id: "order", label: "Placing order", hint: "" },
  { id: "done", label: "Done", hint: "" },
];

const STAGE_INDEX = Object.fromEntries(WORKFLOW_STAGES.map((s, i) => [s.id, i]));

export function stageMeta(id) {
  return WORKFLOW_STAGES.find((s) => s.id === id) ?? WORKFLOW_STAGES[0];
}

/** Map a raw adapter step name → workflow stage id (or null). */
export function stageForStep(stepName) {
  const s = String(stepName || "");
  if (!s) return null;
  if (/^(warm_|akamai_|sbsd_|home_|api_get_token|api_sensor|antibot_|proxy_)/i.test(s)) return "warm";
  if (/^(pdp_|sku_|akamai_pixel|category_)/i.test(s)) return "product";
  if (/^(cart_|http_handoff)/i.test(s)) return "cart";
  if (/^checkout_(set_address|set_billing|gate)/i.test(s)) return "details";
  if (/^paydock_(pk|tokenize)/i.test(s) || s === "place_order_gate") return "tokenize";
  if (/create_3ds|paydock_3ds/i.test(s)) return "threeds";
  if (/^(place_order|payment_summary|checkout_soh_event)/i.test(s)) return "order";
  return null;
}

export function stageRank(id) {
  return STAGE_INDEX[id] ?? -1;
}

const TTL_MS = 45 * 60 * 1000;
/** @type {Map<string, object>} */
const store = new Map();

function prune() {
  const cutoff = Date.now() - TTL_MS;
  for (const [id, row] of store) {
    if ((row.updatedAt ?? 0) < cutoff) store.delete(id);
  }
}

export function setTaskProgress(taskId, patch = {}) {
  if (!taskId) return null;
  prune();
  const prev = store.get(taskId) ?? {
    taskId,
    stage: "warm",
    label: stageMeta("warm").label,
    hint: stageMeta("warm").hint,
    detail: null,
    step: null,
    history: [],
    startedAt: Date.now(),
    running: true,
    done: false,
    ok: null,
    orderNumber: null,
  };

  const next = {
    ...prev,
    ...patch,
    taskId,
    updatedAt: Date.now(),
  };

  if (patch.stage && patch.stage !== prev.stage) {
    const meta = stageMeta(patch.stage);
    if (!patch.label) next.label = meta.label;
    if (!patch.hint) next.hint = meta.hint;
    next.history = [
      ...(prev.history || []),
      { stage: patch.stage, label: next.label, step: patch.step ?? null, at: Date.now() },
    ].slice(-24);
  } else if (patch.stage && !patch.label) {
    next.label = stageMeta(patch.stage).label;
    next.hint = stageMeta(patch.stage).hint;
  }

  store.set(taskId, next);
  return next;
}

export function getTaskProgress(taskId) {
  if (!taskId) return null;
  prune();
  return store.get(taskId) ?? null;
}

export function markTaskDone(taskId, { ok = null, orderNumber = null, detail = null } = {}) {
  return setTaskProgress(taskId, {
    stage: "done",
    label: ok ? (orderNumber ? "Order confirmed" : "Complete") : "Something went wrong",
    hint: "",
    detail,
    running: false,
    done: true,
    ok,
    orderNumber: orderNumber ?? null,
  });
}

/**
 * Derive the furthest workflow stage reached from a finished steps array.
 */
export function stageFromSteps(steps = []) {
  let best = "warm";
  let bestRank = 0;
  for (const s of steps) {
    const id = stageForStep(s?.step);
    if (!id) continue;
    const r = stageRank(id);
    if (r > bestRank) {
      bestRank = r;
      best = id;
    }
  }
  return best;
}
