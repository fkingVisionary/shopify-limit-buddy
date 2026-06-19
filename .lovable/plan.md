## Goal

- Eliminate Browserless 408/timeout failures.
- Drive end-to-end checkout time to <15s (currently ~70s).

## Why it's slow today

`supabase/functions/run-checkout/index.ts` drives a full headless browser through every Shopify checkout screen with conservative waits. The biggest costs:

1. Loading `storeUrl` and `/checkout?...qs` with all images, fonts, third-party scripts (analytics, Shop Pay, Klarna, etc.) — easily 5–15s per nav.
2. Sequential GET → fill → continue → fill → continue across contact / shipping / payment, each gated by `setTimeout`s (150–600ms) and `waitForNetworkIdle` calls.
3. `bringPaymentIntoView` / `selectCreditCardPayment` / `selectShippingRate` each have their own 4.5–5s deadlines that often run to the end.
4. Single Browserless `/function` call with `timeout=60000` — if anything stalls, the whole job 408s and we restart from cart.

## Plan

### 1. Block heavy resources at the browser (biggest single win)

In the Browserless script, install a request interceptor right after `page` is available:

- Abort: `image`, `font`, `media`, `stylesheet` not on the checkout origin, and any request whose host matches a denylist (`google-analytics`, `googletagmanager`, `facebook`, `hotjar`, `clarity`, `segment`, `tiktok`, `pinterest`, `klaviyo`, `shop.app/pay`, `paypal`, `klarna`, `afterpay`, `bing`, `doubleclick`, `cdn.shopify.com/.../shop_pay`, etc.).
- Keep: documents, XHR/fetch, scripts on the shop's own origin, and Shopify checkout assets needed to render the card iframe (`*.shopifycs.com`, `pay.shopify.com` card-fields frame).

Expected: 60–80% faster nav + lower memory.

### 2. Skip the UI for everything before payment

Replace the `/checkout?...qs` GET + UI address fill + "Continue to shipping" + shipping-rate click + "Continue to payment" sequence with direct Shopify endpoints, then jump straight to the payment step in the browser:

- `POST /cart/add.js` (already done).
- `POST /cart/update.js` with shipping address attributes, or `POST /wallets/checkouts.json` to create a checkout with address + email server-side.
- `GET /cart/shipping_rates.json?...` to pre-compute the rate id.
- `POST /checkouts/{token}.json` with `shipping_rate.id` and contact info.
- Then `page.goto(checkoutUrl + '?step=payment_method', { waitUntil: 'domcontentloaded' })` and only run UI code from `card_fill` onward.

The browser is only used for the card iframe + Pay Now click (the parts that genuinely require JS/Stripe-like tokenization). This collapses ~4 navigations into 1.

### 3. Trim the remaining browser waits

Inside the `card_fill` → `submit` → `payment_result` block:

- Replace fixed `setTimeout(600/450/250/150)` with `page.waitForSelector` / `page.waitForFunction` against the actual element we need next, with tight timeouts (≤1500ms) and early-exit.
- Drop `bringPaymentIntoView` (no longer needed — we navigate to payment step directly).
- `selectCreditCardPayment` deadline 5000ms → 1500ms; bail to first card radio without polling if it's already selected.
- `securityCodeRetryNeeded` only runs when the result loop sees a CVV-shaped error; remove the unconditional retry path.
- `resultDeadline` 30s → 12s; thank-you URL detection via `page.waitForFunction` instead of 500ms poll.
- Skip the success-path `page.screenshot` (or run it only on failure) — full-page b64 screenshots add ~500ms–1s and a lot of payload.

### 4. Browserless transport hardening (kills the 408)

- Switch from `/function` (60s hard cap on your plan) to a Puppeteer WebSocket connection: `wss://production-sfo.browserless.io?token=…&timeout=120000&stealth=true&blockAds=true`. `blockAds=true` is Browserless-side ad/tracker blocking on top of our interceptor.
- The edge function still drives the script, but the session can run longer than 60s without 408ing the worker.
- Add a single retry-on-408: if the first connection 408s before `card_fill`, reconnect once and resume from cart (cart cookie still valid on the same proxy session via `proxySticky`).
- Keep `timeout=120000` as a safety net only — the goal is to finish in <15s.

### 5. Status / UX

- `checkout_jobs.stage` already drives the polling UI; no schema changes needed.
- Add two new stages so the user sees progress on the new fast path: `prefill_api` (covers cart_add + address + shipping_rate via API) and `payment_open`.

### Out of scope

- No changes to client polling, auth, or schemas.
- No changes to product resolution / proxy selection.
- Keep the existing "decline = success" mapping in `src/routes/_paired/index.tsx`.

## Technical notes

Files touched:

- `supabase/functions/run-checkout/index.ts`
  - Add `page.setRequestInterception(true)` + abort handler with allow/deny lists.
  - Add `prefillCheckoutViaApi(page, input)` helper that POSTs to `/cart/add.js`, `/cart/update.js`, `/wallets/checkouts.json`, `/cart/shipping_rates.json`, then `PATCH /checkouts/{token}.json` with the chosen rate.
  - Replace the `/checkout?qs` GET + `address_fill` + `shipping_continue` + `shipping_method` + `payment_continue` block with `prefillCheckoutViaApi` followed by `page.goto(paymentStepUrl)`.
  - Replace fixed sleeps in `card_fill`/`submit`/`payment_result` with `waitForSelector`/`waitForFunction`.
  - Swap the Browserless `/function` HTTP call for `puppeteer.connect({ browserWSEndpoint })` (Browserless WS endpoint) with `timeout=120000`, `blockAds=true`, `stealth=true`.
  - Single retry on 408 / WS close before `card_fill`.
  - Make success-path screenshot optional (skip by default).
- No frontend changes.

Risk: Shopify's `wallets/checkouts.json` and `checkouts/{token}.json` shapes vary per store (Checkout Extensibility vs legacy). The plan falls back to today's UI path if the API prefill returns non-2xx, so worst case we match current behavior with the new resource blocker still active (which alone should drop runtime ~50%).
