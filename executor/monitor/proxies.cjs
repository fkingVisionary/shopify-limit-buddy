// AU ISP rotation for global detect — separate from checkout proxies.
// Protects the fleet: round-robin among healthy exits, cooldown on blocks/errors,
// min reuse gap so we don't hammer the same IP.

const fs = require("fs");
const path = require("path");

function parseProxyList(raw) {
  return String(raw || "")
    .split(/[\n,]/)
    .map((s) => s.trim())
    .filter((s) => s && !s.startsWith("#"))
    .map((entry) => {
      if (/^https?:\/\//i.test(entry)) return entry;
      const parts = entry.split(":");
      if (parts.length >= 4) {
        const [host, port, user, ...passParts] = parts;
        const pass = passParts.join(":");
        return `http://${encodeURIComponent(user)}:${encodeURIComponent(pass)}@${host}:${port}`;
      }
      if (parts.length === 2) return `http://${parts[0]}:${parts[1]}`;
      return entry;
    })
    .filter(Boolean);
}

function loadIspEntries() {
  const fromEnv = parseProxyList(process.env.MONITOR_ISP_PROXIES || process.env.PROXY_URL_ISP || "");
  if (fromEnv.length) return fromEnv;

  const file =
    process.env.MONITOR_ISP_FILE ||
    path.join(__dirname, "..", "isp.proxies");
  try {
    const fromFile = parseProxyList(fs.readFileSync(file, "utf8"));
    if (fromFile.length) return fromFile;
  } catch {
    /* optional */
  }

  // Fly already has checkout resi — use it so monitor isn't stuck on direct/Akamai.
  const resi = String(process.env.MONITOR_FALLBACK_PROXY || process.env.PROXY_URL_RESI || "").trim();
  return resi ? [resi] : [];
}

/**
 * Soft rotation pool.
 * - next() prefers exits not in cooldown and past minReuseMs
 * - reportResult() cools blocked/failed exits
 */
class IspPool {
  /**
   * @param {string[]} entries
   * @param {{ cooldownMs?: number; minReuseMs?: number }} [opts]
   */
  constructor(entries = [], opts = {}) {
    this.entries = (entries.length ? entries : [null]).map((url) => ({
      url,
      coolUntil: 0,
      lastUsed: 0,
      ok: 0,
      fail: 0,
      blocked: 0,
    }));
    this.i = 0;
    this.cooldownMs = Math.max(15_000, Number(opts.cooldownMs) || Number(process.env.MONITOR_ISP_COOLDOWN_MS) || 90_000);
    // Faster reuse for monitor cadence (was 45s — too slow vs Zephyr-style loops).
    this.minReuseMs = Math.max(1_000, Number(opts.minReuseMs) || Number(process.env.MONITOR_ISP_MIN_REUSE_MS) || 5_000);
  }

  size() {
    return this.entries.filter((e) => e.url).length;
  }

  /** @returns {string | null} */
  next() {
    const now = Date.now();
    const n = this.entries.length;
    if (!n) return null;

    // Prefer healthy + cooled-down + past min reuse
    for (let attempt = 0; attempt < n; attempt++) {
      const idx = (this.i + attempt) % n;
      const row = this.entries[idx];
      if (!row.url) {
        this.i = (idx + 1) % n;
        return null;
      }
      if (row.coolUntil > now) continue;
      if (now - row.lastUsed < this.minReuseMs) continue;
      this.i = (idx + 1) % n;
      row.lastUsed = now;
      return row.url;
    }

    // Fallback: least-recently-used among non-cooled (ignore min reuse to avoid stall)
    let best = null;
    for (const row of this.entries) {
      if (!row.url) continue;
      if (row.coolUntil > now) continue;
      if (!best || row.lastUsed < best.lastUsed) best = row;
    }
    if (best) {
      best.lastUsed = now;
      return best.url;
    }

    // Everything cooled — still rotate (soft) so we keep trying slowly
    const row = this.entries[this.i % n];
    this.i = (this.i + 1) % n;
    if (row) row.lastUsed = now;
    return row?.url || null;
  }

  /**
   * @param {string | null} proxyUrl
   * @param {{ ok?: boolean; blocked?: boolean; softFail?: boolean }} result
   */
  reportResult(proxyUrl, result = {}) {
    if (!proxyUrl) return;
    const row = this.entries.find((e) => e.url === proxyUrl);
    if (!row) return;
    if (result.ok) {
      row.ok += 1;
      row.coolUntil = 0;
      return;
    }
    if (result.blocked) {
      row.blocked += 1;
      row.fail += 1;
      // Longer cool on Akamai / 403
      row.coolUntil = Date.now() + this.cooldownMs * 2;
      return;
    }
    if (result.softFail) {
      row.fail += 1;
      row.coolUntil = Date.now() + Math.floor(this.cooldownMs / 2);
      return;
    }
    row.fail += 1;
    row.coolUntil = Date.now() + this.cooldownMs;
  }

  stats() {
    const now = Date.now();
    return {
      total: this.size(),
      available: this.entries.filter((e) => e.url && e.coolUntil <= now).length,
      cooled: this.entries.filter((e) => e.url && e.coolUntil > now).length,
      cooldownMs: this.cooldownMs,
      minReuseMs: this.minReuseMs,
    };
  }
}

function createIspPoolFromEnv() {
  return new IspPool(loadIspEntries());
}

module.exports = { parseProxyList, loadIspEntries, IspPool, createIspPoolFromEnv };
