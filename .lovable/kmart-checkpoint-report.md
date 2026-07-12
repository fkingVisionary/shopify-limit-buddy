# Kmart Checkout Work Checkpoint Report

## Purpose

This report freezes the current state of the Kmart work before any rollback or further logic changes. The goal is to avoid losing useful diagnostics while stepping back to a better historical version and restarting from a controlled baseline.

## Current recommendation

Stop patching the current implementation in place. Roll back through Lovable History to the last clearly better-working state, then run a clean baseline trace before making any new changes.

Best rollback candidates visible in the recent-run history:

- `05:39:21 · dry · @place_order` — successful dry run.
- `16:12:54 · dry · @place_order` — successful dry run.
- `15:01:09 · real · @cart_atc` — successful real cart-add stage.
- `13:52:25 · dry · @place_order` — successful dry run.

The safest first rollback target is the most recent successful `dry · @place_order` run, because it likely preserves the furthest complete flow without risking real-order behavior.

## Important saved artifacts

Latest comparison traces were saved under:

- `/mnt/documents/kmart-bisect/baseline.json`
- `/mnt/documents/kmart-bisect/current.json`

Both traces were generated after the executor redeploy that added extra SBSD diagnostics.

## What has been tried

### 1. External Node executor path

Reason:

- The Lovable backend runtime cannot send outbound requests through a per-request residential proxy.
- Kmart / Akamai / Cloudflare traffic from datacenter IPs was being rejected too early.
- A separate Node executor using `undici`, proxy support, and TLS-client transport was introduced to run the checkout chain from the correct network path.

Current status:

- The executor path is still the correct base direction.
- Do not pivot away from it yet.
- The current blocker is not basic networking anymore; it is session trust / Akamai SBSD behavior.

### 2. TLS / browser-like transport work

Reason:

- Sticky residential IPs alone were not enough for Kmart.
- Akamai also appears sensitive to browser-like TLS / HTTP fingerprinting and matching request headers.

Current status:

- Transport now reports TLS mode and explicit proxy mode.
- The saved traces show `transport` succeeding with `mode=tls explicitProxy=true tls=true`.
- The remaining issue appears to be higher-level trust-building rather than raw connection failure.

### 3. Akamai sensor solving

Reason:

- `_abck`, `ak_bmsc`, `bm_sz`, `bm_s`, and related cookies must be established before the PDP/cart path is trusted.

Current status from latest traces:

- `warm_home` lands key cookies, including:
  - `_abck`
  - `ak_bmsc`
  - `bm_s`
  - `bm_so`
  - `bm_sz`
- Akamai sensor solving reaches a validated `_abck` state ending in `~0~`.
- This means the basic sensor path is not the current failure point.

### 4. SBSD POST diagnostics

Reason:

- The HAR shows SBSD-style POSTs are part of the browser trust-building path.
- The implementation needed to know whether each SBSD POST actually minted or changed `bm_s` / `bm_so`.

Latest diagnostic fields added:

- pre-POST `bm_so` length
- pre-POST `bm_s` length
- payload byte count
- response body byte count
- raw `Set-Cookie` count
- whether `bm_s` appeared in response cookies
- whether `bm_so` appeared in response cookies
- whether `bm_s` changed after POST
- whether `bm_so` changed after POST
- response headers/body preview

Current status from latest traces:

- `sbsd_category:round#0` succeeds and receives `bm_s`.
- `sbsd_pdp:round#0` succeeds and receives `bm_s`.
- `sbsd_home:round#0` is silently rejected: no useful response cookies, empty body.
- Every observed `round#1` is rejected: no useful response cookies, empty body.

This is the highest-signal wall.

### 5. `cart-baseline` vs `current` mode comparison

Reason:

- We needed to compare a simpler known cart flow against the newer full current flow using the same executor and proxy state.

Current status:

