// Durable-enough milestone log for Kmart checkout wins.
// Survives across /run requests on the same Fly machine (disk under TMPDIR).
// Not a substitute for a DB — just so we stop losing "reached 3DS / cart_get 200"
// when the HTTP client times out or the agent only looks at failedStep.

import fs from "node:fs";
import path from "node:path";

const MAX = 80;
const FILE =
  process.env.KMART_MILESTONE_LOG ||
  path.join(process.env.TMPDIR || "/tmp", "j1ms-kmart-milestones.jsonl");

/** Stages we care about capturing (furthest wins). */
const MILESTONE_RANK = {
  cart_get: 10,
  cart_atc: 20,
  cart_verified: 25,
  address: 30,
  billing: 35,
  tokenize: 40,
  "3ds": 50,
  place_order: 60,
  ordered: 70,
};

function rankOf(stage) {
  return MILESTONE_RANK[stage] ?? 0;
}

function stepOk(steps, name) {
  return (steps || []).some((s) => s?.step === name && s.ok !== false && (s.status == null || s.status < 400));
}

/**
 * Derive a milestone label from a finished adapter result.
 * Returns null if the run never cleared cart_get JSON.
 */
export function milestoneFromResult(out = {}) {
  const steps = out.steps || [];
  const cartGet = steps.find((s) => s?.step === "cart_get");
  const cartGetOk =
    Boolean(cartGet?.ok) &&
    (cartGet.status == null || cartGet.status === 200) &&
    !/all_denied|Access Denied|AkamaiGHost/i.test(String(cartGet?.note || ""));

  const has3dsSteps = (steps || []).some((s) =>
    /^paydock_3ds|create_3ds/i.test(String(s?.step || "")),
  );
  // Never drop a 3DS/order trail just because cart_get was scored poorly —
  // client timeouts + Access Denied notes used to erase Revolut-proven wins.
  if (
    !cartGetOk &&
    !out.orderNumber &&
    !has3dsSteps &&
    rankOf(out.checkoutStage) < rankOf("tokenize")
  ) {
    return null;
  }

  let stage = out.checkoutStage || null;
  if (out.orderNumber) stage = "ordered";
  else if (!stage || rankOf(stage) < 10) {
    if (stepOk(steps, "cart_atc") || out.checkoutStage === "cart_atc") stage = "cart_atc";
    else if (cartGetOk) stage = "cart_get";
  }

  // Promote from payment steps even if checkoutStage lagged.
  if (steps.some((s) => /^paydock_3ds|create_3ds/i.test(String(s?.step || "")))) {
    if (rankOf(stage) < rankOf("3ds")) stage = "3ds";
  }
  if (steps.some((s) => s?.step === "paydock_tokenize" && s.ok)) {
    if (rankOf(stage) < rankOf("tokenize")) stage = "tokenize";
  }
  if (steps.some((s) => s?.step === "place_order")) {
    if (rankOf(stage) < rankOf("place_order")) stage = "place_order";
  }

  if (!stage || rankOf(stage) < rankOf("cart_get")) return null;

  const pay = out.paymentSummary && typeof out.paymentSummary === "object" ? out.paymentSummary : null;
  const threeDsStep = steps.find((s) => /create_3ds_token|paydock_3ds_widget/i.test(String(s?.step || "")));

  return {
    at: new Date().toISOString(),
    ts: Date.now(),
    stage,
    ok: Boolean(out.ok),
    orderNumber: out.orderNumber ?? null,
    paymentStatus: out.paymentStatus ?? null,
    dryRun: out.dryRun !== false,
    cartGet: cartGetOk,
    reached3ds: rankOf(stage) >= rankOf("3ds"),
    frictionless: pay?.frictionless ?? null,
    processStatus: pay?.processStatus ?? null,
    widgetNote: threeDsStep ? String(threeDsStep.note || "").slice(0, 240) : null,
    failedStep: out.failedStep ?? null,
  };
}

function appendMilestoneRow(row) {
  try {
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    fs.appendFileSync(FILE, `${JSON.stringify(row)}\n`, "utf8");
    trimFile();
  } catch (e) {
    console.warn(JSON.stringify({ milestoneLogError: e?.message ?? String(e) }));
  }
  // Always log a single structured line for Fly log drains / `fly logs`.
  console.log(JSON.stringify({ kmartMilestone: row }));
  return row;
}

export function recordRunMilestone(taskId, out, meta = {}) {
  const milestone = milestoneFromResult(out);
  if (!milestone) return null;

  return appendMilestoneRow({
    taskId: taskId || null,
    ...milestone,
    proxy: meta.proxy ? true : false,
    transport: meta.transport ?? null,
    gitSha: process.env.EXECUTOR_GIT_SHA || null,
  });
}

/**
 * Flush a milestone mid-run (before /run returns). Critical when the HTTP
 * client times out around 3DS — Fly keeps going and Revolut pings, but the
 * agent used to see an empty body and score "cart dead."
 *
 * Workflow stage ids (cart/tokenize/threeds/order) map to milestone labels.
 */
export function noteLiveMilestone(taskId, workflowStage, meta = {}) {
  const map = {
    cart: "cart_get",
    details: "address",
    tokenize: "tokenize",
    threeds: "3ds",
    order: "place_order",
    done: meta.orderNumber ? "ordered" : null,
  };
  const stage = map[workflowStage] || null;
  if (!stage || rankOf(stage) < rankOf("cart_get")) return null;

  return appendMilestoneRow({
    taskId: taskId || null,
    at: new Date().toISOString(),
    ts: Date.now(),
    stage,
    ok: Boolean(meta.ok),
    orderNumber: meta.orderNumber ?? null,
    paymentStatus: meta.paymentStatus ?? null,
    dryRun: meta.dryRun !== false,
    cartGet: rankOf(stage) >= rankOf("cart_get"),
    reached3ds: rankOf(stage) >= rankOf("3ds"),
    frictionless: null,
    processStatus: null,
    widgetNote: null,
    failedStep: null,
    live: true,
    proxy: meta.proxy ? true : false,
    transport: meta.transport ?? null,
    gitSha: process.env.EXECUTOR_GIT_SHA || null,
    step: meta.step ?? null,
  });
}

function trimFile() {
  try {
    const text = fs.readFileSync(FILE, "utf8");
    const lines = text.split("\n").filter(Boolean);
    if (lines.length <= MAX) return;
    fs.writeFileSync(FILE, `${lines.slice(-MAX).join("\n")}\n`, "utf8");
  } catch {
    /* ignore */
  }
}

export function listRunMilestones({ limit = 40, minStage = "cart_get", taskId = null } = {}) {
  const minRank = rankOf(minStage);
  const wantTask = taskId != null && String(taskId).length ? String(taskId) : null;
  let lines = [];
  try {
    lines = fs.readFileSync(FILE, "utf8").split("\n").filter(Boolean);
  } catch {
    return [];
  }
  const rows = [];
  for (let i = lines.length - 1; i >= 0 && rows.length < limit; i--) {
    try {
      const row = JSON.parse(lines[i]);
      if (wantTask && String(row.taskId || "") !== wantTask) continue;
      if (rankOf(row.stage) >= minRank) rows.push(row);
    } catch {
      /* skip bad line */
    }
  }
  return rows;
}
