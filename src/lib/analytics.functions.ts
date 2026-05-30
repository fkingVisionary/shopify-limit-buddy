// Workspace-scoped checkout analytics. Aggregates runner_jobs + runner_results
// for every device in the caller's workspace. Tries hard to pull a money
// amount out of either the dispatched job payload or the runner result
// payload (different runners report different shapes).
import { createServerFn } from "@tanstack/react-start";
import { requireWorkspaceDevice } from "@/integrations/workspace/middleware";
import { supabaseAdmin } from "@/integrations/supabase/client.server";

export type Transaction = {
  jobId: string;
  storeUrl: string;
  orderId: string | null;
  amount: number | null;
  currency: string | null;
  profileName: string | null;
  variantTitle: string | null;
  qty: number | null;
  at: number;
  ok: boolean;
  error: string | null;
};

export type AnalyticsSummary = {
  totalDispatched: number;
  totalSuccess: number;
  totalFailed: number;
  totalPending: number;
  totalSpent: number;
  currency: string | null;
  successRate: number; // 0..1, only counts resolved (success+failed)
  avgOrderValue: number;
  last24hSuccess: number;
  last24hSpent: number;
  // 14-day mini series, oldest -> newest
  byDay: Array<{ day: string; success: number; failed: number; spent: number }>;
  transactions: Transaction[];
};

function pickAmount(...sources: Array<Record<string, unknown> | null | undefined>): { amount: number | null; currency: string | null } {
  const amountKeys = ["amount", "total", "total_price", "totalPrice", "price", "subtotal_price", "subtotalPrice", "grand_total", "grandTotal"];
  const currencyKeys = ["currency", "currency_code", "currencyCode"];
  for (const src of sources) {
    if (!src) continue;
    for (const k of amountKeys) {
      const v = src[k];
      if (v == null) continue;
      const n = typeof v === "string" ? parseFloat(v) : typeof v === "number" ? v : NaN;
      if (Number.isFinite(n) && n > 0) {
        let currency: string | null = null;
        for (const ck of currencyKeys) {
          const cv = src[ck];
          if (typeof cv === "string") { currency = cv; break; }
        }
        return { amount: n, currency };
      }
    }
  }
  return { amount: null, currency: null };
}

function dayKey(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export const getWorkspaceAnalytics = createServerFn({ method: "POST" })
  .middleware([requireWorkspaceDevice])
  .handler(async ({ context }): Promise<AnalyticsSummary> => {
    const { data: devices } = await supabaseAdmin
      .from("runner_devices")
      .select("id")
      .eq("workspace_id", context.workspaceId);
    const deviceIds = (devices ?? []).map((d) => d.id);

    const empty: AnalyticsSummary = {
      totalDispatched: 0, totalSuccess: 0, totalFailed: 0, totalPending: 0,
      totalSpent: 0, currency: null, successRate: 0, avgOrderValue: 0,
      last24hSuccess: 0, last24hSpent: 0, byDay: [], transactions: [],
    };
    if (deviceIds.length === 0) return empty;

    const { data: rows, error } = await supabaseAdmin
      .from("runner_jobs")
      .select("id, store_url, created_at, payload, runner_results(ok, order_id, error, payload, created_at)")
      .in("device_id", deviceIds)
      .order("created_at", { ascending: false })
      .limit(500);
    if (error) throw new Error(error.message);

    const now = Date.now();
    const cutoff24h = now - 24 * 60 * 60 * 1000;
    const cutoff14d = now - 14 * 24 * 60 * 60 * 1000;

    let totalSuccess = 0, totalFailed = 0, totalPending = 0;
    let totalSpent = 0, last24hSuccess = 0, last24hSpent = 0;
    let currency: string | null = null;
    const sumsForAvg: number[] = [];
    const byDayMap = new Map<string, { success: number; failed: number; spent: number }>();
    const transactions: Transaction[] = [];

    // Seed byDay so the chart shows zero-bars for empty days
    for (let i = 13; i >= 0; i--) {
      const k = dayKey(now - i * 86_400_000);
      byDayMap.set(k, { success: 0, failed: 0, spent: 0 });
    }

    for (const row of (rows ?? []) as Array<{
      id: string;
      store_url: string;
      created_at: string;
      payload: Record<string, unknown> | null;
      runner_results:
        | { ok: boolean; order_id: string | null; error: string | null; payload: Record<string, unknown> | null; created_at: string }
        | null;
    }>) {
      const at = new Date(row.created_at).getTime();
      const r = row.runner_results;
      const jobPayload = (row.payload ?? {}) as Record<string, unknown>;
      const resultPayload = r?.payload ?? null;
      const profile = (jobPayload.profile ?? null) as { first_name?: string; last_name?: string } | null;
      const profileName = profile && (profile.first_name || profile.last_name)
        ? `${profile.first_name ?? ""} ${profile.last_name ?? ""}`.trim()
        : null;
      const variantTitle = typeof jobPayload.variantTitle === "string" ? jobPayload.variantTitle as string : null;
      const qty = typeof jobPayload.qty === "number" ? jobPayload.qty as number : null;
      const { amount, currency: cur } = pickAmount(resultPayload, jobPayload);
      if (cur && !currency) currency = cur;

      const inWindow = at >= cutoff14d;
      const dk = dayKey(at);

      if (r == null) {
        totalPending++;
      } else if (r.ok) {
        totalSuccess++;
        if (amount != null) {
          totalSpent += amount;
          sumsForAvg.push(amount);
        }
        if (at >= cutoff24h) {
          last24hSuccess++;
          if (amount != null) last24hSpent += amount;
        }
        if (inWindow) {
          const bucket = byDayMap.get(dk);
          if (bucket) { bucket.success++; if (amount != null) bucket.spent += amount; }
        }
        if (transactions.length < 50) {
          transactions.push({
            jobId: row.id, storeUrl: row.store_url, orderId: r.order_id,
            amount, currency: cur ?? currency, profileName, variantTitle, qty,
            at, ok: true, error: null,
          });
        }
      } else {
        totalFailed++;
        if (inWindow) {
          const bucket = byDayMap.get(dk);
          if (bucket) bucket.failed++;
        }
        if (transactions.length < 50) {
          transactions.push({
            jobId: row.id, storeUrl: row.store_url, orderId: null,
            amount: null, currency: cur ?? currency, profileName, variantTitle, qty,
            at, ok: false, error: r.error,
          });
        }
      }
    }

    const resolved = totalSuccess + totalFailed;
    return {
      totalDispatched: (rows ?? []).length,
      totalSuccess, totalFailed, totalPending,
      totalSpent, currency,
      successRate: resolved === 0 ? 0 : totalSuccess / resolved,
      avgOrderValue: sumsForAvg.length === 0 ? 0 : sumsForAvg.reduce((a, b) => a + b, 0) / sumsForAvg.length,
      last24hSuccess, last24hSpent,
      byDay: Array.from(byDayMap.entries()).map(([day, v]) => ({ day, ...v })),
      transactions,
    };
  });
