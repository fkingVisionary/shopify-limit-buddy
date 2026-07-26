// Public proxy to Fly GET /milestones — so smokes can recover 3DS/payment
// after Cloudflare 524 / client timeout hides the /run body.
import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/api/public/exec-milestones")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const url = process.env.EXECUTOR_URL;
        const token = process.env.EXECUTOR_TOKEN;
        if (!url || !token) {
          return Response.json(
            { ok: false, error: "EXECUTOR_URL / EXECUTOR_TOKEN missing on server" },
            { status: 500 },
          );
        }
        let origin = url.trim();
        try {
          origin = new URL(origin).origin;
        } catch {
          origin = origin.replace(/\/+$/, "");
        }
        const incoming = new URL(request.url);
        const qs = new URLSearchParams();
        for (const key of ["limit", "minStage", "taskId"] as const) {
          const v = incoming.searchParams.get(key);
          if (v) qs.set(key, v);
        }
        if (!qs.has("limit")) qs.set("limit", "40");
        if (!qs.has("minStage")) qs.set("minStage", "tokenize");

        try {
          const res = await fetch(`${origin}/milestones?${qs}`, {
            headers: { authorization: `Bearer ${token}` },
          });
          const data = await res.json().catch(() => ({}));
          return Response.json(
            {
              ok: res.ok,
              status: res.status,
              ...data,
            },
            { status: res.ok ? 200 : res.status },
          );
        } catch (e) {
          return Response.json(
            { ok: false, error: e instanceof Error ? e.message : String(e) },
            { status: 502 },
          );
        }
      },
    },
  },
});
