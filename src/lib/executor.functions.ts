import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

// Calls the external Node executor service (deployed on Fly.io) which runs
// the checkout HTTP chain through a residential proxy. See /executor for the
// service code and SETUP.md for the deploy walkthrough.
//
// Required env vars (Lovable Cloud secrets):
//   EXECUTOR_URL    e.g. https://j1ms-bot-executor.fly.dev
//   EXECUTOR_TOKEN  shared secret matching the executor's EXECUTOR_TOKEN

const CardSchema = z.object({
  number: z.string().min(12).max(25),
  cvv: z.string().min(3).max(4),
  expMonth: z.string().min(1).max(2),
  expYear: z.string().min(2).max(4),
  holder: z.string().min(1).max(100),
});

const PlaceOrderMutationSchema = z.object({
  operationName: z.string().min(1).max(100),
  query: z.string().min(10).max(20_000),
  extraVars: z.record(z.string(), z.unknown()).optional(),
});

const InputSchema = z.object({
  taskId: z.string().min(1).max(100),
  storeUrl: z.string().url().max(500),
  variantId: z.number().int().positive(),
  qty: z.number().int().min(1).max(20).default(1),
  proxy: z.string().min(7).max(200).optional().nullable(),
  dryRun: z.boolean().default(true),
  // Optional caller-supplied card. When omitted, falls back to env-injected
  // card on the server. Future: comes from the calling user's profile row.
  card: CardSchema.optional().nullable(),
  // Real submit gates: both must be truthy to place a real order.
  //   placeOrder=true tells the adapter to attempt the final GraphQL call.
  //   placeOrderMutation supplies the op captured via bundle_recon / HAR.
  placeOrder: z.boolean().default(false),
  placeOrderMutation: PlaceOrderMutationSchema.optional().nullable(),
});

// Read card fields from Lovable Cloud secrets server-side. Returns null when
// any required field is missing (lets dry-runs work without card configured).
function cardFromEnv() {
  const number = process.env.KMART_CARD_NUMBER;
  const cvv = process.env.KMART_CARD_CVV;
  const expMonth = process.env.KMART_CARD_EXPIRY_MONTH;
  const expYear = process.env.KMART_CARD_EXPIRY_YEAR;
  const holder = process.env.KMART_CARD_HOLDER;
  if (!number || !cvv || !expMonth || !expYear || !holder) return null;
  return { number, cvv, expMonth, expYear, holder };
}

export const runOnExecutor = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => InputSchema.parse(input))
  .handler(async ({ data }) => {
    const rawUrl = process.env.EXECUTOR_URL;
    const token = process.env.EXECUTOR_TOKEN;
    if (!rawUrl || !token) {
      return { ok: false as const, error: "EXECUTOR_URL or EXECUTOR_TOKEN not configured" };
    }
    // Defensive: strip trailing slash and any accidental /health, /run, /recon suffix
    const url = rawUrl.replace(/\/$/, "").replace(/\/(health|run|recon)$/i, "");

    // Fall back to PROXY_URL_RESI env if no proxy supplied per-task.
    // Prefer caller-supplied card (future: profile-sourced); else inject from env.
    const payload = {
      ...data,
      proxy: data.proxy ?? process.env.PROXY_URL_RESI ?? null,
      card: data.card ?? cardFromEnv(),
    };
    const t0 = Date.now();
    try {
      const res = await fetch(`${url}/run`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(payload),
      });
      const rawBody = await res.text().catch(() => "");
      let body: Record<string, unknown> = {};
      if (rawBody) {
        try {
          body = JSON.parse(rawBody) as Record<string, unknown>;
        } catch {
          body = { rawBody: rawBody.slice(0, 2_000) };
        }
      }
      const fallbackError = !res.ok && !body?.error
        ? `Executor returned HTTP ${res.status}${rawBody ? "" : " with an empty body"}`
        : undefined;
      return {
        ok: res.ok,
        status: res.status,
        elapsedMs: Date.now() - t0,
        result: body,
        ...(fallbackError ? { error: fallbackError } : {}),
      };
    } catch (e) {
      return {
        ok: false as const,
        error: e instanceof Error ? e.message : String(e),
        elapsedMs: Date.now() - t0,
      };
    }
  });

export const pingExecutor = createServerFn({ method: "GET" }).handler(async () => {
  const rawUrl = process.env.EXECUTOR_URL;
  if (!rawUrl) return { ok: false as const, error: "EXECUTOR_URL not set" };
  const url = rawUrl.replace(/\/$/, "").replace(/\/(health|run|recon)$/i, "");
  try {
    const res = await fetch(`${url}/health`);
    return { ok: res.ok, status: res.status, body: await res.json().catch(() => null) };
  } catch (e) {
    return { ok: false as const, error: e instanceof Error ? e.message : String(e) };
  }
});
