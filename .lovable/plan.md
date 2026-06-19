## Goal

Make success and failure outcomes reflect the **true** result of the checkout (confirmed order vs. payment declined vs. transport/fill failure), and ensure the corresponding webhook fires for each.

## Current behaviour (the bug)

`run-checkout` returns `{ ok: true, paymentRejected: true, paymentMessage }` when Shopify shows a "payment declined" message after submit. Downstream this is treated as a *quasi-success*:

- DB row (`supabase/functions/run-checkout/index.ts` ~L1166): writes `status: "succeeded"`, `stage: "confirm"` — wrong, the order never went through.
- UI `finish()` (`src/routes/_paired/index.tsx` ~L1315-1349): sets task status to `"checkout_ready"`, shows "payment declined as expected", and **fires no webhook at all**.
- A real confirmed order fires `confirmed`; a transport/fill error fires `failed`; a decline silently disappears.

## Plan

### 1. Treat declines as failures with a distinct sub-type

In `supabase/functions/run-checkout/index.ts`:

- Final DB write: if `result.paymentRejected`, write `status: "failed"`, `stage: "payment_declined"`, `error: result.paymentMessage`. Keep `result` JSON intact so the UI can still surface the screenshot + message.
- Sanity-check confirmed success: only treat as `"succeeded"` when `result.ok === true && !result.paymentRejected && (result.orderId || /thank_you|orders\//.test(result.finalUrl || ""))`. Otherwise mark `failed` with `stage: "confirm_uncertain"` so we don't fire false-positive `confirmed` webhooks.

### 2. UI: fire the correct webhook for every outcome

In `src/routes/_paired/index.tsx` `finish()`:

- **Dry-run** (`b.dryRun`): unchanged — `checkout_ready` status, no webhook.
- **Payment declined** (`b.paymentRejected`): set task `status: "failed"`, message `Payment declined: <paymentMessage>`, and **fire `failed` webhook** with `message: "declined: <paymentMessage>"`. (Reuses existing `failed` event — no new event type or settings UI required.)
- **Confirmed**: require either an `orderId` or a thank-you URL before firing `confirmed`; otherwise fall through to the failed branch with message "Order outcome uncertain".
- **Failed** (current path): unchanged.

Apply the same logic in the runner-poll path (`runViaLocalRunner` finish branch already shares the `finish()` function, so this is one change).

### 3. Runner parity

`runner/checkout.cjs` currently has no decline detection — it returns `ok:true` with whatever URL it lands on. Add a post-submit check mirroring the edge function: if the final URL is not a thank-you/orders URL and the page body contains the existing `paymentTerms` regex match, return `{ ok: true, paymentRejected: true, paymentMessage }`. The report endpoint stores the result blob verbatim, so the UI logic from step 2 handles display + webhook uniformly.

### 4. Verification

- Run a Culture Kings task with the known-declining card → expect: task card shows red "Failed — Payment declined: …", Discord `failed` webhook posts with the decline reason, DB row `status=failed, stage=payment_declined`.
- Run a task with a card that would actually succeed (or a Shopify Bogus Gateway "1" card on a test store) → expect: `confirmed` webhook with `orderId`, status `confirmed`.
- Force a fill/transport error → expect: existing `failed` webhook still posts.

## Files to touch

- `supabase/functions/run-checkout/index.ts` — final DB write block (~L1165) + result shape comment.
- `src/routes/_paired/index.tsx` — `finish()` helper (~L1315-1349).
- `runner/checkout.cjs` — post-submit decline detection.

No schema, secret, or webhook-config changes required. The existing `failed` Discord event covers declines; users who already enabled `failed` notifications will start receiving them automatically.
