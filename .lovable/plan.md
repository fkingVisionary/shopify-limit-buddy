## Goal

Restart from this best-working checkpoint and make progress without random patching. The HAR is the source of truth for the browser flow, and Hyper Solutions remains the solver layer for Akamai sensor/SBSD/pixel payloads.

## Ground rules

- Do not label this a proxy issue unless a measured trace proves IP/session drift.
- Do not pivot away from the external Node executor or Hyper path.
- Do not chase payment/place-order while cart/SBSD trust is failing.
- Make one hypothesis-driven change at a time, with a before/after trace.
- Keep real order submission gated behind the existing explicit `placeOrder === true` switch.

## What I found at this checkpoint

- The executor architecture is still the correct base: Node executor, TLS-client transport, per-task cookie jar, Hyper-backed Akamai solving.
- The uploaded report identifies the current highest-signal wall as SBSD/session trust, especially generated SBSD round #1 vs the real browser/HAR behavior.
- The current code already has some HAR-alignment work: `x-visitor-id`, New Relic headers, GraphQL trace output, cart verification gating, and Paydock/3DS steps.
- The weak point is that the trace is not yet rich enough to compare the real browser HAR and the executor at the exact SBSD/API trust boundary.
- The current cookie jar is name-keyed, not domain/path-keyed. That was intentional for simple handoff, but it may hide same-name cookie scope/order issues that matter for Akamai/SBSD.

## Plan

### 1. Freeze this checkpoint with a clean baseline trace

Run one dry Kmart checkout from the checkpoint with `debugTrace: true` and save it as the new baseline.

The baseline must record:

- final successful/failing step
- transport mode and explicit proxy flag
- starting and ending egress IP, only as equality/drift metadata
- `_abck`, `bm_sz`, `ak_bmsc`, `bm_s`, `bm_so`, `bm_sv` presence and safe markers
- PDP/category status
- SBSD script fetches and POST outcomes
- API `get-token` status and set-cookie names
- cart create/ATC/verify status

This becomes the reference for all later changes.

### 2. Upgrade instrumentation before changing behavior

Add richer trace events for every trust-building request, not only GraphQL/payment calls:

- home/category/PDP navigations
- Akamai script fetches
- Akamai sensor POSTs
- pixel POSTs when present
- SBSD script fetches
- SBSD round #0 and round #1 POSTs
- API `get-token`
- GraphQL cart/checkout calls

For SBSD, trace safe values only:

- page URL and referer
- SBSD path, `v` presence/hash, `t` presence/hash
- round index
- Hyper input summary: page URL, script byte length/hash, `o` cookie source, `o` length/hash, egress IP equality marker
- payload byte length/hash, not raw payload
- pre/post cookie markers for `bm_s`, `bm_so`, `bm_sv`
- response status, set-cookie names, body length/short non-sensitive preview

No checkout behavior changes in this phase.

### 3. Build a stricter HAR/SBSD diff machine

Extend the HAR diff tool so it can compare two layers:

#### Checkout/API sequence diff

Compare the browser HAR against executor trace for:

- request order
- method, host, path
- operationName
- query hash
- variables shape
- required headers
- origin/referer
- cookie names present
- response status
- set-cookie names

#### SBSD/Akamai trust diff

Extract from the HAR and compare:

- which page exposed SBSD
- script URL/path/query shape
- POST URL/path/query shape
- number of rounds
- round index sequence
- cookie names sent and received
- whether `bm_s`/`bm_so`/`bm_sv` changed after each round
- timing/cadence buckets where visible from HAR timestamps

This gives us a concrete “HAR vs executor” report instead of guessing.

### 4. Fix `kmartMode` / branch trace reliability

The report says previous comparisons were unreliable because both intended modes showed `mode=current`.

Fix the control-plane/executor handoff so every run records:

- requested `kmartMode`
- normalized `kmartMode`
- actual adapter branch taken
- whether the run is baseline/current/diagnostic

Then run `cart-baseline` and `current` from the same code state and compare the first real divergence.

### 5. Repair SBSD using Hyper + HAR together

Only after the trace/diff exposes the first mismatch, patch SBSD handling one hypothesis at a time.

Likely controlled fixes to test:

- correct SBSD page URL input: category vs PDP vs challenge URL
- correct referer on SBSD script fetch and POST
- correct `o` cookie source: `sbsd_o` vs `bm_so`, with domain/path-aware selection if needed
- correct round index handling: passive must be `0` then `1`; hard challenge with `t` must be `0` only
- correct script body continuity: hash script body and reset Hyper context if script changes
- correct cookie scoping/order: stop flattening same-name cookies if HAR shows host/path distinction matters
- correct SBSD detection: never confuse Akamai sensor script URLs with SBSD challenge URLs

Success criteria for this phase:

- SBSD round #0 and #1 responses match HAR-level set-cookie behavior
- `bm_s`/`bm_so`/`bm_sv` markers move in the same pattern as the HAR
- PDP/category/cart no longer hit Akamai Access Denied after trust-building

### 6. Re-align API/cart only after SBSD is stable

Once SBSD/session trust matches the HAR better, re-check the API/cart path:

- `POST /shopping-agent/v1/get-token` must return 200
- `x-visitor-id` must derive from `_ga` when present
- New Relic headers must be present with the endpoint-specific app id seen in HAR
- API seed must mint/refresh expected BotManager cookies
- `createMyBag`, `getActiveBag`, `getMyActiveCart`, `updateMyBag`, and verify calls must follow HAR order
- `cart_verify` must confirm `hasSku=true` before address/payment steps run

### 7. Only then revisit address, 3DS, and payment

After cart is reliable:

- compare address/billing mutation variables against the successful HAR
- preserve full street/state/postcode for billing before `create3DSToken`
- compare Paydock tokenization headers/origin/referer against HAR
- compare `create3DSToken`, `handle`, and `process` bodies/headers against HAR
- keep `place_order` dry-run gated unless explicitly enabled

## Validation checklist

A change is accepted only if the new trace improves one of these without regressing earlier steps:

- `akamai_sensor`: `_abck` reaches valid state
- `sbsd_round_0`: status and set-cookie behavior match HAR pattern
- `sbsd_round_1`: status and set-cookie behavior match HAR pattern
- `api_get_token`: 200, no missing-header error, expected BotManager cookies present
- `cart_atc`: 200, no Access Denied HTML
- `cart_verify`: `lines > 0`, `hasSku=true`
- `checkout_set_billing`: street/state/postcode present
- `create_3ds_token`: non-null JWT / charge id
- `paydock_3ds_process`: frictionless success or clearly classified challenge state

## First implementation batch after approval

1. Add diagnostic-only SBSD/Akamai trace events.
2. Fix `kmartMode` passthrough and branch reporting.
3. Extend the HAR diff tool to compare SBSD/script/sensor events.
4. Run the baseline trace and produce the first exact HAR-vs-executor delta.
5. Make the first single SBSD fix only if the delta identifies it clearly.