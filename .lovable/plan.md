## The actual error

Session replay shows:

> `transport: Browserless HTTP 400: Timeout must be an integer between 1 and 60,000 seconds based on the limit for your plan`

Cause: `src/lib/browserless.functions.ts:310` sends `timeout=120000` on the `/function` request. Your Browserless plan caps that at **60,000 ms**, so Browserless rejects the call before our checkout script ever runs. This is why "full Browserless checkout" never executes — it's failing at the HTTP transport layer, not inside the script.

The script itself (ATC → shipping → contact → payment iframe fill → submit / dry-run) is already written and complete in `browserlessScript()`. It just never gets to run.

## Plan

### 1. Fix the timeout (unblocks the entire flow)

In `src/lib/browserless.functions.ts`:

- Change `url.searchParams.set("timeout", "120000")` → `"60000"`.
- Tighten the internal page timeouts so the whole script fits inside the 60s envelope:
  - `page.goto` 30s → 20s
  - Variant POST `timeout: 45_000` → 25_000
  - `waitForNavigation` after shipping 30s → 15s
  - `waitForSelector` payment iframe 20s → 15s
  - Final navigation wait `60_000` → 25_000
- Add a hard `Promise.race` budget of ~55s inside the script so we fail fast with a useful `failedStep` instead of Browserless killing the whole request.

### 2. Make failures observable instead of swallowed

- Always return the `steps` array Browserless built so far, plus the last screenshot (`screenshotB64`) even on transport errors — today on HTTP 400 we throw away everything.
- Surface `failedStep` ("atc" | "shipping" | "payment" | "submit") in the Tasks UI status pill so you can see exactly where it died next time.

### 3. Settings: Browserless plan note + connectivity check

- Add a "Test Browserless" button in Settings → Auto-checkout that calls a tiny server fn hitting `/function` with a no-op script and the configured key. Returns OK / plan limit info so you don't have to read replays to know the key works.

### 4. What this does NOT change

- No edits to Tasks UI form, monitor loop, webhook layout, runner/executor code, or `checkout.functions.ts` cart-warm path. Cart-warm stays as the fallback when Browserless is unavailable.
- No new dependencies, no DB migration.

## Files touched

- `src/lib/browserless.functions.ts` — timeout fix, tighter internal waits, richer error returns
- `src/routes/_paired/index.tsx` — show `failedStep` in the status pill
- `src/routes/_paired/settings.tsx` (or wherever Auto-checkout lives) — "Test Browserless" button
- new tiny `src/lib/browserless-ping.functions.ts` for the test call

## Honest expectation after the fix

Browserless free/starter (60s cap) is tight for a full Shopify checkout when the store is slow or under load. The script will work on most stores end-to-end, but expect occasional `failedStep: "submit"` timeouts on heavy stores. If that becomes a problem, the next step is either upgrading the Browserless plan (so we can go back to 120s) or moving the full submit to the Fly.io executor path, which has no per-request cap.
