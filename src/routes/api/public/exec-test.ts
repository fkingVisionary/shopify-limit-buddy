// Internal smoke-test endpoint for the Fly executor.
// Public path purely so the agent can curl it during setup;
// callers must still know the storeUrl to test.
import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/api/public/exec-test")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const url = process.env.EXECUTOR_URL;
        const token = process.env.EXECUTOR_TOKEN;
        if (!url || !token) {
          return Response.json(
            { ok: false, error: "EXECUTOR_URL / EXECUTOR_TOKEN missing on server" },
            { status: 500 },
          );
        }
        const body = (await request.json().catch(() => ({}))) as {
          storeUrl?: string;
          variantId?: number;
          taskId?: string;
        };
        if (!body.storeUrl) {
          return Response.json({ ok: false, error: "storeUrl required" }, { status: 400 });
        }
        const payload = {
          taskId: body.taskId ?? `smoke-${Date.now()}`,
          storeUrl: body.storeUrl,
          variantId: body.variantId ?? 1,
          qty: 1,
          dryRun: true,
          proxy: process.env.PROXY_URL_RESI ?? null,
        };
        const t0 = Date.now();
        try {
          const res = await fetch(`${url.replace(/\/$/, "")}/run`, {
            method: "POST",
            headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
            body: JSON.stringify(payload),
          });
          const data = await res.json().catch(() => ({}));
          return Response.json({ ok: res.ok, status: res.status, elapsedMs: Date.now() - t0, result: data });
        } catch (e) {
          return Response.json(
            { ok: false, error: e instanceof Error ? e.message : String(e), elapsedMs: Date.now() - t0 },
            { status: 502 },
          );
        }
      },
    },
  },
});
