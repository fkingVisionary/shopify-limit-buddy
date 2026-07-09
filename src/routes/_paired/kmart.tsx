import { createFileRoute, Link } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { ArrowLeft, Loader2, Play, Save, Trash2, Copy } from "lucide-react";
import { runOnExecutor } from "@/lib/executor.functions";

export const Route = createFileRoute("/_paired/kmart")({
  head: () => ({
    meta: [
      { title: "Kmart AU checkout — J1m's Bot" },
      { name: "description", content: "Run Kmart AU HTTP checkouts through the executor. Auto-captures the placeOrder mutation from live traffic." },
      { name: "robots", content: "noindex" },
    ],
  }),
  component: KmartPage,
});

// localStorage keys (aio:* prefix → auto-synced across paired devices).
const RECON_CANDIDATES_KEY = "aio:kmart-recon-candidates";
const MUTATION_KEY = "aio:kmart-place-order-mutation";
const HISTORY_KEY = "aio:kmart-run-history";
const LAST_INPUT_KEY = "aio:kmart-last-input";

type Step = { step: string; ok: boolean; status: number | null; ms?: number; note?: string };
type RunResult = {
  ok: boolean;
  status?: number;
  elapsedMs?: number;
  result?: {
    ok?: boolean;
    steps?: Step[];
    finalUrl?: string;
    dryRun?: boolean;
    orderNumber?: string | null;
    orderId?: string | null;
    paymentStatus?: string | null;
    error?: string;
    failedStep?: string;
    adapter?: string;
  };
  error?: string;
};

type StoredMutation = {
  operationName: string;
  query: string;
  extraVars?: Record<string, unknown>;
  savedAt: number;
};

type HistoryEntry = {
  taskId: string;
  at: number;
  url: string;
  ok: boolean;
  dryRun: boolean;
  orderNumber?: string | null;
  finalStep?: string;
  candidatesFound?: string[];
};

function readJSON<T>(key: string, fallback: T): T {
  if (typeof window === "undefined") return fallback;
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}
function writeJSON<T>(key: string, value: T) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {}
}

// Pull op-name candidates out of a `bundle_recon` step note.
// Format we emit from the adapter: `candidates: name1, name2, name3`
function extractCandidatesFromSteps(steps: Step[]): string[] {
  const out = new Set<string>();
  for (const s of steps) {
    if (s.step !== "bundle_recon" || !s.note) continue;
    const m = s.note.match(/candidates:\s*(.+)$/);
    if (!m) continue;
    for (const raw of m[1].split(",")) {
      const name = raw.trim();
      if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) out.add(name);
    }
  }
  return Array.from(out);
}

