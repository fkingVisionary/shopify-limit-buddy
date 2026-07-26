// Bandai F5 harvest pool (desktop main process).
// Metadata bank only — live Playwright bridges live in the executor sidecar.
// Arm before a drop; Autocheckout claims one slot (sticky proxy + bridge id).
// Empty bank → Bandai checkout cold-starts (unchanged).

const crypto = require("crypto");

/** @typedef {{
 *  id: string,
 *  proxy: string,
 *  proxyHost: string|null,
 *  area: string,
 *  harvestedAt: number,
 *  expiresAt: number,
 *  note?: string,
 * }} HarvestMeta */

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

function createBandaiHarvestPool({ sidecar, emit } = {}) {
  /** @type {HarvestMeta[]} */
  let pool = [];
  let running = false;
  let busy = false;
  let lastError = null;
  let solvedCount = 0;
  let failedCount = 0;
  let config = {
    proxyGroupId: null,
    desired: 2,
    area: "au",
    proxyCursor: 0,
  };
  let tickTimer = null;

  function snapshot() {
    const t = now();
    const fresh = pool.filter((s) => s.expiresAt > t);
    return {
      running,
      busy,
      lastError,
      solvedCount,
      failedCount,
      config: { ...config },
      ready: fresh.length,
      sessions: fresh.map((s) => ({
        id: s.id,
        proxyHost: s.proxyHost,
        area: s.area,
        ageSec: Math.round((t - s.harvestedAt) / 1000),
        ttlSec: Math.max(0, Math.round((s.expiresAt - t) / 1000)),
        note: s.note || null,
      })),
    };
  }

  function publish() {
    emit?.({ type: "bandaiHarvest", data: snapshot() });
  }

  function evictExpired() {
    const t = now();
    const before = pool.length;
    pool = pool.filter((s) => s.expiresAt > t);
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
      lastError = "Start the engine first (Harvest needs local executor Playwright)";
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
      const res = await sidecar.harvestBandai({
        proxy,
        area: config.area || "au",
      });
      if (!res?.ok || !res.session) {
        failedCount += 1;
        lastError = res?.error || "harvest failed";
        publish();
        return { ok: false, error: lastError };
      }
      const s = res.session;
      /** @type {HarvestMeta} */
      const row = {
        id: s.id || `bf5_${crypto.randomBytes(4).toString("hex")}`,
        proxy: s.proxy || proxy,
        proxyHost: s.proxyHost || proxyHost(s.proxy || proxy),
        area: s.area || config.area || "au",
        harvestedAt: s.harvestedAt || now(),
        expiresAt: s.expiresAt || now() + 6 * 60_000,
        note: s.note,
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
    const desired = Math.max(0, Math.min(6, Number(config.desired) || 0));
    const fresh = pool.filter((s) => s.expiresAt > now());
    if (fresh.length >= desired) {
      publish();
      return;
    }
    const entries = typeof getEntries === "function" ? getEntries() : [];
    await harvestOne(entries);
  }

  function start({ proxyGroupId, desired, area, getEntries } = {}) {
    if (proxyGroupId) config.proxyGroupId = proxyGroupId;
    if (desired != null) config.desired = Math.max(0, Math.min(6, Number(desired) || 0));
    if (area) config.area = String(area).toLowerCase().slice(0, 2);
    running = true;
    lastError = null;
    publish();
    if (tickTimer) clearInterval(tickTimer);
    void tick(getEntries);
    // Chromium mint is slow — refill slower than Toymate CapSolver ticks.
    tickTimer = setInterval(() => {
      void tick(getEntries);
    }, 12_000);
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

  async function clear() {
    pool = [];
    try {
      if (sidecar?.status?.().running && sidecar.clearBandaiHarvest) {
        await sidecar.clearBandaiHarvest();
      }
    } catch {
      /* ignore — local metadata still cleared */
    }
    publish();
    return snapshot();
  }

  function configure(patch = {}) {
    if (patch.proxyGroupId != null) config.proxyGroupId = patch.proxyGroupId;
    if (patch.desired != null) config.desired = Math.max(0, Math.min(6, Number(patch.desired) || 0));
    if (patch.area != null) config.area = String(patch.area).toLowerCase().slice(0, 2);
    publish();
    return snapshot();
  }

  /**
   * Claim one warm bridge id for a Bandai checkout task (single-use).
   * Sticky proxy on the session must be used for the run.
   */
  function take() {
    evictExpired();
    const t = now();
    const idx = pool.findIndex((s) => s.expiresAt > t);
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
  createBandaiHarvestPool,
  toProxyUrl,
  proxyHost,
};
