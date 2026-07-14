// Workspace analytics dashboard: checkout counts, spend, mini chart, and a
// transaction log. Merges runner_jobs (Shopify local runner) with local
// aio:checkout-analytics (Kmart executor + other task outcomes).
import { useEffect, useMemo, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Loader2, RefreshCcw, CheckCircle2, XCircle, TrendingUp, Receipt, AlertTriangle } from "lucide-react";
import { getWorkspaceAnalytics, type AnalyticsSummary, type Transaction } from "@/lib/analytics.functions";
import { loadCheckoutAnalytics, type LocalCheckoutTx } from "@/lib/checkout-analytics";

function formatMoney(amount: number, currency: string | null) {
  const cur = currency || "AUD";
  try {
    return new Intl.NumberFormat(undefined, { style: "currency", currency: cur, maximumFractionDigits: 2 }).format(amount);
  } catch {
    return `${amount.toFixed(2)} ${cur}`;
  }
}

function formatAgo(ts: number) {
  const s = Math.max(1, Math.floor((Date.now() - ts) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

function shortStore(url: string) {
  try {
    return new URL(url).host.replace(/^www\./, "");
  } catch {
    return url;
  }
}

function dayKey(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function localToTx(row: LocalCheckoutTx): Transaction & { declined?: boolean; retailer?: string | null } {
  return {
    jobId: row.id,
    storeUrl: row.storeUrl,
    orderId: row.orderId ?? null,
    amount: row.amount ?? null,
    currency: row.currency ?? "AUD",
    profileName: row.profileName ?? null,
    variantTitle: row.productTitle ?? null,
    qty: row.qty ?? null,
    at: row.at,
    ok: row.ok,
    error: row.error ?? null,
    declined: row.declined,
    retailer: row.retailer,
  };
}

function mergeAnalytics(remote: AnalyticsSummary, local: LocalCheckoutTx[]): AnalyticsSummary & { declinedCount: number } {
  const now = Date.now();
  const cutoff24h = now - 24 * 60 * 60 * 1000;
  const cutoff14d = now - 14 * 24 * 60 * 60 * 1000;

  const byDayMap = new Map<string, { success: number; failed: number; spent: number }>();
  for (const d of remote.byDay) byDayMap.set(d.day, { ...d });
  for (let i = 13; i >= 0; i--) {
    const k = dayKey(now - i * 86_400_000);
    if (!byDayMap.has(k)) byDayMap.set(k, { success: 0, failed: 0, spent: 0 });
  }

  let totalSuccess = remote.totalSuccess;
  let totalFailed = remote.totalFailed;
  let totalDispatched = remote.totalDispatched;
  let totalSpent = remote.totalSpent;
  let last24hSuccess = remote.last24hSuccess;
  let last24hSpent = remote.last24hSpent;
  let declinedCount = 0;
  let currency = remote.currency || "AUD";
  const sumsForAvg: number[] = [];
  if (remote.avgOrderValue > 0 && remote.totalSuccess > 0) {
    // Approximate — only used if we have no local amounts.
  }

  const remoteTx = remote.transactions;
  const localTx = local.map(localToTx);
  for (const row of local) {
    totalDispatched++;
    if (row.ok) {
      totalSuccess++;
      if (row.amount != null) {
        totalSpent += row.amount;
        sumsForAvg.push(row.amount);
      }
      if (row.at >= cutoff24h) {
        last24hSuccess++;
        if (row.amount != null) last24hSpent += row.amount;
      }
      if (row.at >= cutoff14d) {
        const b = byDayMap.get(dayKey(row.at));
        if (b) {
          b.success++;
          if (row.amount != null) b.spent += row.amount;
        }
      }
    } else {
      totalFailed++;
      if (row.declined) declinedCount++;
      if (row.at >= cutoff14d) {
        const b = byDayMap.get(dayKey(row.at));
        if (b) b.failed++;
      }
    }
    if (row.currency) currency = row.currency;
  }

  const resolved = totalSuccess + totalFailed;
  const byDay = Array.from(byDayMap.entries())
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([day, v]) => ({ day, ...v }));

  const transactions = [...localTx, ...remoteTx]
    .sort((a, b) => b.at - a.at)
    .slice(0, 80);

  const avgOrderValue =
    sumsForAvg.length > 0
      ? sumsForAvg.reduce((a, b) => a + b, 0) / sumsForAvg.length
      : remote.avgOrderValue;

  return {
    totalDispatched,
    totalSuccess,
    totalFailed,
    totalPending: remote.totalPending,
    totalSpent,
    currency,
    successRate: resolved > 0 ? totalSuccess / resolved : 0,
    avgOrderValue,
    last24hSuccess,
    last24hSpent,
    byDay,
    transactions,
    declinedCount,
  };
}

export function AnalyticsPanel() {
  const fetchFn = useServerFn(getWorkspaceAnalytics);
  const [data, setData] = useState<(AnalyticsSummary & { declinedCount: number }) | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const load = async () => {
    setLoading(true);
    setErr(null);
    try {
      let remote: AnalyticsSummary;
      try {
        remote = await fetchFn();
      } catch {
        remote = {
          totalDispatched: 0,
          totalSuccess: 0,
          totalFailed: 0,
          totalPending: 0,
          totalSpent: 0,
          currency: "AUD",
          successRate: 0,
          avgOrderValue: 0,
          last24hSuccess: 0,
          last24hSpent: 0,
          byDay: [],
          transactions: [],
        };
      }
      const local = loadCheckoutAnalytics();
      setData(mergeAnalytics(remote, local));
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Failed to load analytics");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const id = setInterval(() => {
      void load();
    }, 15000);
    const onChanged = () => {
      void load();
    };
    window.addEventListener("aio:changed", onChanged);
    window.addEventListener("aio:cloud-applied", onChanged);
    return () => {
      clearInterval(id);
      window.removeEventListener("aio:changed", onChanged);
      window.removeEventListener("aio:cloud-applied", onChanged);
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const maxBar = useMemo(() => {
    if (!data) return 1;
    return Math.max(1, ...data.byDay.map((d) => d.success + d.failed));
  }, [data]);

  if (!data && loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      </div>
    );
  }
  if (err && !data) {
    return (
      <Card className="border-destructive/50 bg-destructive/10 p-3 text-xs text-destructive">
        <div className="flex items-start gap-2">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5" />
          {err}
        </div>
      </Card>
    );
  }
  if (!data) return null;

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <div className="text-sm text-muted-foreground">
          Last 24h · <span className="font-medium text-foreground">{data.last24hSuccess}</span> checkouts ·{" "}
          <span className="font-medium text-foreground">{formatMoney(data.last24hSpent, data.currency)}</span>
        </div>
        <Button size="icon" variant="ghost" className="h-8 w-8" onClick={() => void load()} disabled={loading}>
          {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCcw className="h-4 w-4" />}
        </Button>
      </div>

      <div className="grid grid-cols-2 gap-2">
        <Card className="p-3">
          <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-muted-foreground">
            <Receipt className="h-3 w-3" /> Total spent
          </div>
          <div className="mt-1 text-2xl font-bold tabular-nums">{formatMoney(data.totalSpent, data.currency)}</div>
          <div className="text-[10px] text-muted-foreground">Avg {formatMoney(data.avgOrderValue, data.currency)}/order</div>
        </Card>
        <Card className="p-3">
          <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-muted-foreground">
            <CheckCircle2 className="h-3 w-3" /> Checkouts
          </div>
          <div className="mt-1 text-2xl font-bold tabular-nums">{data.totalSuccess}</div>
          <div className="text-[10px] text-muted-foreground">{Math.round(data.successRate * 100)}% success rate</div>
        </Card>
        <Card className="p-3">
          <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-muted-foreground">
            <XCircle className="h-3 w-3" /> Failed / declined
          </div>
          <div className="mt-1 text-2xl font-bold tabular-nums text-destructive">{data.totalFailed}</div>
          <div className="text-[10px] text-muted-foreground">
            {data.declinedCount > 0 ? `${data.declinedCount} declined · ` : ""}
            {data.totalDispatched} dispatched
          </div>
        </Card>
        <Card className="p-3">
          <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-muted-foreground">
            <TrendingUp className="h-3 w-3" /> Pending
          </div>
          <div className="mt-1 text-2xl font-bold tabular-nums text-amber-400">{data.totalPending}</div>
          <div className="text-[10px] text-muted-foreground">awaiting runner</div>
        </Card>
      </div>

      <Card className="p-3">
        <div className="mb-2 flex items-center justify-between">
          <div className="text-xs font-medium">Last 14 days</div>
          <div className="flex items-center gap-2 text-[10px] text-muted-foreground">
            <span className="flex items-center gap-1">
              <span className="h-2 w-2 rounded-sm bg-primary" /> success
            </span>
            <span className="flex items-center gap-1">
              <span className="h-2 w-2 rounded-sm bg-destructive" /> failed
            </span>
          </div>
        </div>
        <div className="flex h-24 items-end gap-1">
          {data.byDay.map((d) => {
            const total = d.success + d.failed;
            const hPct = total === 0 ? 4 : (total / maxBar) * 100;
            const sPct = total === 0 ? 0 : (d.success / total) * 100;
            const isToday = d.day === data.byDay[data.byDay.length - 1].day;
            return (
              <div key={d.day} className="flex flex-1 flex-col items-center gap-1">
                <div
                  className="relative w-full overflow-hidden rounded-sm bg-muted/40"
                  style={{ height: `${hPct}%`, minHeight: "4px" }}
                  title={`${d.day} — ${d.success} ok, ${d.failed} failed`}
                >
                  <div className="absolute inset-x-0 bottom-0 bg-destructive" style={{ height: "100%" }} />
                  <div className="absolute inset-x-0 bottom-0 bg-primary" style={{ height: `${sPct}%` }} />
                </div>
                <span className={`text-[8px] ${isToday ? "font-bold text-primary" : "text-muted-foreground"}`}>
                  {d.day.slice(8)}
                </span>
              </div>
            );
          })}
        </div>
      </Card>

      <div>
        <div className="mb-1.5 flex items-center justify-between">
          <div className="text-xs font-medium uppercase tracking-wider text-muted-foreground">Transaction log</div>
          <Badge variant="outline" className="text-[10px]">
            {data.transactions.length}
          </Badge>
        </div>
        {data.transactions.length === 0 ? (
          <div className="rounded-lg border border-dashed p-8 text-center text-xs text-muted-foreground">
            No transactions yet. Confirmed, declined, and failed checkouts appear here.
          </div>
        ) : (
          <div className="space-y-1.5">
            {data.transactions.map((t) => {
              const declined = Boolean((t as Transaction & { declined?: boolean }).declined);
              const Icon = t.ok ? CheckCircle2 : XCircle;
              const color = t.ok ? "text-emerald-400" : declined ? "text-orange-400" : "text-destructive";
              const retailer = (t as Transaction & { retailer?: string }).retailer;
              return (
                <Card key={t.jobId} className="p-2.5">
                  <div className="flex items-start gap-2.5">
                    <Icon className={`mt-0.5 h-4 w-4 shrink-0 ${color}`} />
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="truncate text-sm font-medium">{shortStore(t.storeUrl)}</span>
                        {retailer === "kmart" && (
                          <Badge variant="outline" className="h-4 px-1 text-[9px]">
                            kmart
                          </Badge>
                        )}
                        {t.orderId && (
                          <Badge variant="outline" className="h-4 px-1 font-mono text-[9px]">
                            #{t.orderId}
                          </Badge>
                        )}
                        {declined && (
                          <Badge variant="destructive" className="h-4 px-1 text-[9px]">
                            declined
                          </Badge>
                        )}
                      </div>
                      <div className="mt-0.5 truncate text-[11px] text-muted-foreground">
                        {t.profileName ?? "—"}
                        {t.variantTitle && <> · {t.variantTitle}</>}
                        {t.qty && <> · ×{t.qty}</>}
                      </div>
                      {!t.ok && t.error && <div className="mt-0.5 truncate text-[11px] text-destructive">{t.error}</div>}
                    </div>
                    <div className="shrink-0 text-right">
                      {t.amount != null && (
                        <div className="text-sm font-semibold tabular-nums">{formatMoney(t.amount, t.currency)}</div>
                      )}
                      <div className="text-[10px] text-muted-foreground">{formatAgo(t.at)}</div>
                    </div>
                  </div>
                </Card>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
