import { useEffect, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from "@/components/ui/dialog";
import { Loader2, Copy, Check, KeyRound, Plus, Trash2, ShieldAlert, LogOut } from "lucide-react";
import {
  generateActivationCode,
  listWorkspaceDevices,
  revokeWorkspaceDevice,
  rotateWorkspaceRecoveryCode,
} from "@/lib/workspace.functions";
import { clearPairing, readDeviceId } from "@/integrations/workspace/client";

function formatAgo(ts: number): string {
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 10) return "just now";
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

export function DevicesPanel() {
  const qc = useQueryClient();
  const listFn = useServerFn(listWorkspaceDevices);
  const genFn = useServerFn(generateActivationCode);
  const revokeFn = useServerFn(revokeWorkspaceDevice);
  const rotateFn = useServerFn(rotateWorkspaceRecoveryCode);

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ["workspace-devices"],
    queryFn: () => listFn(),
    refetchInterval: 15_000,
  });

  const [code, setCode] = useState<string | null>(null);
  const [codeExpiresAt, setCodeExpiresAt] = useState<number | null>(null);
  const [now, setNow] = useState(Date.now());
  const [copied, setCopied] = useState(false);
  const [recoveryShown, setRecoveryShown] = useState<string | null>(null);
  const [confirmRevoke, setConfirmRevoke] = useState<{ id: string; name: string } | null>(null);

  useEffect(() => {
    if (!codeExpiresAt) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [codeExpiresAt]);

  const genMut = useMutation({
    mutationFn: () => genFn(),
    onSuccess: (r) => {
      setCode(r.code);
      setCodeExpiresAt(Date.now() + r.expiresInSec * 1000);
    },
  });

  const revokeMut = useMutation({
    mutationFn: (deviceId: string) => revokeFn({ data: { deviceId } }),
    onSuccess: () => {
      setConfirmRevoke(null);
      qc.invalidateQueries({ queryKey: ["workspace-devices"] });
    },
  });

  const rotateMut = useMutation({
    mutationFn: () => rotateFn(),
    onSuccess: (r) => setRecoveryShown(r.recoveryCode),
  });

  const currentId = readDeviceId();
  const codeRemaining = codeExpiresAt ? Math.max(0, Math.round((codeExpiresAt - now) / 1000)) : 0;

  const copyCode = async () => {
    if (!code) return;
    try { await navigator.clipboard.writeText(code); setCopied(true); setTimeout(() => setCopied(false), 2000); } catch {}
  };

  const handleSignOut = () => {
    if (confirm("Sign out of this device? You'll need an activation or recovery code to pair again.")) {
      clearPairing();
      window.location.href = "/pair";
    }
  };

  return (
    <Card className="p-4 space-y-4">
      <div className="flex items-start justify-between gap-2">
        <div>
          <h3 className="text-base font-semibold">Devices</h3>
          <p className="text-xs text-muted-foreground">Phones, tablets, or computers paired to this workspace.</p>
        </div>
        <Button variant="ghost" size="sm" onClick={handleSignOut} className="text-muted-foreground">
          <LogOut className="h-4 w-4 mr-1.5" /> Sign out
        </Button>
      </div>

      {/* Generate code */}
      <div className="rounded-md border bg-muted/30 p-3 space-y-3">
        <div className="flex items-center justify-between gap-2">
          <div>
            <div className="text-sm font-medium">Add another device</div>
            <div className="text-xs text-muted-foreground">Generate a 6-character code and enter it on the new device.</div>
          </div>
          {!code && (
            <Button size="sm" onClick={() => genMut.mutate()} disabled={genMut.isPending}>
              {genMut.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <><Plus className="h-4 w-4 mr-1.5" /> Generate</>}
            </Button>
          )}
        </div>
        {code && (
          <div className="space-y-2">
            <div className="flex items-center gap-2">
              <div className="flex-1 rounded-md bg-background border px-3 py-3 text-center font-mono text-2xl tracking-[0.4em] select-all">
                {code}
              </div>
              <Button variant="outline" size="icon" onClick={copyCode}>
                {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
              </Button>
            </div>
            <div className="flex items-center justify-between text-xs text-muted-foreground">
              <span>
                {codeRemaining > 0
                  ? `Expires in ${Math.floor(codeRemaining / 60)}:${String(codeRemaining % 60).padStart(2, "0")}`
                  : "Expired"}
              </span>
              <button className="underline" onClick={() => { setCode(null); setCodeExpiresAt(null); }}>
                Done
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Device list */}
      <div className="space-y-2">
        {isLoading && (
          <div className="text-sm text-muted-foreground flex items-center gap-2">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading devices…
          </div>
        )}
        {error && (
          <Alert variant="destructive">
            <AlertTitle>Couldn't load devices</AlertTitle>
            <AlertDescription className="flex items-center gap-2">
              {error instanceof Error ? error.message : "Unknown error"}
              <Button size="sm" variant="outline" onClick={() => refetch()}>Retry</Button>
            </AlertDescription>
          </Alert>
        )}
        {data?.devices.map((d) => {
          const isMe = d.id === currentId;
          return (
            <div key={d.id} className="flex items-center justify-between gap-2 rounded-md border p-3">
              <div className="min-w-0">
                <div className="text-sm font-medium flex items-center gap-2">
                  <span className="truncate">{d.name}</span>
                  {isMe && <span className="text-[10px] uppercase tracking-wide text-primary bg-primary/10 px-1.5 py-0.5 rounded">This device</span>}
                </div>
                <div className="text-xs text-muted-foreground">
                  Last seen {formatAgo(d.lastSeenAt)}
                </div>
              </div>
              {!isMe && (
                <Button variant="ghost" size="sm" onClick={() => setConfirmRevoke({ id: d.id, name: d.name })}>
                  <Trash2 className="h-4 w-4" />
                </Button>
              )}
            </div>
          );
        })}
      </div>

      {/* Recovery code */}
      <div className="rounded-md border bg-muted/30 p-3 space-y-2">
        <div className="flex items-center justify-between gap-2">
          <div>
            <div className="text-sm font-medium flex items-center gap-1.5"><KeyRound className="h-4 w-4" /> Recovery code</div>
            <div className="text-xs text-muted-foreground">Lets you re-pair if every device is lost. Rotating invalidates the old one.</div>
          </div>
          <Button size="sm" variant="outline" onClick={() => {
            if (confirm("Generate a new recovery code? The old one will stop working.")) rotateMut.mutate();
          }} disabled={rotateMut.isPending}>
            {rotateMut.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : "Rotate"}
          </Button>
        </div>
      </div>

      {/* Revoke confirm */}
      <Dialog open={!!confirmRevoke} onOpenChange={(o) => !o && setConfirmRevoke(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Revoke "{confirmRevoke?.name}"?</DialogTitle>
            <DialogDescription>
              The device will be signed out immediately and will need a new activation code to pair again.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmRevoke(null)}>Cancel</Button>
            <Button variant="destructive" onClick={() => confirmRevoke && revokeMut.mutate(confirmRevoke.id)} disabled={revokeMut.isPending}>
              {revokeMut.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : "Revoke device"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* New recovery code dialog */}
      <Dialog open={!!recoveryShown} onOpenChange={(o) => !o && setRecoveryShown(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2"><ShieldAlert className="h-5 w-5 text-amber-500" /> New recovery code</DialogTitle>
            <DialogDescription>
              Save this somewhere safe. It will not be shown again.
            </DialogDescription>
          </DialogHeader>
          <div className="rounded-md border bg-muted p-3 font-mono text-sm break-all select-all">
            {recoveryShown}
          </div>
          <DialogFooter>
            <Button onClick={() => {
              if (recoveryShown) navigator.clipboard.writeText(recoveryShown).catch(() => {});
              setRecoveryShown(null);
            }}>I've saved it</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
