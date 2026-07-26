// Disney Akamai + CapSolver harvest pool (desktop main process).
// Mirrors Toymate: serializable jar + captcha TTL, desktop-owned bank.
// Empty bank → Disney checkout cold-starts (warm + CapSolver on path).

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
  let config = {
    proxyGroupId: null,
    desired: 2,
    solveCaptcha: true,
    proxyCursor: 0,
  };
  let tickTimer = null;

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

  function snapshot() {
    const t = now();
    const fresh = pool.filter((s) => isFresh(s, t));
    const withCaptcha = fresh.filter((s) => hasCaptcha(s, t));
    return {
      running,
      busy,
      lastError,
      solvedCount,
      failedCount,
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
    const fresh = pool.filter((s) => isFresh(s));
    if (fresh.length >= desired) {
      publish();
      return;
    }
    const entries = typeof getEntries === "function" ? getEntries() : [];
    await harvestOne(entries);
  }

  function start({ proxyGroupId, desired, solveCaptcha, getEntries } = {}) {
    if (proxyGroupId) config.proxyGroupId = proxyGroupId;
    if (desired != null) config.desired = Math.max(0, Math.min(12, Number(desired) || 0));
    if (solveCaptcha != null) config.solveCaptcha = Boolean(solveCaptcha);
    running = true;
    lastError = null;
    publish();
    if (tickTimer) clearInterval(tickTimer);
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
    if (patch.solveCaptcha != null) config.solveCaptcha = Boolean(patch.solveCaptcha);
    publish();
    return snapshot();
  }

  /** Claim one session for checkout. Prefer captcha-ready. Single-use. */
  function take({ preferCaptcha = true } = {}) {
    evictExpired();
    const t = now();
    let idx = -1;
    if (preferCaptcha) {
      idx = pool.findIndex((s) => isFresh(s, t) && hasCaptcha(s, t));
    }
    if (idx < 0) idx = pool.findIndex((s) => isFresh(s, t));
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
  createDisneyHarvestPool,
  toProxyUrl,
  proxyHost,
};
