import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/api/public/exec-health")({
  server: {
    handlers: {
      GET: async () => {
        const url = process.env.EXECUTOR_URL;
        if (!url) return Response.json({ ok: false, error: "no EXECUTOR_URL" }, { status: 500 });
        let origin = url.trim();
        try { origin = new URL(origin).origin; } catch { origin = origin.replace(/\/+$/, ""); }
        const t0 = Date.now();
        try {
          const res = await fetch(`${origin}/health`);
          const text = await res.text();
          return Response.json({ ok: res.ok, status: res.status, ms: Date.now() - t0, origin, body: text.slice(0, 2000) });
        } catch (e) {
          return Response.json({ ok: false, error: e instanceof Error ? e.message : String(e), ms: Date.now() - t0, origin }, { status: 502 });
        }
      },
    },
  },
});
