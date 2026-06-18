import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

// Async checkout-job API.
//
// Why this exists: a real Shopify checkout via Browserless /function takes
// 30–60s, but TanStack server fns run on Cloudflare Workers with a ~30s
// wall-clock limit. We enqueue a row, kick a Supabase Edge Function
// (Deno, ~150s budget) fire-and-forget, then poll the row from the client.

const ProfileSchema = z.object({
  email: z.string().max(200),
  first_name: z.string().max(100),
  last_name: z.string().max(100),
  address1: z.string().max(200),
  address2: z.string().max(200).optional().nullable(),
  city: z.string().max(100),
  province: z.string().max(100),
  zip: z.string().max(30),
  country: z.string().max(100),
  phone: z.string().max(40),
});
const CardSchema = z.object({
  number: z.string().min(12).max(25),
  name: z.string().min(1).max(100),
  exp_month: z.string().regex(/^\d{1,2}$/),
  exp_year: z.string().regex(/^\d{2,4}$/),
  cvv: z.string().regex(/^\d{3,4}$/),
});
const EnqueueSchema = z.object({
  storeUrl: z.string().url().max(500),
  variantId: z.number().int().positive(),
  qty: z.number().int().min(1).max(20),
  profile: ProfileSchema,
  card: CardSchema,
  proxy: z.string().min(7).max(200).optional().nullable(),
  captchaToken: z.string().min(10).max(4000).optional().nullable(),
  dryRun: z.boolean().optional(),
});

export type CheckoutJobStatus = "pending" | "running" | "succeeded" | "failed";

export type CheckoutJobView = {
  id: string;
  status: CheckoutJobStatus;
  stage: string;
  error: string | null;
  result: any | null;
  createdAt: string;
  updatedAt: string;
};

export const enqueueCheckout = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => EnqueueSchema.parse(input))
  .handler(async ({ data }): Promise<{ jobId: string } | { error: string }> => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const SUPABASE_URL = process.env.SUPABASE_URL;
    const EXECUTOR_TOKEN = process.env.EXECUTOR_TOKEN;
    if (!SUPABASE_URL) return { error: "SUPABASE_URL missing" };
    if (!EXECUTOR_TOKEN) return { error: "EXECUTOR_TOKEN missing" };

    const { data: row, error } = await supabaseAdmin
      .from("checkout_jobs")
      .insert({ status: "pending", stage: "queued", input: data as any })
      .select("id")
      .single();
    if (error || !row) return { error: error?.message ?? "insert failed" };

    // Fire-and-forget edge function invocation. We deliberately do NOT await
    // the body — the worker will run for up to ~90s and the CF Worker hosting
    // this server fn would time out long before then.
    const edgeUrl = `${SUPABASE_URL}/functions/v1/run-checkout`;
    try {
      // Kick off the request; ignore the promise. `void` keeps lint quiet.
      void fetch(edgeUrl, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-executor-token": EXECUTOR_TOKEN,
        },
        body: JSON.stringify({ jobId: row.id }),
      }).catch(() => {});
    } catch {
      /* ignore */
    }
    return { jobId: row.id as string };
  });

export const getCheckoutJob = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => z.object({ jobId: z.string().uuid() }).parse(input))
  .handler(async ({ data }): Promise<CheckoutJobView | { error: string }> => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data: row, error } = await supabaseAdmin
      .from("checkout_jobs")
      .select("id,status,stage,error,result,created_at,updated_at")
      .eq("id", data.jobId)
      .maybeSingle();
    if (error || !row) return { error: error?.message ?? "not found" };
    return {
      id: row.id as string,
      status: row.status as CheckoutJobStatus,
      stage: row.stage as string,
      error: (row.error as string) ?? null,
      result: row.result ?? null,
      createdAt: row.created_at as string,
      updatedAt: row.updated_at as string,
    };
  });
