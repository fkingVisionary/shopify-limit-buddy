// Adapter registry. Pick by hostname; return null when nothing matches so
// the caller can fall back to the legacy generic-Shopify chain in checkout.js.

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
