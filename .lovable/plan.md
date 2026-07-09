# Full HTTP Checkout — Kmart AU to order confirmation

Focus this batch on finishing the Kmart adapter end-to-end. Everything stays as HTTP chains through the Fly executor (residential-proxy-capable) — no Playwright, no browser. The existing adapter already lands PDP with `_abck ~0~`, creates the cart, adds to bag, warms checkout, sets addresses, tokenizes at Paydock and calls `create3DSToken`. Two things are missing: 3DS handling and the final `placeOrder` mutation.

## Deliverables

1. **Capture the missing GraphQL ops from live traffic** — `create3DSToken` response variants and the real `placeOrder` / `submitOrder` mutation (op name, query, variables, expected response shape). Recon step, no user action required beyond a real successful web-checkout HAR if one is available; otherwise infer from bundle JS already fetched during `checkout_warm`.
2. **3DS branch** — inspect the `create3DSToken` response:
   - `status: "not_required"` → skip challenge, go straight to submit.
   - `status: "challenge"` with `acsUrl` + `sessionData` → POST the challenge in headless HTTP (Paydock's 3DS is iframe-postMessage but the underlying calls are plain HTTPS); poll `charge3DSStatus` until resolved. Frictionless 3DS (99% of test cards) resolves in one round.
   - Record each sub-step in the timeline.
3. **placeOrder mutation** — wire the real op name captured in step 1, feed `paymentToken` from the 3DS result + `cartId`/`cartVersion`. Parse the returned `orderNumber` / `orderId`. Add to result JSON.
4. **Execution path** — Fly executor only for checkouts (proxies + real IP + long-lived dispatcher). ServerFn stays as the dispatcher (`runOnExecutor`). Electron runner is unchanged and out of scope this round.
5. **Concurrency at ~100** — audit the adapter for shared mutable state (cookie jar, dispatcher). Each task already gets its own jar+dispatcher in `checkout.js`, so the only real risk is Fly instance memory. Bump `fly.toml` VM to a size that comfortably holds 100 concurrent HTTP chains and add a `MAX_CONCURRENT` guard in `server.js` that rejects with 429 above the cap so a burst can't OOM the box.
6. **Card flow** — accept per-task `card` (already does), fall back to env only for smoke tests. Never log the PAN; the current `note` string already masks — verify.
7. **Result contract** — extend adapter return with `orderNumber`, `orderId`, `paymentStatus`, plus the same `steps` timeline. Surface these on the checkout UI (whichever panel is calling `runOnExecutor` today).

## Explicitly out of scope

- Playwright / real browser paths — user vetoed.
- JB Hi-Fi checkout (discovery-only for now).
- Generic Shopify submit hardening (`shopify-http-checkout.functions.ts` `TODO_REAL_SUBMIT`) — separate follow-up if the user wants it after Kmart is live.

## Technical notes

- `executor/adapters/kmart.js` step 8f already dispatches `create3DSToken`; add a new `handle3DS` helper right after it that branches on response `status`, does the POST-to-`acsUrl` + poll loop, and returns the final `paymentToken`.
- The real placeOrder op name isn't captured yet. Two ways to get it:
  - **Preferred**: user pastes a HAR of one successful web checkout (any card, any product) — we grep for `mutation.*[Oo]rder` in the request bodies.
  - **Fallback**: the checkout bundle JS fetched by `checkout_warm` embeds op names as string literals. Add a recon step that greps `checkoutHtml` (and follows `<script src>` refs) for `/mutation \w*[Oo]rder/`.
- Keep the adapter idempotent: if `task.placeOrder !== true` (default), stop after `create3DSToken` — matches current behaviour and gives us a safe "full-chain-except-charge" dry-run.
- `runOnExecutor` schema already accepts arbitrary passthrough; just add `placeOrder: boolean` to the input validator so the UI can flip it per task.

## Open question before build

To capture the placeOrder mutation, do you have a HAR (or DevTools Network export) from a real successful Kmart web checkout you can share? If not, we go the bundle-grep route — slower but works.
