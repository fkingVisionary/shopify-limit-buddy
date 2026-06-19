## Problem

From the screenshot: cart → checkout → address → shipping → payment_continue all succeeded, but the card iframe rendered as an unstyled **legacy fallback** ("Issue date / Issue number / Name on card" twice). Our `card_fill` step logged ✓ because the heuristic typed "M edwards" into one of those fallback inputs, but Shopify's real card-fields iframe was never reached and no real tokenisation occurred. This is fragile across stores — every Shopify checkout version (legacy `/checkouts/<token>`, Checkout One `/checkouts/cn/<token>`, Hydrogen, headless) renders different DOM, so DOM scraping will never be reliable.

## Goal

Stop scraping the payment iframe DOM. Use Shopify's **documented, standardised** path that every store supports:

1. `POST https://deposit.us.shopifycs.com/sessions` → returns a vault `session id` (works for every Shopify store; this is what Cybersole/Wrath/Valor use)
2. Submit checkout completion via Shopify Checkout One **GraphQL** (`submitForCompletion` / `checkoutComplete`) with that session id as the payment method

This is store-agnostic and avoids the iframe entirely.

## Plan

### 1. New vault helper (already partially exists)
- Promote the `payment_vault` block from `src/lib/shopify-http-checkout.functions.ts` into a shared helper `vaultCard(card, hostname) → sessionId` in `src/lib/shopify-vault.functions.ts`.
- Add response validation + retries (deposit.us, deposit.eu fallback by store region).

### 2. Replace browser-based card_fill with vault + GraphQL submit
In `supabase/functions/run-checkout/index.ts`:
- After `payment_continue`, instead of `fillCardField(...)`:
  - Read `checkoutToken` from the page URL (`/checkouts/cn/<token>`).
  - Scrape `x-checkout-one-token` / `_shopify_y` cookies + queue token from the page (available via `page.cookies()` and `document.querySelector('meta[name="shopify-checkout-authorization-token"]')`).
  - Call `vaultCard()` from inside the page context (so the proxy IP is used) via `page.evaluate(fetch(...))`.
  - POST the GraphQL `submitForCompletion` mutation to `/checkouts/unstable/graphql` with `paymentMethod: { directPaymentMethod: { sessionId, billingAddress, cardSource } }`.
  - Poll `pollForReceipt` until `receipt.processing === false`, then read `redirectUrl` → thank-you page.
- Keep the existing browser flow up to `payment_continue` (it works) — only swap the card-fill + submit steps.

### 3. Legacy checkout fallback
- If URL is `/checkouts/<token>` (not `/cn/`), fall back to the **classic** flow: vault → POST `previous_step=payment_method&step=&s=<sessionId>&checkout[payment_gateway]=<id>&checkout[total_price]=<cents>` to the checkout URL. Scrape `payment_gateway` id and `total_price` from the rendered payment page (stable selectors: `input[name="checkout[payment_gateway]"]`, `[data-checkout-payment-due-target]`).

### 4. Detection / routing
Add an early branch at `lastStep = "payment_continue"`:
```text
url contains "/checkouts/cn/"  → Checkout One GraphQL path
url contains "/checkouts/"     → legacy form-POST path
otherwise                       → fail with "unsupported checkout"
```

### 5. Cross-store compatibility checklist (codified as a self-test serverFn)
New `src/lib/checkout-selftest.functions.ts` runs a **dry-run vault-only** test against any store URL + variant id:
1. cart/add.js → expect 200
2. POST /cart → follow → expect `/checkouts/`
3. GET checkout → detect version (cn vs legacy)
4. POST contact + shipping
5. Poll shipping_rates.json
6. POST shipping_method
7. Scrape `total_price` + `payment_gateway` id (or Checkout One queue token)
8. Vault a **test card** (`4111 1111 1111 1111`) → expect `id`
9. Stop before real submit, return a `compat report` with version, total, gateway id, vault ok, elapsed.

Expose a "Test checkout path" button on each store card in `src/components/StoresPanel.tsx` (or wherever stores are listed) that calls this and shows the report inline.

### 6. Verification
- Run the self-test against Culture Kings (Checkout One) and 2 other stores from the user's store list (legacy + cn).
- Run one real task with the new path, confirm card_fill is removed from the timeline and replaced by `vault` + `graphql_submit`.

## Technical details

- Card vault endpoint: `https://deposit.{region}.shopifycs.com/sessions`, JSON body `{ credit_card: { number, name, month, year, verification_value }, payment_session_scope: "<store-hostname>" }`. Returns `{ id }`. No auth, no CORS issue from the browser context.
- Checkout One GraphQL endpoint: `https://<store>/checkouts/unstable/graphql?operationName=SubmitForCompletion`, headers `x-checkout-one-token`, `x-checkout-web-source-id`. Body schema follows Shopify's `NegotiationInput`. We will store the mutation as a constant string in `src/lib/checkout-one-graphql.functions.ts` (already exists — extend it).
- Legacy submit: standard URL-encoded POST that Shopify has supported since 2015; `s=` is the vault session id, `checkout[payment_gateway]` is the gateway id from the payment-method page.
- Proxy: every fetch runs inside `page.evaluate` so it goes out through Browserless's authenticated proxy session (already configured).

## Out of scope (this turn)

- Shop Pay / Apple Pay / wallet payments.
- 3DS challenge flow (will surface as `redirectUrl` to bank — we'll log and stop; future work).

## Files

- new: `src/lib/shopify-vault.functions.ts`, `src/lib/checkout-selftest.functions.ts`
- edit: `supabase/functions/run-checkout/index.ts` (replace card_fill block, add version routing)
- edit: `src/lib/checkout-one-graphql.functions.ts` (extend with submit mutation)
- edit: store list UI (add "Test path" button + report)
