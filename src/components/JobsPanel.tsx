// Workspace jobs history. Lists runner_jobs joined with runner_results for
// every device in this workspace. Pending jobs (no result yet) show in
// orange — useful to verify dispatch even before the PC runner connects.
import { useEffect, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Sheet, SheetContent, SheetHeader, SheetTitle,
} from "@/components/ui/sheet";
import { Loader2, RefreshCcw, CheckCircle2, XCircle, Clock, AlertTriangle } from "lucide-react";
import { listWorkspaceJobs, getJobDetail, type WorkspaceJob } from "@/lib/jobs.functions";

type Filter = "all" | "success" | "failed" | "pending";

const FILTERS: { key: Filter; label: string }[] = [
  { key: "all", label: "All" },
  { key: "success", label: "Success" },
  { key: "failed", label: "Failed" },
  { key: "pending", label: "Pending" },
];

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

export function JobsPanel() {
  const listFn = useServerFn(listWorkspaceJobs);
  const detailFn = useServerFn(getJobDetail);
  const [jobs, setJobs] = useState<WorkspaceJob[]>([]);
  const [filter, setFilter] = useState<Filter>("all");
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [detail, setDetail] = useState<Awaited<ReturnType<typeof getJobDetail>>["job"] | null>(null);

  const load = async () => {
    setLoading(true); setErr(null);
    try {
      const r = await listFn({ data: { filter, search: search || undefined, limit: 100 } });
      setJobs(r.jobs);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Failed to load jobs");
    } finally { setLoading(false); }
  };

  useEffect(() => { void load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [filter]);
  useEffect(() => {
    const id = setInterval(() => { void load(); }, 12000);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filter, search]);

  useEffect(() => {
    if (!openId) { setDetail(null); return; }
    void detailFn({ data: { jobId: openId } }).then((r) => setDetail(r.job));
  }, [openId, detailFn]);

  return (
    <div className="space-y-3">
      <div className="flex gap-2">
        <Input
          placeholder="Search store, order id, error…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") void load(); }}
          className="h-9"
        />
        <Button size="icon" variant="secondary" className="h-9 w-9" onClick={() => void load()} disabled={loading}>
          {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCcw className="h-4 w-4" />}
        </Button>
      </div>

      <div className="flex gap-1.5 overflow-x-auto pb-1">
        {FILTERS.map((f) => (
          <button
            key={f.key}
            onClick={() => setFilter(f.key)}
            className={`shrink-0 rounded-full px-3 py-1 text-xs font-medium transition-colors ${
              filter === f.key ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground"
            }`}
          >
            {f.label}
          </button>
        ))}
      </div>

      {err && (
        <Card className="border-destructive/50 bg-destructive/10 p-3 text-xs text-destructive">
          <div className="flex items-start gap-2">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5" />
            {err}
          </div>
        </Card>
      )}

      {!loading && jobs.length === 0 && (
        <div className="rounded-lg border border-dashed p-8 text-center text-xs text-muted-foreground">
          No jobs yet. Dispatch a task to your runner — it'll show up here.
        </div>
      )}

      <div className="space-y-2">
        {jobs.map((j) => {
          const status =
            j.ok === true ? { icon: CheckCircle2, color: "text-emerald-400", label: "Success" }
            : j.ok === false ? { icon: XCircle, color: "text-destructive", label: "Failed" }
            : { icon: Clock, color: "text-amber-400", label: "Pending" };
          const Icon = status.icon;
          return (
            <Card key={j.id} className="p-3 cursor-pointer hover:bg-accent/40" onClick={() => setOpenId(j.id)}>
              <div className="flex items-start gap-3">
                <Icon className={`mt-0.5 h-4 w-4 shrink-0 ${status.color}`} />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="truncate text-sm font-medium">{shortStore(j.storeUrl)}</span>
                    {j.dryRun && <Badge variant="outline" className="h-4 px-1 text-[9px]">DRY</Badge>}
                  </div>
                  <div className="mt-0.5 truncate text-[11px] text-muted-foreground">
                    {j.profileName ?? "—"} · qty {j.qty ?? "?"} · variant {j.variantId ?? "?"}
                  </div>
                  <div className={`mt-1 truncate text-[11px] ${status.color}`}>
                    {j.ok === true && (j.orderId ? `Order ${j.orderId}` : "Confirmed")}
                    {j.ok === false && (j.error ?? "Failed")}
                    {j.ok === null && "Awaiting runner result"}
                  </div>
                </div>
                <div className="shrink-0 text-right text-[10px] text-muted-foreground">
                  {formatAgo(j.createdAt)}
                </div>
              </div>
            </Card>
          );
        })}
      </div>

      <Sheet open={!!openId} onOpenChange={(v) => !v && setOpenId(null)}>
        <SheetContent side="bottom" className="max-h-[85vh] overflow-y-auto">
          <SheetHeader>
            <SheetTitle>Job detail</SheetTitle>
          </SheetHeader>
          {!detail ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
            </div>
          ) : (
            <div className="mt-3 space-y-3 text-xs">
              <div>
                <div className="text-[10px] uppercase text-muted-foreground">Store</div>
                <div className="break-all">{detail.storeUrl}</div>
              </div>
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <div className="text-[10px] uppercase text-muted-foreground">Created</div>
                  <div>{new Date(detail.createdAt).toLocaleString()}</div>
                </div>
                <div>
                  <div className="text-[10px] uppercase text-muted-foreground">Claimed</div>
                  <div>{detail.claimed ? "Yes" : "No"}</div>
                </div>
              </div>
              {detail.result && (
                <div>
                  <div className="text-[10px] uppercase text-muted-foreground">Result</div>
                  <div className={detail.result.ok ? "text-emerald-400" : "text-destructive"}>
                    {detail.result.ok ? `Success · ${detail.result.orderId ?? "no order id"}` : (detail.result.error ?? "Failed")}
                  </div>
                  <div className="mt-0.5 text-[10px] text-muted-foreground">
                    {new Date(detail.result.at).toLocaleString()}
                  </div>
                </div>
              )}
              <div>
                <div className="text-[10px] uppercase text-muted-foreground">Payload</div>
                <pre className="mt-1 max-h-64 overflow-auto rounded bg-muted p-2 text-[10px]">
{JSON.stringify(detail.payload, null, 2)}
                </pre>
              </div>
              {detail.result?.payload != null && (
                <div>
                  <div className="text-[10px] uppercase text-muted-foreground">Result payload</div>
                  <pre className="mt-1 max-h-64 overflow-auto rounded bg-muted p-2 text-[10px]">
{JSON.stringify(detail.result.payload, null, 2)}
                  </pre>
                </div>
              )}
            </div>
          )}
        </SheetContent>
      </Sheet>
    </div>
  );
}
