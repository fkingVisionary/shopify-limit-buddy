// Dedicated Bandai *monitor* proxy pool — separate from checkout resi.proxies.
// Owner supplies ISP + DC lists via env/files. Soft cooldowns on failure so we
// do not burn the whole pool on a bad exit.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseProxy } from "./http-undici.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * @param {string} raw
 * @returns {string[]} normalised proxy URLs
 */
export function parseMonitorProxyList(raw) {
  const out = [];
  for (const line of String(raw || "").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    for (const part of trimmed.split(",")) {
      const entry = part.trim();
      if (!entry || entry.startsWith("#")) continue;
      const url = parseProxy(entry);
      if (url) out.push(url);
    }
  }
  return out;
}

function readFileList(filePath) {
  try {
    return parseMonitorProxyList(fs.readFileSync(filePath, "utf8"));
  } catch {
    return [];
  }
}

/**
 * Load ISP / DC lists for the monitor only.
 *
 * ISP: BANDAI_MONITOR_ISP_PROXIES | BANDAI_MONITOR_ISP_FILE | monitor/isp.proxies
 * DC:  BANDAI_MONITOR_DC_PROXIES  | BANDAI_MONITOR_DC_FILE  | monitor/dc.proxies
 */
export function loadMonitorProxyLists(opts = {}) {
  const root = opts.rootDir || __dirname;
  let ispList = parseMonitorProxyList(opts.ispRaw || process.env.BANDAI_MONITOR_ISP_PROXIES || "");
  if (!ispList.length) {
    const ispFile = [
      opts.ispFile,
      process.env.BANDAI_MONITOR_ISP_FILE,
      path.join(root, "isp.proxies"),
    ].filter(Boolean);
    for (const f of ispFile) {
      const list = readFileList(f);
      if (list.length) {
        ispList = list;
        break;
      }
    }
  }

  let dcList = parseMonitorProxyList(opts.dcRaw || process.env.BANDAI_MONITOR_DC_PROXIES || "");
  if (!dcList.length) {
    const dcFile = [
      opts.dcFile,
      process.env.BANDAI_MONITOR_DC_FILE,
      path.join(root, "dc.proxies"),
    ].filter(Boolean);
    for (const f of dcFile) {
      const list = readFileList(f);
      if (list.length) {
        dcList = list;
        break;
      }
    }
  }

  return { isp: ispList, dc: dcList };
}

/**
 * Round-robin / random picker with ISP:DC ratio and per-URL cooldown.
 */
export function createMonitorProxyPool(opts = {}) {
  const loaded = loadMonitorProxyLists(opts);
  /** @type {string[]} */
  let isp = [...loaded.isp];
  /** @type {string[]} */
  let dc = [...loaded.dc];
  let ispRatio = clamp01(
    opts.ispRatio != null
      ? Number(opts.ispRatio)
      : process.env.BANDAI_MONITOR_ISP_RATIO != null
        ? Number(process.env.BANDAI_MONITOR_ISP_RATIO)
        : 0.8,
  );
  const mode = String(opts.rotateMode || process.env.BANDAI_MONITOR_ROTATE || "roundrobin")
    .toLowerCase()
    .replace(/[_-]/g, "");
  const random = mode === "random";
  const cooldownMs =
    Number(opts.cooldownMs || process.env.BANDAI_MONITOR_COOLDOWN_MS) || 5 * 60_000;

  /** @type {Map<string, number>} url → coolUntil */
  const coolUntil = new Map();
  let ispIdx = 0;
  let dcIdx = 0;
  let picks = 0;

  function available(list) {
    const now = Date.now();
    return list.filter((u) => (coolUntil.get(u) || 0) <= now);
  }

  function pickFrom(list, idxRef) {
    const live = available(list);
    if (!live.length) return null;
    if (random) {
      return live[Math.floor(Math.random() * live.length)];
    }
    const i = idxRef.value % live.length;
    idxRef.value += 1;
    return live[i];
  }

  function next() {
    picks += 1;
    const wantIsp = Math.random() < ispRatio;
    const ispRef = { value: ispIdx };
    const dcRef = { value: dcIdx };
    let url = null;
    let tier = null;
    if (wantIsp) {
      url = pickFrom(isp, ispRef);
      tier = "isp";
      if (!url) {
        url = pickFrom(dc, dcRef);
        tier = url ? "dc" : null;
      }
    } else {
      url = pickFrom(dc, dcRef);
      tier = "dc";
      if (!url) {
        url = pickFrom(isp, ispRef);
        tier = url ? "isp" : null;
      }
    }
    ispIdx = ispRef.value;
    dcIdx = dcRef.value;
    if (!url) {
      return { ok: false, error: "monitor_proxy_pool_exhausted", url: null, tier: null };
    }
    return { ok: true, url, tier, picks };
  }

  function markFail(url, ms = cooldownMs) {
    if (!url) return;
    coolUntil.set(url, Date.now() + Math.max(1_000, ms));
  }

  function markOk(url) {
    if (!url) return;
    coolUntil.delete(url);
  }

  /**
   * Hot-replace proxy lists (admin dashboard). Clears cooldowns.
   * @param {{ ispRaw?: string, dcRaw?: string, ispRatio?: number }} patch
   */
  function replaceLists(patch = {}) {
    if (patch.ispRaw != null) {
      isp = parseMonitorProxyList(patch.ispRaw);
    }
    if (patch.dcRaw != null) {
      dc = parseMonitorProxyList(patch.dcRaw);
    }
    if (patch.ispRatio != null && Number.isFinite(Number(patch.ispRatio))) {
      ispRatio = clamp01(Number(patch.ispRatio));
    }
    coolUntil.clear();
    ispIdx = 0;
    dcIdx = 0;
    return stats();
  }

  /** Drop soft cooldowns (watchdog / pool-exhausted recovery). */
  function clearCooldowns() {
    coolUntil.clear();
    return stats();
  }

  function stats() {
    return {
      isp: isp.length,
      dc: dc.length,
      ispRatio,
      rotateMode: random ? "random" : "roundrobin",
      cooldownMs,
      cooling: [...coolUntil.entries()].filter(([, t]) => t > Date.now()).length,
      picks,
    };
  }

  return {
    next,
    markFail,
    markOk,
    replaceLists,
    clearCooldowns,
    stats,
  };
}

function clamp01(n) {
  const x = Number(n);
  if (!Number.isFinite(x)) return 0.8;
  return Math.min(1, Math.max(0, x));
}
