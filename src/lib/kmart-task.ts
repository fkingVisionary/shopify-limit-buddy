/** Shared helpers for running the proven Kmart AU executor flow from Tasks / pools. */

import { classifyProxy, rotateStickyProxySession } from "@/lib/proxy-format";
import {
  OUTCOME,
  consumerOutcome,
  consumerProgressMessage,
} from "@/lib/consumer-status";
import type { LiveProgress, WorkflowStageId } from "@/lib/kmart-workflow";
import { WORKFLOW_STAGES, stageRank } from "@/lib/kmart-workflow";

export const KMART_STORE_ID = "preset-kmart";
export const KMART_STORE_URL = "https://www.kmart.com.au";
export const KMART_STORE_NAME = "Kmart AU";

export function isKmartHost(urlOrHost: string | null | undefined): boolean {
  if (!urlOrHost) return false;
  try {
    const host = /^https?:\/\//i.test(urlOrHost)
      ? new URL(urlOrHost).hostname
      : urlOrHost;
    return /(^|\.)kmart\.com\.au$/i.test(host);
  } catch {
    return /kmart\.com\.au/i.test(urlOrHost);
  }
}

export function isKmartStoreId(storeId: string | null | undefined): boolean {
  return storeId === KMART_STORE_ID || Boolean(storeId && /kmart/i.test(storeId));
}

/** Keep the last valid kmart.com.au URL if the field got concatenated pastes. */
export function normalizeKmartPdpUrl(raw: string): string {
  const trimmed = raw.trim();
  const matches = trimmed.match(/https?:\/\/[^\s]+/gi);
  if (!matches || matches.length === 0) return trimmed;
  const kmart = matches.filter((u) => /kmart\.com\.au/i.test(u));
  return (kmart[kmart.length - 1] ?? matches[matches.length - 1]).replace(/[)\].,;]+$/, "");
}

export function isValidKmartPdpUrl(raw: string): boolean {
  const clean = normalizeKmartPdpUrl(raw);
  return /^https:\/\/(www\.)?kmart\.com\.au\//i.test(clean);
}

export function kmartProductLabel(pdpUrl: string): string {
  try {
    const u = new URL(normalizeKmartPdpUrl(pdpUrl));
    const parts = u.pathname.split("/").filter(Boolean);
    const last = parts[parts.length - 1] || "product";
    return decodeURIComponent(last).replace(/[-_]+/g, " ").slice(0, 80);
  } catch {
    return "Kmart product";
  }
}

export type KmartProfileLike = {
  email?: string;
  first_name?: string;
  last_name?: string;
  address1?: string;
  city?: string;
  province?: string;
  zip?: string;
  phone?: string;
  card_number?: string;
  card_name?: string;
  card_exp_month?: string;
  card_exp_year?: string;
  card_cvv?: string;
};

export type KmartExecutorPayload = {
  taskId: string;
  storeUrl: string;
  variantId: number;
  qty: number;
  proxy: string | null;
  dryRun: boolean;
  placeOrder: boolean;
  debugTrace: boolean;
  kmartMode: "current" | "playwright";
  profile: {
    email: string | null;
    first_name: string | null;
    last_name: string | null;
    address1: string | null;
    city: string | null;
    province: string | null;
    zip: string | null;
    phone: string | null;
  };
  card: {
    number: string;
    cvv: string;
    expMonth: string;
    expYear: string;
    holder: string;
  } | null;
  placeOrderMutation: {
    operationName: string;
    query: string;
    extraVars?: Record<string, unknown>;
  } | null;
};

