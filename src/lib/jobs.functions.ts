// Workspace-scoped jobs history. Joins runner_jobs + runner_results for all
// runner devices that belong to the caller's workspace.
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireWorkspaceDevice } from "@/integrations/workspace/middleware";
import { supabaseAdmin } from "@/integrations/supabase/client.server";

export type WorkspaceJob = {
  id: string;
  storeUrl: string;
  dryRun: boolean;
  createdAt: number;
  deviceId: string;
  ok: boolean | null;
  orderId: string | null;
  error: string | null;
  resultAt: number | null;
  // Slim payload preview — full payload available via getJobDetail.
  variantId: number | null;
  qty: number | null;
  profileName: string | null;
};

const ListSchema = z.object({
  limit: z.number().int().min(1).max(200).optional(),
  filter: z.enum(["all", "success", "failed", "pending"]).optional(),
  search: z.string().max(200).optional(),
});

export const listWorkspaceJobs = createServerFn({ method: "POST" })
  .middleware([requireWorkspaceDevice])
  .inputValidator((d: unknown) => ListSchema.parse(d))
  .handler(async ({ data, context }) => {
    const { data: devices } = await supabaseAdmin
      .from("runner_devices")
      .select("id, name")
      .eq("workspace_id", context.workspaceId);
    const deviceIds = (devices ?? []).map((d) => d.id);
    if (deviceIds.length === 0) return { jobs: [] as WorkspaceJob[] };

    const limit = data.limit ?? 50;
    const { data: rows, error } = await supabaseAdmin
      .from("runner_jobs")
      .select(
        "id, store_url, dry_run, created_at, payload, device_id, runner_results(ok, order_id, error, created_at)",
      )
      .in("device_id", deviceIds)
      .order("created_at", { ascending: false })
      .limit(limit);
    if (error) throw new Error(error.message);

    let jobs: WorkspaceJob[] = (rows ?? []).map((row) => {
      const r = (row as { runner_results: { ok: boolean; order_id: string | null; error: string | null; created_at: string } | null })
        .runner_results;
      const payload = (row.payload ?? {}) as {
        variantId?: number;
        qty?: number;
        profile?: { first_name?: string; last_name?: string };
      };
      const profileName =
        payload.profile && (payload.profile.first_name || payload.profile.last_name)
          ? `${payload.profile.first_name ?? ""} ${payload.profile.last_name ?? ""}`.trim()
          : null;
      return {
        id: row.id,
        storeUrl: row.store_url,
        dryRun: row.dry_run,
        createdAt: new Date(row.created_at).getTime(),
        deviceId: row.device_id,
        ok: r?.ok ?? null,
        orderId: r?.order_id ?? null,
        error: r?.error ?? null,
        resultAt: r?.created_at ? new Date(r.created_at).getTime() : null,
        variantId: payload.variantId ?? null,
        qty: payload.qty ?? null,
        profileName,
      };
    });

    if (data.filter && data.filter !== "all") {
      jobs = jobs.filter((j) => {
        if (data.filter === "success") return j.ok === true;
        if (data.filter === "failed") return j.ok === false;
        if (data.filter === "pending") return j.ok === null;
        return true;
      });
    }
    if (data.search) {
      const q = data.search.toLowerCase();
      jobs = jobs.filter(
        (j) =>
          j.storeUrl.toLowerCase().includes(q) ||
          (j.orderId?.toLowerCase().includes(q) ?? false) ||
          (j.error?.toLowerCase().includes(q) ?? false) ||
          (j.profileName?.toLowerCase().includes(q) ?? false),
      );
    }
    return { jobs };
  });

const DetailSchema = z.object({ jobId: z.string().min(1).max(64) });

export const getJobDetail = createServerFn({ method: "POST" })
  .middleware([requireWorkspaceDevice])
  .inputValidator((d: unknown) => DetailSchema.parse(d))
  .handler(async ({ data, context }) => {
    const { data: devices } = await supabaseAdmin
      .from("runner_devices")
      .select("id")
      .eq("workspace_id", context.workspaceId);
    const deviceIds = new Set((devices ?? []).map((d) => d.id));

    const { data: job } = await supabaseAdmin
      .from("runner_jobs")
      .select("id, store_url, dry_run, created_at, payload, device_id, claimed")
      .eq("id", data.jobId)
      .maybeSingle();
    if (!job || !deviceIds.has(job.device_id)) {
      return { job: null as null };
    }
    const { data: result } = await supabaseAdmin
      .from("runner_results")
      .select("ok, order_id, error, payload, created_at")
      .eq("job_id", data.jobId)
      .maybeSingle();
    return {
      job: {
        id: job.id,
        storeUrl: job.store_url,
        dryRun: job.dry_run,
        claimed: job.claimed,
        createdAt: new Date(job.created_at).getTime(),
        payload: job.payload,
        result: result
          ? {
              ok: result.ok,
              orderId: result.order_id,
              error: result.error,
              payload: result.payload,
              at: new Date(result.created_at).getTime(),
            }
          : null,
      },
    };
  });
