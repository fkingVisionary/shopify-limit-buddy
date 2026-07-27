// In-process Bandai F5 harvest bank.
//
// Keeps warm Playwright bridges (goto /{area}/login settled) so checkout can
// skip Chromium launch on the drop critical path. Bridges are NOT serializable —
// they live in this executor process only. Desktop tracks metadata + claims by id.
//
// Hard rules (bible):
// - Never session.warm() after F5 seed
// - Never bank p8komysnbc-* sensors (mint fresh per gated call at checkout)
// - Empty / expired / miss → checkout cold-starts createBandaiF5Bridge (unchanged)

import { createBandaiF5Bridge, parseBandaiProxy } from "./bandai-f5.js";
import { normalizeBandaiArea } from "./bandai-session.js";

const MAX_SLOTS = Math.max(1, Math.min(8, Number(process.env.BANDAI_HARVEST_MAX_SLOTS) || 6));
const DEFAULT_TTL_MS = Math.max(
  60_000,
  Math.min(30 * 60_000, Number(process.env.BANDAI_HARVEST_TTL_MS) || 6 * 60_000),
);
const DEFAULT_SETTLE_MS = Math.max(
  1_200,
  Math.min(3_000, Number(process.env.BANDAI_HARVEST_SETTLE_MS) || 1_400),
);

/** @type {Map<string, {
 *  id: string,
 *  bridge: object,
 *  proxy: string,
 *  proxyHost: string|null,
 *  area: string,
 *  csrf: string|null,
 *  cookieKeys: string[],
 *  harvestedAt: number,
 *  expiresAt: number,
 *  settleMs: number,
 *  note: string,
 * }>} */
const slots = new Map();

let mintInflight = 0;
let mintedCount = 0;
let failedCount = 0;
let claimedCount = 0;

function now() {
  return Date.now();
}

