import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

// Calls the external Node executor service (deployed on Fly.io) which runs
// the checkout HTTP chain through a residential proxy. See /executor for the
// service code and SETUP.md for the deploy walkthrough.
//
// Required env vars (Lovable Cloud secrets):
//   EXECUTOR_URL    e.g. https://j1ms-bot-executor.fly.dev
//   EXECUTOR_TOKEN  shared secret matching the executor's EXECUTOR_TOKEN

const InputSchema = z.object({
  taskId: z.string().min(1).max(100),
  storeUrl: z.string().url().max(500),
  variantId: z.number().int().positive(),
  qty: z.number().int().min(1).max(20).default(1),
  proxy: z.string().min(7).max(200).optional().nullable(),
  dryRun: z.boolean().default(true),
});

export const runOnExecutor = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => InputSchema.parse(input))
  .handler(async ({ data }) => {
    const url = process.env.EXECUTOR_URL;
    const token = process.env.EXECUTOR_TOKEN;
    if (!url || !token) {
      return { ok: false as const, error: "EXECUTOR_URL or EXECUTOR_TOKEN not configured" };
    }
    // Fall back to PROXY_URL_RESI env if no proxy supplied per-task
    const payload = { ...data, proxy: data.proxy ?? process.env.PROXY_URL_RESI ?? null };
    const t0 = Date.now();
    try {
      const res = await fetch(`${url.replace(/\/$/, "")}/run`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(payload),
      });
      const body = await res.json().catch(() => ({}));
      return { ok: res.ok, status: res.status, elapsedMs: Date.now() - t0, result: body };
    } catch (e) {
      return {
        ok: false as const,
        error: e instanceof Error ? e.message : String(e),
        elapsedMs: Date.now() - t0,
      };
    }
  });

export const pingExecutor = createServerFn({ method: "GET" }).handler(async () => {
  const url = process.env.EXECUTOR_URL;
  if (!url) return { ok: false as const, error: "EXECUTOR_URL not set" };
  try {
    const res = await fetch(`${url.replace(/\/$/, "")}/health`);
    return { ok: res.ok, status: res.status, body: await res.json().catch(() => null) };
  } catch (e) {
    return { ok: false as const, error: e instanceof Error ? e.message : String(e) };
  }
});
