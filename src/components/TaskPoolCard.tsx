import { useCallback, useMemo, useRef, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Slider } from "@/components/ui/slider";
import { Badge } from "@/components/ui/badge";
import { Play, Square, Zap } from "lucide-react";
import { runCheckoutOne, type C1StepRecord } from "@/lib/checkout-one-graphql.functions";
type HttpStepRecord = C1StepRecord;

type ProfileLike = {
  id: string; name: string;
  email: string; first_name: string; last_name: string;
  address1: string; address2?: string; city: string;
  province: string; zip: string; country: string; phone: string;
  card_number?: string; card_name?: string;
  card_exp_month?: string; card_exp_year?: string; card_cvv?: string;
};

type TaskRow = {
  id: string;
  proxy: string | null;
  status: "queued" | "running" | "ok" | "failed";
  currentStep: string;
  steps: HttpStepRecord[];
  elapsedMs: number;
  error?: string;
  orderId?: string | null;
};

export function TaskPoolCard({
  defaultStoreUrl, profiles,
}: { defaultStoreUrl?: string; profiles: ProfileLike[] }) {
  const run = useServerFn(runHttpCheckout);
  const [storeUrl, setStoreUrl] = useState(defaultStoreUrl ?? "");
  const [variantId, setVariantId] = useState("");
  const [qty, setQty] = useState("1");
  const [proxiesText, setProxiesText] = useState("");
  const [concurrency, setConcurrency] = useState(5);
  const [dryRun, setDryRun] = useState(true);
  const [profileId, setProfileId] = useState(profiles[0]?.id ?? "");
  const [tasks, setTasks] = useState<TaskRow[]>([]);
  const [running, setRunning] = useState(false);
  const cancelRef = useRef(false);

  const proxies = useMemo(
    () => proxiesText.split("\n").map((l) => l.trim()).filter(Boolean),
    [proxiesText],
  );

  const launch = useCallback(async () => {
    const profile = profiles.find((p) => p.id === profileId);
    if (!storeUrl || !variantId || !profile) return;
    cancelRef.current = false;
    setRunning(true);

    const list = proxies.length > 0 ? proxies : Array.from({ length: concurrency }, () => "");
    const seeded: TaskRow[] = list.map((p, i) => ({
      id: `t${Date.now()}-${i}`, proxy: p || null,
      status: "queued", currentStep: "—", steps: [], elapsedMs: 0,
    }));
    setTasks(seeded);

    const card = profile.card_number && profile.card_exp_month && profile.card_exp_year && profile.card_cvv
      ? {
          number: profile.card_number.replace(/\s+/g, ""),
          name: profile.card_name || `${profile.first_name} ${profile.last_name}`,
          exp_month: profile.card_exp_month,
          exp_year: profile.card_exp_year,
          cvv: profile.card_cvv,
        }
      : null;

    const profileInput = {
      email: profile.email, first_name: profile.first_name, last_name: profile.last_name,
      address1: profile.address1, address2: profile.address2 ?? null,
      city: profile.city, province: profile.province, zip: profile.zip,
      country: profile.country, phone: profile.phone,
    };

    let cursor = 0;
    const worker = async () => {
      while (!cancelRef.current) {
        const i = cursor++;
        if (i >= seeded.length) return;
        setTasks((prev) => prev.map((t, idx) => idx === i ? { ...t, status: "running", currentStep: "cart_add" } : t));
        try {
          const res = await run({
            data: {
              taskId: seeded[i].id, storeUrl,
              variantId: Number(variantId), qty: Number(qty),
              profile: profileInput, card, proxy: seeded[i].proxy, dryRun,
            },
          });
          setTasks((prev) => prev.map((t, idx) => {
            if (idx !== i) return t;
            if (res.ok) {
              return { ...t, status: "ok", currentStep: res.dryRun ? "dry-run ok" : "ok",
                steps: res.steps, elapsedMs: res.elapsedMs, orderId: res.orderId };
            }
            return { ...t, status: "failed", currentStep: res.failedStep,
              steps: res.steps, elapsedMs: res.elapsedMs, error: res.error };
          }));
        } catch (e) {
          setTasks((prev) => prev.map((t, idx) => idx === i
            ? { ...t, status: "failed", currentStep: "transport", error: (e as Error).message }
            : t));
        }
      }
    };
    const n = Math.min(concurrency, seeded.length);
    await Promise.all(Array.from({ length: n }, worker));
    setRunning(false);
  }, [storeUrl, variantId, qty, proxies, concurrency, dryRun, profileId, profiles, run]);

  const stop = () => { cancelRef.current = true; setRunning(false); };

  return (
    <Card className="p-3">
      <div className="flex items-center gap-2">
        <Zap className="h-4 w-4 text-primary" />
        <div className="text-sm font-medium">HTTP task pool</div>
        <Badge variant="secondary" className="ml-auto text-[10px]">parallel · server-side</Badge>
      </div>
      <p className="mt-1 text-[11px] text-muted-foreground">
        Fires N concurrent fetch-chain checkouts. Each row = one task, one proxy. No browser. Dry-run stops before card vault.
      </p>

      <div className="mt-3 grid grid-cols-2 gap-2">
        <div className="col-span-2">
          <Label className="text-xs">Store URL</Label>
          <Input value={storeUrl} onChange={(e) => setStoreUrl(e.target.value)} placeholder="https://store.myshopify.com" className="h-8" />
        </div>
        <div>
          <Label className="text-xs">Variant ID</Label>
          <Input value={variantId} onChange={(e) => setVariantId(e.target.value)} placeholder="123456789" className="h-8" />
        </div>
        <div>
          <Label className="text-xs">Qty</Label>
          <Input value={qty} onChange={(e) => setQty(e.target.value)} className="h-8" />
        </div>
        <div className="col-span-2">
          <Label className="text-xs">Profile</Label>
          <select className="h-8 w-full rounded-md border bg-background px-2 text-sm" value={profileId} onChange={(e) => setProfileId(e.target.value)}>
            {profiles.length === 0 && <option value="">— no profiles —</option>}
            {profiles.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </div>
        <div className="col-span-2">
          <Label className="text-xs">Proxies (one per line, leave empty for direct from edge)</Label>
          <Textarea value={proxiesText} onChange={(e) => setProxiesText(e.target.value)} rows={3} placeholder="user:pass@1.2.3.4:8000" className="font-mono text-xs" />
        </div>
        <div className="col-span-2">
          <Label className="text-xs">Concurrency: {concurrency}</Label>
          <Slider value={[concurrency]} min={1} max={30} step={1} onValueChange={(v) => setConcurrency(v[0])} />
        </div>
        <label className="col-span-2 flex items-center gap-2 text-sm">
          <input type="checkbox" className="h-4 w-4" checked={dryRun} onChange={(e) => setDryRun(e.target.checked)} />
          Dry-run (stop before card vault)
        </label>
      </div>

      <div className="mt-3 flex gap-2">
        {!running ? (
          <Button size="sm" className="h-9" onClick={launch} disabled={!storeUrl || !variantId || !profileId}>
            <Play className="h-4 w-4" /> Launch pool
          </Button>
        ) : (
          <Button size="sm" variant="destructive" className="h-9" onClick={stop}>
            <Square className="h-4 w-4" /> Stop
          </Button>
        )}
        {tasks.length > 0 && (
          <div className="ml-auto text-[11px] text-muted-foreground self-center">
            {tasks.filter((t) => t.status === "ok").length} ok ·{" "}
            {tasks.filter((t) => t.status === "failed").length} failed ·{" "}
            {tasks.filter((t) => t.status === "running" || t.status === "queued").length} pending
          </div>
        )}
      </div>

      {tasks.length > 0 && (
        <div className="mt-3 max-h-72 overflow-auto rounded-md border">
          <table className="w-full text-[11px]">
            <thead className="bg-muted/50">
              <tr>
                <th className="px-2 py-1 text-left">#</th>
                <th className="px-2 py-1 text-left">Proxy</th>
                <th className="px-2 py-1 text-left">Step</th>
                <th className="px-2 py-1 text-left">Status</th>
                <th className="px-2 py-1 text-right">ms</th>
              </tr>
            </thead>
            <tbody>
              {tasks.map((t, i) => (
                <tr key={t.id} className="border-t">
                  <td className="px-2 py-1">{i + 1}</td>
                  <td className="px-2 py-1 font-mono truncate max-w-[140px]">{t.proxy ?? "direct"}</td>
                  <td className="px-2 py-1">{t.currentStep}</td>
                  <td className="px-2 py-1">
                    {t.status === "ok" && <Badge className="bg-emerald-500/20 text-emerald-300">{t.orderId ? `#${t.orderId}` : "ok"}</Badge>}
                    {t.status === "failed" && <Badge variant="destructive" title={t.error}>failed</Badge>}
                    {t.status === "running" && <Badge variant="secondary">running</Badge>}
                    {t.status === "queued" && <Badge variant="outline">queued</Badge>}
                  </td>
                  <td className="px-2 py-1 text-right">{t.elapsedMs || ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}
