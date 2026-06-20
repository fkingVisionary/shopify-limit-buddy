## Root cause (revised)

Real money is leaving your account, Shopify is completing the order, and Browserless finishes the run — but the task on the bot page never reflects any of it. That means the problem is the **whole status pipeline**, not just the 90s timeout. Three independent breakages overlap right now:

1. **Stage callbacks are silently lost.** The headless page POSTs `?action=stage&jobId=…` cross-origin to our edge function from inside the Shopify page context. Request interception, CORS preflights, and the fact that the page is mid-navigation all cause many of these to drop. The DB column `stage` therefore lies — it can stay on `launch` while checkout actually reaches `payment_result`.
2. **Final result write races the watchdog/self-healer.** The launch watchdog aborts the Browserless fetch at 90s based on the (lying) `stage` value. The UI's `getCheckoutJob` does the same. Whichever wins overwrites the row to `failed`, and the worker's later `update({status:'succeeded', result, screenshotB64})` either never fires (fetch was aborted) or fires against a row that's already been mislabeled.
3. **The UI doesn't reconcile.** Once a task is marked failed locally, we never re-read the job from the DB. So even if the worker eventually writes the truth, the bot page keeps showing the stale failure with no screenshot.

## Plan

### A. Make the worker the single source of truth

- The Browserless `/function` call's return value is authoritative. Do not interrupt it from outside.
  - Remove the 90s launch watchdog / AbortController in `supabase/functions/run-checkout/index.ts`.
  - Bound runs only by Browserless's own `timeout=360000` and our `EdgeRuntime.waitUntil`.
- Wrap the entire run in a `try/finally` that **always** writes a terminal row: `succeeded`, `failed`, or a new `unknown_result` with whatever evidence we have (last stage, last URL, screenshot if available).
- On any caught error, also try to grab a final screenshot via a tiny separate Browserless call using the same session id when possible; otherwise fall back to no screenshot but write the failure with the real error message.

### B. Stop the UI from poisoning the row

- Delete the 90s "stuck in launch → failed" self-healer in `src/lib/checkout-jobs.functions.ts`.
- `getCheckoutJob` only reads; it never writes status.
- Replace the safety net with one server-side timeout: a single scheduled re-check at 8 minutes that flips only rows still in `pending`/`running` with no `updated_at` movement, and marks them `failed` with `transport_stalled` — never overwrites a `succeeded`/`failed`/`payment_declined` row. Gate the update with `.in('status', ['pending','running'])`.

### C. Reliable progress signal that isn't a cross-origin POST

- Add a `phase` heartbeat written by the worker itself (Deno side) instead of from the headless page:
  - The worker calls `supa.from('checkout_jobs').update({stage, updated_at: now()})` at key checkpoints in the script handshake (we already pass these back inside `result.steps`).
  - Stream them by switching the Browserless call from one big `/function` to a small step protocol: the script returns an array of step events at the end, but we also keep a lightweight ping pattern using the existing pg_net infrastructure for mid-run updates. For now: the script returns its `steps` log, and the worker writes a final consolidated stage based on the last step before writing the terminal row.
- Keep the existing `?action=stage` callback as a best-effort nice-to-have only; never read it for control flow. Add a 1.5s timeout on the in-page `fetch(stageUrl)` so callback failures cannot slow the run.

### D. Always persist evidence

- Worker writes `result` containing `screenshotB64`, `finalUrl`, `orderId`, `paymentMessage`, `steps[]` for every terminal outcome including failures and "uncertain".
- For `confirm_uncertain`, also record `lastStage`, `lastUrlBeforeAbort`, and any `paymentMessage` we caught — these are the cases that mask successful payments.

### E. UI reconciliation

- `src/routes/_paired/index.tsx`:
  - When a task ends in `failed` *and* the last known `stage` is `submit`, `payment_result`, `three_d_secure`, or `confirm`, render an amber "Payment may have completed — verify in bank / Shopify order email" badge plus the screenshot, instead of red "transport error".
  - Always render `screenshotB64` if present on any outcome (success or failure), not just on success/dry-run.
  - On the bot page, add a "Re-sync from server" button per task that re-calls `getCheckoutJob` and overwrites the local task status with the DB truth.
  - Increase the polling deadline in the task loop from 180s to 360s to match the worker's Browserless `timeout`.

### F. One-time cleanup

- A small SQL update to relabel the recent batch of "Browserless launch timed out within 90s" rows whose `updated_at` is older than 5 minutes and `result` is null: set `stage = 'transport_stalled'` and `error = 'Worker timed out before writing result — payment status uncertain. Check bank / Shopify order email.'` so the bot page reflects the correct ambiguity for the rows that already misled you.

## Files to change

- `supabase/functions/run-checkout/index.ts` — remove watchdog, always write terminal row with evidence, time-bound in-page stage callbacks, worker-side stage updates.
- `src/lib/checkout-jobs.functions.ts` — remove 90s self-healer; read-only.
- `src/routes/_paired/index.tsx` — render screenshots on failures, "may have completed" badge, manual re-sync button, longer poll deadline.
- One-time data fix on `public.checkout_jobs` for the false-positive rows.

## Validation

- Run one real checkout. Expect:
  - The task ends in `confirmed` / `payment_declined` / `confirm_uncertain` with a screenshot and `finalUrl` matching what your bank shows.
  - No row remains in `running` past 8 minutes.
  - The bot page never shows "Browserless launch timed out within 90s" again when money actually moves.
- Run a deliberately broken proxy. Expect `failed` with a real proxy error, not a generic launch timeout.
- Run a 3DS checkout and approve in Revolut. Expect `confirmed` with order id captured and screenshot of the thank-you page.