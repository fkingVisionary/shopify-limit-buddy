// Workspace analytics dashboard: checkout counts, spend, mini chart, and a
// transaction log. Reads getWorkspaceAnalytics on mount and every 15s.
import { useEffect, useMemo, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Loader2, RefreshCcw, CheckCircle2, XCircle, TrendingUp, Receipt, AlertTriangle } from "lucide-react";
import { getWorkspaceAnalytics, type AnalyticsSummary } from "@/lib/analytics.functions";

function formatMoney(amount: number, currency: string | null) {
  const cur = currency || "USD";
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
  try { return new URL(url).host.replace(/^www\./, ""); } catch { return url; }
}

export function AnalyticsPanel() {
  const fetchFn = useServerFn(getWorkspaceAnalytics);
  const [data, setData] = useState<AnalyticsSummary | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const load = async () => {
    setLoading(true); setErr(null);
    try {
      const r = await fetchFn();
      setData(r);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Failed to load analytics");
    } finally { setLoading(false); }
  };

  useEffect(() => { void load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const id = setInterval(() => { void load(); }, 15000);
    return () => clearInterval(id);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const maxBar = useMemo(() => {
    if (!data) return 1;
    return Math.max(1, ...data.byDay.map((d) => d.success + d.failed));
  }, [data]);

  if (!data && loading) {
    return <div className="flex items-center justify-center py-12"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>;
  }
  if (err && !data) {
    return (
      <Card className="border-destructive/50 bg-destructive/10 p-3 text-xs text-destructive">
        <div className="flex items-start gap-2"><AlertTriangle className="mt-0.5 h-3.5 w-3.5" />{err}</div>
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

      {/* Top stat cards */}
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
            <XCircle className="h-3 w-3" /> Failed
          </div>
          <div className="mt-1 text-2xl font-bold tabular-nums text-destructive">{data.totalFailed}</div>
          <div className="text-[10px] text-muted-foreground">of {data.totalDispatched} dispatched</div>
        </Card>
        <Card className="p-3">
          <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-muted-foreground">
            <TrendingUp className="h-3 w-3" /> Pending
          </div>
          <div className="mt-1 text-2xl font-bold tabular-nums text-amber-400">{data.totalPending}</div>
          <div className="text-[10px] text-muted-foreground">awaiting runner</div>
        </Card>
      </div>

      {/* 14-day bar chart */}
      <Card className="p-3">
        <div className="mb-2 flex items-center justify-between">
          <div className="text-xs font-medium">Last 14 days</div>
          <div className="flex items-center gap-2 text-[10px] text-muted-foreground">
            <span className="flex items-center gap-1"><span className="h-2 w-2 rounded-sm bg-primary" /> success</span>
            <span className="flex items-center gap-1"><span className="h-2 w-2 rounded-sm bg-destructive" /> failed</span>
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

      {/* Transaction log */}
      <div>
        <div className="mb-1.5 flex items-center justify-between">
          <div className="text-xs font-medium uppercase tracking-wider text-muted-foreground">Transaction log</div>
          <Badge variant="outline" className="text-[10px]">{data.transactions.length}</Badge>
        </div>
        {data.transactions.length === 0 ? (
          <div className="rounded-lg border border-dashed p-8 text-center text-xs text-muted-foreground">
            No transactions yet. Successful and failed checkouts will appear here.
          </div>
        ) : (
          <div className="space-y-1.5">
            {data.transactions.map((t) => {
              const Icon = t.ok ? CheckCircle2 : XCircle;
              const color = t.ok ? "text-emerald-400" : "text-destructive";
              return (
                <Card key={t.jobId} className="p-2.5">
                  <div className="flex items-start gap-2.5">
                    <Icon className={`mt-0.5 h-4 w-4 shrink-0 ${color}`} />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="truncate text-sm font-medium">{shortStore(t.storeUrl)}</span>
                        {t.orderId && <Badge variant="outline" className="h-4 px-1 font-mono text-[9px]">#{t.orderId}</Badge>}
                      </div>
                      <div className="mt-0.5 truncate text-[11px] text-muted-foreground">
                        {t.profileName ?? "—"}
                        {t.variantTitle && <> · {t.variantTitle}</>}
                        {t.qty && <> · ×{t.qty}</>}
                      </div>
                      {!t.ok && t.error && (
                        <div className="mt-0.5 truncate text-[11px] text-destructive">{t.error}</div>
                      )}
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