export function buildKmartExecutorPayload(opts: {
  taskId: string;
  pdpUrl: string;
  qty?: number;
  proxy?: string | null;
  placeOrder?: boolean;
  kmartMode?: "current" | "playwright";
  profile: KmartProfileLike;
  placeOrderMutation?: KmartExecutorPayload["placeOrderMutation"];
}): { ok: true; data: KmartExecutorPayload } | { ok: false; error: string } {
  const storeUrl = normalizeKmartPdpUrl(opts.pdpUrl);
  if (!isValidKmartPdpUrl(storeUrl)) {
    return { ok: false, error: "Kmart PDP URL required (https://www.kmart.com.au/...)" };
  }

  let proxy: string | null = opts.proxy?.trim() || null;
  if (proxy) {
    const classified = classifyProxy(proxy);
    if (classified.kind === "invalid") {
      return { ok: false, error: `Proxy invalid: ${classified.reason ?? "unrecognized"}` };
    }
    if (classified.kind === "template") {
      return { ok: false, error: "URL-template proxies are not supported on the Kmart lane" };
    }
    proxy = classified.kind === "raw" ? classified.url ?? null : null;
    // Keep listed sticky session- tokens as written. Desktop retries mint a
    // fresh token / advance group entries only after tunnel or Akamai failure.
    // Always rotating here ignored user-provided Noontide exits.
    if (proxy && process.env.KMART_ROTATE_STICKY_SESSION === "1") {
      proxy = rotateStickyProxySession(proxy);
    }
  }

  const placeOrder = opts.placeOrder === true;
  const pan = (opts.profile.card_number || "").replace(/\s+/g, "");
  const cvv = (opts.profile.card_cvv || "").trim();
  const mm = (opts.profile.card_exp_month || "").trim();
  const yy = (opts.profile.card_exp_year || "").trim();
  const holder =
    (opts.profile.card_name || "").trim() ||
    [opts.profile.first_name, opts.profile.last_name].filter(Boolean).join(" ").trim() ||
    "Test Cardholder";

  if (placeOrder && (pan.length < 12 || cvv.length < 3 || !mm || yy.length < 2)) {
    return {
      ok: false,
      error: "Place order requires a complete profile card (number, CVV, MM, YY)",
    };
  }

  const card =
    pan.length >= 12 && cvv.length >= 3
      ? {
          number: pan,
          cvv,
          expMonth: mm || "12",
          expYear: yy || "29",
          holder,
        }
      : null;

  return {
    ok: true,
    data: {
      taskId: opts.taskId,
      storeUrl,
      variantId: 1,
      qty: Math.max(1, Math.min(20, opts.qty ?? 1)),
      proxy,
      dryRun: !placeOrder,
      placeOrder,
      debugTrace: true,
      kmartMode: opts.kmartMode === "playwright" ? "playwright" : "current",
      profile: {
        email: opts.profile.email || null,
        first_name: opts.profile.first_name || null,
        last_name: opts.profile.last_name || null,
        address1: opts.profile.address1 || null,
        city: opts.profile.city || null,
        province: opts.profile.province || null,
        zip: opts.profile.zip || null,
        phone: opts.profile.phone || null,
      },
      card,
      placeOrderMutation: opts.placeOrderMutation ?? null,
    },
  };
}

export function loadStoredKmartMutation(): KmartExecutorPayload["placeOrderMutation"] {
  if (typeof window === "undefined") return null;
  try {
    const raw = localStorage.getItem("aio:kmart-place-order-mutation");
    if (!raw) return null;
    const m = JSON.parse(raw) as { operationName?: string; query?: string; extraVars?: Record<string, unknown> };
    if (typeof m?.operationName === "string" && typeof m?.query === "string") {
      return {
        operationName: m.operationName,
        query: m.query,
        extraVars: m.extraVars && typeof m.extraVars === "object" ? m.extraVars : {},
      };
    }
  } catch {
    /* ignore */
  }
  return null;
}

export function stageLabel(stage: string | null | undefined): string {
  const meta = WORKFLOW_STAGES.find((s) => s.id === stage);
  return meta?.label ?? stage ?? "Checkout";
}

export function progressMessage(progress: LiveProgress | null | undefined): string {
  return consumerProgressMessage(progress);
}

