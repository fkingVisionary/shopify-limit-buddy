## Goal

The checkout worker hit Browserless's 60s cap (last run: 63s → 408 timeout). Cut wall-clock time in `supabase/functions/run-checkout/index.ts` so a normal run finishes comfortably under 50s, leaving headroom for slow stores.

## Where the time goes today

Cumulative worst-case waits per stage:

- Card field fill: 22s deadline × 4 fields = up to 88s alone. Per attempt loop types each char with `delay:110` + an extra `setTimeout(35)`, so a 16-digit card = ~2.3s per attempt, × 5 attempts × 4 fields.
- Post-card settle: `Tab` + `waitForNetworkIdle(idle 900, timeout 6000)` + extra 900ms = up to ~7.8s.
- CVV-retry block: same 6s idle + 900ms after re-submit.
- Shipping advance: 12s rate-select deadline + 10s `waitForFunction` per attempt.
- Payment-result: 35s `waitForFunction`.
- Multiple 1.6s / 900ms / 600ms `setTimeout` "let the page breathe" pauses scattered through select-payment, billing-same-as-shipping, and submit.

## Trims (concrete numbers)

1. **Card fill loop** (`fillCardField`, ~line 548)
   - Per-field deadline: 22000 → 12000 ms.
   - Per-attempt char delay: `el.type(..., {delay: 110})` → 55, drop the extra `setTimeout(35)` between chars.
   - Tail-retype delay: 140 → 70, drop the 45ms gap.
   - Attempts: 5 → 3.
   - Outer loop poll: 350 → 200 ms.

2. **Post-card settle** (~line 700)
   - `waitForNetworkIdle({idleTime: 900, timeout: 6000})` → `{idleTime: 400, timeout: 2500}`.
   - Trailing `setTimeout(900)` → 300.

3. **CVV-retry settle** (~line 745): same numbers as #2.

4. **Shipping advance** (`advanceToPayment`, ~line 306)
   - `waitForFunction` timeout: 10000 → 5000.
   - Post-continue `setTimeout(900)` → 400.
   - `selectShippingRate` deadline: 12000 → 7000; inner sleeps 550/450 → 300/250.

5. **Submit + payment-result** (~line 735, 756)
   - Post-submit `setTimeout(1600)` → 600.
   - `waitForFunction` for thank-you/decline: 35000 → 25000 (still covers slow gateways; total budget already shrunk elsewhere).

6. **Billing-same-as-shipping pause** (~line 539): 600 → 200 ms.

7. **Browserless URL `timeout`** (~line 846): keep at 60000 (don't raise). With the trims above, a healthy run lands ~30-40s.

## Out of scope

No logic changes (selectors, retry semantics, error messages stay the same). No plan-tier change. No splitting the script across multiple Browserless calls.

## Verification

After edit:
- `node --check` parity (template-literal evaluated) to confirm no regex/escape regressions.
- Re-run a checkout from the UI; query `checkout_jobs` for the new `updated_at - created_at` and confirm it lands under 50s on a successful run, and that failures still surface the same `stage` values.
