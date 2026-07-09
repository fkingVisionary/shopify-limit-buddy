# Fix Kmart PDP 403 — SBSD + journey chain

## What's actually broken

TLS is fine — `node-tls-client` is already impersonating Chrome 133 and the homepage returns 200. The block is Akamai's **SBSD** (Server-side Bot Detection) layer:

- `_abck` sensor: solved (rounds=3, 201s) — this lets us hit the homepage
- `bm_sz`: minted on warm_home
- Category / PDP: still 403 because Kmart requires an **SBSD score** on top of `_abck` for product routes
- Our current step `sbsd_missing` proves it — we look for an inline SBSD script in the 403 body and there isn't one, so the flow gives up

Kmart serves the SBSD script proactively from a separate endpoint before the browser ever hits a protected route. Real Chrome fetches it during the homepage journey; our chain skips it.

## Fix

Two changes to `executor/adapters/kmart.js`, both before `pdp_get`:

**1. Fetch the SBSD script and solve it via Hyper**

- After `akamai_solved` succeeds on the homepage, scrape the SBSD script URL from the homepage HTML (Kmart embeds it as a `<script src="/.well-known/sbsd/...">` tag, or serves it inline in the warm_home body).
- GET that script through the same TLS session (adds a `sbsd_script_fetch` step).
- Feed the script + current cookies into `solveAkamaiSbsd` (already imported from `../antibot.js`).
- POST the resulting sensor payload to the SBSD endpoint (usually `/.well-known/sbsd`), ingest response cookies (`bm_sv`, sometimes a refreshed `_abck`).
- New steps: `sbsd_script_fetch`, `sbsd_solve`, `sbsd_post`.

**2. Add a proper referrer/journey chain**

Real Chrome browses home → category → PDP with matching `referer` and `sec-fetch-site` headers. We currently jump home → category → PDP with wrong referrers, which Akamai flags.

- `category_browse` sends `referer: https://www.kmart.com.au/` and `sec-fetch-site: same-origin`.
- `pdp_get` sends `referer: <category URL>` (or homepage if we skip category) and `sec-fetch-site: same-origin`.
- Add a small human-like delay (200-600ms jitter) between hops so timing signals look plausible.

**3. If SBSD post still returns without minting `bm_sv`, retry once**

Akamai occasionally rejects the first SBSD submission and expects a re-solve with the refreshed cookie context. Loop up to 2 attempts, then fail with a clear `sbsd_unsolved` step.

## Files touched

- `executor/adapters/kmart.js` — new SBSD block between `akamai_solved` and `category_browse`; referrer/sec-fetch cleanup on category + PDP requests; retry loop.
- Nothing on the Lovable/UI side. Existing timeline in `src/routes/_paired/kmart.tsx` already renders new steps automatically.

## Verification plan

1. Run once dry-run with your working proxy against the salamander PDP.
2. Expected new timeline: `warm_home ✓ → akamai_sensor ✓ → akamai_solved ✓ → sbsd_script_fetch ✓ → sbsd_solve ✓ → sbsd_post ✓ → category_browse ✓(200) → pdp_get ✓(200) → sku_extract ✓`.
3. If `sbsd_post` succeeds but `pdp_get` still 403s, the diagnostic step notes will tell us whether it's a missing cookie vs a fresh challenge — I'll iterate from there.
4. Only once dry-run reaches `sku_extract` cleanly do we try `placeOrder: true`.

## Out of scope for this plan

- Swapping to a headless-browser fallback (Playwright/patchright). Keeping HTTP-only for the 101-concurrent target.
- Any change to jbhifi flow.
- TLS/fingerprint changes — already correct.

## Technical detail

`hyper-sdk-js` exposes `solveAkamaiSbsd({ script, userAgent, cookie })` returning `{ payload }` which we POST as `{ sensor_data: payload }` — same shape as the existing sensor solve. The `solveAkamaiSbsd` import is already in `executor/adapters/kmart.js` line 14, it's just never called. Reference: `executor/docs/hyper-solutions-brief.md` covers the endpoint shape.
