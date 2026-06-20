## Goal

Two specific fixes on top of the current Browserless checkout flow:

1. Discord webhook reliably fires when Shopify declines the payment.
2. UI shows "Payment submitted" and "Waiting for 3DS approval" stages before the terminal state, instead of jumping from "Starting checkout" straight to "Payment declined".

No other behavior changes.

## What's wrong today

**Webhook on decline isn't firing.** In `supabase/functions/run-checkout/index.ts`, the decline path *does* call `fireTerminalWebhook(... "failed" ...)`. The skip happens inside that helper:

```ts
if (!webhookUrl || !notify) return;
if (!notify?.enabled?.[event]) return;   // <- silently drops "failed"
```

`notify_events` is written by `enqueueCheckout` as `{ enabled: cfg.events, base }`. If the user's saved `NotifyConfig.events` was created before `"failed"` existed (or is missing the key for any reason), `enabled.failed` is `undefined` and the helper returns without firing — and without logging anything, which is why edge logs are empty. The UI also pre-marks `"failed"` as handled in `notifiedRef` after enqueue, so the client-side fallback can't save it.

**Stages stall at "Starting checkout".** The worker emits `submit` → `payment_result` → `three_d_secure` from inside the Browserless `/function` context via cross-origin `fetch`/`sendBeacon` to `?action=stage`. Browserless function-context `fetch` and in-page beacons are unreliable mid-checkout (navigation tears them down), so the `stage` column often never advances past `launch`/`checkout_start` before the terminal write lands. The UI's `stageLabels` map is fine; it just never sees those stages.

## Plan

### 1. Fix decline webhook (server-side)

`supabase/functions/run-checkout/index.ts`

- In `fireTerminalWebhook`, treat a missing `enabled[event]` as **true** when the webhook URL is present. Rationale: the user explicitly configured a Discord webhook; defaulting "failed" off silently is the bug. Keep the explicit `false` opt-out working.
- Add `console.log` lines on every early-return path (`no webhook url`, `event disabled`, `already fired`, `discord post non-2xx`) so future debugging shows up in edge logs.
- After the conditional `webhook_fired_at` claim, log the Discord HTTP status. Don't block on Discord.

`src/lib/discord.ts` + `src/routes/_paired/index.tsx`

- Make `DEFAULT_NOTIFY_CONFIG.events.failed = true` (if not already) and, when loading from localStorage, merge defaults so older saved configs always have `failed`/`confirmed`/`in_stock`/`checkout_ready` keys defined. Prevents the same `undefined` shape from reaching the server next time.

### 2. Surface "Payment submitted" + "Waiting for 3DS" in the UI

The stage callback from inside Browserless is unreliable. Move the stages that matter most to **Deno-side direct DB writes** so they always land:

`supabase/functions/run-checkout/index.ts`

- Add a small helper `writeStage(jobId, stage)` that does `supa.from("checkout_jobs").update({ stage }).eq("id", jobId).in("status", ["pending","running"])`.
- Write `stage = "payment_submitting"` from the Deno worker **immediately before** issuing the Browserless `/function` POST. Guarantees the UI moves off "Starting checkout" within ~1s.
- The headless script keeps emitting `submit`, `payment_result`, `three_d_secure` via the existing beacon path (best-effort, no change). Those will still update the DB when they make it through.
- Add a new terminal-shape result field `awaiting3ds: true` already set whenever the script detects 3DS. After the Browserless request returns and the worker writes the terminal row, no further stage write is needed.
- Extend `stageLabels` in `src/routes/_paired/index.tsx`:
  - `payment_submitting`: "Payment submitted — awaiting response"
  - `three_d_secure`: keep "3DS verification required — approve in your bank app"
  - `submit`: "Submitting payment"
  - `payment_result`: "Waiting for payment result"

### 3. Light diagnostics so the next regression is visible

- In the worker's terminal branches, `console.log("[run-checkout]", jobId, outStatus, outStage)` once per job.
- In `fireTerminalWebhook`, log `jobId`, `event`, and the Discord response status.

These two lines together make it possible to confirm from `supabase--edge_function_logs` whether a declined job actually reached the webhook path.

## Out of scope

- No changes to checkout speed, selectors, captcha, or compat layer.
- No new tables or columns.
- No change to the in-page beacon mechanism — just supplementing it with a guaranteed Deno-side write for the one stage the user cares about (payment submitted).

## Files to change

- `supabase/functions/run-checkout/index.ts` — webhook fallback, stage writes, logs
- `src/routes/_paired/index.tsx` — new `stageLabels` entries
- `src/lib/discord.ts` — defaults merge on load so `enabled.failed` is always defined