export function mapKmartRunToTaskPatch(res: {
  ok?: boolean;
  error?: string;
  elapsedMs?: number;
  result?: {
    ok?: boolean;
    dryRun?: boolean;
    orderNumber?: string | null;
    orderId?: string | null;
    paymentStatus?: string | null;
    checkoutStage?: string | null;
    paymentSummary?: Record<string, unknown> | null;
    steps?: Array<{ step: string; ok: boolean; status?: number | null; ms?: number; note?: string }>;
    finalUrl?: string;
    error?: string;
    failedStep?: string;
    paymentTail?: Array<{ step: string; ok: boolean; note?: string }>;
  };
}): {
  status: "confirmed" | "checkout_ready" | "failed";
  orderId?: string | null;
  finalUrl?: string;
  steps?: Array<{ step: string; t: number; ok: boolean; note?: string }>;
  browserlessElapsedMs?: number;
  message: string;
  running: boolean;
  /** True when bank/user rejected 3DS or issuer declined the charge. */
  declined?: boolean;
  outcome: "confirmed" | "dry_run" | "declined" | "failed" | "oos" | "akamai" | "proxy";
  consumerCode?: string;
  stockStatus?: "ok" | "oos" | "unknown";
} {
  const body = res.result;
  const elapsed = res.elapsedMs ?? 0;
  const stepsArr = Array.isArray(body?.steps)
    ? body!.steps!.map((s) => ({
        step: s.step,
        t: Date.now(),
        ok: s.ok,
        note: s.note,
      }))
    : undefined;

  const runShape = {
    ok: Boolean(body?.ok ?? (res.ok && body)),
    error: body?.error || res.error,
    failedStep: body?.failedStep,
    checkoutStage: body?.checkoutStage,
    orderNumber: body?.orderNumber ?? body?.orderId ?? null,
    steps: body?.steps,
    paymentTail: body?.paymentTail,
    paymentSummary: body?.paymentSummary,
    paymentStatus: body?.paymentStatus,
  };

  if (res.error && !body) {
    const outcome = consumerOutcome({
      ok: false,
      error: res.error,
    });
    return {
      status: "failed",
      running: false,
      browserlessElapsedMs: elapsed,
      steps: stepsArr,
      message: outcome.label,
      declined: outcome.code === "declined",
      outcome: outcome.code === "declined" ? "declined" : "failed",
      consumerCode: outcome.code,
      stockStatus: outcome.stockStatus,
    };
  }

  const orderNumber = body?.orderNumber ?? null;
  if (orderNumber) {
    return {
      status: "confirmed",
      orderId: orderNumber,
      finalUrl: body?.finalUrl,
      steps: stepsArr,
      browserlessElapsedMs: elapsed,
      running: false,
      message: OUTCOME.confirmed,
      declined: false,
      outcome: "confirmed",
      consumerCode: "confirmed",
      stockStatus: "ok",
    };
  }

  if (body?.ok && body?.dryRun) {
    return {
      status: "checkout_ready",
      orderId: null,
      finalUrl: body?.finalUrl,
      steps: stepsArr,
      browserlessElapsedMs: elapsed,
      running: false,
      message: OUTCOME.complete,
      declined: false,
      outcome: "dry_run",
      consumerCode: "complete",
      stockStatus: "ok",
    };
  }

  if (body?.ok && body?.paymentStatus === "captured") {
    return {
      status: "confirmed",
      orderId: body.orderId ?? null,
      finalUrl: body?.finalUrl,
      steps: stepsArr,
      browserlessElapsedMs: elapsed,
      running: false,
      message: OUTCOME.confirmed,
      declined: false,
      outcome: "confirmed",
      consumerCode: "confirmed",
      stockStatus: "ok",
    };
  }

  const classified = consumerOutcome({
    ...runShape,
    ok: false,
  });
  const outcomeMap = {
    declined: "declined",
    oos: "oos",
    akamai: "akamai",
    proxy: "proxy",
  } as const;
  const outcome =
    classified.code in outcomeMap
      ? outcomeMap[classified.code as keyof typeof outcomeMap]
      : "failed";

  return {
    status: "failed",
    finalUrl: body?.finalUrl,
    steps: stepsArr,
    browserlessElapsedMs: elapsed,
    running: false,
    declined: classified.code === "declined",
    outcome,
    message: classified.label,
    consumerCode: classified.code,
    stockStatus: classified.stockStatus,
  };
}

export function isForwardProgress(
  prevStage: string | null | undefined,
  nextStage: string | null | undefined,
): boolean {
  return stageRank(nextStage as WorkflowStageId) >= stageRank(prevStage as WorkflowStageId);
}
