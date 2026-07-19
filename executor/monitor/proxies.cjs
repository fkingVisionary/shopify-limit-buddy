// AU ISP rotation for global detect — separate from checkout proxies.
// Round-robin healthy exits; cool blocked ones briefly; never stall on one IP.

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

function readProxyFile(filePath) {
  try {
    return parseProxyList(fs.readFileSync(filePath, "utf8"));
  } catch {
    return [];
  }
}

function loadIspEntries() {
  const fromEnv = parseProxyList(process.env.MONITOR_ISP_PROXIES || process.env.PROXY_URL_ISP || "");
  if (fromEnv.length) return fromEnv;

  // Deployed with the image: executor/isp.proxies (edit → commit → redeploy).
  const candidates = [
    process.env.MONITOR_ISP_FILE,
    path.join(__dirname, "..", "isp.proxies"),
    path.join(__dirname, "isp.proxies"),
    path.join(__dirname, "..", "..", "monitor", "isp.proxies"),
  ].filter(Boolean);

  for (const file of candidates) {
    const list = readProxyFile(file);
    if (list.length) return list;
  }

  const resi = String(process.env.MONITOR_FALLBACK_PROXY || process.env.PROXY_URL_RESI || "").trim();
  return resi ? [resi] : [];
}

/**
 * Soft rotation pool.
 * - next() prefers exits not in cooldown and past minReuseMs
 * - on block: cool THAT exit only, immediately use another
 * - if all cooled: pick the soonest-to-uncool (keep moving)
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
    // With a real fleet, short cooldowns — rotate away instead of parking.
    const fleet = this.size();
    const defaultCool = fleet >= 5 ? 25_000 : 90_000;
    this.cooldownMs = Math.max(
      5_000,
      Number(opts.cooldownMs) || Number(process.env.MONITOR_ISP_COOLDOWN_MS) || defaultCool,
    );
    this.minReuseMs = Math.max(
      500,
      Number(opts.minReuseMs) || Number(process.env.MONITOR_ISP_MIN_REUSE_MS) || (fleet >= 5 ? 1500 : 5_000),
    );
  }

  size() {
    return this.entries.filter((e) => e.url).length;
  }

  /** @returns {string | null} */
  next() {
    const now = Date.now();
    const usable = this.entries.filter((e) => e.url);
    const n = usable.length;
    if (!n) return null;

    // 1) Healthy + past min reuse (round-robin from this.i)
    for (let attempt = 0; attempt < n; attempt++) {
      const idx = (this.i + attempt) % n;
      const row = usable[idx];
      if (row.coolUntil > now) continue;
      if (now - row.lastUsed < this.minReuseMs) continue;
      this.i = (idx + 1) % n;
      row.lastUsed = now;
      return row.url;
    }

    // 2) Any not cooled (ignore min reuse — keep the loop alive)
    let bestReady = null;
    for (const row of usable) {
      if (row.coolUntil > now) continue;
      if (!bestReady || row.lastUsed < bestReady.lastUsed) bestReady = row;
    }
    if (bestReady) {
      bestReady.lastUsed = now;
      const idx = usable.indexOf(bestReady);
      this.i = (idx + 1) % n;
      return bestReady.url;
    }

    // 3) All cooled — pick soonest-to-uncool (don't hammer the same one forever)
    let soonest = usable[0];
    for (const row of usable) {
      if (row.coolUntil < soonest.coolUntil) soonest = row;
    }
    soonest.lastUsed = now;
    // Clear a sliver of cooldown so the next call can try a different exit too
    soonest.coolUntil = Math.min(soonest.coolUntil, now + Math.floor(this.cooldownMs / 4));
    const idx = usable.indexOf(soonest);
    this.i = (idx + 1) % n;
    return soonest.url;
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
      // Cool only this exit. Fleet ≥5 → shorter park so rotation stays useful.
      const mult = this.size() >= 5 ? 1 : 2;
      row.coolUntil = Date.now() + this.cooldownMs * mult;
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
