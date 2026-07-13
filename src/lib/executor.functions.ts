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
  holder: z.string().max(100).optional().default(""),
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
  proxy: z.string().min(7).max(500).optional().nullable(),
  dryRun: z.boolean().default(true),
  // Optional caller-supplied card. When omitted, falls back to env-injected
  // card on the server. Future: comes from the calling user's profile row.
  card: CardSchema.optional().nullable(),
  // Real submit gates: placeOrder=true tells the adapter to attempt
  // chargePayDockWithToken after frictionless 3DS. placeOrderMutation is
  // optional recon baggage — Kmart adapter hardcodes the charge mutation.
  placeOrder: z.boolean().default(false),
  placeOrderMutation: PlaceOrderMutationSchema.optional().nullable(),
  debugTrace: z.boolean().default(false),
  kmartMode: z.enum(["current", "cart-baseline", "diagnostic", "playwright"]).default("current"),
  transport: z.enum(["undici", "tls"]).optional(),
  forceTls: z.boolean().optional(),
  forceUndici: z.boolean().optional(),
  httpHandoff: z.boolean().default(true),
  skipAtc: z.boolean().default(false),
  resumeFrom: z.enum(["api"]).optional(),
  profile: z
    .object({
      email: z.string().max(200).optional().nullable(),
      first_name: z.string().max(100).optional().nullable(),
      last_name: z.string().max(100).optional().nullable(),
      address1: z.string().max(200).optional().nullable(),
      city: z.string().max(100).optional().nullable(),
      province: z.string().max(100).optional().nullable(),
      zip: z.string().max(30).optional().nullable(),
      phone: z.string().max(40).optional().nullable(),
    })
    .optional()
    .nullable(),
});

const AkamaiLabInputSchema = z.object({
  url: z.string().url().max(500),
  proxy: z.string().min(7).max(500).optional().nullable(),
  rounds: z.number().int().min(1).max(6).default(3),
  baselineTrace: z.unknown().optional().nullable(),
});

const DiagnoseInputSchema = z.object({
  proxy: z.string().min(7).max(500).optional().nullable(),
  targetUrl: z.string().url().max(500).optional(),
  fingerprint: z.boolean().default(true),
  proxyProbe: z.boolean().default(true),
  directProbe: z.boolean().default(true),
});

function executorOrigin(rawUrl: string): string {
  return rawUrl.replace(/\/$/, "").replace(/\/(health|health\/diagnose|run|recon|akamai\/lab|transport\/diagnose)$/i, "");
}

function executorHostLabel(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "(invalid EXECUTOR_URL)";
  }
}

function trimToken(token: string | undefined): string {
  return (token ?? "").trim();
}

export const runOnExecutor = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => InputSchema.parse(input))
  .handler(async ({ data }) => {
    const rawUrl = process.env.EXECUTOR_URL;
    const token = trimToken(process.env.EXECUTOR_TOKEN);
    if (!rawUrl || !token) {
      return { ok: false as const, error: "EXECUTOR_URL or EXECUTOR_TOKEN not configured" };
    }
    // Defensive: strip trailing slash and any accidental path suffix
    const url = executorOrigin(rawUrl);

    const number = process.env.KMART_CARD_NUMBER;
    const cvv = process.env.KMART_CARD_CVV;
    const expMonth = process.env.KMART_CARD_EXPIRY_MONTH;
    const expYear = process.env.KMART_CARD_EXPIRY_YEAR;
    const holder = process.env.KMART_CARD_HOLDER;
    const envCard = number && cvv && expMonth && expYear && holder
      ? { number, cvv, expMonth, expYear, holder }
      : null;

    // Keep an empty proxy truly direct. Falling back to a server-side proxy made
    // "without proxies" runs still use the same failing network path.
    // Prefer caller-supplied card (future: profile-sourced); else inject from env.
    const payload = {
      ...data,
      proxy: data.proxy?.trim() || null,
      card: data.card ?? envCard,
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
      let body: any = {};
      if (rawBody) {
        try {
          body = JSON.parse(rawBody);
        } catch {
          body = { rawBody: rawBody.slice(0, 2_000) };
        }
      }
      const host = executorHostLabel(url);
      const authError = res.status === 401
        ? `Executor unauthorized at ${host} — EXECUTOR_TOKEN on Railway must exactly match the token on Fly (no quotes/spaces). EXECUTOR_URL must be the Fly origin, not the Railway dashboard.`
        : undefined;
      const fallbackError = !res.ok && !body?.error && !authError
        ? `Executor returned HTTP ${res.status}${rawBody ? "" : " with an empty body"}`
        : undefined;
      return {
        ok: res.ok,
        status: res.status,
        elapsedMs: Date.now() - t0,
        result: body,
        executorHost: host,
        ...(authError ? { error: authError } : fallbackError ? { error: fallbackError } : {}),
      };
    } catch (e) {
      return {
        ok: false as const,
        error: e instanceof Error ? e.message : String(e),
        elapsedMs: Date.now() - t0,
        executorHost: executorHostLabel(url),
      };
    }
  });

