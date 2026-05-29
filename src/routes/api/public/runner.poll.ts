import { createFileRoute } from "@tanstack/react-router";
import { authDevice, dequeueJobFor } from "@/lib/runner-store";

export const Route = createFileRoute("/api/public/runner/poll")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const token = request.headers.get("x-runner-token");
        const device = await authDevice(token);
        if (!device) return new Response("Unauthorized", { status: 401 });
        const job = await dequeueJobFor(device.id);
        return Response.json({ job });
      },
    },
  },
});
