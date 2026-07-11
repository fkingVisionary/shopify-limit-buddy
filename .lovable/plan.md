
## Where we actually are

You are right — the HAR has everything. The failure is not "we don't know what to send." From your screenshot:

- `api_get_token` ✅  → BM seed works
- `cart_get` / `cart_create` / `cart_probe1` / `cart_probe2` all **200** → `_abck` is validated, GraphQL host accepts our jar
- `cart_atc` (the `updateMyBag` mutation with `addLineItem`) **403 Access Denied — Reference 18.24f10f17…** → Akamai
- `cart_verify` returns cart with `lineItems: []` → confirms ATC never mutated
- `checkout_gate` correctly stops before address/payment

So four consecutive `POST /gateway/graphql` succeed and the fifth — the mutation carrying `addLineItem` — is scored as a bot. This is a **mutation-scoped scoring problem**, not "we forgot a header". The last two turns have been guessing at headers; we need to stop guessing and measure.

## The plan: instrument, diff, eliminate — in that order

### 1. Turn `har-diff.mjs` into a byte-level diff (not a checklist)

Today the diff prints "MATCH / DELTA" per golden step. Extend it so for every one of the 12 golden requests it prints:

- header set delta (present/absent AND value shape — e.g. `traceparent` present but wrong length)
- cookie name delta on the request (which names were sent, which HAR sent that we didn't, and vice-versa)
- request body delta as a structured JSON patch (missing keys, extra keys, type changes) — not string compare
- normalized GraphQL `query` hash (whitespace-collapsed) so wording drift shows up
- response status + set-cookie name delta

Output one screen per step, red/green only on real differences. This is the source of truth for the next four sub-tasks; no code change to `kmart.js` happens without a diff line pointing at it.

### 2. One clean measured run

Do a single `/run` with `debugTrace:true` against SKU `43664474` (the capybara URL you sent), then run `har-diff.mjs www.kmart.com.au.har_1.json --json run.json`. Save the report. Everything below refers to that report.

### 3. Eliminate the cart_atc 403 — one variable per attempt

Ordered by cheapness × likelihood. After each change we re-run and re-diff; we do NOT stack two changes in one attempt.

1. **Body byte-identity.** Rebuild the `updateMyBag` body so `JSON.stringify` produces the exact key order and whitespace as HAR entry #368 (browser emits `{"operationName":…,"variables":…,"query":…}` with no spaces and a trailing `\n` inside the query string). Diff will show whether content-length now matches 1315.
2. **Request cadence.** Real HAR has ≥30 s of PDP/analytics activity between `createMyBag` (#343) and `updateMyBag` (#368). We fire the whole 4-call GraphQL burst in <1 s. Insert a jittered 800–1500 ms sleep between `cart_probe2` and `cart_atc`, and a smaller one after `cart_create`. If the 403 disappears, cadence was the vector; we then tune, not remove.
3. **OPTIONS preflight parity.** Browser sends `OPTIONS /gateway/graphql` before every POST (HAR #344, #358, #367). Undici skips them. Add an explicit preflight OPTIONS with the same `access-control-request-headers` list Chrome sends. Cheap; either matters or doesn't.
4. **PDP warm before ATC.** Between `cart_probe2` and `cart_atc`, fetch the PDP HTML once (`/product/squish-capybara-toy-assorted-43664474/`) so `bm_sz` rotates on `www.` and `_abck` picks up a fresh score, mirroring HAR #153 rotating `bm_sz` just before ATC.
5. **Fresh sensor round before the mutation.** If steps 1–4 don't move it, run one extra Akamai sensor POST on `www.kmart.com.au` right before ATC to bump `_abck` from `~0~` into the "recently-scored" window. Hyper is already wired; this is one extra `solveAkamaiSensor` call, not a new integration.
6. **Only if all of the above fail.** Suspect TLS/HTTP-2 fingerprint (undici vs Chrome). That is a real, known Akamai lever but expensive to change (would mean routing the mutation via curl-impersonate or a headed browser). We do not touch it until 1–5 are proven not to fix it, because it changes everything else.

### 4. Only after `cart_atc` returns 200 with `hasSku=true`

Then and only then diff the address (#599/#690), Paydock tokenize (#764), `create3DSToken` (#766), Paydock `/handle` (#788) and `/process` (#802), `sohEvent` (#805), `chargePayDockWithToken` (#807). The gating you already have will keep them off until the cart is real, so there is nothing to fix there yet.

### 5. Definition of done

- `har-diff` report shows 0 red rows for every golden step through `cart_atc` and `cart_verify`
- `cart_atc` returns 200 with `hasSku=true` on three consecutive runs against fresh proxy IPs
- No new headers, cookies, or payload fields added that don't appear in HAR (no cargo-culting)

## What files change

- `executor/scripts/har-diff.mjs` — upgrade to byte-level diff (§1)
- `executor/adapters/kmart.js` — at most one change per attempt in §3, each tied to a diff line
- `executor/scripts/README.md` — document the one-variable-at-a-time loop so we don't slide back into stacking fixes

## What I need from you to start

Just "go". First action will be §1 + §2 (diff upgrade, single measured run, publish the report) before touching `kmart.js` again. No more speculative header additions.
