
# Kmart executor recovery plan

Goal: get back to a green cart chain (cart_get → cart_create → cart_atc → cart_verify hasSku=true), then re-enable checkout. Nothing about checkout, address, payment, or place-order gets touched until three consecutive runs show a verified cart.

Sticking to the executor. Not pivoting away from the flow. Not asking you to redo HAR work.

## What we actually know right now

- SBSD POST is fixed (`{"body": payload}`, HAR-accurate headers).
- PDP is passing.
- Regression is on the API host: `api_get_token` runs, then `cart_get` and `cart_create` return 403 from `api.kmart.com.au/gateway/graphql`.
- Before the HAR work we had a working chain all the way to place-order. So the regression is in one of: (a) the API seed step, (b) the cart headers, (c) cookie state being mutated by the newer SBSD/pixel steps between PDP and api_get_token.

## Plan (in order, one small change per step)

### 1. Freeze checkout, expose only the cart chain
- Force `task.checkout = false` in the executor for the duration of this bisect so the run always stops at `cart_verify`. Nothing past `cart_verify` runs, so we stop burning tokens on address/payment noise.
- Keep the `checkout_gate` step so we can still see whether cart passed.

### 2. Add a hard diagnostic dump around the API host
On `api_get_token`, `cart_get`, `cart_create`, capture and print into the trace:
- Full request headers actually sent (post-merge), in order
- Full `Cookie:` header actually sent
- Response status, `server`, `content-type`, `content-length`, `x-akamai-*`, `akamai-grn`
- Every `Set-Cookie` name from the response
- First 500 chars of the response body

This is the mechanical diff surface against HAR. Right now the 403 note doesn't tell us which of {missing cookie, wrong header, wrong order, wrong origin, wrong x-visitor-id} is the cause.

### 3. Add an executor-level `kmartMode` switch
Two modes, selectable per task:
- `cart-baseline`: run `warm_home → sensor → PDP → api_get_token → cart_get → cart_create → cart_atc → cart_verify` and STOP. No SBSD, no pixel, no proactive extras.
- `current`: the full pipeline we have today.

Purpose: bisect whether the regression is caused by an extra step we added around SBSD/pixel, or by something genuinely wrong at the API host.

### 4. Run the bisect
- Run once in `cart-baseline`. If cart passes → the regression is a side-effect from an SBSD/pixel step (most likely candidates: SBSD writing a same-name cookie into the jar, or the api-host sensor solve we already noted was overwriting parent `_abck`). Fix by scoping cookies to the correct host on write.
- Run once in `current`. Diff the cookie jar + header dump against the baseline run's dump. First diverging cookie/header is the culprit.

### 5. Fix the root cause found in step 4
Only one change at a time. After each change, re-run baseline + current and confirm `cart_verify hasSku=true` in both before moving on. Do not stack fixes.

### 6. Stability gate before checkout re-enables
Require three consecutive runs with `cart_verify hasSku=true` on the same account/IP before flipping `task.checkout` back on. Any regression resets the counter.

### 7. Re-enable checkout in the same order it originally worked
`checkout_warm → set_address → set_billing → refresh → paydock_tokenize → create3DSToken → placeOrder`. Do not re-touch the address/billing payload shape — those were HAR-accurate and are not the current failure.

## Technical detail (for the technical reviewer)

- Diagnostic dump lives inside `gqlPost` and around `api_get_token` in `executor/adapters/kmart.js` (~lines 959, 996, 1049, 1086). Emit as extra `steps.push({...})` entries prefixed `dbg:` so they show up in the trace UI without changing existing ok/fail gating.
- `kmartMode` read from `task.kmartMode` (default `"current"`), branch in `executor/adapters/kmart.js` around the SBSD and pixel blocks (~lines 425, 862) to skip them when `cart-baseline`.
- Force-checkout-off: at the top of the checkout block (~line 1266) short-circuit when `task.kmartMode === "cart-baseline"`.
- No schema changes, no new dependencies, no changes to `executor/http.js` or `server.js`.
- Nothing under `src/` changes.

## What I will NOT do

- No new anti-bot approach, no new library, no rewrite. The plumbing worked days ago; we're finding what changed.
- No touching auto-generated files.
- No touching address/payment/place-order code until the cart chain is verified green three runs in a row.

## What I need from you

Approve this plan and I'll implement steps 1–3 in a single pass (diagnostic dump + mode switch + checkout freeze) so your next redeploy gives us the bisect data in one run.
