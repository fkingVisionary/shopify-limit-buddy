// Toymate CF + spam harvest pool (desktop main process).
// Pre-solves CapSolver CF clearance (+ optional checkout reCAPTCHA) on sticky
// proxies so checkout tasks can skip ~75s of warm/spam on the critical path.

const crypto = require("crypto");

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
  let busy = false;
  let lastError = null;
  let solvedCount = 0;
  let failedCount = 0;
  let config = {
    proxyGroupId: null,
    desired: 2,
    solveSpam: true,
    /** Round-robin index into proxy group entries. */
    proxyCursor: 0,
  };
  let tickTimer = null;

  function snapshot() {
    const t = now();
    const fresh = pool.filter((s) => s.cfExpiresAt > t);
    const withSpam = fresh.filter(
      (s) => s.captchaToken && (!s.spamExpiresAt || s.spamExpiresAt > t),
    );
    return {
      running,
      busy,
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
    busy = true;
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
      busy = false;
      publish();
    }
  }

  async function tick(getEntries) {
    if (!running || busy) return;
    evictExpired();
    const desired = Math.max(0, Math.min(12, Number(config.desired) || 0));
    const fresh = pool.filter((s) => s.cfExpiresAt > now());
    if (fresh.length >= desired) {
      publish();
      return;
    }
    const entries = typeof getEntries === "function" ? getEntries() : [];
    await harvestOne(entries);
  }

  function start({ proxyGroupId, desired, solveSpam, getEntries } = {}) {
    if (proxyGroupId) config.proxyGroupId = proxyGroupId;
    if (desired != null) config.desired = Math.max(0, Math.min(12, Number(desired) || 0));
    if (solveSpam != null) config.solveSpam = Boolean(solveSpam);
    running = true;
    lastError = null;
    publish();
    if (tickTimer) clearInterval(tickTimer);
    // Kick immediately, then refill on an interval.
    void tick(getEntries);
    tickTimer = setInterval(() => {
      void tick(getEntries);
    }, 8_000);
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
    if (patch.solveSpam != null) config.solveSpam = Boolean(patch.solveSpam);
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
  };
}

module.exports = {
  createHarvestPool,
  toProxyUrl,
  proxyHost,
};
