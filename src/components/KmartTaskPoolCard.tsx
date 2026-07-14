import { useCallback, useMemo, useRef, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Slider } from "@/components/ui/slider";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Play, Square, Store } from "lucide-react";
import { pollExecutorProgress, runOnExecutor } from "@/lib/executor.functions";
import {
  WORKFLOW_STAGES,
  type LiveProgress,
} from "@/lib/kmart-workflow";
import {
  buildKmartExecutorPayload,
  isValidKmartPdpUrl,
  loadStoredKmartMutation,
  normalizeKmartPdpUrl,
  progressMessage,
  type KmartProfileLike,
} from "@/lib/kmart-task";

type TaskRow = {
  id: string;
  proxy: string | null;
  status: "queued" | "running" | "ok" | "failed";
  currentStep: string;
  stage?: string;
  elapsedMs: number;
  error?: string;
  orderId?: string | null;
};

export function KmartTaskPoolCard({
  profiles,
}: {
  profiles: Array<KmartProfileLike & { id: string; name: string }>;
}) {
  const run = useServerFn(runOnExecutor);
  const progressFn = useServerFn(pollExecutorProgress);
  const [pdpUrl, setPdpUrl] = useState("");
  const [qty, setQty] = useState("1");
  const [proxiesText, setProxiesText] = useState("");
  const [concurrency, setConcurrency] = useState(3);
  const [placeOrder, setPlaceOrder] = useState(false);
  const [usePlaywright, setUsePlaywright] = useState(false);
  const [profileId, setProfileId] = useState(profiles[0]?.id ?? "");
  const [tasks, setTasks] = useState<TaskRow[]>([]);
  const [running, setRunning] = useState(false);
  const cancelRef = useRef(false);

  const proxies = useMemo(
    () => proxiesText.split("\n").map((l) => l.trim()).filter(Boolean),
    [proxiesText],
  );

  const cleanUrl = useMemo(() => normalizeKmartPdpUrl(pdpUrl), [pdpUrl]);
  const canLaunch =
    isValidKmartPdpUrl(cleanUrl) && Boolean(profiles.find((p) => p.id === profileId)) && !running;

  const launch = useCallback(async () => {
    const profile = profiles.find((p) => p.id === profileId);
    if (!profile || !canLaunch) return;
    cancelRef.current = false;
    setRunning(true);

    const list = proxies.length > 0 ? proxies : Array.from({ length: concurrency }, () => "");
    const seeded: TaskRow[] = list.map((p, i) => ({
      id: `kmart-pool-${Date.now().toString(36)}-${i}`,
      proxy: p || null,
      status: "queued",
      currentStep: "—",
      elapsedMs: 0,
    }));
    setTasks(seeded);

    const mutation = loadStoredKmartMutation();
    let cursor = 0;
    const worker = async () => {
      while (!cancelRef.current) {
        const i = cursor++;
        if (i >= seeded.length) return;
        const row = seeded[i];
        setTasks((prev) =>
          prev.map((t, idx) =>
            idx === i ? { ...t, status: "running", currentStep: "Warming session", stage: "warm" } : t,
          ),
        );

        const built = buildKmartExecutorPayload({
          taskId: row.id,
          pdpUrl: cleanUrl,
          qty: Number(qty) || 1,
          proxy: row.proxy,
          placeOrder,
          kmartMode: usePlaywright ? "playwright" : "current",
          profile,
          placeOrderMutation: mutation,
        });
        if (!built.ok) {
          setTasks((prev) =>
            prev.map((t, idx) =>
              idx === i ? { ...t, status: "failed", currentStep: "config", error: built.error } : t,
            ),
          );
          continue;
        }

        let pollTimer: ReturnType<typeof setInterval> | null = null;
        const t0 = Date.now();
        try {
          pollTimer = setInterval(() => {
            void (async () => {
              try {
                const p = (await progressFn({ data: { taskId: row.id } })) as {
                  progress?: LiveProgress | null;
                };
                if (p?.progress) {
                  setTasks((prev) =>
                    prev.map((t, idx) =>
                      idx === i
                        ? {
                            ...t,
                            currentStep: progressMessage(p.progress),
                            stage: p.progress?.stage,
                            elapsedMs: Date.now() - t0,
                          }
                        : t,
                    ),
                  );
                }
              } catch {
                /* ignore */
              }
            })();
          }, 1500);

          const res = (await run({ data: built.data })) as {
            ok?: boolean;
            error?: string;
            elapsedMs?: number;
            result?: {
              ok?: boolean;
              dryRun?: boolean;
              orderNumber?: string | null;
              checkoutStage?: string | null;
              error?: string;
              failedStep?: string;
            };
          };

          const elapsed = res.elapsedMs ?? Date.now() - t0;
          const orderNumber = res.result?.orderNumber ?? null;
          if (orderNumber || (res.result?.ok && !placeOrder)) {
            setTasks((prev) =>
              prev.map((t, idx) =>
                idx === i
                  ? {
                      ...t,
                      status: "ok",
                      currentStep: orderNumber
                        ? `Order ${orderNumber}`
                        : `dry-run (${res.result?.checkoutStage ?? "ok"})`,
                      orderId: orderNumber,
                      elapsedMs: elapsed,
                    }
                  : t,
              ),
            );
          } else {
            setTasks((prev) =>
              prev.map((t, idx) =>
                idx === i
                  ? {
                      ...t,
                      status: "failed",
                      currentStep: res.result?.failedStep ?? res.result?.checkoutStage ?? "failed",
                      error: res.error || res.result?.error || "failed",
                      elapsedMs: elapsed,
                    }
                  : t,
              ),
            );
          }
        } catch (e) {
          setTasks((prev) =>
            prev.map((t, idx) =>
              idx === i
                ? {
                    ...t,
                    status: "failed",
                    currentStep: "transport",
                    error: (e as Error).message,
                    elapsedMs: Date.now() - t0,
                  }
                : t,
            ),
          );
        } finally {
          if (pollTimer) clearInterval(pollTimer);
        }
      }
    };

    const n = Math.min(concurrency, seeded.length);
    await Promise.all(Array.from({ length: n }, worker));
    setRunning(false);
  }, [
    profiles,
    profileId,
    canLaunch,
    proxies,
    concurrency,
    cleanUrl,
    qty,
    placeOrder,
    usePlaywright,
    progressFn,
    run,
  ]);

  const stop = () => {
    cancelRef.current = true;
    setRunning(false);
  };

  const okCount = tasks.filter((t) => t.status === "ok").length;
  const failCount = tasks.filter((t) => t.status === "failed").length;

  return (
    <Card className="p-3">
      <div className="flex items-center gap-1.5 text-sm font-medium">
        <Store className="h-4 w-4" />
        Kmart AU task pool
        <Badge variant="outline" className="text-[10px]">
          executor
        </Badge>
      </div>
      <p className="mt-1 text-[11px] text-muted-foreground">
        Mass-run the proven Fly Kmart lane (Canvas3ds / Revolut). Prefer empty proxy for GraphQL cart.
        Stages: {WORKFLOW_STAGES.filter((s) => s.id !== "done").map((s) => s.label).join(" → ")}.
      </p>

      <div className="mt-3 space-y-2">
        <div>
          <Label className="text-[11px] text-muted-foreground">PDP URL</Label>
          <Input
            className="mt-1 h-9 font-mono text-[11px]"
            placeholder="https://www.kmart.com.au/product/..."
            value={pdpUrl}
            onChange={(e) => setPdpUrl(e.target.value)}
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
          />
        </div>
        <div className="grid grid-cols-2 gap-2">
          <div>
            <Label className="text-[11px] text-muted-foreground">Profile</Label>
            <select
              className="mt-1 flex h-9 w-full rounded-md border border-input bg-background px-2 text-xs"
              value={profileId}
              onChange={(e) => setProfileId(e.target.value)}
            >
              {profiles.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </div>
          <div>
            <Label className="text-[11px] text-muted-foreground">Qty</Label>
            <Input
              className="mt-1 h-9"
              type="number"
              min={1}
              max={20}
              value={qty}
              onChange={(e) => setQty(e.target.value)}
            />
          </div>
        </div>
        <div>
          <Label className="text-[11px] text-muted-foreground">Proxies (one per line — leave empty for direct)</Label>
          <Textarea
            className="mt-1 min-h-[72px] font-mono text-[11px]"
            placeholder="user:pass@host:port"
            value={proxiesText}
            onChange={(e) => setProxiesText(e.target.value)}
            spellCheck={false}
          />
        </div>
        <div>
          <div className="flex items-center justify-between text-[11px]">
            <span className="text-muted-foreground">Concurrency</span>
            <span className="font-mono">{concurrency}</span>
          </div>
          <Slider
            className="mt-2"
            min={1}
            max={20}
            step={1}
            value={[concurrency]}
            onValueChange={(v) => setConcurrency(v[0] ?? 3)}
            disabled={running}
          />
        </div>
        <div className="flex items-center justify-between rounded-md border border-border/50 px-3 py-2">
          <div className="text-xs">
            <div className="font-medium">Place order</div>
            <div className="text-[10px] text-muted-foreground">Off = dry-run through 3DS</div>
          </div>
          <Switch checked={placeOrder} onCheckedChange={setPlaceOrder} disabled={running} />
        </div>
        <div className="flex items-center justify-between rounded-md border border-border/50 px-3 py-2">
          <div className="text-xs">
            <div className="font-medium">Playwright lane</div>
            <div className="text-[10px] text-muted-foreground">Usually off — HTTP lane is the proven path</div>
          </div>
          <Switch checked={usePlaywright} onCheckedChange={setUsePlaywright} disabled={running} />
        </div>
        <div className="flex gap-2">
          <Button size="sm" className="h-9 flex-1" disabled={!canLaunch} onClick={() => void launch()}>
            <Play className="mr-1 h-4 w-4" />
            {running ? "Running…" : "Launch pool"}
          </Button>
          <Button size="sm" variant="destructive" className="h-9" disabled={!running} onClick={stop}>
            <Square className="h-4 w-4" />
          </Button>
        </div>
      </div>

      {tasks.length > 0 && (
        <div className="mt-3 space-y-1">
          <div className="flex gap-2 text-[10px] text-muted-foreground">
            <span>{tasks.length} tasks</span>
            <span className="text-green-600">{okCount} ok</span>
            <span className="text-destructive">{failCount} fail</span>
          </div>
          <div className="max-h-48 overflow-auto rounded border border-border/40">
            <table className="w-full text-[10px]">
              <thead>
                <tr className="border-b border-border/40 text-left text-muted-foreground">
                  <th className="p-1.5">#</th>
                  <th className="p-1.5">Status</th>
                  <th className="p-1.5">Stage</th>
                  <th className="p-1.5">ms</th>
                </tr>
              </thead>
              <tbody>
                {tasks.map((t, i) => (
                  <tr key={t.id} className="border-b border-border/20 align-top">
                    <td className="p-1.5 font-mono">{i + 1}</td>
                    <td className="p-1.5">
                      <Badge
                        variant={
                          t.status === "ok" ? "default" : t.status === "failed" ? "destructive" : "secondary"
                        }
                        className="text-[9px]"
                      >
                        {t.status}
                      </Badge>
                      {t.orderId && <div className="mt-0.5 font-mono">{t.orderId}</div>}
                      {t.error && <div className="mt-0.5 text-destructive">{t.error}</div>}
                    </td>
                    <td className="p-1.5 font-mono">{t.currentStep}</td>
                    <td className="p-1.5 font-mono">{t.elapsedMs || "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </Card>
  );
}
