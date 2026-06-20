# Hyper Solutions integration plan (revised after docs review)

Goal: solve Akamai / SBSD / Incapsula / DataDome / Kasada for JB Hi-Fi and future protected stores, used by both the Browserless Playwright path and the Fly undici HTTP path.

## Use official SDKs — do not reimplement

- `hyper-sdk-js` — low-level primitives (`Session`, `generateSensorData`, `generateSbsdPayload`, `generatePixelPayload`, `generateReese84Sensor`, `generateUtmvcCookie`, `generateInterstitialPayload`, `generateSliderPayload`, `generateTagsPayload`, `generateKasadaPayload`, `generateKasadaPow`, `generateBotIdPayload`).
- `hyper-sdk-playwright` — `AkamaiHandler`, `DataDomeHandler`, `IncapsulaHandler`, `KasadaHandler`. Each has `initialize(page, context)`, `getStatus()`, `reset()`. They attach `page.route()` interceptors that transparently swap sensor/payload bytes.

## Auth & config

- Header: `x-api-key: $HYPER_API_KEY`. (Optional `x-signature` JWT later for hardening.)
- Per-vendor subdomains — handled by the SDKs internally, we never hardcode URLs.
- Secrets:
  - `HYPER_API_KEY` — required; add via `add_secret` once user receives approval.
  - `HYPER_JWT_KEY` — optional, for signed requests; defer.

## Architecture

```
checkout job
  └─ adapter (jbhifi, shopify-generic, …)
       ├─ HTTP path (Fly executor, undici)
       │     └─ hyper-sdk-js primitives → inject _abck / reese84 / datadome / x-kpsdk-* into jar
       └─ Browserless fallback
              └─ dynamic-import hyper-sdk-playwright handlers
                    → handler.initialize(page, context) BEFORE page.goto()
```

## Files

### New
- `executor/antibot.js` — Node wrapper around `hyper-sdk-js`. Exports `solveAkamaiSensor`, `solveSbsd`, `solveReese84`, `solveUtmvc`, `solveDatadome`, `solveKasada`. Reads `HYPER_API_KEY` from `process.env`. Resolves and caches proxy egress IP per dispatcher (one lookup per cold proxy).
- `executor/ip-resolve.js` — small helper to GET `https://api.ipify.org?format=json` through the active proxy dispatcher; memoised per proxy URL for 5 min.

### Changed
- `executor/package.json` — add `hyper-sdk-js`.
- `executor/checkout.js`:
  - After `warm_home`, scan HTML/headers for: Akamai script tag, SBSD `?v=` UUID, Reese84 script, IPS script, DataDome interstitial. Solve via `executor/antibot.js`, POST payload to the captured script URL, refresh cookie jar.
  - On any `cart_add` / `cart_redirect` / `checkout_page` setting a fresh `_abck`, re-run sensor with the previous `context`.
  - New `steps`: `resolve_ip`, `akamai_sensor`, `akamai_sbsd`, `akamai_pixel`, `incap_reese84`, `incap_utmvc`, `dd_interstitial`, `kasada_tl`, `kasada_cd` — each with `ok/ms/status`.
- `supabase/functions/run-checkout/index.ts`:
  - Pass `HYPER_API_KEY` and resolved `proxyIp` into the Browserless `/function` payload via `context`.
  - In the function body: dynamic-`import('hyper-sdk-js')` + `import('hyper-sdk-playwright')`, construct `Session`, instantiate the four handlers, `Promise.all(...initialize(page, page.context()))` BEFORE `page.goto()`.
  - Keep recon mode untouched.
- `src/lib/checkout-jobs.functions.ts` — surface the new step list inside `result.steps` for the existing job viewer (no schema change).

### No schema migration this round
- Step diagnostics live in the existing `checkout_jobs.result` JSONB. We'll add a dedicated `antibot_events` column only if the volume justifies it.

## Adapter wiring — JB Hi-Fi

JB is primarily Akamai. Day-one:
1. HTTP path: warm PDP → `AkamaiHandler`-equivalent sensor flow via `hyper-sdk-js` → `/cart/add.js` (or JB's React cart microservice once recon confirms) → checkout token URL → resolve again on rotation.
2. Browserless fallback: `AkamaiHandler` only is enough; `IncapsulaHandler` / `DataDomeHandler` / `KasadaHandler` initialized for safety but should no-op on JB.

If JB later turns out to use Kasada too, switch to raw `generateKasadaPayload` with JB's actual `ips.js` URL — the `KasadaHandler` regex is Hyatt-specific.

## Browserless install caveat

`hyper-sdk-js` and `hyper-sdk-playwright` must be resolvable from the Browserless runtime. Two options, in order of preference:
1. **Browserless residency install** — pre-publish a small wrapper module that the `/function` body imports (we host it on jsDelivr/npm). Simplest: just import directly from the public npm CDN inside the function (`await import('https://esm.sh/hyper-sdk-js@2.12.2')`).
2. **Bundle** — esbuild the SDK + adapter into a single string and inline it inside the `/function` payload. Heavier but no network dependency at runtime.

Plan: start with option 1 (esm.sh dynamic import). If the SDK isn't ESM-compatible on esm.sh, fall back to bundling.

## Provider abstraction (light)

Single thin interface in `executor/antibot.js`:
```ts
solve(vendor, input) -> { cookieUpdates, headerUpdates, postBack?: { url, body, headers } }
```
Adapters call `solve()` and apply the returned mutations to the jar / next request. PerimeterX is **dropped** from this plan — no Hyper endpoint exists for it.

## Acceptance

- `executor/checkout.js` dry-run against `jbhifi.com.au` returns `ok: true` with `akamai_sensor` step recorded and `_abck` cookie containing `~0~` in `jar.dump()`.
- Browserless recon against JB no longer returns 403 on `/cart` after `AkamaiHandler.initialize()`.
- `HYPER_API_KEY` missing → clear `antibot_misconfigured` failure, no silent fallback.

## Status

Waiting on `HYPER_API_KEY` from Hyper Solutions approval. When it arrives:
1. Call `add_secret` for `HYPER_API_KEY`.
2. `bun add` is not needed — Fly executor uses its own `package.json`; we add `hyper-sdk-js` there.
3. Ship `executor/antibot.js` + `executor/ip-resolve.js` + changes to `executor/checkout.js` and `supabase/functions/run-checkout/index.ts` in one batch.
