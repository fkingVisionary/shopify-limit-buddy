// Checkout residential proxy pool — same load/parse shape as ef84707
// `executor/monitor/proxies.cjs` (isp.proxies), but for /run sticky resi.
// Prefer a list (file / env / request body) over a single PROXY_URL_RESI secret.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseProxy } from "./http.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Parse a multiline / comma-separated proxy list into normalised URLs.
 * Accepts: http(s)://…, host:port:user:pass, user:pass:host:port, host:port.
 * Comments (#…) are stripped per line before comma-splitting so doc commas
 * in resi.proxies headers never become fake entries.
 */
export function parseProxyList(raw) {
  const entries = [];
  for (const line of String(raw || "").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    for (const part of trimmed.split(",")) {
      const entry = part.trim();
      if (!entry || entry.startsWith("#")) continue;
      const url = parseProxy(entry);
      // Only keep lines that parse as real proxies (reject prose leftovers).
      if (url) entries.push(url);
    }
  }
  return entries;
}

function readProxyFile(filePath) {
  try {
    return parseProxyList(fs.readFileSync(filePath, "utf8"));
  } catch {
    return [];
  }
}

/**
 * Load baked / env residential entries (not per-request body).
 * Order: PROXY_RESI_LIST → PROXY_URL_RESI (single) → resi.proxies file candidates.
 */
export function loadResiEntries() {
  const fromListEnv = parseProxyList(process.env.PROXY_RESI_LIST || "");
  if (fromListEnv.length) return fromListEnv;

  const single = String(process.env.PROXY_URL_RESI || "").trim();
  if (single) {
    const one = parseProxyList(single);
    if (one.length) return one;
  }

  const candidates = [
    process.env.PROXY_RESI_FILE,
    path.join(__dirname, "resi.proxies"),
    path.join(__dirname, "isp.proxies"),
  ].filter(Boolean);

  for (const file of candidates) {
    const list = readProxyFile(file);
    if (list.length) return list;
  }
  return [];
}

let cachedEntries = null;
let rrIndex = 0;

export function resiPoolSize() {
  if (cachedEntries == null) cachedEntries = loadResiEntries();
  return cachedEntries.length;
}

export function refreshResiPoolCache() {
  cachedEntries = loadResiEntries();
  rrIndex = 0;
  return cachedEntries.length;
}

/**
 * Round-robin pick from a concrete list (request body) or the baked pool.
 * @param {string[]|null|undefined} overrideEntries
 * @returns {{ proxy: string|null, source: string, index: number, poolSize: number }}
 */
export function pickResiProxy(overrideEntries = null) {
  const fromBody = Array.isArray(overrideEntries)
    ? overrideEntries.map((e) => String(e || "").trim()).filter(Boolean).map((e) => parseProxy(e) || e).filter(Boolean)
    : [];
  if (fromBody.length) {
    const index = rrIndex % fromBody.length;
    rrIndex += 1;
    return { proxy: fromBody[index], source: "request", index, poolSize: fromBody.length };
  }

  if (cachedEntries == null) cachedEntries = loadResiEntries();
  if (!cachedEntries.length) {
    return { proxy: null, source: "none", index: -1, poolSize: 0 };
  }
  const index = rrIndex % cachedEntries.length;
  rrIndex += 1;
  const source = process.env.PROXY_RESI_LIST
    ? "env:PROXY_RESI_LIST"
    : process.env.PROXY_URL_RESI
      ? "env:PROXY_URL_RESI"
      : "file:resi.proxies";
  return { proxy: cachedEntries[index], source, index, poolSize: cachedEntries.length };
}

/**
 * Resolve proxy for /run and diagnose helpers.
 * Precedence: explicit proxy string → proxies[]/proxyEntries[] → baked pool → null.
 */
export function resolveRunProxy({ proxy, proxies, proxyEntries, useProxy } = {}) {
  const explicit = typeof proxy === "string" && proxy.trim() ? proxy.trim() : null;
  if (explicit) {
    return {
      proxy: parseProxy(explicit) || explicit,
      source: "request.proxy",
      index: 0,
      poolSize: 1,
    };
  }

  const list =
    (Array.isArray(proxies) && proxies.length ? proxies : null) ||
    (Array.isArray(proxyEntries) && proxyEntries.length ? proxyEntries : null);

  if (list) {
    return pickResiProxy(list);
  }

  // Same gate as the old PROXY_URL_RESI path: only when useProxy:true.
  if (useProxy === true) {
    const picked = pickResiProxy(null);
    if (picked.proxy) return picked;
    return { proxy: null, source: "useProxy_empty_pool", index: -1, poolSize: 0 };
  }

  return { proxy: null, source: useProxy === false ? "direct" : "none", index: -1, poolSize: resiPoolSize() };
}
