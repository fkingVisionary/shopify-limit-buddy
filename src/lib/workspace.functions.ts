import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireWorkspaceDevice } from "@/integrations/workspace/middleware";
import {
  createActivationCode,
  createWorkspaceWithDevice,
  listDevices,
  redeemActivationCode,
  redeemRecoveryCode,
  renameDevice,
  revokeDevice,
  rotateRecoveryCode,
} from "@/lib/workspace-store";

const DeviceNameSchema = z.object({
  deviceName: z.string().min(1).max(64).optional(),
  userAgent: z.string().max(500).optional(),
});

// ── Public (no auth) ─────────────────────────────────────────────────────
export const createWorkspace = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) => DeviceNameSchema.parse(d))
  .handler(async ({ data }) => {
    return createWorkspaceWithDevice(data.deviceName ?? "Device", data.userAgent ?? null);
  });

const RedeemSchema = z.object({
  code: z.string().min(4).max(64),
  deviceName: z.string().min(1).max(64).optional(),
  userAgent: z.string().max(500).optional(),
});

export const redeemActivation = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) => RedeemSchema.parse(d))
  .handler(async ({ data }) => {
    const upper = data.code.trim().toUpperCase();
    const r = await redeemActivationCode(upper, data.deviceName ?? "Device", data.userAgent ?? null);
    if (!r) return { ok: false as const, error: "Invalid or expired code" };
    return { ok: true as const, ...r };
  });

export const redeemRecovery = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) => RedeemSchema.parse(d))
  .handler(async ({ data }) => {
    const r = await redeemRecoveryCode(data.code, data.deviceName ?? "Device", data.userAgent ?? null);
    if (!r) return { ok: false as const, error: "Invalid recovery code" };
    return { ok: true as const, ...r };
  });

// ── Authenticated (require paired device) ───────────────────────────────
export const whoami = createServerFn({ method: "GET" })
  .middleware([requireWorkspaceDevice])
  .handler(async ({ context }) => {
    return {
      workspaceId: context.workspaceId,
      deviceId: context.deviceId,
      deviceName: context.deviceName,
    };
  });

export const generateActivationCode = createServerFn({ method: "POST" })
  .middleware([requireWorkspaceDevice])
  .handler(async ({ context }) => {
    const code = await createActivationCode(context.workspaceId);
    return { code, expiresInSec: 600 };
  });

export const listWorkspaceDevices = createServerFn({ method: "GET" })
  .middleware([requireWorkspaceDevice])
  .handler(async ({ context }) => {
    const devices = await listDevices(context.workspaceId);
    return { devices, currentDeviceId: context.deviceId };
  });

const RevokeSchema = z.object({ deviceId: z.string().uuid() });
export const revokeWorkspaceDevice = createServerFn({ method: "POST" })
  .middleware([requireWorkspaceDevice])
  .inputValidator((d: unknown) => RevokeSchema.parse(d))
  .handler(async ({ data, context }) => {
    const ok = await revokeDevice(context.workspaceId, data.deviceId);
    return { ok };
  });

const RenameSchema = z.object({ deviceId: z.string().uuid(), name: z.string().min(1).max(64) });
export const renameWorkspaceDevice = createServerFn({ method: "POST" })
  .middleware([requireWorkspaceDevice])
  .inputValidator((d: unknown) => RenameSchema.parse(d))
  .handler(async ({ data, context }) => {
    const ok = await renameDevice(context.workspaceId, data.deviceId, data.name);
    return { ok };
  });

export const rotateWorkspaceRecoveryCode = createServerFn({ method: "POST" })
  .middleware([requireWorkspaceDevice])
  .handler(async ({ context }) => {
    const recoveryCode = await rotateRecoveryCode(context.workspaceId);
    return { recoveryCode };
  });
