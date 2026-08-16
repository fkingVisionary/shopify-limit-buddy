// Toymate CF + spam harvest pool (desktop main process).
// Pre-solves CapSolver CF clearance (+ optional checkout reCAPTCHA) on sticky
// proxies so checkout tasks can skip ~75s of warm/spam on the critical path.
//
// Mass-scale: parallel CapSolver mints (default 3) refill a larger bank (≤48).
// Claim at run-start (job-runner) — spam tokens only last ~100s.

const crypto = require("crypto");

const MAX_DESIRED = 48;
const MAX_PARALLEL = 8;
const DEFAULT_PARALLEL = 3;
const TICK_MS = 4_000;

/** @typedef {{
 *  id: string,
 *  proxy: string,
 *  proxyHost: string|null,
 *  userAgent: string,
 *  cookies: Record<string,string>,
 *  captchaToken: string|null,
 *  harvestedAt: number,
 *  cfExpiresAt: number,
 *  spamExpiresAt: number|null,
 *  cfNote?: string,
 *  spamNote?: string,
 * }} HarvestSession */

function now() {
  return Date.now();
}

function clampDesired(n) {
  return Math.max(0, Math.min(MAX_DESIRED, Number(n) || 0));
}

function clampParallel(n) {
  return Math.max(1, Math.min(MAX_PARALLEL, Number(n) || DEFAULT_PARALLEL));
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

function createHarvestPool({ sidecar, emit } = {}) {
  /** @type {HarvestSession[]} */
  let pool = [];
  let running = false;
  /** In-flight CapSolver harvests (parallel). */
  let inflight = 0;
  let refillPauseDepth = 0;
  let lastError = null;
  let solvedCount = 0;
  let failedCount = 0;
  let config = {
    proxyGroupId: null,
    desired: 2,
    parallel: DEFAULT_PARALLEL,
    solveSpam: true,
    /** Round-robin index into proxy group entries. */
    proxyCursor: 0,
  };
  let tickTimer = null;
  /** @type {null | (() => string[])} */
  let getEntriesFn = null;

  function snapshot() {
    const t = now();
    const fresh = pool.filter((s) => s.cfExpiresAt > t);
    const withSpam = fresh.filter(
      (s) => s.captchaToken && (!s.spamExpiresAt || s.spamExpiresAt > t),
    );
    return {
      running,
      busy: inflight > 0,
      inflight,
      refillPaused: refillPauseDepth > 0,
      lastError,
      solvedCount,
      failedCount,
      config: { ...config },
      ready: fresh.length,
      readyWithSpam: withSpam.length,
      sessions: fresh.map((s) => ({
        id: s.id,
        proxyHost: s.proxyHost,
        hasSpam: Boolean(s.captchaToken && (!s.spamExpiresAt || s.spamExpiresAt > t)),
        ageSec: Math.round((t - s.harvestedAt) / 1000),
        cfTtlSec: Math.max(0, Math.round((s.cfExpiresAt - t) / 1000)),
        spamTtlSec: s.spamExpiresAt
          ? Math.max(0, Math.round((s.spamExpiresAt - t) / 1000))
          : null,
        cfNote: s.cfNote || null,
        spamNote: s.spamNote || null,
      })),
    };
  }

  function publish() {
    emit?.({ type: "harvest", data: snapshot() });
  }

  function evictExpired() {
    const t = now();
    const before = pool.length;
    pool = pool.filter((s) => s.cfExpiresAt > t);
    return before - pool.length;
  }

  function pickProxy(entries) {
    const list = (entries || []).map((e) => String(e || "").trim()).filter(Boolean);
    if (!list.length) return null;
    const i = Math.abs(config.proxyCursor) % list.length;
    config.proxyCursor = i + 1;
    return toProxyUrl(list[i]);
  }

  async function harvestOne(entries) {
    if (!sidecar?.status?.().running) {
      lastError = "Start the engine first (Harvest needs CapSolver via local executor)";
      publish();
      return { ok: false, error: lastError };
    }
    const proxy = pickProxy(entries);
    if (!proxy) {
      lastError = "Pick a proxy group with sticky AU ISP/resi lines";
      publish();
      return { ok: false, error: lastError };
    }
    inflight += 1;
    publish();
    try {
      const res = await sidecar.harvestToymate({
        proxy,
        solveSpam: config.solveSpam !== false,
      });
      if (!res?.ok || !res.session) {
        failedCount += 1;
        lastError = res?.error || "harvest failed";
        publish();
        return { ok: false, error: lastError };
      }
      const s = res.session;
      /** @type {HarvestSession} */
      const row = {
        id: s.id || `hv_${crypto.randomBytes(4).toString("hex")}`,
        proxy: s.proxy || proxy,
        proxyHost: s.proxyHost || proxyHost(s.proxy || proxy),
        userAgent: s.userAgent || "",
        cookies: s.cookies || {},
        captchaToken: s.captchaToken || null,
        harvestedAt: s.harvestedAt || now(),
        cfExpiresAt: s.cfExpiresAt || now() + 25 * 60_000,
        spamExpiresAt: s.spamExpiresAt || (s.captchaToken ? now() + 100_000 : null),
        cfNote: s.cfNote,
        spamNote: s.spamNote,
      };
      pool.push(row);
      solvedCount += 1;
      lastError = null;
      publish();
      return { ok: true, session: row, ms: res.ms };
    } catch (e) {
      failedCount += 1;
      lastError = e?.message || String(e);
      publish();
      return { ok: false, error: lastError };
    } finally {
      inflight = Math.max(0, inflight - 1);
      publish();
    }
  }

  /**
   * Kick as many parallel CapSolver mints as needed to approach `desired`,
   * without exceeding `parallel` in-flight.
   */
  async function tick(getEntries) {
    if (!running || refillPauseDepth > 0) return;
    evictExpired();
    const desired = clampDesired(config.desired);
    const parallel = clampParallel(config.parallel);
    const fresh = pool.filter((s) => s.cfExpiresAt > now());
    const need = desired - fresh.length - inflight;
    if (need <= 0) {
      publish();
      return;
    }
    const slots = Math.min(need, parallel - inflight);
    if (slots <= 0) {
      publish();
      return;
    }
    const entries =
      typeof getEntries === "function"
        ? getEntries()
        : typeof getEntriesFn === "function"
          ? getEntriesFn()
          : [];
    const launches = [];
    for (let i = 0; i < slots; i++) {
      launches.push(harvestOne(entries));
    }
    await Promise.allSettled(launches);
  }

  function start({ proxyGroupId, desired, parallel, solveSpam, getEntries } = {}) {
    if (proxyGroupId) config.proxyGroupId = proxyGroupId;
    if (desired != null) config.desired = clampDesired(desired);
    if (parallel != null) config.parallel = clampParallel(parallel);
    if (solveSpam != null) config.solveSpam = Boolean(solveSpam);
    if (typeof getEntries === "function") getEntriesFn = getEntries;
    running = true;
    lastError = null;
    publish();
    if (tickTimer) clearInterval(tickTimer);
    // Kick immediately, then refill on a short interval (spam ~100s TTL).
    void tick(getEntriesFn);
    tickTimer = setInterval(() => {
      void tick(getEntriesFn);
    }, TICK_MS);
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
    if (patch.desired != null) config.desired = clampDesired(patch.desired);
    if (patch.parallel != null) config.parallel = clampParallel(patch.parallel);
    if (patch.solveSpam != null) config.solveSpam = Boolean(patch.solveSpam);
    publish();
    return snapshot();
  }

  function pauseRefill() {
    refillPauseDepth += 1;
    publish();
    return snapshot();
  }

  function resumeRefill() {
    refillPauseDepth = Math.max(0, refillPauseDepth - 1);
    publish();
    return snapshot();
  }

  /**
   * Claim one session for a checkout task. Prefer sessions with spam token.
   * Removes from pool (single-use — sticky proxy must match task).
   */
  function take({ preferSpam = true } = {}) {
    evictExpired();
    const t = now();
    let idx = -1;
    if (preferSpam) {
      idx = pool.findIndex(
        (s) =>
          s.cfExpiresAt > t &&
          s.captchaToken &&
          (!s.spamExpiresAt || s.spamExpiresAt > t),
      );
    }
    if (idx < 0) {
      idx = pool.findIndex((s) => s.cfExpiresAt > t);
    }
    if (idx < 0) return null;
    const [session] = pool.splice(idx, 1);
    publish();
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
    pauseRefill,
    resumeRefill,
    MAX_DESIRED,
    MAX_PARALLEL,
    DEFAULT_PARALLEL,
  };
}

module.exports = {
  createHarvestPool,
  toProxyUrl,
  proxyHost,
  MAX_DESIRED,
  MAX_PARALLEL,
  DEFAULT_PARALLEL,
  TICK_MS,
};
