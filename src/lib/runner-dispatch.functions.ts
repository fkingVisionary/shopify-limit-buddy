import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import {
  createPairingCode,
  enqueueJob,
  getActiveDevice,
  getResult,
  listRecentJobs,
  disconnectActiveDevice,
} from "./runner-store.server";
import type { RunnerJob, RunnerResult } from "./runner-protocol";

// ── Pairing ────────────────────────────────────────────────────────────────
export const createRunnerPairingCode = createServerFn({ method: "POST" })
  .inputValidator((d: { deviceName?: string }) => d)
  .handler(async ({ data }) => {
    const code = createPairingCode(data.deviceName ?? "Runner");
    return { code, expiresInSec: 10 * 60 };
  });

export const getRunnerStatus = createServerFn({ method: "GET" }).handler(async () => {
  const d = getActiveDevice();
  if (!d) return { connected: false as const };
  return {
    connected: true as const,
    deviceId: d.id,
    name: d.name,
    lastSeenAt: d.lastSeenAt,
    staleMs: Date.now() - d.lastSeenAt,
  };
});

// ── Job dispatch ───────────────────────────────────────────────────────────
const JobInput = z.object({
  storeUrl: z.string().url(),
  variantId: z.number().int().positive(),
  qty: z.number().int().min(1).max(20),
  profile: z.object({
    email: z.string(), first_name: z.string(), last_name: z.string(),
    address1: z.string(), address2: z.string().nullable().optional(),
    city: z.string(), province: z.string(), zip: z.string(),
    country: z.string(), phone: z.string(),
  }),
  card: z.object({
    number: z.string(), name: z.string(),
    exp_month: z.string(), exp_year: z.string(), cvv: z.string(),
  }),
  proxy: z.string().nullable().optional(),
  captchaToken: z.string().nullable().optional(),
  dryRun: z.boolean().optional(),
});

export const dispatchRunnerJob = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => JobInput.parse(input))
  .handler(async ({ data }) => {
    const job: RunnerJob = {
      id: crypto.randomUUID(),
      createdAt: Date.now(),
      ...data,
      dryRun: data.dryRun ?? true,
    };
    const r = enqueueJob(job);
    if (!r.dispatched) {
      return { ok: false as const, error: "No runner connected" };
    }
    return { ok: true as const, jobId: job.id, deviceId: r.deviceId };
  });

export const pollRunnerJobResult = createServerFn({ method: "GET" })
  .inputValidator((d: { jobId: string }) => d)
  .handler(async ({ data }): Promise<{ result: RunnerResult | null }> => {
    return { result: getResult(data.jobId) };
  });
