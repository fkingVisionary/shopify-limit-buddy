import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

// Per-SKU endpoint probe. Fans out across public Shopify surfaces and
// returns an endpoint matrix showing which URLs leak data for each SKU.
// See executor/experiments/jbhifi-probe.js.

const InputSchema = z.object({
  skus: z.array(z.string().min(1).max(64)).max(50).default([]),
  queries: z.array(z.string().min(1).max(200)).max(20).default([]),
  proxy: z.string().min(7).max(300).nullable().optional(),
  concurrency: z.number().int().min(1).max(16).default(6),
  refreshKeys: z.boolean().optional(),
  skipShopify: z.boolean().optional(),
  hitsPerQuery: z.number().int().min(1).max(50).optional(),
}).refine((v) => v.skus.length > 0 || v.queries.length > 0, { message: "provide skus or queries" });


export const runJbhifiProbe = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => InputSchema.parse(input))
  .handler(async ({ data }) => {
    const url = process.env.EXECUTOR_URL;
    const token = process.env.EXECUTOR_TOKEN;
    if (!url || !token) {
      return { ok: false as const, error: "EXECUTOR_URL or EXECUTOR_TOKEN not configured" };
    }
    const t0 = Date.now();
    try {
      let origin = url.trim();
      try { origin = new URL(origin).origin; }
      catch { origin = origin.replace(/\/+$/, ""); }
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), 26_000);
      const res = await fetch(`${origin}/jbhifi/probe`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify(data),
        signal: ac.signal,
      }).finally(() => clearTimeout(timer));
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const body = (await res.json().catch(() => ({}))) as any;
      return {
        ok: res.ok,
        status: res.status,
        elapsedMs: Date.now() - t0,
        result: body,
        error: res.ok ? undefined : body?.error ?? body?.message ?? `Executor HTTP ${res.status}`,
      };
    } catch (e) {
      return { ok: false as const, error: e instanceof Error ? e.message : String(e), elapsedMs: Date.now() - t0 };
    }
  });