function newId() {
  return `bf5_${now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function proxyHost(raw) {
  try {
    const parsed = parseBandaiProxy(raw);
    if (parsed?.url) return new URL(parsed.url).hostname;
  } catch {
    /* ignore */
  }
  try {
    if (/^https?:\/\//i.test(raw)) return new URL(raw).hostname;
    return String(raw || "").split(":")[0] || null;
  } catch {
    return null;
  }
}

async function safeClose(bridge) {
  try {
    await bridge?.close?.();
  } catch {
    /* ignore */
  }
}

/** Proxy / browser flake — retry on another sticky exit. Not Shape SoftBlock. */
export function isTransientHarvestError(err) {
  const s = String(err?.message || err || "");
  return /ERR_CONNECTION_CLOSED|ERR_CONNECTION_RESET|ERR_CONNECTION_TIMED_OUT|ERR_TUNNEL|ERR_PROXY|Timeout \d+ms exceeded|net::ERR_|Target closed|browser has been closed|Protocol error/i.test(
    s,
  );
}

async function evictExpired() {
  const t = now();
  const drop = [];
  for (const [id, slot] of slots) {
    if (slot.expiresAt <= t) drop.push(id);
  }
  for (const id of drop) {
    const slot = slots.get(id);
    slots.delete(id);
    await safeClose(slot?.bridge);
  }
  return drop.length;
}

function metaOf(slot) {
  const t = now();
  return {
    id: slot.id,
    proxy: slot.proxy,
    proxyHost: slot.proxyHost,
    area: slot.area,
    csrfPreview: slot.csrf ? `${String(slot.csrf).slice(0, 8)}…` : null,
    cookieKeys: slot.cookieKeys,
    harvestedAt: slot.harvestedAt,
    expiresAt: slot.expiresAt,
    ageSec: Math.max(0, Math.round((t - slot.harvestedAt) / 1000)),
    ttlSec: Math.max(0, Math.round((slot.expiresAt - t) / 1000)),
    settleMs: slot.settleMs,
    note: slot.note,
  };
}

export function harvestSnapshot() {
  const ready = [...slots.values()].map(metaOf);
  return {
    ready: ready.length,
    maxSlots: MAX_SLOTS,
    mintInflight,
    mintedCount,
    failedCount,
    claimedCount,
    ttlMs: DEFAULT_TTL_MS,
    sessions: ready,
  };
}

/**
 * Mint one warm F5 bridge on a sticky proxy. Does not log in — login stays
 * on the checkout critical path with a fresh sensor mint.
 */
export async function mintHarvestSlot({
  proxy,
  area = "au",
  settleMs = DEFAULT_SETTLE_MS,
  ttlMs = DEFAULT_TTL_MS,
  timeoutMs = 90_000,
} = {}) {
  await evictExpired();
  if (!proxy || !String(proxy).trim()) {
    return { ok: false, error: "proxy required (sticky AU ISP/resi)" };
  }
  if (slots.size >= MAX_SLOTS) {
    return {
      ok: false,
      error: `harvest bank full (${slots.size}/${MAX_SLOTS}) — claim or clear first`,
      atCapacity: true,
    };
  }

  const region = normalizeBandaiArea(area) || "au";
  const settle = Math.max(1_200, Math.min(3_000, Number(settleMs) || DEFAULT_SETTLE_MS));
  const ttl = Math.max(60_000, Math.min(30 * 60_000, Number(ttlMs) || DEFAULT_TTL_MS));
  const proxyRaw = String(proxy).trim();
  const t0 = now();
  mintInflight += 1;

  let bridge = null;
  try {
    bridge = await createBandaiF5Bridge({
      proxy: proxyRaw,
      area: region,
      timeoutMs: Number(timeoutMs) || 90_000,
    });
    await bridge.goto(`${bridge.BANDAI_BASE}/login`, { settleMs: settle });
    const csrf = await bridge.csrfToken();
    const cookies = (await bridge.cookies()) || {};
    const cookieKeys = Object.keys(cookies);
    const hasEdge = cookieKeys.some((k) => /^TS/i.test(k) || k === "SESSION");
    if (!csrf && !hasEdge) {
      await safeClose(bridge);
      bridge = null;
      failedCount += 1;
      return {
        ok: false,
        error: "F5 seed missing CSRF and SESSION/TS* cookies",
        ms: now() - t0,
      };
    }

    const id = newId();
    const harvestedAt = now();
    const slot = {
      id,
      bridge,
      proxy: proxyRaw,
      proxyHost: proxyHost(proxyRaw),
      area: region,
      csrf: csrf || null,
      cookieKeys,
      harvestedAt,
      expiresAt: harvestedAt + ttl,
      settleMs: settle,
      note: csrf
        ? `login seeded csrf=${String(csrf).slice(0, 8)}… cookies=${cookieKeys.length}`
        : `login seeded cookies=${cookieKeys.join(",")}`,
    };
    slots.set(id, slot);
    bridge = null; // ownership in map
    mintedCount += 1;
    return {
      ok: true,
      ms: now() - t0,
      session: metaOf(slot),
    };
  } catch (e) {
    failedCount += 1;
    await safeClose(bridge);
    return { ok: false, error: e?.message || String(e), ms: now() - t0 };
  } finally {
    mintInflight = Math.max(0, mintInflight - 1);
  }
}

/**
 * Mint across a proxy list, rotating on transient network/browser errors.
 * Stops on SoftBlock-ish / non-transient failures or success.
 */
export async function mintHarvestSlotWithRetries({
  proxies,
  area = "au",
  settleMs = DEFAULT_SETTLE_MS,
  ttlMs = DEFAULT_TTL_MS,
  timeoutMs = 90_000,
  maxAttempts = 3,
} = {}) {
  const list = (Array.isArray(proxies) ? proxies : [proxies])
    .map((p) => String(p || "").trim())
    .filter(Boolean);
  if (!list.length) return { ok: false, error: "proxies required" };
  const attempts = Math.max(1, Math.min(8, Number(maxAttempts) || 3));
  const tried = [];
  let last = null;
  for (let i = 0; i < attempts && i < list.length; i++) {
    const proxy = list[i];
    const tag = (proxy.match(/session-([^-]+)/) || [])[1] || `i${i}`;
    const res = await mintHarvestSlot({ proxy, area, settleMs, ttlMs, timeoutMs });
    tried.push({
      i,
      tag,
      ok: res.ok,
      ms: res.ms,
      error: res.error ? String(res.error).slice(0, 160) : null,
      id: res.session?.id || null,
    });
    if (res.ok) {
      return { ...res, attempts: tried, retried: i > 0 };
    }
    last = res;
    if (res.atCapacity) break;
    if (!isTransientHarvestError(res.error)) break;
  }
  return {
    ok: false,
    error: last?.error || "harvest mint failed",
    ms: last?.ms,
    attempts: tried,
    retried: tried.length > 1,
  };
}

/**
 * Transfer a ready bridge to checkout. Caller owns close(). Returns null on miss.
 * @returns {{ bridge, meta } | null}
 */
export function takeHarvestSlot(id) {
  if (!id) return null;
  const slot = slots.get(String(id));
  if (!slot) return null;
  slots.delete(String(id));
  if (slot.expiresAt <= now()) {
    void safeClose(slot.bridge);
    return null;
  }
  claimedCount += 1;
  return {
    bridge: slot.bridge,
    meta: metaOf(slot),
    proxy: slot.proxy,
    area: slot.area,
    csrf: slot.csrf,
  };
}

/**
 * Claim the next ready bridge (optionally matching area). Used when a specific
 * harvest id is dead/missing but the bank still has warm slots.
 * @returns {{ bridge, meta, proxy, area, csrf } | null}
 */
export function takeNextHarvestSlot({ area = null, excludeIds = [] } = {}) {
  void evictExpired();
  const exclude = new Set((Array.isArray(excludeIds) ? excludeIds : [excludeIds]).map(String).filter(Boolean));
  const want = area ? normalizeBandaiArea(area) : null;
  const t = now();
  for (const [id, slot] of slots) {
    if (exclude.has(String(id))) continue;
    if (want && slot.area !== want) continue;
    if (slot.expiresAt <= t) continue;
    return takeHarvestSlot(id);
  }
  return null;
}

/** Peek without claiming (tests / UI). */
export function peekHarvestSlot(id) {
  const slot = slots.get(String(id || ""));
  return slot ? metaOf(slot) : null;
}

export async function releaseHarvestSlot(id) {
  const slot = slots.get(String(id || ""));
  if (!slot) return { ok: false, error: "not found" };
  slots.delete(String(id));
  await safeClose(slot.bridge);
  return { ok: true, id: String(id) };
}

export async function clearHarvestSlots() {
  const ids = [...slots.keys()];
  for (const id of ids) {
    const slot = slots.get(id);
    slots.delete(id);
    await safeClose(slot?.bridge);
  }
  await evictExpired();
  return { ok: true, cleared: ids.length, snapshot: harvestSnapshot() };
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
  mintHarvestSlot,
  mintHarvestSlotWithRetries,
  takeHarvestSlot,
  takeNextHarvestSlot,
  peekHarvestSlot,
  releaseHarvestSlot,
  clearHarvestSlots,
  harvestSnapshot,
  isTransientHarvestError,
};
