// Persistent storage for the runner control-plane, backed by Lovable Cloud.
// All access is through the admin client (service_role); no end-user grants.
// All functions are async — call sites must await.

import { supabaseAdmin } from "@/integrations/supabase/client.server";
import type { RunnerJob, RunnerResult } from "./runner-protocol";

type Device = { id: string; token: string; name: string; lastSeenAt: number };
type RecentJob = {
  id: string;
  storeUrl: string;
  ok: boolean | null;
  orderId: string | null;
  error: string | null;
  at: number;
  dryRun: boolean;
};

const TEN_MIN_MS = 10 * 60 * 1000;

function rid() {
  return crypto.randomUUID().replace(/-/g, "").slice(0, 24);
}

export async function createPairingCode(deviceName: string): Promise<string> {
  const code = Array.from({ length: 6 }, () =>
    "ABCDEFGHJKMNPQRSTUVWXYZ23456789"[Math.floor(Math.random() * 31)]
  ).join("");
  const { error } = await supabaseAdmin
    .from("runner_pairing_codes")
    .insert({ code, device_name: deviceName || "Runner" });
  if (error) throw new Error(`createPairingCode: ${error.message}`);
  return code;
}

export async function consumePairingCode(code: string): Promise<Device | null> {
  // Look up the code
  const { data: entry } = await supabaseAdmin
    .from("runner_pairing_codes")
    .select("device_name, created_at")
    .eq("code", code)
    .maybeSingle();
  if (!entry) return null;

  // Always delete (single-use)
  await supabaseAdmin.from("runner_pairing_codes").delete().eq("code", code);

  // Expired?
  if (Date.now() - new Date(entry.created_at).getTime() > TEN_MIN_MS) return null;

  // Deactivate any existing active devices (single-active-device model)
  await supabaseAdmin
    .from("runner_devices")
    .update({ is_active: false })
    .eq("is_active", true);

  const token = rid() + rid();
  const { data: device, error } = await supabaseAdmin
    .from("runner_devices")
    .insert({ token, name: entry.device_name, is_active: true })
    .select("id, token, name, last_seen_at")
    .single();
  if (error || !device) throw new Error(`consumePairingCode: ${error?.message}`);

  return {
    id: device.id,
    token: device.token,
    name: device.name,
    lastSeenAt: new Date(device.last_seen_at).getTime(),
  };
}

export async function authDevice(token: string | null | undefined): Promise<Device | null> {
  if (!token) return null;
  const { data } = await supabaseAdmin
    .from("runner_devices")
    .select("id, token, name, last_seen_at")
    .eq("token", token)
    .maybeSingle();
  if (!data) return null;
  // Heartbeat
  await supabaseAdmin
    .from("runner_devices")
    .update({ last_seen_at: new Date().toISOString() })
    .eq("id", data.id);
  return {
    id: data.id,
    token: data.token,
    name: data.name,
    lastSeenAt: Date.now(),
  };
}

async function getActiveDeviceId(): Promise<string | null> {
  const { data } = await supabaseAdmin
    .from("runner_devices")
    .select("id")
    .eq("is_active", true)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  return data?.id ?? null;
}

export async function enqueueJob(
  job: RunnerJob
): Promise<{ dispatched: boolean; deviceId: string | null }> {
  const deviceId = await getActiveDeviceId();
  if (!deviceId) return { dispatched: false, deviceId: null };
  const { error } = await supabaseAdmin.from("runner_jobs").insert({
    id: job.id,
    device_id: deviceId,
    store_url: job.storeUrl,
    dry_run: job.dryRun,
    payload: job as never,
    claimed: false,
  });
  if (error) throw new Error(`enqueueJob: ${error.message}`);
  return { dispatched: true, deviceId };
}

export async function dequeueJobFor(deviceId: string): Promise<RunnerJob | null> {
  const { data: next } = await supabaseAdmin
    .from("runner_jobs")
    .select("id, payload")
    .eq("device_id", deviceId)
    .eq("claimed", false)
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();
  if (!next) return null;
  await supabaseAdmin
    .from("runner_jobs")
    .update({ claimed: true })
    .eq("id", next.id);
  return next.payload as unknown as RunnerJob;
}

export async function recordResult(result: RunnerResult): Promise<void> {
  await supabaseAdmin.from("runner_results").upsert({
    job_id: result.jobId,
    ok: result.ok,
    order_id: result.ok ? result.orderId : null,
    error: result.ok ? null : `${result.failedStep}: ${result.error}`,
    payload: result as never,
  });
}

export async function getResult(jobId: string): Promise<RunnerResult | null> {
  const { data } = await supabaseAdmin
    .from("runner_results")
    .select("payload")
    .eq("job_id", jobId)
    .maybeSingle();
  return (data?.payload as unknown as RunnerResult) ?? null;
}

export async function listRecentJobs(): Promise<RecentJob[]> {
  const { data } = await supabaseAdmin
    .from("runner_jobs")
    .select(
      "id, store_url, dry_run, created_at, runner_results(ok, order_id, error)"
    )
    .order("created_at", { ascending: false })
    .limit(10);
  return (data ?? []).map((row) => {
    const r = (row as { runner_results: { ok: boolean; order_id: string | null; error: string | null } | null }).runner_results;
    return {
      id: row.id,
      storeUrl: row.store_url,
      ok: r?.ok ?? null,
      orderId: r?.order_id ?? null,
      error: r?.error ?? null,
      at: new Date(row.created_at).getTime(),
      dryRun: row.dry_run,
    };
  });
}

export async function disconnectActiveDevice(): Promise<boolean> {
  const deviceId = await getActiveDeviceId();
  if (!deviceId) return false;
  // Cascade deletes jobs + results for this device
  await supabaseAdmin.from("runner_devices").delete().eq("id", deviceId);
  return true;
}

export async function getActiveDevice(): Promise<Device | null> {
  const { data } = await supabaseAdmin
    .from("runner_devices")
    .select("id, token, name, last_seen_at")
    .eq("is_active", true)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (!data) return null;
  return {
    id: data.id,
    token: data.token,
    name: data.name,
    lastSeenAt: new Date(data.last_seen_at).getTime(),
  };
}
