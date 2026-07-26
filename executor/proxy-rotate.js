// Helpers for rotating ISP/resi exits when GraphQL cart_get is Akamai-denied.
// get-token can succeed while api GraphQL is Ghost-denied on a burnt exit —
// rotating to another pool line is the consumer-facing recovery path.

import { pickResiProxy, resiPoolSize } from "./proxy-pool.js";

export function proxyHostFromUrl(raw) {
  const s = String(raw || "").trim();
  if (!s) return "";
  try {
    const u = new URL(/^[a-z]+:\/\//i.test(s) ? s : `http://${s}`);
    return String(u.hostname || "").toLowerCase();
  } catch {
    return s.split(":")[0].toLowerCase();
  }
}

/** True when warm/token cleared but every GraphQL cart_get profile was Akamai-denied. */
export function isGraphqlAkamaiWall(result) {
  if (!result || result.ok) return false;
  const steps = [...(result.steps || []), ...(result.lastSteps || [])];
  if (steps.some((s) => s && s.step === "cart_get:all_profiles_denied")) return true;
  const cart = [...steps].reverse().find((s) => s && s.step === "cart_get");
  if (
    cart &&
    cart.ok === false &&
    /all_denied|AkamaiGHost|Access Denied/i.test(String(cart.note || ""))
  ) {
    return true;
  }
  const blob = [result.failedStep, result.error, result.checkoutStage]
    .filter(Boolean)
    .join(" ");
  return /cart_get:all_profiles_denied|all_profiles_denied/i.test(blob);
}

/**
 * Pick next pool/list proxy skipping already-tried hosts.
 * Returns null proxy when the pool is exhausted.
 */
export function pickUnusedResiProxy(excludeHosts = [], overrideEntries = null) {
  const tried = new Set(
    [...excludeHosts].map((h) => String(h || "").toLowerCase()).filter(Boolean),
  );
  const poolSize = overrideEntries?.length || resiPoolSize();
  if (!poolSize) {
    return { proxy: null, source: "none", index: -1, poolSize: 0 };
  }
  if (tried.size >= poolSize) {
    return { proxy: null, source: "pool_exhausted", index: -1, poolSize };
  }
  // Round-robin advances each pick — scan up to one full cycle for a fresh host.
  for (let i = 0; i < poolSize; i++) {
    const picked = pickResiProxy(overrideEntries);
    if (!picked.proxy) return picked;
    const host = proxyHostFromUrl(picked.proxy);
    if (!host || !tried.has(host)) return picked;
  }
  return { proxy: null, source: "pool_exhausted", index: -1, poolSize };
}
