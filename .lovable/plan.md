# Fix: Browserless checkout times out

## Root cause

`runBrowserlessCheckout` runs inside a TanStack server function on Cloudflare Workers. The Worker has a hard ~30s wall-clock limit for a single request, but a real Shopify checkout via Browserless `/function` takes 30–60s (we even set `timeout=60000`). The Worker kills the fetch before Browserless responds → client sees "timed out" / undefined payload.

This is a runtime-limit problem, not a Browserless problem. We need to stop waiting for Browserless inside the page request.

## Approach: async job queue + Supabase Edge Function worker

Edge Functions (Deno) have a much longer wall-clock (~150s), which fits a full checkout. We use them only as the long-running worker; the client never calls them directly.

```text
client ──► serverFn enqueueCheckout ──► insert row in checkout_jobs (pending)
                                   └──► fire-and-forget invoke edge fn `run-checkout`
                                                            │
                                                            ▼
                                            edge fn calls Browserless /function
                                            (up to 90s), then updates row
                                                            │
client ──► serverFn getCheckoutJob (poll every 1.5s) ◄──────┘
```

No new third-party API needed — same Browserless key, just executed from a runtime that can wait long enough.

## Steps

1. **DB migration** — `public.checkout_jobs`
   - `id uuid pk`, `user_id uuid` (RLS scoped to `auth.uid()`)
   - `status text` (`pending` | `running` | `succeeded` | `failed`)
   - `stage text` (current step label for UI ticker — replaces guessed client ticker)
   - `input jsonb`, `result jsonb`, `error text`
   - `created_at`, `updated_at`
   - RLS: owner SELECT; service_role ALL. GRANTs as per project rules.

2. **Edge function `run-checkout`** (Deno)
   - Reads `jobId` from body, loads row with service role.
   - Sets `status=running`, then calls Browserless `/function` with the existing checkout script (lifted from `browserless.functions.ts`).
   - Periodically updates `stage` so the UI can show real progress (`cart_add`, `checkout_load`, …) instead of the current fake ticker.
   - On finish, writes `result` / `error` and final status.

3. **Server functions** (`src/lib/checkout-jobs.functions.ts`)
   - `enqueueCheckout` — auth required, inserts row, fire-and-forget `fetch` to the edge function (no `await` on the body), returns `{ jobId }` immediately. Well under the 30s Worker limit.
   - `getCheckoutJob({ jobId })` — auth required, returns status/stage/result/error.

4. **Client wiring** (`src/routes/_paired/index.tsx`)
   - Replace direct `browserlessFn(...)` call with `enqueueCheckout` → poll `getCheckoutJob` every ~1.5s.
   - Drive the existing status message off the row's `stage` field (real progress, not the simulated ticker). Keep elapsed-time display.
   - On `succeeded`/`failed`, render the same success/failure UI as today.

5. **Retire the now-unused sync path**
   - Keep `browserlessScript()` (used by the edge fn) but remove the public `runBrowserlessCheckout` server fn so nothing can accidentally invoke the 30s-bound version.

## Notes

- `BROWSERLESS_API_KEY` already exists; no new secret needed.
- Edge function needs `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY` (auto-provisioned) and `BROWSERLESS_API_KEY` (already set).
- Fire-and-forget invoke is safe because the edge function authorizes via the row's `user_id` written by the authenticated server fn — the edge fn itself doesn't need the user's JWT.
- No change to retailer detection, in-stock polling, or the manual-assist fallback.
