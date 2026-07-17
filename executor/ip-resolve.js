// Resolves the egress IPv4 for the current proxy. Hyper needs the IP that
// the target retailer actually sees so the generated sensor fingerprint
// stays consistent with the rest of the session.
//
// Memoised per-proxy for 5 minutes. Failures cache a null so we don't hammer
// ipify on every request when the proxy is down.
//
// Prefer the proxy hostname when it is already a public IPv4 (sticky ISP
// endpoints). Avoid undici ProxyAgent before a TLS Session in the same
// process — bogdanfinn CONNECT often 403s afterward even after destroyTLS.

import { makeDispatcher, createJar, request } from "./http.js";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const TTL_MS = 5 * 60 * 1000;
const cache = new Map(); // key = proxy string ("" for direct) → { ip, ts }

function ipv4FromProxyUrl(proxyUrl) {
  if (!proxyUrl) return null;
  try {
    const u = new URL(proxyUrl);
    if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(u.hostname)) return u.hostname;
  } catch {
    /* ignore */
  }
  return null;
}

function parseIpBody(body) {
  const text = String(body ?? "").trim();
  if (!text) return null;
  try {
    const j = JSON.parse(text);
    if (j?.ip && /^\d{1,3}(?:\.\d{1,3}){3}$/.test(j.ip)) return j.ip;
  } catch {
    /* plain text */
  }
  const m = text.match(/\b(\d{1,3}(?:\.\d{1,3}){3})\b/);
  return m?.[1] ?? null;
}

async function resolveViaCurl(proxyUrl) {
  if (!proxyUrl) return null;
  try {
    const { stdout } = await execFileAsync(
      "curl",
      ["-sS", "--max-time", "12", "-x", proxyUrl, "https://api.ipify.org"],
      { timeout: 15_000 },
    );
    return parseIpBody(stdout);
  } catch {
    return null;
  }
}

async function resolveViaUndici(proxyUrl) {
  const dispatcher = makeDispatcher(proxyUrl || null, { forceUndici: true });
  const jar = createJar();
  const resolveCtx = { dispatcher, jar };
  try {
    for (const url of [
      "https://api.ipify.org?format=json",
      "https://icanhazip.com",
      "https://ifconfig.me/ip",
    ]) {
      try {
        const res = await request(url, { method: "GET" }, resolveCtx);
        const ip = parseIpBody(await res.text());
        if (ip) return ip;
      } catch {
        /* next */
      }
    }
    return null;
  } finally {
    try {
      await dispatcher.close();
    } catch {
      /* ignore */
    }
  }
}

export async function resolveEgressIp(ctx, { force = false } = {}) {
  const key = ctx?.dispatcher?.proxy ?? "";
  if (!force) {
    const hit = cache.get(key);
    if (hit && Date.now() - hit.ts < TTL_MS) return hit.ip;
  }

  // Sticky ISP proxies expose the egress IP as the proxy host — no network hop.
  const fromHost = ipv4FromProxyUrl(key);
  if (fromHost) {
    cache.set(key, { ip: fromHost, ts: Date.now() });
    return fromHost;
  }

  // Prefer curl so we don't open undici ProxyAgent before a TLS Session.
  let ip = await resolveViaCurl(key);
  if (!ip && ctx?.dispatcher?.useTls !== true) {
    ip = await resolveViaUndici(key);
  }

  cache.set(key, { ip, ts: Date.now() });
  return ip;
}
