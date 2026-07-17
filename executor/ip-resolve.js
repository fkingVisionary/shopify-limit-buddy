// Resolves the egress IPv4 for the current proxy. Hyper needs the IP that
// the target retailer actually sees so the generated sensor fingerprint
// stays consistent with the rest of the session.
//
// Memoised per-proxy for 5 minutes on success only. Failures are not cached —
// sticky tunnels often recover, and some residential pools block a single
// IP-echo host (e.g. ipify) while Kmart still works.
//
// Endpoints are raced in parallel with a short per-request timeout so a
// dead residential tunnel fails in ~seconds instead of serial-minute burns.

import { request } from "./http.js";

const TTL_MS = 5 * 60 * 1000;
const cache = new Map(); // key = proxy string ("" for direct) → { ip, ts }

/** Ordered fallbacks — many resi providers block one or more of these. */
const IP_ENDPOINTS = [
  {
    url: "https://api.ipify.org?format=json",
    parse: (body) => {
      try {
        return JSON.parse(body)?.ip ?? null;
      } catch {
        return null;
      }
    },
  },
  {
    url: "https://api64.ipify.org?format=json",
    parse: (body) => {
      try {
        return JSON.parse(body)?.ip ?? null;
      } catch {
        return null;
      }
    },
  },
  {
    url: "https://icanhazip.com",
    parse: (body) => String(body || "").trim().split(/\s/)[0] || null,
  },
  {
    url: "https://ifconfig.me/ip",
    parse: (body) => String(body || "").trim().split(/\s/)[0] || null,
  },
  {
    url: "https://checkip.amazonaws.com",
    parse: (body) => String(body || "").trim().split(/\s/)[0] || null,
  },
  {
    url: "https://cloudflare.com/cdn-cgi/trace",
    parse: (body) => {
      const m = String(body || "").match(/^ip=([^\r\n]+)/m);
      return m?.[1]?.trim() || null;
    },
  },
];

function looksLikeIpv4(value) {
  return typeof value === "string" && /^\d{1,3}(?:\.\d{1,3}){3}$/.test(value);
}

function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timeout ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function probeEndpoint(ep, ctx, timeoutMs) {
  const res = await withTimeout(
    request(ep.url, { method: "GET" }, ctx),
    timeoutMs,
    ep.url,
  );
  if (!(res.status >= 200 && res.status < 400)) {
    throw new Error(`${ep.url} HTTP ${res.status}`);
  }
  const body = await res.text();
  const ip = ep.parse(body);
  if (!looksLikeIpv4(ip)) throw new Error(`${ep.url} bad body`);
  return ip;
}

export async function resolveEgressIp(ctx, { force = false, timeoutMs } = {}) {
  const key = ctx?.dispatcher?.proxy ?? "";
  if (!force) {
    const hit = cache.get(key);
    if (hit && hit.ip && Date.now() - hit.ts < TTL_MS) return hit.ip;
  }

  // Sticky residential CONNECT is slow; ISP is fast. Cap so dead tunnels
  // don't serial-burn ~70s × N endpoints before warm_home.
  const sticky = Boolean(ctx?.dispatcher?.sticky);
  const perTryMs = Number(timeoutMs) > 0 ? Number(timeoutMs) : sticky ? 8_000 : 12_000;

  const errors = [];
  const probes = IP_ENDPOINTS.map(async (ep) => {
    try {
      return await probeEndpoint(ep, ctx, perTryMs);
    } catch (e) {
      errors.push(`${ep.url} ${e?.message ?? e}`);
      throw e;
    }
  });

  try {
    const ip = await Promise.any(probes);
    cache.set(key, { ip, ts: Date.now() });
    if (ctx && typeof ctx === "object") ctx._ipResolveErrors = [];
    return ip;
  } catch {
    cache.delete(key);
    if (ctx && typeof ctx === "object") ctx._ipResolveErrors = errors.slice(0, 6);
    return null;
  }
}
