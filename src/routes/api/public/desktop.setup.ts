import { createFileRoute } from "@tanstack/react-router";
import { vantaWinSetupUrl } from "@/lib/vanta-download";

/**
 * One-click redirect to the Windows Setup installer.
 * Override with VANTA_WIN_SETUP_URL on the dashboard host (Railway/etc).
 */
export const Route = createFileRoute("/api/public/desktop/setup")({
  server: {
    handlers: {
      GET: async () => Response.redirect(vantaWinSetupUrl(), 302),
    },
  },
});
