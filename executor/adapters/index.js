// Adapter registry. Pick by hostname; return null when nothing matches so
// the caller can fall back to the legacy generic-Shopify chain in checkout.js.
//
// Checkout path: kmart (raw HTTP) + toymate (BigCommerce/CF) + bandai (p-bandai)
// + kmart-playwright (opt-in via kmartMode="playwright" in checkout.js).
// Lab/recon modules live under ../experiments/ and are mounted as separate HTTP endpoints.
//
// Adding a store = new adapter file + push here. Do not change kmartAdapter.

import { kmartAdapter } from "./kmart.js";
import { toymateAdapter } from "./toymate.js";
import { bandaiAdapter } from "./bandai.js";

const ADAPTERS = [kmartAdapter, toymateAdapter, bandaiAdapter];

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
