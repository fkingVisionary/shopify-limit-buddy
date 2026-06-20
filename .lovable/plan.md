# Hyper Solutions integration plan

Goal: solve Akamai (and later Datadome / Kasada / PerimeterX / Incapsula / Akamai SBSD) for JB Hi-Fi and any future protected store, so the checkout bot can run a fast HTTP path first and fall back to Browserless only when needed.

## Architecture

```
checkout job
  └─ adapter (jbhifi, shopify-generic, …)
       ├─ try HTTP path (Fly executor + undici)
       │     └─ AntibotProvider.solve({ kind: "akamai", url, … })
       │            → Hyper /v2/akamai/sensor → POST sensor → _abck cookie
       │            → Hyper /v2/akamai/pixel  → POST pixel  → bm_sz cookie
       └─ on block / 403 / challenge → Browserless fallback
              └─ same AntibotProvider, intercepts sensor POSTs in-page
```

One `AntibotProvider` interface, one Hyper client, two call sites (HTTP runner + Browserless script). Adapters never talk to Hyper directly.

## Secrets

Add via `add_secret` after approval:
- `HYPER_API_KEY` — Hyper Solutions API token
- `HYPER_BASE_URL` (optional, default `https://akm.hypersolutions.co`) — lets us swap regions / vendors without code changes

## New files

1. `src/lib/antibot/hyper-client.ts`
   - `solveAkamaiSensor({ pageUrl, userAgent, abck, bmsz, scriptHash })`
   - `solveAkamaiPixel({ pageUrl, userAgent, html })`
   - `solveSbsd(...)`, `solveDatadome(...)`, `solveKasada(...)`, `solvePx(...)`, `solveIncapsula(...)` — stubs that throw `not_implemented` until enabled
   - Thin `fetch` wrapper; reads `HYPER_API_KEY` from `process.env` inside the call (never at module scope); 10s timeout; structured errors `{ vendor, code, status, body }`
2. `src/lib/antibot/types.ts` — shared `AntibotProvider` interface + `Challenge` discriminated union
3. `executor/antibot.js` — mirror of the client for the Fly Node executor (uses `undici`, same env var `HYPER_API_KEY` injected via Fly secrets)
4. `supabase/functions/run-checkout/antibot.ts` — Deno mirror for the Browserless orchestrator side

## Changes to existing files

- `executor/checkout.js`
  - After `warm_home`, parse response for Akamai script tag → if present, call `solveAkamaiSensor` → POST sensor to the script URL → store `_abck` in jar
  - Repeat on `cart_add` / `cart_redirect` if response sets a new `_abck` (Akamai rotates)
  - Add `steps` entries: `akamai_sensor`, `akamai_pixel` with `ok/ms/status`
- `supabase/functions/run-checkout/index.ts`
  - Pass `HYPER_API_KEY` into the Browserless `code` payload as an arg
  - Browserless script: `page.route('**/akam/*', …)` to intercept sensor POSTs, call Hyper, replace body
  - New `detectChallenge(page)` helper that fingerprints vendor (Akamai/DD/Kasada/PX) from response headers/body and routes to the right Hyper endpoint
- `src/lib/checkout-jobs.functions.ts` — no schema change; surface antibot step results in the existing `result` JSON so the UI panel can show "Akamai solved 1.2s"
- `supabase/migrations/<new>.sql` — add `antibot_events` JSONB column to `checkout_jobs` (nullable) for richer per-step diagnostics; GRANTs + RLS mirror existing table

## Adapter flow (JB Hi-Fi)

1. HTTP path on Fly:
   - GET PDP via AU residential proxy → solve Akamai sensor + pixel
   - POST `/cart/add.js` (or JB's React cart microservice once recon confirms endpoint)
   - GET checkout token URL → solve Akamai again if rotated
   - If any step returns 403 / challenge HTML → mark `failedStep`, return to orchestrator
2. Browserless fallback (only on HTTP failure):
   - Same Hyper provider, but Playwright drives the page; Hyper supplies sensor payloads via route interception
   - Existing recon-style stage screenshots kept for debugging

## Provider abstraction (future-proofing)

`AntibotProvider` interface so we can later swap Hyper for another vendor or run multiple in parallel per vendor:

```ts
interface AntibotProvider {
  supports(vendor: "akamai"|"akamai-sbsd"|"datadome"|"kasada"|"perimeterx"|"incapsula"): boolean
  solve(challenge: Challenge): Promise<Solution>
}
```

Only `HyperProvider` ships now; Akamai sensor+pixel fully wired, the other vendors return `not_implemented` with a clear error so we can light them up incrementally.

## Out of scope (this plan)

- Actual JB cart/checkout XHR endpoints — still need recon round 2 to capture them; Hyper integration is independent and unblocks that work
- Datadome/Kasada/PX/SBSD live implementations — interface + stubs only; turn on per-store when a real target appears
- UI changes beyond surfacing antibot step timings in the existing job result viewer

## Acceptance

- `executor/checkout.js` dry-run against `jbhifi.com.au` returns `ok: true` with `akamai_sensor` + `akamai_pixel` steps recorded and `_abck` cookie present in `jar.dump()`
- Browserless recon against JB no longer 403s on `/cart` after Hyper interception is enabled
- `HYPER_API_KEY` missing → adapters fail with a clear `antibot_misconfigured` error, no silent fallback
