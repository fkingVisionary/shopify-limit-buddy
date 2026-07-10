# Switch Kmart to Oxylabs Web Unblocker

## Why

We've confirmed the block isn't sensor validity — it's Akamai fingerprinting the connection (TLS/JA3, HTTP2, header order, IP class). Chasing that ourselves is a losing arms race. Oxylabs Web Unblocker does the whole stack (real Chrome TLS handshake, sensor generation, residential IP rotation, retries) and returns the final response. We stay HTTP, stay fast, and stop maintaining Akamai bypass logic.

## What the user provides

1. Create an Oxylabs Web Unblocker sub-user at dashboard.oxylabs.io → Web Unblocker.
2. When prompted, paste the username + password into the secure secret form (`OXYLABS_UNBLOCKER_USER`, `OXYLABS_UNBLOCKER_PASS`).

## Changes

### 1. `executor/http.js` — add an Oxylabs transport

- New transport mode `oxylabs` selected when `EXECUTOR_HTTP_TRANSPORT=oxylabs` **or** when `ctx.useUnblocker === true`.
- Routes requests through `http://customer-USER:PASS@unblock.oxylabs.io:60000` using undici's `ProxyAgent` with `requestTls: { rejectUnauthorized: false }` (their MITM cert).
- Adds `x-oxylabs-geo-location: United States` and `x-oxylabs-render: html` headers only on the first hit of a flow (category / PDP HTML); JSON add-to-cart calls skip render.
- Preserves cookie jar ingestion on the response we actually use.
- Falls back to the existing undici transport for non-Kmart adapters.

### 2. `executor/adapters/kmart.js` — opt into unblocker

- Set `ctx.useUnblocker = true` at the top of the Kmart flow.
- Delete the SBSD solve chain, the Akamai sensor warm loop, the fingerprint header pinning, and the retry-on-403 branches — Oxylabs handles all of it. Keep the request sequence (home → category → PDP → add-to-cart → checkout) since we still need the resulting cookies/HTML for parsing.
- Keep the cookie jar; Oxylabs returns Set-Cookie headers we still ingest for the checkout POST.

### 3. `executor/server.js` — surface unblocker status in `/health` and job logs

- Log `transport=oxylabs` on each step so we can see it in Fly logs.

### 4. `executor/README.md`

- Document the two new env vars and how to toggle per-adapter.

### 5. Secret setup

- Use `add_secret` for `OXYLABS_UNBLOCKER_USER` and `OXYLABS_UNBLOCKER_PASS` (user pastes values into the secure form).
- These are runtime secrets injected into the Fly executor via existing deploy pipeline — no build-time changes.

## Out of scope

- No changes to the TanStack frontend, checkout job queue, or `src/lib/executor.functions.ts` request shape.
- Other adapters (non-Kmart) keep the current undici transport.
- No retry/backoff tuning yet — Oxylabs retries internally; we'll observe one clean run before adding our own.

## Validation

1. Deploy executor with the two secrets set.
2. Run one Kmart checkout job end-to-end.
3. Confirm 200s on category + PDP + add-to-cart in the job log, and a completed order.
4. If it works, delete the dead SBSD/sensor code paths in a follow-up cleanup pass.
