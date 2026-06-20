// Resolves the egress IPv4 for the current proxy. Hyper needs the IP that
// the target retailer actually sees so the generated sensor fingerprint
// stays consistent with the rest of the session.
//
// Memoised per-proxy for 5 minutes. Failures cache a null so we don't hammer
// ipify on every request when the proxy is down.

import { request } from "./http.js";

const TTL_MS = 5 * 60 * 1000;
const cache = new Map(); // key = proxy string ("" for direct) → { ip, ts }

export async function resolveEgressIp(ctx) {
  const key = ctx?.dispatcher ? ctx.dispatcher[Symbol.for("proxy-uri")] ?? "proxied" : "";
  const hit = cache.get(key);
  if (hit && Date.now() - hit.ts < TTL_MS) return hit.ip;

  try {
    const res = await request("https://api.ipify.org?format=json", { method: "GET" }, ctx);
    const body = await res.text();
    const ip = JSON.parse(body)?.ip ?? null;
    cache.set(key, { ip, ts: Date.now() });
    return ip;
  } catch {
    cache.set(key, { ip: null, ts: Date.now() });
    return null;
  }
}
