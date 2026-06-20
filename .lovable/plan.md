
# Hyper Solutions integration — Kmart-only, HTTP-first

**Pivot 2026-06-20**: Hyper account is whitelisted for **Kmart AU only**. Shopify
not yet approved (likely because most Shopify stores aren't Akamai-fronted —
they're CF or unprotected, so Hyper has nothing to solve). Scope narrowed to
Kmart for this batch; Shopify generic + JB Hi-Fi are deferred until Hyper
greenlights those domains.

## Goal

Drop Browserless from the production checkout path. All retailer requests go through Fly executor (Node + undici), with Hyper Solutions API solving Akamai / SBSD / Incapsula / DataDome / Kasada challenges inline. Browserless stays in the codebase but only runs in recon mode for reverse-engineering new retailers.

First batch covers:
- **JB Hi-Fi** (Akamai)
- **Shopify-generic** adapter (Akamai/CF in front of any Shopify store)

## Why HTTP-only

Per Hyper's own benchmarks: 6 network requests vs 281, 0.3s vs 5.46s, 340KB vs 6.5MB, no headless detection surface, vendor patches handled by Hyper. There's no reason to keep Browserless in the hot path once Hyper covers the antibot layer.

## Architecture

```
TanStack server fn (enqueueCheckout)
  └─ insert checkout_jobs row
       └─ request_checkout_worker → POST Fly executor /run
            └─ executor/checkout.js
                 ├─ adapters/jbhifi.js
                 ├─ adapters/shopify.js
                 └─ antibot.js  ──► hyper-sdk-js (Akamai / SBSD / Incap / DD / Kasada)
                                    ↑
                                    HYPER_API_KEY (Fly secret)

Browserless path: only invoked by recon.functions.ts for reverse-engineering.
                  Removed from run-checkout edge function entirely.
```

## Files

### New
- `executor/antibot.js` — wraps `hyper-sdk-js`. Single `solve(vendor, input)` interface returning `{ cookieUpdates, headerUpdates, postBack? }`. Handles Akamai sensor + SBSD + pixel, Incapsula Reese84/UTMVC, DataDome interstitial, Kasada TL/CD/POW.
- `executor/ip-resolve.js` — resolves egress IP per proxy via `api.ipify.org`, memoised 5 min. Required by Hyper for fingerprint consistency.
- `executor/adapters/jbhifi.js` — JB checkout chain (custom React stack, not Shopify).
- `executor/adapters/shopify.js` — generic Shopify chain (cart/add.js → /cart redirect → checkout token → GraphQL submit).
- `executor/adapters/index.js` — picks adapter by hostname.

### Changed
- `executor/package.json` — add `hyper-sdk-js`.
- `executor/checkout.js` — replace inline Shopify-ish logic with `adapters.pick(task.storeUrl).run(task, ctx)`. Adds `resolve_ip`, `akamai_sensor`, `akamai_sbsd`, `akamai_pixel`, `incap_reese84`, `dd_interstitial`, `kasada_tl` steps to the timeline.
- `supabase/functions/run-checkout/index.ts` — **remove** Browserless call from production path. Keep only the Fly dispatch. Browserless code moves to recon-only.
- `src/lib/recon.functions.ts` — owns the Browserless-driven recon (unchanged behaviour, just becomes its only caller).
- `src/lib/checkout-jobs.functions.ts` — surface new step diagnostics from `result.steps`.

### No schema migration
Steps land in existing `checkout_jobs.result` JSONB.

## Secrets

- `HYPER_API_KEY` — added once user has Hyper approval. Header is `x-api-key`. Lives in Fly executor env + Supabase secrets (for parity if any server fn ever needs it).
- `BROWSERLESS_API_KEY` — kept (recon only).

## Adapter contract

```ts
interface Adapter {
  id: string;                // "jbhifi" | "shopify-generic"
  matches(url: URL): boolean;
  run(task, ctx): Promise<{ ok, steps, finalUrl, cookies }>;
}
```

Each adapter:
1. `warmHome()` — GET homepage, ingest cookies.
2. `solveAntibotIfPresent()` — scan response for vendor markers, call `antibot.solve()`, POST sensor payload back to the captured URL, repeat on rotation.
3. `addToCart()` — retailer-specific.
4. `beginCheckout()` — capture checkout token / URL.
5. `submitOrder()` — gated behind `task.dryRun === false`; not in this batch.

Dry-run mode returns `ok:true` once the checkout page renders without 403/challenge.

## JB Hi-Fi notes

- Primarily Akamai. `_abck` cookie must contain `~0~` after sensor POST.
- Cart endpoint TBD via recon (probably a Next.js API route under `/api/cart`).
- For this batch: get to PDP → cart → checkout-loaded state without 403. Order submission is a follow-up batch.

## Shopify-generic notes

- Existing `executor/checkout.js` logic already covers the happy path. Move it into `adapters/shopify.js` and wrap each request in the antibot scan so CF/Akamai-fronted Shopify stores work without changes.

## Browserless removal

`supabase/functions/run-checkout/index.ts` currently invokes Browserless. After this batch:
- Production: edge function only inserts/updates the job + pings Fly. No Browserless call.
- Recon: `src/lib/recon.functions.ts` keeps its Browserless usage for capturing real request shapes when authoring a new adapter.
- `BROWSERLESS_API_KEY` stays in secrets.

## Acceptance

1. `executor/checkout.js` dry-run against `jbhifi.com.au/products/...` returns `ok:true`, with `akamai_sensor` step present and `_abck` containing `~0~`.
2. `executor/checkout.js` dry-run against any Shopify store with Akamai/CF in front returns `ok:true`, with `cart_add` succeeding.
3. `supabase/functions/run-checkout/index.ts` no longer references `BROWSERLESS_API_KEY` in the production code path.
4. `recon.functions.ts` still works end-to-end with Browserless.
5. Missing `HYPER_API_KEY` → executor returns `antibot_misconfigured` step error; no silent fallback to raw requests.

## Status

Blocked on Hyper API approval. When key arrives:
1. `add_secret HYPER_API_KEY` (Supabase + Fly).
2. `bun add hyper-sdk-js` inside `executor/`.
3. Ship all files in one batch.
4. Run dry-run against JB PDP URL provided earlier to validate.
