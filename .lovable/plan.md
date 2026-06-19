## Goal

Split the checkout into multiple Browserless `/function` calls, each well under the 60s plan cap, with state handed off between calls via cookies + URL stored on the `checkout_jobs` row. No plan upgrade required, no per-call risk of a 408 wiping all progress.

## Architecture

Today: one `/function` call drives the whole checkout (cart → address → shipping → payment → submit → result). When it stalls, the entire 60s budget is lost.

New: the worker runs in up to 3 phases, each its own `/function` call (~15-25s each). The worker re-enqueues itself between phases by calling `request_checkout_worker` (existing RPC) again with the same `jobId`. The job row gets a new `phase` column to track which leg to run next.

```text
Phase A — prep (≤25s budget)
  launch → cart_add → checkout_load → address_fill
  → advance_to_shipping → select_shipping → advance_to_payment
  Save: cookies[], currentUrl, paymentReached:true
  Re-enqueue self as phase=B.

Phase B — pay (≤25s budget)
  launch fresh Chromium → restoreCookies → goto(currentUrl, domcontentloaded)
  → selectCreditCardPayment → fillCardField (number/expiry/cvv/name)
  → submit → poll payment_result (≤12s)
  Final status written.

Phase C — recovery (optional, ≤25s)
  Only fires if B times out before result. Restores cookies + goes back to
  page.url() at time of timeout, re-checks for thank-you / decline, returns
  paymentRejected or fail.
```

## State handoff

New columns on `checkout_jobs`:

- `phase` text default 'A' — which leg the next worker call should run.
- `session` jsonb null — `{ cookies: SerializedCookie[], currentUrl: string, sourceUserAgent: string }`.

The worker script returns the new state at the end of each phase via the existing JSON result. The edge function writes it to `session` + flips `phase`, then calls `request_checkout_worker(jobId, executorUrl, executorToken)` again (fire-and-forget, same pattern as enqueue).

`session.cookies` is captured with `page.cookies()` (Puppeteer) at end of phase A and restored with `page.setCookie(...session.cookies)` at start of phase B, before `page.goto(session.currentUrl)`. The proxy stays sticky (`proxySticky=true`) so the gateway sees the same IP across phases.

## Per-phase budgets

Each phase has an in-script `SCRIPT_BUDGET_MS = 45000` (well under Browserless 60s). Transport `timeout` stays at `60000`. Per-step deadlines from last turn are kept. If a phase exhausts its budget, it returns `{ ok: true, partial: true, nextPhase, session }` instead of failing — the edge function re-enqueues so we use a fresh 60s window rather than dying inside one.

## Resource blocker

The interceptor from last turn stays in every phase (biggest single speedup).

## UI / status

`checkout_jobs.stage` keeps driving the polling UI; `src/routes/_paired/index.tsx` already maps stage names. Two new stages appear naturally: `phase_a_done` and `phase_b_start`. Frontend treats them like any other intermediate stage — no code change needed.

## Files touched

- `supabase/migrations/<timestamp>_checkout_jobs_phases.sql` — add `phase` text default 'A' and `session` jsonb columns. GRANT not needed (table already grants are in place).
- `supabase/functions/run-checkout/index.ts`:
  - Extract `phaseAScript()` and `phaseBScript()` (and small `phaseCScript()` for recovery) — share helpers via a `commonHelpers()` template literal.
  - Phase A script ends with `return { ok: true, partial: true, nextPhase: "B", session: { cookies: await page.cookies(), currentUrl: page.url() } }` once payment step is reached.
  - Phase B script starts with `await page.setCookie(...context.session.cookies); await page.goto(context.session.currentUrl, { waitUntil: "domcontentloaded", timeout: 15000 });`.
  - Edge function reads `job.phase`, picks script + passes `context.session`, then on `partial:true` writes `phase`, `session`, `stage` and re-enqueues itself via `supabase.rpc('request_checkout_worker', { p_job_id, p_url, p_token })`.
  - Safety: hard cap of 3 phase invocations per job (`phase_attempts` int column) to avoid infinite loops if something keeps timing out.

## Risk

- Some Shopify "Checkout One" pages bind a session token to a specific browser fingerprint. We mitigate by reusing the same proxy IP (sticky) and forwarding the phase-A `userAgent` to phase B's `launch` args. If a store still rejects the resumed session, we fall back to a single-shot path automatically: phase A returns the URL of the payment step *and* also tries to complete inline if budget remains.
- Adds ~2-4s of overhead per extra phase (Browserless cold start + cookie restore + nav). The blocker keeps the goto under ~2s, so total wall-clock stays around 20-30s even when we split, with zero risk of 408.

## Out of scope

- No frontend changes.
- No swap to WebSocket/reconnect transport (would need puppeteer-core inside the edge function and is more invasive). Cookie-resume gives us most of the benefit at much lower risk.
