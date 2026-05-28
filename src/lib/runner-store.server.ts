// In-memory store for the runner control-plane.
//
// ⚠️ SCAFFOLD ONLY. Cloudflare Workers run multiple isolates and recycle
// memory aggressively, so this Map is per-isolate and short-lived. It's
// enough to validate the end-to-end runner flow during development. Move
// to a Lovable Cloud table (`runner_devices`, `runner_jobs`) before going
// to production — the protocol stays identical.

import type { RunnerJob, RunnerResult } from "./runner-protocol";

type Device = { id: string; token: string; name: string; lastSeenAt: number };

const pairingCodes = new Map<string, { deviceName: string; createdAt: number }>();
const devicesByToken = new Map<string, Device>();
const jobsByDevice  = new Map<string, RunnerJob[]>(); // FIFO queue per device
const resultsByJob  = new Map<string, RunnerResult>();
const activeDeviceRef = { id: null as string | null };

const TEN_MIN = 10 * 60 * 1000;

function rid() {
  return crypto.randomUUID().replace(/-/g, "").slice(0, 24);
}

export function createPairingCode(deviceName: string) {
  // 6-char human-friendly code
  const code = Array.from({ length: 6 }, () =>
    "ABCDEFGHJKMNPQRSTUVWXYZ23456789"[Math.floor(Math.random() * 31)]
  ).join("");
  pairingCodes.set(code, { deviceName, createdAt: Date.now() });
  return code;
}

export function consumePairingCode(code: string): Device | null {
  const entry = pairingCodes.get(code);
  if (!entry) return null;
  if (Date.now() - entry.createdAt > TEN_MIN) {
    pairingCodes.delete(code);
    return null;
  }
  pairingCodes.delete(code);
  const device: Device = {
    id: rid(),
    token: rid() + rid(),
    name: entry.deviceName || "Runner",
    lastSeenAt: Date.now(),
  };
  devicesByToken.set(device.token, device);
  activeDeviceRef.id = device.id;
  return device;
}

export function authDevice(token: string | null | undefined): Device | null {
  if (!token) return null;
  const d = devicesByToken.get(token);
  if (d) d.lastSeenAt = Date.now();
  return d ?? null;
}

export function enqueueJob(job: RunnerJob): { dispatched: boolean; deviceId: string | null } {
  // Round-robin not needed — single-runner scaffold uses the most recent
  // paired device.
  const deviceId = activeDeviceRef.id;
  if (!deviceId) return { dispatched: false, deviceId: null };
  const list = jobsByDevice.get(deviceId) ?? [];
  list.push(job);
  jobsByDevice.set(deviceId, list);
  return { dispatched: true, deviceId };
}

export function dequeueJobFor(deviceId: string): RunnerJob | null {
  const list = jobsByDevice.get(deviceId);
  if (!list || list.length === 0) return null;
  const next = list.shift()!;
  jobsByDevice.set(deviceId, list);
  return next;
}

export function recordResult(result: RunnerResult) {
  resultsByJob.set(result.jobId, result);
}

export function getResult(jobId: string): RunnerResult | null {
  return resultsByJob.get(jobId) ?? null;
}

export function getActiveDevice(): Device | null {
  if (!activeDeviceRef.id) return null;
  for (const d of devicesByToken.values()) {
    if (d.id === activeDeviceRef.id) return d;
  }
  return null;
}
