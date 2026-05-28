import { createFileRoute } from "@tanstack/react-router";
import { authDevice, dequeueJobFor } from "@/lib/runner-store.server";

// Short-poll: runner calls this every ~2s. Returns next job or { job: null }.
// (Long-poll would be nicer but Workers cap CPU/wall on idle awaits.)
export const Route = createFileRoute("/api/public/runner/poll")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const token = request.headers.get("x-runner-token");
        const device = authDevice(token);
        if (!device) return new Response("Unauthorized", { status: 401 });
        const job = dequeueJobFor(device.id);
        return Response.json({ job });
      },
    },
  },
});
