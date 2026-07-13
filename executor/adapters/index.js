// Adapter registry. Pick by hostname; return null when nothing matches so
// the caller can fall back to the legacy generic-Shopify chain in checkout.js.
//
// Checkout path only: kmart (raw HTTP) + kmart-playwright (opt-in via
// kmartMode="playwright" in checkout.js). Lab/recon modules live under
// ../experiments/ and are mounted as separate HTTP endpoints.

import { kmartAdapter } from "./kmart.js";

const ADAPTERS = [kmartAdapter];

export function pickAdapter(storeUrl) {
  let host;
  try {
    host = new URL(storeUrl).hostname.toLowerCase();
  } catch {
    return null;
  }
  for (const a of ADAPTERS) if (a.matches(host)) return a;
  return null;
}
