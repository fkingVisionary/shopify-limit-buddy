## Goal
Get the Kmart executor back to the previous working milestone first: PDP passes, API seed passes, cart read/create/add-to-cart passes, then resume checkout/place-order work only after cart is stable.

## Current read of the failure
The screenshot shows the API/cart layer is now blocked:
- `cart_get` is 403 from `api.kmart.com.au/gateway/graphql`.
- `cart_create` is also 403, so `cartId=null` and `cart_atc` is skipped.
- This is not a product/SKU issue yet; it is an API-host anti-bot/session issue before cart creation.

## Plan

### 1. Stop changing the whole flow at once
Freeze checkout/payment/place-order work until cart is green again. The only target is:
```text
warm_home -> sensor solve -> PDP 200 -> api_get_token -> cart_get -> cart_create -> cart_probe1 -> cart_probe2 -> cart_atc -> cart_verify
```
No address, Paydock, 3DS, or `placeOrder` changes until that exact chain passes repeatedly.

### 2. Make the next run produce useful evidence
Tighten `debugTrace` for failing API requests so it returns, per GraphQL step:
- exact operation name
- request header names/order
- cookie names sent
- response status/body snippet
- Set-Cookie names
- whether `api_get_token` actually seeded `ak_bmsc` / `bm_sv`

This avoids judging from the UI’s narrow mobile table only.

### 3. Compare current executor trace to the HAR mechanically
Use the existing `executor/scripts/har-diff.mjs` loop as the source of truth:
1. Run `/run` with `debugTrace: true`.
2. Save the returned JSON.
3. Diff it against the HAR.
4. Fix only the first red delta on `seed` or `cart_get_initial`.

No more guessing headers/payloads from memory. If `cart_get_initial` is 403, the first diff target is whichever of these diverges from HAR:
- API seed cookies missing/wrong host
- GraphQL request header set/order
- visitor/session identity mismatch
- request body/query hash mismatch
- cookie names sent to `api.kmart.com.au`

### 4. Add a controlled recovery switch to bisect the regression
Add an executor-side mode flag for Kmart, for example `kmartMode`, with two paths:
- `current`: today’s full Akamai/SBSD path
- `cart-baseline`: minimal path that skips risky recent additions and uses only the proven HAR cart sequence

The point is not to ship two permanent flows; it is to identify whether the HAR-era SBSD/header changes poisoned the API session. Once the baseline gets cart green, merge only the winning pieces back.

### 5. Treat API host as a separate anti-bot boundary
Right now we solve the storefront (`www.kmart.com.au`) and then assume cookies transfer cleanly to `api.kmart.com.au`. The 403 on `gateway/graphql` means the API boundary must be validated independently:
- ensure `/shopping-agent/v1/get-token` is called before GraphQL
- ensure it returns/sets the same cookie names as HAR
- ensure GraphQL sends the same identity headers as HAR (`x-visitor-id`, New Relic headers if present, cache headers, referer/origin, sec-fetch values)
- ensure the cookie jar is not overwriting parent-domain cookies with API-scoped bad values

### 6. Restore cart before checkout
Once `cart_create` returns an id again:
- verify `cart_probe1` and `cart_probe2` match HAR order
- only then attempt `cart_atc`
- require 3 consecutive successful `cart_verify hasSku=true` runs on fresh proxy sessions before touching address/payment/place-order again

## Implementation sequence after approval
1. Patch trace output to expose the failing API seed/cart details clearly.
2. Patch or add a baseline/bisect mode for Kmart cart only.
3. Run one debug trace through the executor.
4. Use the HAR diff output to make a single targeted cart/API fix.
5. Repeat until `cart_verify` is stable, then resume checkout/place-order from the last known good payment code.

## Non-goals for this pass
- No UI redesign.
- No payment/place-order edits.
- No new anti-bot guesses unless backed by the trace-vs-HAR diff.
- No broad rewrites of the adapter.