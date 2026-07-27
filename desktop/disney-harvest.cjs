// Disney Akamai + CapSolver harvest pool (desktop main process).
// Mirrors Toymate: serializable jar + captcha TTL, desktop-owned bank.
// Empty bank → Disney checkout cold-starts (warm + CapSolver on path).
//
// Drop pressure: when armed, refill faster while bank < desired; after each
// claim, mint immediately. take() refuses near-expiry captcha (cold fallback).

const crypto = require("crypto");

/** @typedef {{
 *  id: string,
 *  proxy: string,
 *  proxyHost: string|null,
 *  userAgent: string,
 *  cookies: Record<string,string>,
 *  captchaToken: string|null,
 *  harvestedAt: number,
 *  abckExpiresAt: number,
 *  captchaExpiresAt: number|null,
 *  egressIp?: string|null,
 *  warmNote?: string,
 *  captchaNote?: string,
 * }} DisneyHarvestSession */

const TICK_IDLE_MS = 8_000;
const TICK_PRESSURE_MS = 3_000;
/** Refuse claim if captcha dies sooner than this (checkout needs headroom). */
const DEFAULT_MIN_CAPTCHA_TTL_MS = 15_000;

function now() {
  return Date.now();
}

function proxyHost(raw) {
  try {
    if (/^https?:\/\//i.test(raw)) return new URL(raw).hostname;
    return String(raw).split(":")[0] || null;
  } catch {
    return null;
  }
}

function toProxyUrl(raw) {
  if (!raw) return null;
  if (/^https?:\/\//i.test(raw)) return raw;
  const parts = String(raw).split(":");
  if (parts.length >= 4) {
    const [host, port, user, ...pass] = parts;
    return `http://${encodeURIComponent(user)}:${encodeURIComponent(pass.join(":"))}@${host}:${port}`;
  }
  return raw;
}

function createDisneyHarvestPool({ sidecar, emit } = {}) {
  /** @type {DisneyHarvestSession[]} */
  let pool = [];
  let running = false;
  let busy = false;
  let lastError = null;
  let solvedCount = 0;
  let failedCount = 0;
  let claimedCount = 0;
  let rejectedStaleCount = 0;
  let config = {
    proxyGroupId: null,
    desired: 2,
    solveCaptcha: true,
    /** Faster refill while bank below desired (drop pressure). */
    dropPressure: true,
    /** Minimum captcha TTL remaining to allow claim (ms). */
    minCaptchaTtlMs: DEFAULT_MIN_CAPTCHA_TTL_MS,
    proxyCursor: 0,
  };
  let tickTimer = null;
  /** @type {null | (() => string[])} */
  let getEntriesFn = null;

  function isFresh(s, t = now()) {
    if (!s || Number(s.abckExpiresAt) <= t) return false;
    const abck = s.cookies?._abck || "";
    return /~0~/.test(String(abck));
  }

  function hasCaptcha(s, t = now()) {
    return Boolean(
      s.captchaToken && (!s.captchaExpiresAt || Number(s.captchaExpiresAt) > t),
    );
  }

  function captchaTtlMs(s, t = now()) {
    if (!s?.captchaToken) return 0;
    if (s.captchaExpiresAt == null) return Number.POSITIVE_INFINITY;
    return Number(s.captchaExpiresAt) - t;
  }

  function snapshot() {
    const t = now();
    const fresh = pool.filter((s) => isFresh(s, t));
    const withCaptcha = fresh.filter((s) => hasCaptcha(s, t));
    const desired = Math.max(0, Math.min(12, Number(config.desired) || 0));
    const underPressure =
      Boolean(config.dropPressure) && running && fresh.length < desired;
    return {
      running,
      busy,
      lastError,
      solvedCount,
      failedCount,
      claimedCount,
      rejectedStaleCount,
      underPressure,
      config: { ...config },
      ready: fresh.length,
      readyWithCaptcha: withCaptcha.length,
      sessions: fresh.map((s) => ({
        id: s.id,
        proxyHost: s.proxyHost,
        hasCaptcha: hasCaptcha(s, t),
        ageSec: Math.round((t - s.harvestedAt) / 1000),
        abckTtlSec: Math.max(0, Math.round((Number(s.abckExpiresAt) - t) / 1000)),
        captchaTtlSec: s.captchaExpiresAt
          ? Math.max(0, Math.round((Number(s.captchaExpiresAt) - t) / 1000))
          : null,
        warmNote: s.warmNote || null,
        captchaNote: s.captchaNote || null,
      })),
    };
  }

  function publish() {
    emit?.({ type: "disneyHarvest", data: snapshot() });
  }

  function evictExpired() {
    const t = now();
    const before = pool.length;
    pool = pool.filter((s) => isFresh(s, t));
    return before - pool.length;
  }

  function pickProxy(entries) {
    const list = (entries || []).map((e) => String(e || "").trim()).filter(Boolean);
    if (!list.length) return null;
    const i = Math.abs(config.proxyCursor) % list.length;
    config.proxyCursor = i + 1;
    return toProxyUrl(list[i]);
  }

  function rescheduleTick() {
    if (!running) return;
    if (tickTimer) clearInterval(tickTimer);
    const snap = snapshot();
    const ms = snap.underPressure ? TICK_PRESSURE_MS : TICK_IDLE_MS;
    tickTimer = setInterval(() => {
      void tick(getEntriesFn);
    }, ms);
  }

  async function harvestOne(entries) {
    if (!sidecar?.status?.().running) {
      lastError = "Start the engine first (Harvest needs Hyper + CapSolver via local executor)";
      publish();
      return { ok: false, error: lastError };
    }
    const proxy = pickProxy(entries);
    if (!proxy) {
      lastError = "Pick a proxy group with sticky AU ISP/resi lines";
      publish();
      return { ok: false, error: lastError };
    }
    busy = true;
    publish();
    try {
      // bank:false — desktop owns the serializable blob (Toymate-shaped).
      const res = await sidecar.harvestDisney({
        proxy,
        solveCaptcha: config.solveCaptcha !== false,
        bank: false,
      });
      if (!res?.ok || !res.session) {
        failedCount += 1;
        lastError = res?.error || "harvest failed";
        publish();
        return { ok: false, error: lastError };
      }
      const s = res.session;
      /** @type {DisneyHarvestSession} */
      const row = {
        id: s.id || `dhv_${crypto.randomBytes(4).toString("hex")}`,
        proxy: s.proxy || proxy,
        proxyHost: s.proxyHost || proxyHost(s.proxy || proxy),
        userAgent: s.userAgent || "",
        cookies: s.cookies || {},
        captchaToken: s.captchaToken || null,
        harvestedAt: s.harvestedAt || now(),
        abckExpiresAt: s.abckExpiresAt || now() + 3 * 60_000,
        captchaExpiresAt:
          s.captchaExpiresAt || (s.captchaToken ? now() + 100_000 : null),
        egressIp: s.egressIp || null,
        warmNote: s.warmNote,
        captchaNote: s.captchaNote,
        captchaSitekey: s.captchaSitekey || null,
        captchaAction: s.captchaAction || "AddToCart",
        pdpUrl: s.pdpUrl || null,
        origin: s.origin || "https://www.disneystore.com.au",
      };
      if (!isFresh(row)) {
        failedCount += 1;
        lastError = "harvested session missing valid _abck ~0~";
        publish();
        return { ok: false, error: lastError };
      }
      pool.push(row);
      solvedCount += 1;
      lastError = null;
      publish();
      rescheduleTick();
      return { ok: true, session: row, ms: res.ms };
    } catch (e) {
      failedCount += 1;
      lastError = e?.message || String(e);
      publish();
      return { ok: false, error: lastError };
    } finally {
      busy = false;
      publish();
      rescheduleTick();
    }
  }

  async function tick(getEntries) {
    if (!running || busy) return;
    evictExpired();
    const desired = Math.max(0, Math.min(12, Number(config.desired) || 0));
    const fresh = pool.filter((s) => isFresh(s));
    if (fresh.length >= desired) {
      publish();
      rescheduleTick();
      return;
    }
    const entries =
      typeof getEntries === "function"
        ? getEntries()
        : typeof getEntriesFn === "function"
          ? getEntriesFn()
          : [];
    await harvestOne(entries);
  }

  function start({ proxyGroupId, desired, solveCaptcha, dropPressure, getEntries } = {}) {
    if (proxyGroupId) config.proxyGroupId = proxyGroupId;
    if (desired != null) config.desired = Math.max(0, Math.min(12, Number(desired) || 0));
    if (solveCaptcha != null) config.solveCaptcha = Boolean(solveCaptcha);
    if (dropPressure != null) config.dropPressure = Boolean(dropPressure);
    if (typeof getEntries === "function") getEntriesFn = getEntries;
    running = true;
    lastError = null;
    publish();
    if (tickTimer) clearInterval(tickTimer);
    void tick(getEntriesFn);
    rescheduleTick();
    return snapshot();
  }

  function stop() {
    running = false;
    if (tickTimer) {
      clearInterval(tickTimer);
      tickTimer = null;
    }
    publish();
    return snapshot();
  }

  function clear() {
    pool = [];
    publish();
    return snapshot();
  }

  function configure(patch = {}) {
    if (patch.proxyGroupId != null) config.proxyGroupId = patch.proxyGroupId;
    if (patch.desired != null) config.desired = Math.max(0, Math.min(12, Number(patch.desired) || 0));
    if (patch.solveCaptcha != null) config.solveCaptcha = Boolean(patch.solveCaptcha);
    if (patch.dropPressure != null) config.dropPressure = Boolean(patch.dropPressure);
    if (patch.minCaptchaTtlMs != null) {
      config.minCaptchaTtlMs = Math.max(0, Number(patch.minCaptchaTtlMs) || 0);
    }
    publish();
    rescheduleTick();
    return snapshot();
  }

  function kickRefill() {
    if (running && config.dropPressure) {
      void Promise.resolve().then(() => {
        if (running) void tick(getEntriesFn);
      });
    }
    rescheduleTick();
  }

  /**
   * Claim one session for checkout. Prefer captcha-ready with TTL headroom.
   * Single-use. Returns session | null — null → caller cold-paths (never throws).
   * Near-expiry captcha sessions are discarded (not claimed) so checkout does not
   * burn a half-dead token; bank refills under drop pressure.
   * @param {{ preferCaptcha?: boolean, requireCaptcha?: boolean }} [opts]
   */
  function take({ preferCaptcha = true, requireCaptcha = false } = {}) {
    evictExpired();
    const t = now();
    const minTtl = Math.max(0, Number(config.minCaptchaTtlMs) || 0);

    // Evict captcha-too-short rows (keep warm-only jars).
    const kept = [];
    for (const s of pool) {
      if (!isFresh(s, t)) continue;
      if (hasCaptcha(s, t) && captchaTtlMs(s, t) < minTtl) {
        rejectedStaleCount += 1;
        continue;
      }
      kept.push(s);
    }
    if (kept.length !== pool.length) {
      pool = kept;
      publish();
      kickRefill();
    }

    let idx = -1;
    if (preferCaptcha || requireCaptcha) {
      idx = pool.findIndex((s) => isFresh(s, t) && hasCaptcha(s, t));
    }
    if (idx < 0 && !requireCaptcha) {
      idx = pool.findIndex((s) => isFresh(s, t));
    }
    if (idx < 0) {
      publish();
      return null;
    }
    const [session] = pool.splice(idx, 1);
    claimedCount += 1;
    publish();
    kickRefill();
    return session;
  }

  return {
    snapshot,
    start,
    stop,
    clear,
    configure,
    take,
    harvestOne,
    /** @internal test helper */
    _pool: () => pool,
    _pushForTest(row) {
      pool.push(row);
      publish();
    },
  };
}

module.exports = {
  createDisneyHarvestPool,
  toProxyUrl,
  proxyHost,
  TICK_IDLE_MS,
  TICK_PRESSURE_MS,
  DEFAULT_MIN_CAPTCHA_TTL_MS,
};
