/** Shared Kmart checkout workflow stages (UI + docs). Mirrors executor/progress.js */

export type WorkflowStageId =
  | "warm"
  | "product"
  | "cart"
  | "details"
  | "tokenize"
  | "threeds"
  | "order"
  | "done";

export type WorkflowStage = {
  id: WorkflowStageId;
  label: string;
  hint: string;
};

export const WORKFLOW_STAGES: WorkflowStage[] = [
  { id: "warm", label: "Starting", hint: "" },
  { id: "product", label: "Loading product", hint: "" },
  { id: "cart", label: "Adding to cart", hint: "" },
  { id: "details", label: "Proceeding to checkout", hint: "" },
  { id: "tokenize", label: "Processing payment", hint: "" },
  { id: "threeds", label: "Waiting for bank approval", hint: "" },
  { id: "order", label: "Placing order", hint: "" },
  { id: "done", label: "Done", hint: "" },
];

const STAGE_INDEX: Record<string, number> = Object.fromEntries(
  WORKFLOW_STAGES.map((s, i) => [s.id, i]),
);

export function stageRank(id: string | null | undefined): number {
  if (!id) return -1;
  return STAGE_INDEX[id] ?? -1;
}

export function stageForStep(stepName: string | null | undefined): WorkflowStageId | null {
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

export function stageFromCheckoutStage(checkoutStage: string | null | undefined): WorkflowStageId {
  switch (checkoutStage) {
    case "ordered":
      return "done";
    case "place_order":
      return "order";
    case "3ds":
      return "threeds";
    case "tokenize":
      return "tokenize";
    case "billing":
    case "address":
      return "details";
    case "cart_verified":
    case "cart_atc":
      return "cart";
    default:
      return "warm";
  }
}

export function furthestStageFromSteps(
  steps: Array<{ step: string }> | null | undefined,
): WorkflowStageId {
  let best: WorkflowStageId = "warm";
  let bestRank = 0;
  for (const s of steps ?? []) {
    const id = stageForStep(s.step);
    if (!id) continue;
    const r = stageRank(id);
    if (r > bestRank) {
      bestRank = r;
      best = id;
    }
  }
  return best;
}

export type LiveProgress = {
  taskId?: string;
  stage?: string;
  label?: string;
  hint?: string;
  detail?: string | null;
  step?: string | null;
  running?: boolean;
  done?: boolean;
  ok?: boolean | null;
  orderNumber?: string | null;
  startedAt?: number;
  updatedAt?: number;
  history?: Array<{ stage: string; label?: string; step?: string | null; at: number }>;
};
