import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { validateDesktopApiKey } from "@/lib/desktop-license";

const Body = z.object({
  apiKey: z.string().min(1).max(200),
});

export const Route = createFileRoute("/api/public/desktop/validate-key")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        let parsed: z.infer<typeof Body>;
        try {
          parsed = Body.parse(await request.json());
        } catch {
          return Response.json({ ok: false, error: "Invalid body" }, { status: 400 });
        }
        const result = await validateDesktopApiKey(parsed.apiKey);
        return Response.json(result, { status: result.ok ? 200 : 401 });
      },
    },
  },
});
