import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

// Calls the executor's /jbhifi/recon endpoint. Discovers products across
// JB Hi-Fi's public Shopify surfaces (sitemap, products.json, per-collection
// feeds, per-handle hydration). See executor/adapters/jbhifi-recon.js.

const InputSchema = z.object({
  query: z.string().max(200).nullable().optional(),
  limit: z.number().int().min(1).max(1000).default(200),
  hiddenOnly: z.boolean().default(false),
  refresh: z.boolean().default(false),
  hydrateAll: z.boolean().default(false),
  useProxy: z.boolean().default(false),
});

export const runJbhifiRecon = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => InputSchema.parse(input))
  .handler(async ({ data }) => {
    const url = process.env.EXECUTOR_URL;
    const token = process.env.EXECUTOR_TOKEN;
    if (!url || !token) {
      return { ok: false as const, error: "EXECUTOR_URL or EXECUTOR_TOKEN not configured" };
    }
    const t0 = Date.now();
    try {
      const res = await fetch(`${url.replace(/\/$/, "")}/jbhifi/recon`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(data),
      });
      const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      return {
        ok: res.ok,
        status: res.status,
        elapsedMs: Date.now() - t0,
        result: body,
      };
    } catch (e) {
      return {
        ok: false as const,
        error: e instanceof Error ? e.message : String(e),
        elapsedMs: Date.now() - t0,
      };
    }
  });
