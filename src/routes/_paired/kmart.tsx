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
import { ArrowLeft, Loader2, Play, Save, Trash2, Copy, FlaskConical, Download, GitCompareArrows, HeartPulse } from "lucide-react";
import { diagnoseExecutor, pingExecutor, runAkamaiLab, runOnExecutor } from "@/lib/executor.functions";
import { classifyProxy } from "@/lib/proxy-format";

export const Route = createFileRoute("/_paired/kmart")({
  head: () => ({
    meta: [
      { title: "Kmart AU checkout — J1m's Bot" },
      { name: "description", content: "Run Kmart AU HTTP checkouts through the executor. Built-in chargePayDockWithToken for real submits." },
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
const PROFILE_KEY = "aio:kmart-checkout-profile";
const AKAMAI_BASELINE_KEY = "aio:kmart-akamai-baseline-trace";

type CheckoutProfile = {
  email: string;
  first_name: string;
  last_name: string;
  address1: string;
  city: string;
  province: string;
  zip: string;
  phone: string;
};

type TestCard = {
  number: string;
  cvv: string;
  expMonth: string;
  expYear: string;
  holder: string;
};

const EMPTY_PROFILE: CheckoutProfile = {
  email: "",
  first_name: "",
  last_name: "",
  address1: "",
  city: "",
  province: "",
  zip: "",
  phone: "",
};

const EMPTY_CARD: TestCard = {
  number: "",
  cvv: "",
  expMonth: "",
  expYear: "",
  holder: "",
};

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
    paymentSummary?: Record<string, unknown> | null;
    checkoutStage?: string | null;
    paymentTail?: Step[];
    lastSteps?: Step[];
    error?: string;
    failedStep?: string;
    adapter?: string;
    transport?: string;
    trace?: unknown;
  };
  error?: string;
  taskId?: string;
};

type DiagnoseResult = {
  ok: boolean;
  status?: number;
  elapsedMs?: number;
  error?: string;
  result?: {
    ok?: boolean;
    elapsedMs?: number;
    hint?: string | null;
    proxyUsed?: string | null;
    checks?: {
      env?: { ok?: boolean; hyperApiKey?: boolean; proxyUrlResiConfigured?: boolean; httpTransport?: string; node?: string };
      direct?: { ok?: boolean; status?: number | null; error?: string; elapsedMs?: number };
      proxy?: { ok?: boolean; skipped?: boolean; egressIp?: string | null; error?: string; target?: { status?: number | null; error?: string | null; ok?: boolean }; proxy?: string | null };
      fingerprint?: { ok?: boolean; allMatch?: boolean; error?: string; match?: Record<string, boolean>; observed?: Record<string, unknown> };
    };
  };
};

type LabResult = {
  ok: boolean;
  status?: number;
  elapsedMs?: number;
  result?: {
    ok?: boolean;
    classification?: "SOLVED" | "SENSOR_CHALLENGE" | "EDGE_DENY" | "UNKNOWN";
    verdict?: string;
    transport?: string;
    requestedProxy?: boolean;
    initialIp?: string | null;
    finalIp?: string | null;
    ipStable?: boolean;
    initialStatus?: number;
    scriptBytes?: number;
    steps?: Step[];
    rounds?: unknown[];
    cookies?: unknown;
    trace?: AkamaiTrace;
    diff?: TraceDiff | null;
    error?: string;
  };
  error?: string;
};

type AkamaiTrace = {
  id?: string;
  createdAt?: string;
  targetUrl?: string;
  sanitized?: boolean;
  events?: Array<Record<string, unknown> & { label?: string; type?: string }>;
};

type TraceDiff = {
  baselineId?: string | null;
  comparedAt?: string;
  eventCounts?: { baseline?: number; current?: number };
  missingCurrent?: string[];
  missingBaseline?: string[];
  mismatches?: Array<{ label: string; field: string; expected: unknown; actual: unknown }>;
  mismatchCount?: number;
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

function downloadJSON(filename: string, value: unknown) {
  if (typeof window === "undefined") return;
  const blob = new Blob([JSON.stringify(value, null, 2)], { type: "application/json" });
  const href = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = href;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(href);
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
  const labFn = useServerFn(runAkamaiLab);
  const pingFn = useServerFn(pingExecutor);
  const diagnoseFn = useServerFn(diagnoseExecutor);

  const [url, setUrl] = useState("");
  const [qty, setQty] = useState(1);
  const [proxy, setProxy] = useState("");
  const [placeOrder, setPlaceOrder] = useState(false);
  const [usePlaywright, setUsePlaywright] = useState(false);
  const [running, setRunning] = useState(false);
  const [labRunning, setLabRunning] = useState(false);
  const [diagRunning, setDiagRunning] = useState(false);
  const [result, setResult] = useState<RunResult | null>(null);
  const [labResult, setLabResult] = useState<LabResult | null>(null);
  const [diagResult, setDiagResult] = useState<DiagnoseResult | null>(null);
  const [healthPing, setHealthPing] = useState<{ ok: boolean; body?: any; error?: string } | null>(null);
  const [akamaiBaseline, setAkamaiBaseline] = useState<AkamaiTrace | null>(null);
  const [akamaiBaselineText, setAkamaiBaselineText] = useState("");

  const [candidates, setCandidates] = useState<string[]>([]);
  const [mutation, setMutation] = useState<StoredMutation | null>(null);
  const [mutOpName, setMutOpName] = useState("");
  const [mutQuery, setMutQuery] = useState("");
  const [mutExtraVars, setMutExtraVars] = useState("");
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [profile, setProfile] = useState<CheckoutProfile>(EMPTY_PROFILE);
  // Test card stays in memory only — never written to localStorage.
  const [card, setCard] = useState<TestCard>(EMPTY_CARD);

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
    setProfile({ ...EMPTY_PROFILE, ...readJSON<Partial<CheckoutProfile>>(PROFILE_KEY, {}) });
    const savedBaseline = readJSON<AkamaiTrace | null>(AKAMAI_BASELINE_KEY, null);
    setAkamaiBaseline(savedBaseline);
    if (savedBaseline) setAkamaiBaselineText(JSON.stringify(savedBaseline, null, 2));
    const last = readJSON<{ url: string; qty: number; proxy: string; placeOrder: boolean; usePlaywright?: boolean } | null>(LAST_INPUT_KEY, null);
    if (last) {
      setUrl(last.url ?? "");
      setQty(last.qty ?? 1);
      setProxy(last.proxy ?? "");
      setPlaceOrder(Boolean(last.placeOrder));
      setUsePlaywright(Boolean(last.usePlaywright));
    }
  }, []);

  // Persist inputs.
  useEffect(() => {
    writeJSON(LAST_INPUT_KEY, { url, qty, proxy, placeOrder, usePlaywright });
  }, [url, qty, proxy, placeOrder, usePlaywright]);
  useEffect(() => {
    writeJSON(PROFILE_KEY, profile);
  }, [profile]);

  // Normalize: if the field contains an accidental duplication (e.g. user
  // pasted while the field was non-empty and the two got concatenated),
  // keep only the LAST valid https://…kmart.com.au/… occurrence.
  const normalizeKmartUrl = (raw: string): string => {
    const trimmed = raw.trim();
    const matches = trimmed.match(/https?:\/\/[^\s]+/gi);
    if (!matches || matches.length === 0) return trimmed;
    const kmart = matches.filter((u) => /kmart\.com\.au/i.test(u));
    return (kmart[kmart.length - 1] ?? matches[matches.length - 1]).replace(/[)\].,;]+$/, "");
  };
  const cleanUrl = useMemo(() => normalizeKmartUrl(url), [url]);
  const urlWasCleaned = cleanUrl !== url.trim() && url.trim().length > 0;

  const cardReady = useMemo(() => {
    const pan = card.number.replace(/\s+/g, "");
    const cvv = card.cvv.trim();
    const mm = card.expMonth.trim();
    const yy = card.expYear.trim();
    return pan.length >= 12 && cvv.length >= 3 && mm.length >= 1 && yy.length >= 2;
  }, [card]);

  const canRun = useMemo(() => {
    return /^https:\/\/(www\.)?kmart\.com\.au\//i.test(cleanUrl) && qty > 0 && !running;
  }, [cleanUrl, qty, running]);

  const handleRun = async () => {
    setRunning(true);
    setResult(null);
    try {
      const taskId = `kmart-${Date.now().toString(36)}`;
      const proxyRaw = proxy.trim();
      const classified = proxyRaw ? classifyProxy(proxyRaw) : null;
      if (classified?.kind === "invalid") {
        setResult({
          ok: false,
          error: `Proxy format invalid: ${classified.reason ?? "unrecognized"}. Use user:pass@host:port or host:port:user:pass`,
          taskId,
        } as RunResult);
        return;
      }
      if (classified?.kind === "template") {
        setResult({
          ok: false,
          error: "URL-template proxies are not supported on the Kmart HTTP lane. Paste a raw user:pass@host:port residential entry.",
          taskId,
        } as RunResult);
        return;
      }
      const proxyUrl = classified?.kind === "raw" ? classified.url ?? null : null;
      if (placeOrder) {
        const pan = card.number.replace(/\s+/g, "");
        const cvv = card.cvv.trim();
        const mm = card.expMonth.trim();
        const yy = card.expYear.trim();
        if (pan.length < 12 || cvv.length < 3 || !mm || yy.length < 2) {
          setResult({
            ok: false,
            error:
              "Real place order requires a complete test card (number, CVV, MM, YY) in the Checkout profile panel.",
            taskId,
          } as RunResult);
          return;
        }
      }
      const holder =
        card.holder.trim() ||
        [profile.first_name, profile.last_name].filter(Boolean).join(" ").trim() ||
        "Test Cardholder";
      const pan = card.number.replace(/\s+/g, "");
      const cvv = card.cvv.trim();
      const cardPayload =
        pan.length >= 12 && cvv.length >= 3
          ? {
              number: pan,
              cvv,
              expMonth: card.expMonth.trim() || "12",
              expYear: card.expYear.trim() || "29",
              holder,
            }
          : null;
      const res = (await runFn({
        data: {
          taskId,
          storeUrl: cleanUrl,
          // Kmart adapter reads SKU from PDP; variantId is only shape-required.
          variantId: 1,
          qty,
          proxy: proxyUrl,
          dryRun: !placeOrder,
          placeOrder,
          debugTrace: true,
          kmartMode: usePlaywright ? "playwright" : "current",
          // Stay on undici for the HTTP lane. Auto transport=tls with a proxy
          // produced empty 502s (native TLS crash) — use forceTls / Playwright
          // when deliberately testing Chrome TLS impersonation.
          profile: {
            email: profile.email || null,
            first_name: profile.first_name || null,
            last_name: profile.last_name || null,
            address1: profile.address1 || null,
            city: profile.city || null,
            province: profile.province || null,
            zip: profile.zip || null,
            phone: profile.phone || null,
          },
          card: cardPayload,
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
        url: cleanUrl,
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

  const handleAkamaiLab = async () => {
    setLabRunning(true);
    setLabResult(null);
    try {
      const res = (await labFn({
        data: {
          url: cleanUrl,
          proxy: proxy.trim() || null,
          rounds: 3,
          baselineTrace: akamaiBaseline,
        },
      })) as LabResult;
      setLabResult(res);
    } catch (e) {
      setLabResult({ ok: false, error: e instanceof Error ? e.message : String(e) });
    } finally {
      setLabRunning(false);
    }
  };

  const handleDiagnose = async () => {
    setDiagRunning(true);
    setDiagResult(null);
    setHealthPing(null);
    try {
      const ping = (await pingFn()) as { ok: boolean; body?: any; error?: string };
      setHealthPing(ping);
      const res = (await diagnoseFn({
        data: {
          proxy: proxy.trim() || null,
          targetUrl: /^https:\/\/(www\.)?kmart\.com\.au\//i.test(cleanUrl) ? cleanUrl : "https://www.kmart.com.au/",
          fingerprint: true,
          proxyProbe: true,
          directProbe: true,
        },
      })) as DiagnoseResult;
      setDiagResult(res);
    } catch (e) {
      setDiagResult({ ok: false, error: e instanceof Error ? e.message : String(e) });
    } finally {
      setDiagRunning(false);
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
  const labTrace = labResult?.result?.trace;
  const labDiff = labResult?.result?.diff;
  const saveAkamaiBaseline = () => {
    if (!labTrace) return;
    setAkamaiBaseline(labTrace);
    setAkamaiBaselineText(JSON.stringify(labTrace, null, 2));
    writeJSON(AKAMAI_BASELINE_KEY, labTrace);
  };
  const importAkamaiBaseline = () => {
    try {
      const parsed = JSON.parse(akamaiBaselineText);
      const trace = Array.isArray(parsed?.events) ? parsed : parsed?.trace;
      if (!trace || !Array.isArray(trace.events)) throw new Error("Trace JSON must include an events array");
      setAkamaiBaseline(trace);
      writeJSON(AKAMAI_BASELINE_KEY, trace);
    } catch (e) {
      alert(e instanceof Error ? e.message : "Invalid baseline trace JSON");
    }
  };
  const clearAkamaiBaseline = () => {
    setAkamaiBaseline(null);
    setAkamaiBaselineText("");
    try { localStorage.removeItem(AKAMAI_BASELINE_KEY); } catch {}
  };

  return (
    <div className="min-h-screen bg-background text-foreground">
      <div className="mx-auto max-w-4xl p-4 md:p-6">
        <div className="mb-6">
          <Link to="/" className="mb-2 inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
            <ArrowLeft className="h-3 w-3" /> Back
          </Link>
          <h1 className="text-2xl font-semibold tracking-tight">Kmart AU checkout</h1>
          <p className="text-sm text-muted-foreground">
            Runs Kmart through the Fly executor. Default lane is raw HTTP + Hyper; toggle Playwright for the Chromium fallback.
            Use <strong>Executor diagnose</strong> first when pages fail to load — it separates proxy CONNECT / TLS fingerprint issues from checkout logic.
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
              {urlWasCleaned && (
                <div className="mt-1 flex items-center justify-between gap-2 rounded border border-amber-500/40 bg-amber-500/5 px-2 py-1 text-[11px] text-amber-700 dark:text-amber-400">
                  <span className="truncate">
                    URL looks doubled — will submit as <code className="break-all">{cleanUrl}</code>
                  </span>
                  <button
                    type="button"
                    onClick={() => setUrl(cleanUrl)}
                    className="shrink-0 rounded border border-amber-500/40 px-2 py-0.5 hover:bg-amber-500/10"
                  >
                    Fix
                  </button>
                </div>
              )}
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
                <Label className="text-xs">Proxy (optional — paste into this field)</Label>
                <Input
                  value={proxy}
                  onChange={(e) => setProxy(e.target.value)}
                  placeholder="user:pass@host:port  or  host:port:user:pass"
                  className="font-mono text-xs"
                />
                <p className="mt-1 text-[11px] text-muted-foreground">
                  Leave empty = Fly direct egress (often GraphQL 403). Filling this used to force TLS and empty 502s — runs now stay on undici.
                </p>
              </div>
            </div>
            <details className="rounded-md border border-border/50 p-3" open>
              <summary className="cursor-pointer text-sm font-medium">Checkout profile + test card</summary>
              <div className="mt-3 grid gap-2 md:grid-cols-2">
                {(
                  [
                    ["email", "Email"],
                    ["phone", "Phone"],
                    ["first_name", "First name"],
                    ["last_name", "Last name"],
                    ["address1", "Street (number + name)"],
                    ["city", "City"],
                    ["province", "State (e.g. QLD)"],
                    ["zip", "Postcode"],
                  ] as const
                ).map(([key, label]) => (
                  <div key={key}>
                    <Label className="text-xs">{label}</Label>
                    <Input
                      value={profile[key]}
                      onChange={(e) => setProfile((p) => ({ ...p, [key]: e.target.value }))}
                      className="text-xs"
                    />
                  </div>
                ))}
              </div>
              <div className="mt-4 border-t border-border/40 pt-3">
                <div className="mb-2 text-xs font-medium">Test card (Paydock) — not saved to browser storage</div>
                <div className="grid gap-2 md:grid-cols-2">
                  <div className="md:col-span-2">
                    <Label className="text-xs">Card number</Label>
                    <Input
                      value={card.number}
                      onChange={(e) => setCard((c) => ({ ...c, number: e.target.value }))}
                      placeholder="4111 1111 1111 1111"
                      inputMode="numeric"
                      autoComplete="cc-number"
                      className="font-mono text-xs"
                    />
                  </div>
                  <div>
                    <Label className="text-xs">Exp month (MM)</Label>
                    <Input
                      value={card.expMonth}
                      onChange={(e) => setCard((c) => ({ ...c, expMonth: e.target.value.replace(/\D/g, "").slice(0, 2) }))}
                      placeholder="12"
                      inputMode="numeric"
                      autoComplete="cc-exp-month"
                      className="font-mono text-xs"
                    />
                  </div>
                  <div>
                    <Label className="text-xs">Exp year (YY)</Label>
                    <Input
                      value={card.expYear}
                      onChange={(e) => setCard((c) => ({ ...c, expYear: e.target.value.replace(/\D/g, "").slice(0, 4) }))}
                      placeholder="29"
                      inputMode="numeric"
                      autoComplete="cc-exp-year"
                      className="font-mono text-xs"
                    />
                  </div>
                  <div>
                    <Label className="text-xs">CVV</Label>
                    <Input
                      value={card.cvv}
                      onChange={(e) => setCard((c) => ({ ...c, cvv: e.target.value.replace(/\D/g, "").slice(0, 4) }))}
                      placeholder="123"
                      inputMode="numeric"
                      autoComplete="cc-csc"
                      type="password"
                      className="font-mono text-xs"
                    />
                  </div>
                  <div>
                    <Label className="text-xs">Cardholder (optional)</Label>
                    <Input
                      value={card.holder}
                      onChange={(e) => setCard((c) => ({ ...c, holder: e.target.value }))}
                      placeholder="Defaults to first + last name"
                      autoComplete="cc-name"
                      className="text-xs"
                    />
                  </div>
                </div>
              </div>
              <p className="mt-2 text-[11px] text-muted-foreground">
                Empty address fields fall back to adapter fixtures. Card here overrides Fly <code>KMART_CARD_*</code>.
                Dry-run still runs Paydock + 3DS when card is filled; place order stays off until you toggle it.
                {placeOrder && !cardReady && (
                  <span className="mt-1 block text-destructive">
                    Real submit needs number + CVV + expiry MM/YY filled above.
                  </span>
                )}
              </p>
            </details>
            <div className="flex items-center justify-between rounded-md border border-border/50 p-3">
              <div>
                <div className="text-sm font-medium">Attempt real place order</div>
                <div className="text-xs text-muted-foreground">
                  Off = dry-run (stops after 3DS). On = runs built-in <code>chargePayDockWithToken</code> after 3DS auth.
                  Revolut cards use a <em>decoupled</em> 3DS push — when you see <code>paydock_3ds_acs:hint</code>, approve in the Revolut app (you will not get a prompt if ACS dies on a cert error).
                  {usePlaywright ? " Playwright seeds Akamai cookies, then HTTP GraphQL completes checkout." : ""}
                </div>
              </div>
              <Switch checked={placeOrder} onCheckedChange={setPlaceOrder} />
            </div>
            <div className="flex items-center justify-between rounded-md border border-border/50 p-3">
              <div>
                <div className="text-sm font-medium">Use Playwright fallback lane</div>
                <div className="text-xs text-muted-foreground">
                  Real Chrome + Hyper Playwright handlers for WWW/api trust, then HTTP GraphQL handoff.
                  Needs a sticky AU residential proxy — rotating exits that hard-deny at the edge never load Bot Manager (Hyper cannot solve that).
                </div>
              </div>
              <Switch checked={usePlaywright} onCheckedChange={setUsePlaywright} />
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Button onClick={handleDiagnose} disabled={diagRunning} variant="outline">
                {diagRunning ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <HeartPulse className="mr-2 h-4 w-4" />}
                {diagRunning ? "Diagnosing…" : "Executor diagnose"}
              </Button>
              <Button onClick={handleAkamaiLab} disabled={!canRun || labRunning} variant="outline">
                {labRunning ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <FlaskConical className="mr-2 h-4 w-4" />}
                {labRunning ? "Testing Akamai…" : "Akamai lab"}
              </Button>
              <Button onClick={handleRun} disabled={!canRun || (placeOrder && !cardReady)}>
                {running ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Play className="mr-2 h-4 w-4" />}
                {running ? "Running…" : placeOrder ? "Run — real submit" : "Run — dry run"}
              </Button>
              {placeOrder && cardReady && (
                <Badge variant="secondary" className="text-[10px]">
                  will charge via <code>chargePayDockWithToken</code>
                </Badge>
              )}
              {placeOrder && !cardReady && (
                <Badge variant="destructive" className="text-[10px]">
                  fill test card first
                </Badge>
              )}
              {usePlaywright && (
                <Badge variant="outline" className="text-[10px]">
                  lane=playwright
                </Badge>
              )}
            </div>
          </div>
        </Card>

        {/* Executor deep health */}
        {(diagResult || healthPing) && (
          <Card className="mb-4 p-4">
            <div className="mb-2 flex items-center justify-between gap-2">
              <div className="text-sm font-medium">Executor diagnose</div>
              <div className="flex flex-wrap gap-2">
                <Badge variant={diagResult?.ok ? "default" : "destructive"} className="text-[10px]">
                  {diagResult?.ok ? "healthy" : "issues"}
                </Badge>
                {diagResult?.elapsedMs != null && (
                  <Badge variant="outline" className="text-[10px]">{diagResult.elapsedMs}ms</Badge>
                )}
              </div>
            </div>
            {healthPing && (
              <div className="mb-2 grid gap-1 text-xs md:grid-cols-4">
                <div><span className="text-muted-foreground">Ping:</span> {healthPing.ok ? "ok" : healthPing.error ?? "fail"}</div>
                <div><span className="text-muted-foreground">Transport:</span> <code>{healthPing.body?.transport ?? "—"}</code></div>
                <div><span className="text-muted-foreground">Hyper key:</span> <code>{String(healthPing.body?.hyperApiKey ?? "—")}</code></div>
                <div><span className="text-muted-foreground">Proxy env:</span> <code>{String(healthPing.body?.proxyConfigured ?? "—")}</code></div>
              </div>
            )}
            {diagResult?.error && (
              <div className="mb-2 rounded border border-destructive/40 bg-destructive/5 p-2 text-xs text-destructive">
                {diagResult.error}
              </div>
            )}
            {diagResult?.result?.hint && (
              <div className="mb-2 rounded border border-amber-500/40 bg-amber-500/10 p-2 text-xs">
                {diagResult.result.hint}
              </div>
            )}
            <div className="mb-2 grid gap-2 text-xs md:grid-cols-2">
              <div className="rounded border border-border/50 p-2">
                <div className="mb-1 font-medium">Proxy CONNECT</div>
                {diagResult?.result?.checks?.proxy?.skipped ? (
                  <div className="text-muted-foreground">Skipped — no proxy on task and PROXY_URL_RESI unset</div>
                ) : (
                  <>
                    <div>ok=<code>{String(diagResult?.result?.checks?.proxy?.ok ?? "—")}</code></div>
                    <div>egress=<code>{diagResult?.result?.checks?.proxy?.egressIp ?? "—"}</code></div>
                    <div>target=<code>{diagResult?.result?.checks?.proxy?.target?.status ?? diagResult?.result?.checks?.proxy?.target?.error ?? "—"}</code></div>
                    {diagResult?.result?.checks?.proxy?.error && (
                      <div className="mt-1 text-destructive">{diagResult.result.checks.proxy.error}</div>
                    )}
                  </>
                )}
              </div>
              <div className="rounded border border-border/50 p-2">
                <div className="mb-1 font-medium">TLS fingerprint</div>
                <div>ok=<code>{String(diagResult?.result?.checks?.fingerprint?.ok ?? "—")}</code></div>
                <div>allMatch=<code>{String(diagResult?.result?.checks?.fingerprint?.allMatch ?? "—")}</code></div>
                {diagResult?.result?.checks?.fingerprint?.match && (
                  <div className="font-mono text-[11px] text-muted-foreground">
                    {Object.entries(diagResult.result.checks.fingerprint.match).map(([k, v]) => `${k}=${v}`).join(" · ")}
                  </div>
                )}
                {diagResult?.result?.checks?.fingerprint?.error && (
                  <div className="mt-1 text-destructive">{diagResult.result.checks.fingerprint.error}</div>
                )}
              </div>
              <div className="rounded border border-border/50 p-2">
                <div className="mb-1 font-medium">Direct target</div>
                <div>ok=<code>{String(diagResult?.result?.checks?.direct?.ok ?? "—")}</code></div>
                <div>status=<code>{diagResult?.result?.checks?.direct?.status ?? "—"}</code></div>
                {diagResult?.result?.checks?.direct?.error && (
                  <div className="mt-1 text-destructive">{diagResult.result.checks.direct.error}</div>
                )}
              </div>
              <div className="rounded border border-border/50 p-2">
                <div className="mb-1 font-medium">Env</div>
                <div>node=<code>{diagResult?.result?.checks?.env?.node ?? "—"}</code></div>
                <div>transport=<code>{diagResult?.result?.checks?.env?.httpTransport ?? "—"}</code></div>
                <div>proxyUsed=<code className="break-all">{diagResult?.result?.proxyUsed ?? "—"}</code></div>
              </div>
            </div>
            <details className="rounded border border-border/60 bg-muted/30 p-2 text-[11px]">
              <summary className="cursor-pointer text-muted-foreground">Raw diagnose JSON</summary>
              <pre className="mt-2 overflow-x-auto whitespace-pre-wrap break-all font-mono">
                {JSON.stringify(diagResult?.result ?? diagResult, null, 2)}
              </pre>
            </details>
          </Card>
        )}

        {/* Akamai-only lab result */}
        {labResult && (
          <Card className="mb-4 p-4">
            <div className="mb-2 flex items-center justify-between gap-2">
              <div className="text-sm font-medium">Akamai lab</div>
              <div className="flex flex-wrap gap-2">
                <Badge
                  variant={
                    labResult.result?.classification === "SOLVED"
                      ? "default"
                      : labResult.result?.classification === "EDGE_DENY"
                        ? "secondary"
                        : "destructive"
                  }
                  className="text-[10px]"
                >
                  {labResult.result?.classification ?? (labResult.result?.ok ? "pass" : "fail")}
                </Badge>
                {labResult.result?.transport && <Badge variant="outline" className="text-[10px]">{labResult.result.transport}</Badge>}
                {labResult.result?.initialStatus != null && <Badge variant="outline" className="text-[10px]">edge {labResult.result.initialStatus}</Badge>}
                {labResult.result?.ipStable != null && <Badge variant="outline" className="text-[10px]">IP {labResult.result.ipStable ? "stable" : "changed"}</Badge>}
              </div>
            </div>
            {labResult.result?.classification === "EDGE_DENY" && (
              <div className="mb-2 rounded border border-amber-500/40 bg-amber-500/10 p-2 text-xs">
                <strong>Edge deny (not a Hyper failure).</strong> Akamai refused this IP before bot-manager loaded — no <code>_abck</code> sentinel was set. Try a different proxy/pool. This IP's reputation is the problem, not the sensor code.
              </div>
            )}
            {labResult.error && (
              <div className="mb-2 rounded border border-destructive/40 bg-destructive/5 p-2 text-xs text-destructive">
                Lab error: {labResult.error}
              </div>
            )}
            {labResult.result?.verdict && (
              <div className="mb-2 rounded border border-border/60 bg-muted/30 p-2 font-mono text-xs break-all">
                {labResult.result.verdict}
              </div>
            )}
            <div className="mb-3 flex flex-wrap items-center gap-2 rounded border border-border/60 bg-muted/20 p-2 text-xs">
              <div className="mr-auto min-w-0">
                <div className="font-medium">Trace evidence</div>
                <div className="truncate text-muted-foreground">
                  {akamaiBaseline ? `Baseline ${akamaiBaseline.id ?? "saved"} · ${akamaiBaseline.events?.length ?? 0} events` : "No baseline saved yet"}
                </div>
              </div>
              <Button size="sm" variant="outline" onClick={() => labTrace && downloadJSON(`kmart-akamai-trace-${labTrace.id ?? Date.now()}.json`, labTrace)} disabled={!labTrace}>
                <Download className="mr-2 h-3 w-3" /> Trace
              </Button>
              <Button size="sm" variant="outline" onClick={() => labResult?.result && downloadJSON(`kmart-akamai-result-${Date.now()}.json`, labResult.result)} disabled={!labResult?.result}>
                <Download className="mr-2 h-3 w-3" /> Result
              </Button>
              <Button size="sm" variant="outline" onClick={saveAkamaiBaseline} disabled={!labTrace}>
                <Save className="mr-2 h-3 w-3" /> Save baseline
              </Button>
              {akamaiBaseline && (
                <Button size="sm" variant="ghost" onClick={clearAkamaiBaseline}>
                  <Trash2 className="mr-2 h-3 w-3" /> Clear baseline
                </Button>
              )}
            </div>
            <details className="mb-3 rounded border border-border/60 bg-muted/20 p-2 text-xs">
              <summary className="cursor-pointer text-muted-foreground">Paste/import baseline trace JSON</summary>
              <Textarea
                value={akamaiBaselineText}
                onChange={(e) => setAkamaiBaselineText(e.target.value)}
                placeholder='{"id":"browser-baseline","events":[...]}'
                className="mt-2 min-h-[120px] font-mono text-[11px]"
              />
              <div className="mt-2 flex gap-2">
                <Button size="sm" variant="outline" onClick={importAkamaiBaseline} disabled={!akamaiBaselineText.trim()}>
                  <GitCompareArrows className="mr-2 h-3 w-3" /> Use as baseline
                </Button>
              </div>
            </details>
            {labDiff && (
              <div className="mb-3 rounded border border-border/60 bg-muted/20 p-2 text-xs">
                <div className="mb-2 flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2 font-medium">
                    <GitCompareArrows className="h-3 w-3" /> Baseline diff
                  </div>
                  <Badge variant={labDiff.mismatchCount ? "destructive" : "default"} className="text-[10px]">
                    {labDiff.mismatchCount ?? 0} mismatches
                  </Badge>
                </div>
                <div className="mb-2 grid gap-1 text-muted-foreground md:grid-cols-3">
                  <div>baseline events <code>{labDiff.eventCounts?.baseline ?? "—"}</code></div>
                  <div>current events <code>{labDiff.eventCounts?.current ?? "—"}</code></div>
                  <div>missing current <code>{labDiff.missingCurrent?.length ?? 0}</code></div>
                </div>
                {(labDiff.missingCurrent?.length ?? 0) > 0 && (
                  <div className="mb-2 font-mono text-[11px] text-destructive">
                    Missing current: {labDiff.missingCurrent?.join(", ")}
                  </div>
                )}
                {(labDiff.mismatches?.length ?? 0) > 0 && (
                  <div className="space-y-1">
                    {labDiff.mismatches?.slice(0, 10).map((m, i) => (
                      <div key={`${m.label}-${m.field}-${i}`} className="rounded border border-border/40 bg-background/60 p-2 font-mono text-[11px]">
                        <div className="font-medium">{m.label} · {m.field}</div>
                        <div className="break-all text-muted-foreground">expected: {JSON.stringify(m.expected)}</div>
                        <div className="break-all">actual: {JSON.stringify(m.actual)}</div>
                      </div>
                    ))}
                    {(labDiff.mismatchCount ?? 0) > 10 && (
                      <div className="text-muted-foreground">Showing first 10 mismatches. Download result JSON for all diff entries.</div>
                    )}
                  </div>
                )}
              </div>
            )}
            <div className="mb-2 grid gap-2 text-xs md:grid-cols-3">
              <div><span className="text-muted-foreground">Initial IP:</span> <code>{labResult.result?.initialIp ?? "—"}</code></div>
              <div><span className="text-muted-foreground">Final IP:</span> <code>{labResult.result?.finalIp ?? "—"}</code></div>
              <div><span className="text-muted-foreground">Script bytes:</span> <code>{labResult.result?.scriptBytes ?? "—"}</code></div>
            </div>
            <div className="hidden overflow-x-auto md:block">
              <table className="w-full text-xs table-fixed">
                <thead>
                  <tr className="border-b border-border/50 text-left text-muted-foreground">
                    <th className="w-44 py-1 pr-2">Step</th>
                    <th className="w-14 py-1 pr-2">Status</th>
                    <th className="py-1">Note</th>
                  </tr>
                </thead>
                <tbody>
                  {(labResult.result?.steps ?? []).map((s, i) => (
                    <tr key={i} className="border-b border-border/20 align-top">
                      <td className="py-1 pr-2 font-mono break-all">
                        <span className={s.ok ? "text-green-600" : "text-destructive"}>{s.ok ? "✓" : "✗"}</span> {s.step}
                      </td>
                      <td className="py-1 pr-2 font-mono">{s.status ?? "—"}</td>
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
            <div className="space-y-2 md:hidden">
              {(labResult.result?.steps ?? []).map((s, i) => (
                <div key={i} className="rounded border border-border/40 bg-muted/20 p-2 text-xs">
                  <div className="mb-1 flex items-center justify-between gap-2 font-mono">
                    <span className="break-all"><span className={s.ok ? "text-green-600" : "text-destructive"}>{s.ok ? "✓" : "✗"}</span> {s.step}</span>
                    <code>{s.status ?? "—"}</code>
                  </div>
                  <div className="max-h-28 overflow-auto break-all font-mono text-[11px] text-muted-foreground">{s.note ?? ""}</div>
                </div>
              ))}
            </div>
            <details className="mt-2 rounded border border-border/60 bg-muted/30 p-2 text-[11px]">
              <summary className="cursor-pointer text-muted-foreground">Raw lab JSON</summary>
              <pre className="mt-2 overflow-x-auto whitespace-pre-wrap break-all font-mono">
                {JSON.stringify(labResult.result, null, 2)}
              </pre>
            </details>
          </Card>
        )}

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
              <div className="flex flex-wrap gap-2">
                <Badge variant={result.result?.ok ? "default" : "destructive"} className="text-[10px]">
                  {result.result?.ok ? "ok" : "failed"} · {result.result?.dryRun ? "dry-run" : "real"}
                </Badge>
                {result.result?.checkoutStage && (
                  <Badge variant="outline" className="text-[10px]">
                    stage={result.result.checkoutStage}
                  </Badge>
                )}
                {result.result?.adapter && (
                  <Badge variant="outline" className="text-[10px]">{result.result.adapter}</Badge>
                )}
                {result.result?.transport && (
                  <Badge variant="outline" className="text-[10px]">transport={result.result.transport}</Badge>
                )}
                {result.status != null && (
                  <Badge variant="outline" className="text-[10px]">HTTP {result.status}</Badge>
                )}
                {result.elapsedMs != null && (
                  <Badge variant="outline" className="text-[10px]">{result.elapsedMs}ms</Badge>
                )}
                <button
                  type="button"
                  onClick={() => {
                    const r = result.result;
                    const compact = {
                      taskId: result.taskId,
                      ok: r?.ok ?? result.ok,
                      dryRun: r?.dryRun,
                      checkoutStage: r?.checkoutStage,
                      orderNumber: r?.orderNumber,
                      paymentStatus: r?.paymentStatus,
                      paymentSummary: r?.paymentSummary,
                      paymentTail: r?.paymentTail,
                      lastSteps: r?.lastSteps,
                    };
                    navigator.clipboard?.writeText(JSON.stringify(compact, null, 2));
                  }}
                  className="rounded border border-border/60 bg-muted/40 px-2 py-0.5 text-[10px] hover:bg-muted"
                  title="Copy compact payment summary (best for chat)"
                >
                  Copy payment tail
                </button>
                <button
                  type="button"
                  onClick={() => navigator.clipboard?.writeText(JSON.stringify(result.result ?? result, null, 2))}
                  className="rounded border border-border/60 bg-muted/40 px-2 py-0.5 text-[10px] hover:bg-muted"
                  title="Copy full result JSON"
                >
                  Copy JSON
                </button>
              </div>
            </div>
            {result.result?.trace != null && (
              <details className="mb-2 rounded border border-border/60 bg-muted/30 p-2 text-[11px]">
                <summary className="cursor-pointer text-muted-foreground">
                  Trace / hyperStatus
                </summary>
                <pre className="mt-2 max-h-96 overflow-auto whitespace-pre-wrap break-all font-mono">
                  {JSON.stringify(result.result.trace, null, 2)}
                </pre>
              </details>
            )}
            {result.error && (
              <div className="mb-2 rounded border border-destructive/40 bg-destructive/5 p-2 text-xs text-destructive">
                Transport error: {result.error}
              </div>
            )}
            {result.result?.error && (
              <div className="mb-2 rounded border border-destructive/40 bg-destructive/5 p-2 text-xs text-destructive">
                Failed at <code>{result.result.failedStep ?? "—"}</code>: {result.result.error}
              </div>
            )}
            {/* Raw body dump when no steps came back (helps debug executor issues) */}
            {(!steps || steps.length === 0) && result.result && (
              <details className="mb-2 rounded border border-border/60 bg-muted/30 p-2 text-[11px]">
                <summary className="cursor-pointer text-muted-foreground">Raw response body</summary>
                <pre className="mt-2 overflow-x-auto whitespace-pre-wrap break-all font-mono">
                  {JSON.stringify(result.result, null, 2)}
                </pre>
              </details>
            )}

            {result.result?.orderNumber && (
              <div className="mb-2 rounded border border-green-500/40 bg-green-500/5 p-2 text-xs">
                <b>Order:</b> <code>{result.result.orderNumber}</code>
                {result.result.paymentStatus && <> · payment: <code>{result.result.paymentStatus}</code></>}
              </div>
            )}
            {(result.result?.paymentSummary ||
              steps.some(
                (s) =>
                  s.step === "payment_summary" ||
                  s.step.startsWith("paydock_") ||
                  s.step === "place_order" ||
                  s.step === "create_3ds_token",
              )) && (
              <div className="mb-2 rounded border border-border/50 bg-muted/20 p-2 text-xs">
                <div className="mb-1 font-medium">Payment pipeline</div>
                <div className="flex flex-wrap gap-2">
                  {[
                    "paydock_tokenize",
                    "create_3ds_token",
                    "paydock_3ds_init",
                    "paydock_3ds_method",
                    "paydock_3ds_handle",
                    "paydock_3ds_process",
                    "paydock_3ds_acs",
                    "paydock_3ds_process#2",
                    "place_order",
                    "payment_summary",
                  ].map((name) => {
                    const s = steps.find((x) => x.step === name);
                    if (!s) return null;
                    return (
                      <Badge key={name} variant={s.ok ? "secondary" : "destructive"} className="text-[10px] font-mono">
                        {s.ok ? "✓" : "✗"} {name}
                      </Badge>
                    );
                  })}
                </div>
                {result.result?.paymentSummary && (
                  <pre className="mt-2 max-h-28 overflow-auto whitespace-pre-wrap break-all font-mono text-[10px] text-muted-foreground">
                    {JSON.stringify(result.result.paymentSummary, null, 2)}
                  </pre>
                )}
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