export const pingExecutor = createServerFn({ method: "GET" }).handler(async () => {
  const rawUrl = process.env.EXECUTOR_URL;
  if (!rawUrl) return { ok: false as const, error: "EXECUTOR_URL not set" };
  const url = executorOrigin(rawUrl);
  try {
    const res = await fetch(`${url}/health`);
    return { ok: res.ok, status: res.status, body: await res.json().catch(() => null) };
  } catch (e) {
    return { ok: false as const, error: e instanceof Error ? e.message : String(e) };
  }
});

export const diagnoseExecutor = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => DiagnoseInputSchema.parse(input))
  .handler(async ({ data }) => {
    const rawUrl = process.env.EXECUTOR_URL;
    const token = trimToken(process.env.EXECUTOR_TOKEN);
    if (!rawUrl || !token) {
      return { ok: false as const, error: "EXECUTOR_URL or EXECUTOR_TOKEN not configured" };
    }
    const url = executorOrigin(rawUrl);
    const t0 = Date.now();
    try {
      const res = await fetch(`${url}/health/diagnose`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          proxy: data.proxy?.trim() || null,
          targetUrl: data.targetUrl,
          fingerprint: data.fingerprint,
          proxyProbe: data.proxyProbe,
          directProbe: data.directProbe,
        }),
      });
      const rawBody = await res.text().catch(() => "");
      let body: any = {};
      if (rawBody) {
        try {
          body = JSON.parse(rawBody);
        } catch {
          body = { rawBody: rawBody.slice(0, 2_000) };
        }
      }
      const host = executorHostLabel(url);
      return {
        ok: res.ok && body?.ok !== false,
        status: res.status,
        elapsedMs: Date.now() - t0,
        result: body,
        executorHost: host,
        ...(res.status === 401
          ? { error: `Executor unauthorized at ${host} — EXECUTOR_TOKEN mismatch (Railway vs Fly)` }
          : !res.ok && !body?.error
            ? { error: `Executor returned HTTP ${res.status}` }
            : {}),
      };
    } catch (e) {
      return {
        ok: false as const,
        error: e instanceof Error ? e.message : String(e),
        elapsedMs: Date.now() - t0,
        executorHost: executorHostLabel(url),
      };
    }
  });

export const runAkamaiLab = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => AkamaiLabInputSchema.parse(input))
  .handler(async ({ data }) => {
    const rawUrl = process.env.EXECUTOR_URL;
    const token = trimToken(process.env.EXECUTOR_TOKEN);
    if (!rawUrl || !token) {
      return { ok: false as const, error: "EXECUTOR_URL or EXECUTOR_TOKEN not configured" };
    }
    const url = executorOrigin(rawUrl);
    const t0 = Date.now();
    try {
      const res = await fetch(`${url}/akamai/lab`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          url: data.url,
          proxy: data.proxy?.trim() || null,
          rounds: data.rounds,
          baselineTrace: data.baselineTrace ?? null,
        }),
      });
      const rawBody = await res.text().catch(() => "");
      let body: any = {};
      if (rawBody) {
        try {
          body = JSON.parse(rawBody);
        } catch {
          body = { rawBody: rawBody.slice(0, 2_000) };
        }
      }
      const host = executorHostLabel(url);
      return {
        ok: res.ok,
        status: res.status,
        elapsedMs: Date.now() - t0,
        result: body,
        executorHost: host,
        ...(res.status === 401
          ? { error: `Executor unauthorized at ${host} — EXECUTOR_TOKEN mismatch (Railway vs Fly)` }
          : {}),
      };
    } catch (e) {
      return {
        ok: false as const,
        error: e instanceof Error ? e.message : String(e),
        elapsedMs: Date.now() - t0,
        executorHost: executorHostLabel(url),
      };
    }
  });
