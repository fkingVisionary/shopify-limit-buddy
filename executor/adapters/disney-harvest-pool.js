/**
 * In-process Disney harvest bank (Toymate-shaped serializable sessions).
 *
 * Unlike Bandai F5, slots are plain cookie/captcha blobs — claim returns the
 * session object for task.harvestedSession. Empty/expired → checkout cold path.
 */

import {
  harvestDisneySession,
  isDisneyHarvestFresh,
  DISNEY_ABCK_TTL_MS,
} from "./disney-harvest-session.js";

const MAX_SLOTS = Math.max(1, Math.min(12, Number(process.env.DISNEY_HARVEST_MAX_SLOTS) || 6));
const DEFAULT_TTL_MS = Math.max(
  60_000,
  Math.min(10 * 60_000, Number(process.env.DISNEY_HARVEST_TTL_MS) || DISNEY_ABCK_TTL_MS),
);

/** @type {Map<string, object>} */
const slots = new Map();

let mintInflight = 0;
let mintedCount = 0;
let failedCount = 0;
let claimedCount = 0;

function now() {
  return Date.now();
}

function metaOf(session) {
  const t = now();
  return {
    id: session.id,
    proxy: session.proxy,
    proxyHost: session.proxyHost,
    harvestedAt: session.harvestedAt,
    expiresAt: session.abckExpiresAt,
    ageSec: Math.max(0, Math.round((t - session.harvestedAt) / 1000)),
    ttlSec: Math.max(0, Math.round((Number(session.abckExpiresAt) - t) / 1000)),
    abckValid: Boolean(session.abckValid),
    hasCaptcha: Boolean(
      session.captchaToken &&
        (session.captchaExpiresAt == null || Number(session.captchaExpiresAt) > t),
    ),
    captchaTtlSec: session.captchaExpiresAt
      ? Math.max(0, Math.round((Number(session.captchaExpiresAt) - t) / 1000))
      : null,
    note: session.warmNote || null,
    captchaNote: session.captchaNote || null,
  };
}

function evictExpired() {
  const t = now();
  let n = 0;
  for (const [id, session] of slots) {
    if (!isDisneyHarvestFresh(session) || Number(session.abckExpiresAt) <= t) {
      slots.delete(id);
      n += 1;
    }
  }
  return n;
}

export function disneyHarvestSnapshot() {
  evictExpired();
  const ready = [...slots.values()].map(metaOf);
  return {
    store: "disney",
    ready: ready.length,
    readyWithCaptcha: ready.filter((s) => s.hasCaptcha).length,
    maxSlots: MAX_SLOTS,
    mintInflight,
    mintedCount,
    failedCount,
    claimedCount,
    ttlMs: DEFAULT_TTL_MS,
    sessions: ready,
  };
}

export async function mintDisneyHarvestSlot({
  proxy,
  solveCaptcha = true,
  pdpUrl,
  ttlMs = DEFAULT_TTL_MS,
} = {}) {
  evictExpired();
  if (!proxy || !String(proxy).trim()) {
    return { ok: false, error: "proxy required (sticky AU ISP/resi)" };
  }
  if (slots.size >= MAX_SLOTS) {
    return {
      ok: false,
      error: `disney harvest bank full (${slots.size}/${MAX_SLOTS}) — claim or clear first`,
      atCapacity: true,
    };
  }

  mintInflight += 1;
  try {
    const out = await harvestDisneySession({
      proxyRaw: String(proxy).trim(),
      solveCaptcha: solveCaptcha !== false,
      pdpUrl,
    });
    if (!out.ok || !out.session) {
      failedCount += 1;
      return {
        ok: false,
        error: out.error || "harvest failed",
        ms: out.ms,
        snapshot: disneyHarvestSnapshot(),
      };
    }
    const session = {
      ...out.session,
      abckExpiresAt: out.session.harvestedAt + (Number(ttlMs) || DEFAULT_TTL_MS),
    };
    slots.set(session.id, session);
    mintedCount += 1;
    return {
      ok: true,
      ms: out.ms,
      session: metaOf(session),
      // Full blob for desktop/local claim without round-trip take
      fullSession: session,
      snapshot: disneyHarvestSnapshot(),
    };
  } catch (e) {
    failedCount += 1;
    return { ok: false, error: e?.message || String(e), snapshot: disneyHarvestSnapshot() };
  } finally {
    mintInflight = Math.max(0, mintInflight - 1);
  }
}

/** Claim a banked session for checkout (removed from bank). */
export function takeDisneyHarvestSlot(id) {
  if (!id) return null;
  const session = slots.get(String(id));
  if (!session) return null;
  slots.delete(String(id));
  if (!isDisneyHarvestFresh(session)) return null;
  claimedCount += 1;
  return { session, meta: metaOf(session) };
}

export function peekDisneyHarvestSlot(id) {
  const session = slots.get(String(id || ""));
  return session ? metaOf(session) : null;
}

export function releaseDisneyHarvestSlot(id) {
  const session = slots.get(String(id || ""));
  if (!session) return { ok: false, error: "not found" };
  slots.delete(String(id));
  return { ok: true, id: String(id) };
}

export function clearDisneyHarvestSlots() {
  const n = slots.size;
  slots.clear();
  return { ok: true, cleared: n, snapshot: disneyHarvestSnapshot() };
}

export const __test = {
  MAX_SLOTS,
  DEFAULT_TTL_MS,
  slots,
  resetCounts() {
    mintedCount = 0;
    failedCount = 0;
    claimedCount = 0;
    mintInflight = 0;
  },
};

export default {
  mintDisneyHarvestSlot,
  takeDisneyHarvestSlot,
  peekDisneyHarvestSlot,
  releaseDisneyHarvestSlot,
  clearDisneyHarvestSlots,
  disneyHarvestSnapshot,
};
