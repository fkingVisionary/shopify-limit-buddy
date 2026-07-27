/**
 * In-process Pokémon Centre harvest bank (optional Fly / local executor).
 * Desktop prefers bank:false blobs; this pool supports claim-by-id on /run.
 */

import {
  harvestPokemonCentreSession,
  isPcHarvestFresh,
  PC_EDGE_TTL_MS,
} from "./pokemoncentre-harvest-session.js";

const MAX_SLOTS = Math.max(1, Math.min(12, Number(process.env.PC_HARVEST_MAX_SLOTS) || 6));
/** @type {Map<string, { session: object, meta: object }>} */
const slots = new Map();
let mintInflight = 0;

function metaOf(session) {
  return {
    id: session.id,
    proxyHost: session.proxyHost || null,
    hasCaptcha: Boolean(session.captchaToken),
    harvestedAt: session.harvestedAt,
    edgeExpiresAt: session.edgeExpiresAt,
    captchaExpiresAt: session.captchaExpiresAt || null,
    egressIp: session.egressIp || null,
    warmNote: session.warmNote || null,
  };
}

export function pokemoncentreHarvestSnapshot() {
  const t = Date.now();
  const ready = [];
  for (const [id, row] of slots) {
    if (!isPcHarvestFresh(row.session)) {
      slots.delete(id);
      continue;
    }
    ready.push({
      ...row.meta,
      ageSec: Math.round((t - Number(row.session.harvestedAt || t)) / 1000),
      edgeTtlSec: Math.max(0, Math.round((Number(row.session.edgeExpiresAt) - t) / 1000)),
    });
  }
  return {
    ready: ready.length,
    maxSlots: MAX_SLOTS,
    mintInflight,
    sessions: ready,
    ttlMs: PC_EDGE_TTL_MS,
  };
}

export async function mintPokemonCentreHarvestSlot(opts = {}) {
  if (slots.size >= MAX_SLOTS) {
    return { ok: false, error: "harvest bank full", atCapacity: true, snapshot: pokemoncentreHarvestSnapshot() };
  }
  mintInflight += 1;
  try {
    const out = await harvestPokemonCentreSession(opts);
    if (!out.ok || !out.session) {
      return { ok: false, error: out.error || "harvest failed", ms: out.ms, snapshot: pokemoncentreHarvestSnapshot() };
    }
    const session = out.session;
    if (opts.ttlMs) session.edgeExpiresAt = Date.now() + Number(opts.ttlMs);
    slots.set(session.id, { session, meta: metaOf(session) });
    return {
      ok: true,
      session: metaOf(session),
      fullSession: session,
      ms: out.ms,
      snapshot: pokemoncentreHarvestSnapshot(),
    };
  } finally {
    mintInflight = Math.max(0, mintInflight - 1);
  }
}

export function takePokemonCentreHarvestSlot(id) {
  const key = String(id || "").trim();
  if (!key) return null;
  const row = slots.get(key);
  if (!row) return null;
  slots.delete(key);
  if (!isPcHarvestFresh(row.session)) {
    return { session: null, meta: row.meta, expired: true };
  }
  return { session: row.session, meta: row.meta };
}

export function peekPokemonCentreHarvestSlot(id) {
  const row = slots.get(String(id || "").trim());
  if (!row) return null;
  if (!isPcHarvestFresh(row.session)) {
    slots.delete(String(id || "").trim());
    return null;
  }
  return { meta: row.meta };
}

export function releasePokemonCentreHarvestSlot(id) {
  const key = String(id || "").trim();
  if (!slots.has(key)) return { ok: false, error: "not found" };
  slots.delete(key);
  return { ok: true, id: key, snapshot: pokemoncentreHarvestSnapshot() };
}

export function clearPokemonCentreHarvestSlots() {
  const n = slots.size;
  slots.clear();
  return { ok: true, cleared: n, snapshot: pokemoncentreHarvestSnapshot() };
}
