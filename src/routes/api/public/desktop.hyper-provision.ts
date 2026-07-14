import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import {
  hyperProvisionEnabled,
  operatorHyperApiKey,
  validateDesktopApiKey,
} from "@/lib/desktop-license";

const Body = z.object({
  apiKey: z.string().min(1).max(200),
});

/**
 * Transitional: after license check, return the operator Hyper key so the
 * desktop sidecar can run Akamai solves. Prefer BYO Hyper in the app when
 * possible. Enable only with DESKTOP_HYPER_PROVISION=1.
 */
export const Route = createFileRoute("/api/public/desktop/hyper-provision")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        if (!hyperProvisionEnabled()) {
          return Response.json(
            {
              ok: false,
              error: "Hyper provision disabled — set DESKTOP_HYPER_PROVISION=1 or use BYO Hyper in the app",
            },
            { status: 403 },
          );
        }
        let parsed: z.infer<typeof Body>;
        try {
          parsed = Body.parse(await request.json());
        } catch {
          return Response.json({ ok: false, error: "Invalid body" }, { status: 400 });
        }
        const lic = await validateDesktopApiKey(parsed.apiKey);
        if (!lic.ok) {
          return Response.json({ ok: false, error: lic.message }, { status: 401 });
        }
        const hyperApiKey = operatorHyperApiKey();
        if (!hyperApiKey) {
          return Response.json(
            { ok: false, error: "HYPER_API_KEY not configured on control plane" },
            { status: 503 },
          );
        }
        return Response.json({ ok: true, hyperApiKey });
      },
    },
  },
});
