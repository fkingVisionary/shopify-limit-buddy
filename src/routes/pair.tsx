import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Loader2, Smartphone, Plus, KeyRound, Copy, Check, AlertTriangle } from "lucide-react";
import {
  createWorkspace,
  redeemActivation,
  redeemRecovery,
} from "@/lib/workspace.functions";
import { guessDeviceName, isPaired, savePairing } from "@/integrations/workspace/client";

export const Route = createFileRoute("/pair")({
  head: () => ({
    meta: [
      { title: "Pair device — J1m's Bot" },
      { name: "description", content: "Pair this device to a J1m's Bot workspace." },
    ],
  }),
  component: PairPage,
});

type Mode = "menu" | "create" | "join" | "recover" | "created";

function PairPage() {
  const navigate = useNavigate();
  const [mode, setMode] = useState<Mode>("menu");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [deviceName, setDeviceName] = useState("");
  const [code, setCode] = useState("");
  const [recoveryShown, setRecoveryShown] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const createFn = useServerFn(createWorkspace);
  const joinFn = useServerFn(redeemActivation);
  const recoverFn = useServerFn(redeemRecovery);

  // Already paired? Bounce to home.
  useEffect(() => {
    if (isPaired()) navigate({ to: "/" });
    setDeviceName(guessDeviceName());
  }, [navigate]);

  const ua = typeof navigator !== "undefined" ? navigator.userAgent.slice(0, 500) : undefined;

  const onCreate = async () => {
    setBusy(true); setError(null);
    try {
      const r = await createFn({ data: { deviceName, userAgent: ua } });
      savePairing(r);
      setRecoveryShown(r.recoveryCode);
      setMode("created");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally { setBusy(false); }
  };

  const onJoin = async () => {
    setBusy(true); setError(null);
    try {
      const r = await joinFn({ data: { code, deviceName, userAgent: ua } });
      if (!r.ok) { setError(r.error); return; }
      savePairing(r);
      navigate({ to: "/" });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally { setBusy(false); }
  };

  const onRecover = async () => {
    setBusy(true); setError(null);
    try {
      const r = await recoverFn({ data: { code, deviceName, userAgent: ua } });
      if (!r.ok) { setError(r.error); return; }
      savePairing(r);
      navigate({ to: "/" });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally { setBusy(false); }
  };

  const copyRecovery = async () => {
    if (!recoveryShown) return;
    try { await navigator.clipboard.writeText(recoveryShown); setCopied(true); setTimeout(() => setCopied(false), 2000); } catch {}
  };

  return (
    <div className="min-h-[100dvh] flex items-center justify-center bg-background p-4 pb-[env(safe-area-inset-bottom)]">
      <Card className="w-full max-w-md p-6 space-y-6">
        <div className="text-center space-y-1">
          <h1 className="text-2xl font-bold">J1m's Bot</h1>
          <p className="text-sm text-muted-foreground">Pair this device to a workspace</p>
        </div>

        {error && (
          <Alert variant="destructive">
            <AlertTriangle className="h-4 w-4" />
            <AlertTitle>Couldn't pair</AlertTitle>
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}

        {mode === "menu" && (
          <div className="space-y-3">
            <Button className="w-full h-12 text-base" onClick={() => setMode("create")}>
              <Plus className="h-4 w-4 mr-2" /> Create new workspace
            </Button>
            <Button variant="outline" className="w-full h-12 text-base" onClick={() => setMode("join")}>
              <Smartphone className="h-4 w-4 mr-2" /> Join existing workspace
            </Button>
            <Button variant="ghost" className="w-full" onClick={() => setMode("recover")}>
              <KeyRound className="h-4 w-4 mr-2" /> Use recovery code
            </Button>
          </div>
        )}

        {mode === "create" && (
          <div className="space-y-4">
            <div className="space-y-2">
              <Label>Name this device</Label>
              <Input value={deviceName} onChange={(e) => setDeviceName(e.target.value)} placeholder="e.g. My Mac" maxLength={64} autoComplete="off" />
            </div>
            <p className="text-xs text-muted-foreground">
              We'll create a fresh workspace and pair this device. You can add more devices afterwards from Settings → Devices.
            </p>
            <div className="flex gap-2">
              <Button variant="outline" onClick={() => setMode("menu")} disabled={busy}>Back</Button>
              <Button onClick={onCreate} disabled={busy || !deviceName.trim()} className="flex-1">
                {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : "Create workspace"}
              </Button>
            </div>
          </div>
        )}

        {mode === "join" && (
          <div className="space-y-4">
            <div className="space-y-2">
              <Label>Activation code</Label>
              <Input
                value={code}
                onChange={(e) => setCode(e.target.value.toUpperCase())}
                placeholder="6 characters"
                maxLength={6}
                autoCapitalize="characters"
                autoComplete="off"
                spellCheck={false}
                className="font-mono text-lg tracking-widest text-center uppercase"
                inputMode="text"
              />
            </div>
            <div className="space-y-2">
              <Label>Name this device</Label>
              <Input value={deviceName} onChange={(e) => setDeviceName(e.target.value)} placeholder="e.g. iPhone" maxLength={64} autoComplete="off" />
            </div>
            <p className="text-xs text-muted-foreground">
              Open Settings → Devices on your paired device and tap "Generate activation code".
            </p>
            <div className="flex gap-2">
              <Button variant="outline" onClick={() => setMode("menu")} disabled={busy}>Back</Button>
              <Button onClick={onJoin} disabled={busy || code.length !== 6} className="flex-1">
                {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : "Pair"}
              </Button>
            </div>
          </div>
        )}

        {mode === "recover" && (
          <div className="space-y-4">
            <div className="space-y-2">
              <Label>Recovery code</Label>
              <Input
                value={code}
                onChange={(e) => setCode(e.target.value)}
                placeholder="Paste your recovery code"
                autoComplete="off"
                spellCheck={false}
                className="font-mono"
              />
            </div>
            <div className="space-y-2">
              <Label>Name this device</Label>
              <Input value={deviceName} onChange={(e) => setDeviceName(e.target.value)} maxLength={64} autoComplete="off" />
            </div>
            <p className="text-xs text-muted-foreground">
              Use this if you've lost access to all paired devices. The recovery code was shown when the workspace was first created.
            </p>
            <div className="flex gap-2">
              <Button variant="outline" onClick={() => setMode("menu")} disabled={busy}>Back</Button>
              <Button onClick={onRecover} disabled={busy || !code.trim()} className="flex-1">
                {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : "Recover"}
              </Button>
            </div>
          </div>
        )}

        {mode === "created" && recoveryShown && (
          <div className="space-y-4">
            <Alert>
              <AlertTriangle className="h-4 w-4" />
              <AlertTitle>Save your recovery code</AlertTitle>
              <AlertDescription>
                This is the ONLY way to recover your workspace if you lose every paired device. It is shown once.
              </AlertDescription>
            </Alert>
            <div className="rounded-md border bg-muted p-3 font-mono text-sm break-all select-all">
              {recoveryShown}
            </div>
            <Button variant="outline" className="w-full" onClick={copyRecovery}>
              {copied ? <><Check className="h-4 w-4 mr-2" /> Copied</> : <><Copy className="h-4 w-4 mr-2" /> Copy to clipboard</>}
            </Button>
            <Button className="w-full" onClick={() => navigate({ to: "/" })}>
              I've saved it — continue
            </Button>
          </div>
        )}
      </Card>
    </div>
  );
}
