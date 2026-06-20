## Goals

1. Cut end-to-end checkout time on base Shopify (Checkout One + legacy) by trimming redundant navigations, parallelizing form fills, and pre-warming the payment vault.
2. Make Discord webhooks fire **exactly once** for every terminal outcome — even when the user closes the tab, refreshes, or the device that started the task goes offline.

## Part 1 — Shopify checkout speed

Current `supabase/functions/run-checkout/index.ts` per-run cost (rough):
- `goto(storeUrl)` domcontentloaded: ~1.5–3.0s (only needed for cookies/origin)
- `goto(/checkout)` w/ up to 3× 45s retries: ~1.5–4.0s typical
- 9 sequential `setCheckoutValue()` calls, each `page.$` + `evaluate`: ~0.9–1.5s
- `clickContinue` polling loops (3.5s deadline × up to 3 steps): ~1.0–3.0s
- Card iframe fill + submit: ~2.0–4.0s

Changes:

**A. Skip the product-page hop.**
Replace `page.goto(input.storeUrl)` with `page.goto(origin + "/cart")` (lighter HTML, sets the storefront cookie jar identically). `/cart/add.js` works the same way. Saves one full document load.

**B. Single-pass address fill.**
Collapse the 9 `setCheckoutValue()` awaits into one `page.evaluate(fillAll, profile)` that walks a selector map in the page context. One round-trip instead of nine; also lets us dispatch `input`/`change` in the same microtask so Shopify's React state settles in a single render.

**C. Parallel pre-vault while address fills.**
Kick off a Node-side `fetch("https://deposit.us.shopifycs.com/sessions", …)` immediately after `cart_add` succeeds (we already know hostname + card). Store the returned `id`. When we reach the payment step, inject the vault id directly into the hidden `s` field on the card-fields iframe form instead of typing into the iframe. Falls back to the current iframe-type path if the vault call fails or the store rejects the session id.

**D. Tighter wait budgets.**
- `clickContinue` deadline 3.5s → 1.8s with 80ms poll (we already retry up).
- `waitForNetworkIdle({ idleTime: 150, timeout: 600 })` → `{ idleTime: 80, timeout: 350 }` after fills.
- Drop the per-attempt 1500ms backoff between `/checkout` retries to 600ms.

**E. Prefer `networkidle0` only where needed.**
Audit any remaining `waitUntil: "networkidle*"` and switch to `"domcontentloaded"` plus a targeted `waitForSelector` for the next step's anchor element.

**F. Keep the existing resource blocker** — already aggressive and correct. No change.

Expected savings on a typical base Shopify Checkout One store: ~3–6s per run (worst case clamped by the bank's authorization step, which we don't control).

## Part 2 — Reliable webhooks

Current shape (`src/lib/discord.ts` + `src/routes/_paired/index.tsx`): `fireWebhook` runs **only in the browser**, gated by an in-memory `notifiedRef` Set, triggered when the UI transitions a task to `confirmed`/`failed`/`checkout_ready`/`in_stock`. Failure modes today:
- User closes tab before the worker finishes → no webhook ever sent.
- Two devices paired to the same workspace → webhook may fire twice (each has its own `notifiedRef`).
- Timeout on the UI side fires `failed` while the worker is still running and later writes `succeeded` to the DB → user gets a "failed" webhook for a successful checkout.

Changes:

**G. Move terminal-state webhooks server-side.**
Add a `notify_webhook` column (text, nullable) and `notify_events` (jsonb) on `checkout_jobs`. `enqueueCheckout` copies the user's Discord config onto the job row at enqueue time. In `run-checkout/index.ts`, the same `try/finally` that writes the terminal row also POSTs the Discord embed for `succeeded` / `payment_declined` / `failed` before returning. This guarantees one fire per terminal write, regardless of tab state.

**H. Idempotency.**
Add `webhook_fired_at timestamptz` on `checkout_jobs`. Worker uses a conditional update — `UPDATE … SET webhook_fired_at = now() WHERE id = $1 AND webhook_fired_at IS NULL RETURNING 1` — and only POSTs Discord if the update affected one row. Safe against retried invocations.

**I. UI fires only the pre-terminal events.**
`in_stock` and `checkout_ready` stay client-side (worker doesn't know about them). `confirmed` / `failed` are removed from the UI `fireWebhook` paths; the UI just reflects whatever the worker wrote. Eliminates double-fires and false-failure webhooks from UI timeouts.

**J. Manual / runner / legacy paths.**
Non-Browserless checkouts (local runner, manual) still terminate in the UI. For those, keep client-side `confirmed`/`failed` webhooks but gate them on a workspace-scoped `localStorage` flag (`aio:notified:<jobId>`) so refreshes don't re-fire.

**K. Retry on transient Discord 429/5xx.**
Worker-side POST: 1 retry after 1s on 429 (respect `retry_after` if present) or 5xx; otherwise fire-and-forget. Never block the terminal DB write on Discord.

## Files to change

- `supabase/functions/run-checkout/index.ts` — A–F speed work + G/H/K server-side webhook fire.
- `src/lib/checkout-jobs.functions.ts` — `enqueueCheckout` accepts `notifyWebhook` + `notifyEvents`, persists onto the job row.
- `src/lib/discord.ts` — export the embed builder as a pure function the worker can import-mirror (or duplicate in the edge fn since it's Deno).
- `src/routes/_paired/index.tsx` — drop `confirmed`/`failed` `fireWebhook` calls on Browserless paths; keep them on runner/manual paths with localStorage dedup; pass current `notifyConfig` into `enqueueCheckout`.
- SQL migration — add `notify_webhook text`, `notify_events jsonb`, `webhook_fired_at timestamptz` to `public.checkout_jobs` (GRANTs already in place).

## Out of scope

- Cross-store compatibility test UI button (separate request).
- Non-Shopify storefronts.
- 3DS auto-solve.

## Verification

- Time 5 runs against a known Checkout One store before/after; expect ≥3s median reduction.
- Manually close the tab mid-run; confirm Discord still receives exactly one embed when the worker finishes.
- Force a Discord 429 (point at an invalid webhook) and confirm one retry then silent drop, with terminal DB row still written.
