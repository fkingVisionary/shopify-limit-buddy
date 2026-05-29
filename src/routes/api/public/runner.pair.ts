import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { consumePairingCode } from "@/lib/runner-store.server";

const Body = z.object({
  pairingCode: z.string().regex(/^[A-Z2-9]{6}$/),
  deviceName: z.string().min(1).max(64).optional(),
});

export const Route = createFileRoute("/api/public/runner/pair")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        let parsed;
        try {
          parsed = Body.parse(await request.json());
        } catch {
          return new Response("Invalid body", { status: 400 });
        }
        const device = await consumePairingCode(parsed.pairingCode);
        if (!device) return new Response("Invalid or expired code", { status: 401 });
        return Response.json({ deviceToken: device.token, deviceId: device.id });
      },
    },
  },
});
