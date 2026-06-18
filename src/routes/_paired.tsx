import { createFileRoute, Outlet } from "@tanstack/react-router";
import { useCloudSync } from "@/hooks/use-cloud-sync";

// Standalone-mode layout. We no longer gate the app on a paired device —
// the dashboard is fully usable on its own and stores data locally. Cloud
// sync still runs opportunistically when a workspace token is present
// (the hook silently no-ops / catches errors if it isn't), so users who
// link a device later get cross-device sync for free. The /pair route is
// still reachable from Settings for linking another device.
export const Route = createFileRoute("/_paired")({
  component: PairedLayout,
});

function PairedLayout() {
  useCloudSync();
  return <Outlet />;
}
