// Server-side workspace + device-pairing primitives.
// All access through the admin client (service_role); RLS denies all
// anon/authenticated traffic by design — we trust this layer.

import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { createHash, randomBytes } from "node:crypto";

const ACTIVATION_TTL_MS = 10 * 60 * 1000; // 10 min

function sha256(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString("hex"); // 64 chars
}

function randomCode(len: number): string {
  // Crockford-ish alphabet — no 0/O/1/I/L confusion.
  const alpha = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
  let out = "";
  const buf = randomBytes(len);
  for (let i = 0; i < len; i++) out += alpha[buf[i] % alpha.length];
  return out;
}

export type Device = {
  id: string;
  workspaceId: string;
  name: string;
  lastSeenAt: number;
  createdAt: number;
  userAgent: string | null;
};

export type CreateWorkspaceResult = {
  workspaceId: string;
  deviceId: string;
  deviceToken: string;
  recoveryCode: string;
};

export type JoinResult = {
  workspaceId: string;
  deviceId: string;
  deviceToken: string;
};

/** Create a brand-new workspace seeded with this first device. */
export async function createWorkspaceWithDevice(
  deviceName: string,
  userAgent: string | null,
): Promise<CreateWorkspaceResult> {
  const recoveryCode = randomCode(24); // user-facing recovery secret
  const deviceToken = randomToken(32);

  const { data: ws, error: e1 } = await supabaseAdmin
    .from("workspaces")
    .insert({ recovery_code_hash: sha256(recoveryCode) })
    .select("id")
    .single();
  if (e1 || !ws) throw new Error(`workspace create failed: ${e1?.message}`);

  const { data: dev, error: e2 } = await supabaseAdmin
    .from("workspace_devices")
    .insert({
      workspace_id: ws.id,
      token_hash: sha256(deviceToken),
      name: deviceName || "Device",
      user_agent: userAgent,
    })
    .select("id")
    .single();
  if (e2 || !dev) throw new Error(`device insert failed: ${e2?.message}`);

  return { workspaceId: ws.id, deviceId: dev.id, deviceToken, recoveryCode };
}

/** Generate a 6-char activation code for an existing workspace. */
export async function createActivationCode(workspaceId: string): Promise<string> {
  // Try a few times in the (vanishingly unlikely) event of collision.
  for (let i = 0; i < 5; i++) {
    const code = randomCode(6);
    const { error } = await supabaseAdmin
      .from("workspace_activation_codes")
      .insert({ code, workspace_id: workspaceId });
    if (!error) return code;
  }
  throw new Error("could not allocate activation code");
}

/** Redeem an activation code; mints a new device token bound to that workspace. */
export async function redeemActivationCode(
  code: string,
  deviceName: string,
  userAgent: string | null,
): Promise<JoinResult | null> {
  const { data: entry } = await supabaseAdmin
    .from("workspace_activation_codes")
    .select("workspace_id, created_at")
    .eq("code", code)
    .maybeSingle();
  if (!entry) return null;
  // Single-use: always delete.
  await supabaseAdmin.from("workspace_activation_codes").delete().eq("code", code);
  if (Date.now() - new Date(entry.created_at).getTime() > ACTIVATION_TTL_MS) return null;
  return mintDevice(entry.workspace_id, deviceName, userAgent);
}

/** Redeem a recovery code; mints a new device on the matching workspace. */
export async function redeemRecoveryCode(
  code: string,
  deviceName: string,
  userAgent: string | null,
): Promise<JoinResult | null> {
  const hash = sha256(code.trim());
  const { data: ws } = await supabaseAdmin
    .from("workspaces")
    .select("id")
    .eq("recovery_code_hash", hash)
    .maybeSingle();
  if (!ws) return null;
  return mintDevice(ws.id, deviceName, userAgent);
}

async function mintDevice(
  workspaceId: string,
  deviceName: string,
  userAgent: string | null,
): Promise<JoinResult> {
  const deviceToken = randomToken(32);
  const { data: dev, error } = await supabaseAdmin
    .from("workspace_devices")
    .insert({
      workspace_id: workspaceId,
      token_hash: sha256(deviceToken),
      name: deviceName || "Device",
      user_agent: userAgent,
    })
    .select("id")
    .single();
  if (error || !dev) throw new Error(`device mint failed: ${error?.message}`);
  return { workspaceId, deviceId: dev.id, deviceToken };
}

/** Validate a token, update heartbeat, return device. */
export async function authDeviceByToken(
  token: string | null | undefined,
): Promise<Device | null> {
  if (!token) return null;
  const hash = sha256(token);
  const { data } = await supabaseAdmin
    .from("workspace_devices")
    .select("id, workspace_id, name, last_seen_at, created_at, user_agent")
    .eq("token_hash", hash)
    .maybeSingle();
  if (!data) return null;
  // Fire-and-forget heartbeat (don't await — keep auth path snappy).
  void supabaseAdmin
    .from("workspace_devices")
    .update({ last_seen_at: new Date().toISOString() })
    .eq("id", data.id);
  return {
    id: data.id,
    workspaceId: data.workspace_id,
    name: data.name,
    lastSeenAt: Date.now(),
    createdAt: new Date(data.created_at).getTime(),
    userAgent: data.user_agent,
  };
}

export async function listDevices(workspaceId: string): Promise<Device[]> {
  const { data } = await supabaseAdmin
    .from("workspace_devices")
    .select("id, workspace_id, name, last_seen_at, created_at, user_agent")
    .eq("workspace_id", workspaceId)
    .order("created_at", { ascending: true });
  return (data ?? []).map((d) => ({
    id: d.id,
    workspaceId: d.workspace_id,
    name: d.name,
    lastSeenAt: new Date(d.last_seen_at).getTime(),
    createdAt: new Date(d.created_at).getTime(),
    userAgent: d.user_agent,
  }));
}

export async function revokeDevice(workspaceId: string, deviceId: string): Promise<boolean> {
  const { error } = await supabaseAdmin
    .from("workspace_devices")
    .delete()
    .eq("workspace_id", workspaceId)
    .eq("id", deviceId);
  return !error;
}

export async function renameDevice(
  workspaceId: string,
  deviceId: string,
  name: string,
): Promise<boolean> {
  const { error } = await supabaseAdmin
    .from("workspace_devices")
    .update({ name: name.slice(0, 64) })
    .eq("workspace_id", workspaceId)
    .eq("id", deviceId);
  return !error;
}

/** Rotate the workspace's recovery code; returns the new plaintext code. */
export async function rotateRecoveryCode(workspaceId: string): Promise<string> {
  const code = randomCode(24);
  const { error } = await supabaseAdmin
    .from("workspaces")
    .update({ recovery_code_hash: sha256(code) })
    .eq("id", workspaceId);
  if (error) throw new Error(`rotate recovery failed: ${error.message}`);
  return code;
}
