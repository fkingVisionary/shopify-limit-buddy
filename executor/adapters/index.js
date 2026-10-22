// Adapter registry. Pick by hostname; return null when nothing matches so
// the caller can fall back to the generic Shopify chain (runShopify) in
// checkout.js — the same implementation the shopifyAdapter wraps.
//
// Checkout path: kmart (raw HTTP) + toymate (BigCommerce/CF) + bandai (p-bandai)
// + pokemoncentre (TPCI Incapsula/DD/Cortex/GE)
// + disney (SFCC AUNZ + Akamai + GE 1696)
// + shopify (generic *.myshopify.com ATC + checkout handoff, no payment)
// + kmart-playwright (opt-in via kmartMode="playwright" in checkout.js).
// Lab/recon modules live under ../experiments/ and are mounted as separate HTTP endpoints.
//
// Adding a store = new adapter file + push here. Do not change kmartAdapter.

import { kmartAdapter } from "./kmart.js";
import { toymateAdapter } from "./toymate.js";
import { bandaiAdapter } from "./bandai.js";
import { pokemoncentreAdapter } from "./pokemoncentre.js";
import { disneyAdapter } from "./disney.js";
import { shopifyAdapter } from "./shopify.js";

const ADAPTERS = [
  kmartAdapter,
  toymateAdapter,
  bandaiAdapter,
  pokemoncentreAdapter,
  disneyAdapter,
  // Generic Shopify (*.myshopify.com) stays LAST so dedicated retailer
  // adapters above always win first. Custom-domain Shopify stores fall through
  // to the same runShopify() path via checkout.js's fallback branch.
  shopifyAdapter,
];

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
