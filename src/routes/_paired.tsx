import { createFileRoute, Outlet, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { isPaired } from "@/integrations/workspace/client";
import { useCloudSync } from "@/hooks/use-cloud-sync";
import { Loader2 } from "lucide-react";

// Pathless layout that gates the entire app: redirects to /pair if no
// device token is stored. We do the check on the client only — the token
// lives in localStorage and would not be available during SSR anyway.
export const Route = createFileRoute("/_paired")({
  component: PairedLayout,
});

function PairedLayout() {
  const navigate = useNavigate();
  const [ready, setReady] = useState(false);
  useCloudSync();

  useEffect(() => {
    if (!isPaired()) {
      navigate({ to: "/pair", replace: true });
      return;
    }
    setReady(true);
    // React to pairing changes (e.g. revoke from another tab).
    const onChange = () => { if (!isPaired()) navigate({ to: "/pair", replace: true }); };
    window.addEventListener("workspace:pairing-changed", onChange);
    window.addEventListener("storage", onChange);
    return () => {
      window.removeEventListener("workspace:pairing-changed", onChange);
      window.removeEventListener("storage", onChange);
    };
  }, [navigate]);

  if (!ready) {
    return (
      <div className="min-h-[100dvh] flex items-center justify-center bg-background">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }
  return <Outlet />;
}
