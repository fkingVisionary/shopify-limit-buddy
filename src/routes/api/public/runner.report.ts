import { createFileRoute } from "@tanstack/react-router";
import { authDevice, recordResult } from "@/lib/runner-store.server";
import type { RunnerResult } from "@/lib/runner-protocol";

export const Route = createFileRoute("/api/public/runner/report")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const token = request.headers.get("x-runner-token");
        const device = authDevice(token);
        if (!device) return new Response("Unauthorized", { status: 401 });
        let body: RunnerResult;
        try {
          body = (await request.json()) as RunnerResult;
        } catch {
          return new Response("Invalid body", { status: 400 });
        }
        if (!body || typeof body !== "object" || !("jobId" in body)) {
          return new Response("Invalid result", { status: 400 });
        }
        recordResult(body);
        return Response.json({ ok: true });
      },
    },
  },
});