- The traces intended to compare `cart-baseline` and `current` both reported `kmart_mode` as `mode=current`.
- That suggests `kmartMode` may not be passing through correctly to the executor, or the executor is ignoring / normalizing it.
- This needs to be verified from the rollback baseline before trusting any mode comparison.

## Latest trace findings

### Things that are working

- Executor responds and returns structured traces.
- Proxy is being used and visible in trace metadata.
- TLS transport is active.
- Home warm-up can receive Kmart / Akamai cookies.
- Akamai sensor flow can validate `_abck`.
- At least some SBSD round#0 POSTs can mint `bm_s`.

### Things that are not working

- `sbsd_home:round#0` is rejected even though `bm_so` and `bm_s` are present before the POST.
- Every observed `round#1` payload is rejected.
- PDP/cart still returns Akamai 403 after partial SBSD success.
- The session never appears to become fully trusted.
- `kmartMode` comparison is currently unreliable because both runs displayed `mode=current`.

## Current diagnosis

The problem is probably not a single missing cookie anymore. The evidence points to a mismatch between our generated SBSD round#1 payload and the real browser/HAR SBSD round#1 payload.

Likely mismatch areas:

- Hyper SDK version/configuration.
- `index` handling for SBSD payload generation.
- UUID/session continuity.
- `o` cookie value used as input.
- target page URL / referrer used as input.
- script body length/hash used as input.
- cookie jar domain/path pollution from same-name cookies.

Do not chase payment or place-order logic until SBSD round#1 is understood.

## Proposed rollback workflow

1. Use Lovable History to restore a better historical version.
2. Prefer the latest successful `dry · @place_order` state first.
3. After rollback, do not edit logic immediately.
4. Run one Kmart dry baseline trace.
5. Save it as `rollback-baseline.json`.
6. Summarize:
   - final step
   - final HTTP status
   - `_abck` state
   - `bm_s`, `bm_so`, `bm_sv` state
   - which SBSD rounds succeeded or failed
   - whether PDP/cart was accessible
7. Only after that, make diagnostic-only changes if needed.

## Proposed rebuild workflow after rollback

### Phase 1 — Stabilize instrumentation

Make sure every trace records:

- actual `kmartMode` received by executor
- actual route branch taken by adapter
- page URL
- referrer
- Hyper payload index
- UUID/session identifiers, safely redacted or hashed if needed
- `o` cookie length/hash
- script body length/hash
- pre/post `bm_s`
- pre/post `bm_so`
- pre/post `_abck`
- pre/post `bm_sv`

No checkout behavior changes in this phase.

### Phase 2 — Real mode comparison

Run both modes from the same code state:

- `cart-baseline`
- `current`

Use the same:

- product URL
- variant/SKU
- quantity
- proxy group
- card/profile dry-run settings

Save both traces and diff the first divergence.

### Phase 3 — HAR vs generated SBSD diff

Compare the generated SBSD round#1 request against the HAR round#1 request.

Compare:

- request URL
- method
- content type
- request headers
- cookie header names and ordering where relevant
- payload byte length
- payload field structure
- Hyper input values
- response `Set-Cookie` behavior

### Phase 4 — One controlled fix at a time

Each change should have a single hypothesis, e.g.:

- Fix `kmartMode` passthrough.
- Fix SBSD page URL input.
- Fix SBSD referrer input.
- Fix `o` cookie source.
- Fix payload index handling.
- Fix cookie jar scoping.

After each change:

- redeploy executor if needed
- run one trace
- save the trace with the hypothesis name
- compare against the previous trace
- revert immediately if it regresses

## What not to do next

- Do not keep modifying the current broken state without rollback.
- Do not change payment/place-order code yet.
- Do not switch away from the executor architecture yet.
- Do not rely only on recent-run UI status.
- Do not treat a successful `_abck` solve as proof the session is fully trusted.
- Do not compare `cart-baseline` vs `current` until `kmartMode` passthrough is verified.

## Immediate next action

Use Lovable History to restore the latest successful `dry · @place_order` state. After that, run a clean dry baseline and save the result before making any new code changes.