function KmartPage() {
  const runFn = useServerFn(runOnExecutor);

  const [url, setUrl] = useState("");
  const [qty, setQty] = useState(1);
  const [proxy, setProxy] = useState("");
  const [placeOrder, setPlaceOrder] = useState(false);
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<RunResult | null>(null);

  const [candidates, setCandidates] = useState<string[]>([]);
  const [mutation, setMutation] = useState<StoredMutation | null>(null);
  const [mutOpName, setMutOpName] = useState("");
  const [mutQuery, setMutQuery] = useState("");
  const [mutExtraVars, setMutExtraVars] = useState("");
  const [history, setHistory] = useState<HistoryEntry[]>([]);

  // Hydrate from localStorage after mount (SSR safety).
  useEffect(() => {
    setCandidates(readJSON<string[]>(RECON_CANDIDATES_KEY, []));
    const m = readJSON<StoredMutation | null>(MUTATION_KEY, null);
    setMutation(m);
    if (m) {
      setMutOpName(m.operationName);
      setMutQuery(m.query);
      setMutExtraVars(m.extraVars ? JSON.stringify(m.extraVars, null, 2) : "");
    }
    setHistory(readJSON<HistoryEntry[]>(HISTORY_KEY, []));
    const last = readJSON<{ url: string; qty: number; proxy: string; placeOrder: boolean } | null>(LAST_INPUT_KEY, null);
    if (last) {
      setUrl(last.url ?? "");
      setQty(last.qty ?? 1);
      setProxy(last.proxy ?? "");
      setPlaceOrder(Boolean(last.placeOrder));
    }
  }, []);

  // Persist inputs.
  useEffect(() => {
    writeJSON(LAST_INPUT_KEY, { url, qty, proxy, placeOrder });
  }, [url, qty, proxy, placeOrder]);

  const canRun = useMemo(() => {
    return /^https:\/\/(www\.)?kmart\.com\.au\//i.test(url.trim()) && qty > 0 && !running;
  }, [url, qty, running]);

  const handleRun = async () => {
    setRunning(true);
    setResult(null);
    try {
      const taskId = `kmart-${Date.now().toString(36)}`;
      const res = (await runFn({
        data: {
          taskId,
          storeUrl: url.trim(),
          // Kmart adapter reads SKU from PDP; variantId is only shape-required.
          variantId: 1,
          qty,
          proxy: proxy.trim() || null,
          dryRun: !placeOrder,
          placeOrder,
          placeOrderMutation: mutation
            ? { operationName: mutation.operationName, query: mutation.query, extraVars: mutation.extraVars ?? {} }
            : null,
        },
      })) as RunResult;
      setResult(res);

      // Auto-capture: merge any new op-name candidates into storage.
      const steps = res?.result?.steps ?? [];
      const found = extractCandidatesFromSteps(steps);
      if (found.length > 0) {
        const merged = Array.from(new Set([...candidates, ...found]));
        setCandidates(merged);
        writeJSON(RECON_CANDIDATES_KEY, merged);
      }

      // Update run history (keep last 20).
      const lastStep = steps[steps.length - 1];
      const entry: HistoryEntry = {
        taskId,
        at: Date.now(),
        url: url.trim(),
        ok: Boolean(res?.result?.ok),
        dryRun: Boolean(res?.result?.dryRun),
        orderNumber: res?.result?.orderNumber ?? null,
        finalStep: lastStep?.step,
        candidatesFound: found.length > 0 ? found : undefined,
      };
      const next = [entry, ...history].slice(0, 20);
      setHistory(next);
      writeJSON(HISTORY_KEY, next);
    } catch (e) {
      setResult({ ok: false, error: e instanceof Error ? e.message : String(e) });
    } finally {
      setRunning(false);
    }
  };

  const saveMutation = () => {
    const name = mutOpName.trim();
    const q = mutQuery.trim();
    if (!name || !q) {
      alert("Operation name and query are both required");
      return;
    }
    let extra: Record<string, unknown> = {};
    if (mutExtraVars.trim()) {
      try {
        extra = JSON.parse(mutExtraVars);
      } catch {
        alert("extraVars must be valid JSON (or leave empty)");
        return;
      }
    }
    const m: StoredMutation = { operationName: name, query: q, extraVars: extra, savedAt: Date.now() };
    setMutation(m);
    writeJSON(MUTATION_KEY, m);
  };
  const clearMutation = () => {
    setMutation(null);
    setMutOpName("");
    setMutQuery("");
    setMutExtraVars("");
    try { localStorage.removeItem(MUTATION_KEY); } catch {}
  };

  const clearCandidates = () => {
    setCandidates([]);
    try { localStorage.removeItem(RECON_CANDIDATES_KEY); } catch {}
  };

  const steps = result?.result?.steps ?? [];

  return (
    <div className="min-h-screen bg-background text-foreground">
      <div className="mx-auto max-w-4xl p-4 md:p-6">
        <div className="mb-6">
          <Link to="/" className="mb-2 inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
            <ArrowLeft className="h-3 w-3" /> Back
          </Link>
          <h1 className="text-2xl font-semibold tracking-tight">Kmart AU checkout</h1>
          <p className="text-sm text-muted-foreground">
            Runs the full Kmart HTTP chain through the Fly executor: Akamai clear → cart → address → Paydock vault → 3DS → place order. Auto-captures the <code>placeOrder</code> mutation from checkout bundle JS.
          </p>
        </div>

        <Card className="mb-4 p-4">
          <div className="grid gap-3">
            <div>
              <Label className="text-xs">Kmart PDP URL</Label>
              <Input
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                placeholder="https://www.kmart.com.au/product/…"
                className="font-mono text-xs"
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label className="text-xs">Quantity</Label>
                <Input
                  type="number"
                  min={1}
                  max={20}
                  value={qty}
                  onChange={(e) => setQty(Math.max(1, Math.min(20, Number(e.target.value) || 1)))}
                />
              </div>
              <div>
                <Label className="text-xs">Proxy (optional)</Label>
                <Input
                  value={proxy}
                  onChange={(e) => setProxy(e.target.value)}
                  placeholder="user:pass@host:port  or  host:port:user:pass"
                  className="font-mono text-xs"
                />
              </div>
            </div>
            <div className="flex items-center justify-between rounded-md border border-border/50 p-3">
              <div>
                <div className="text-sm font-medium">Attempt real place order</div>
                <div className="text-xs text-muted-foreground">
                  Off = dry-run (stops after 3DS token). On = calls saved placeOrder mutation, charges the card on file.
                </div>
              </div>
              <Switch checked={placeOrder} onCheckedChange={setPlaceOrder} />
            </div>
            <div className="flex items-center gap-2">
              <Button onClick={handleRun} disabled={!canRun}>
                {running ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Play className="mr-2 h-4 w-4" />}
                {running ? "Running…" : placeOrder ? "Run — real submit" : "Run — dry run"}
              </Button>
              {placeOrder && !mutation && (
                <Badge variant="destructive" className="text-[10px]">
                  no saved mutation — will only capture candidates
                </Badge>
              )}
              {placeOrder && mutation && (
                <Badge variant="secondary" className="text-[10px]">
                  will submit via <code>{mutation.operationName}</code>
                </Badge>
              )}
            </div>
          </div>
        </Card>

        {/* Saved mutation editor */}
        <Card className="mb-4 p-4">
          <div className="mb-2 flex items-center justify-between">
            <div>
              <div className="text-sm font-medium">Saved placeOrder mutation</div>
              <div className="text-xs text-muted-foreground">
                Paste the exact GraphQL captured from a HAR or the recon output. Stored per workspace and re-used on every run.
              </div>
            </div>
            {mutation && (
              <Badge variant="outline" className="text-[10px]">
                saved {new Date(mutation.savedAt).toLocaleString()}
              </Badge>
            )}
          </div>
          <div className="grid gap-2">
            <div>
              <Label className="text-xs">Operation name</Label>
              <Input
                value={mutOpName}
                onChange={(e) => setMutOpName(e.target.value)}
                placeholder="placeOrder"
                className="font-mono text-xs"
              />
            </div>
            <div>
              <Label className="text-xs">Query (full mutation string)</Label>
              <Textarea
                value={mutQuery}
                onChange={(e) => setMutQuery(e.target.value)}
                placeholder='mutation placeOrder($paymentToken: String!, $cartId: String!, $cartVersion: Long!) { placeOrder(...) { orderNumber } }'
                className="min-h-[120px] font-mono text-xs"
              />
            </div>
            <div>
              <Label className="text-xs">extraVars JSON (optional)</Label>
              <Textarea
                value={mutExtraVars}
                onChange={(e) => setMutExtraVars(e.target.value)}
                placeholder='{"someField": "value"}'
                className="min-h-[60px] font-mono text-xs"
              />
            </div>
            <div className="flex gap-2">
              <Button size="sm" onClick={saveMutation}>
                <Save className="mr-2 h-3 w-3" /> Save
              </Button>
              {mutation && (
                <Button size="sm" variant="outline" onClick={clearMutation}>
                  <Trash2 className="mr-2 h-3 w-3" /> Clear
                </Button>
              )}
            </div>
          </div>
        </Card>

        {/* Recon candidates */}
        <Card className="mb-4 p-4">
          <div className="mb-2 flex items-center justify-between">
            <div>
              <div className="text-sm font-medium">Captured op-name candidates</div>
              <div className="text-xs text-muted-foreground">
                Auto-collected from every run's <code>bundle_recon</code> step. Click one to pre-fill the operation name above.
              </div>
            </div>
            {candidates.length > 0 && (
              <Button size="sm" variant="ghost" onClick={clearCandidates}>
                <Trash2 className="mr-2 h-3 w-3" /> Clear
              </Button>
            )}
          </div>
          {candidates.length === 0 ? (
            <div className="text-xs text-muted-foreground">
              None yet. Run once with "Attempt real place order" on — the recon step will populate this list.
            </div>
          ) : (
            <div className="flex flex-wrap gap-1">
              {candidates.map((c) => (
                <button
                  key={c}
                  type="button"
                  onClick={() => setMutOpName(c)}
                  className="rounded border border-border/60 bg-muted/40 px-2 py-1 font-mono text-[11px] hover:bg-muted"
                >
                  {c}
                </button>
              ))}
            </div>
          )}
        </Card>

        {/* Run result */}
        {result && (
          <Card className="mb-4 p-4">
            <div className="mb-2 flex items-center justify-between">
              <div className="text-sm font-medium">Result</div>
              <div className="flex gap-2">
                <Badge variant={result.result?.ok ? "default" : "destructive"} className="text-[10px]">
                  {result.result?.ok ? "ok" : "failed"} · {result.result?.dryRun ? "dry-run" : "real"}
                </Badge>
                {result.elapsedMs != null && (
                  <Badge variant="outline" className="text-[10px]">{result.elapsedMs}ms</Badge>
                )}
              </div>
            </div>
            {result.error && (
              <div className="mb-2 rounded border border-destructive/40 bg-destructive/5 p-2 text-xs text-destructive">
                Transport error: {result.error}
              </div>
            )}
            {result.result?.error && (
              <div className="mb-2 rounded border border-destructive/40 bg-destructive/5 p-2 text-xs text-destructive">
                Failed at <code>{result.result.failedStep}</code>: {result.result.error}
              </div>
            )}
            {result.result?.orderNumber && (
              <div className="mb-2 rounded border border-green-500/40 bg-green-500/5 p-2 text-xs">
                <b>Order:</b> <code>{result.result.orderNumber}</code>
                {result.result.paymentStatus && <> · payment: <code>{result.result.paymentStatus}</code></>}
              </div>
            )}
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b border-border/50 text-left text-muted-foreground">
                    <th className="py-1 pr-2">Step</th>
                    <th className="py-1 pr-2 w-14">Status</th>
                    <th className="py-1 pr-2 w-16">ms</th>
                    <th className="py-1">Note</th>
                  </tr>
                </thead>
                <tbody>
                  {steps.map((s, i) => (
                    <tr key={i} className="border-b border-border/20 align-top">
                      <td className="py-1 pr-2 font-mono">
                        <span className={s.ok ? "text-green-600" : "text-destructive"}>{s.ok ? "✓" : "✗"}</span> {s.step}
                      </td>
                      <td className="py-1 pr-2 font-mono">{s.status ?? "—"}</td>
                      <td className="py-1 pr-2 font-mono">{s.ms ?? ""}</td>
                      <td className="py-1 font-mono text-[11px] break-all">
                        {s.note ?? ""}
                        {s.note && (
                          <button
                            type="button"
                            onClick={() => navigator.clipboard?.writeText(s.note ?? "")}
                            className="ml-1 inline-flex align-middle text-muted-foreground hover:text-foreground"
                            title="Copy"
                          >
                            <Copy className="inline h-3 w-3" />
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
        )}

        {/* Recent runs */}
        {history.length > 0 && (
          <Card className="p-4">
            <div className="mb-2 text-sm font-medium">Recent runs</div>
            <div className="space-y-1 text-xs">
              {history.map((h) => (
                <div key={h.taskId} className="flex items-center justify-between border-b border-border/20 py-1">
                  <div className="truncate font-mono">
                    <span className={h.ok ? "text-green-600" : "text-destructive"}>{h.ok ? "✓" : "✗"}</span>{" "}
                    {new Date(h.at).toLocaleTimeString()} · {h.dryRun ? "dry" : "real"}
                    {h.orderNumber && <> · <b>{h.orderNumber}</b></>}
                    {h.finalStep && !h.orderNumber && <> · @{h.finalStep}</>}
                  </div>
                  {h.candidatesFound && (
                    <Badge variant="outline" className="text-[10px]">+{h.candidatesFound.length} candidates</Badge>
                  )}
                </div>
              ))}
            </div>
          </Card>
        )}
      </div>
    </div>
  );
}
