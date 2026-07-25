# Toymate HAR wire notes (login → ATC → checkout)

Captured 2026-07-25 via `scripts/toymate-capture-har.mjs`  
Account: generated vault login · PDP `productId=53116` · stop before place-order.

Full HAR (local only, **not committed**): `/tmp/toymate-login-atc-checkout.har`  
Redacted index: `docs/toymate-har-summary.json`

## Flow captured

| Step | Result |
|------|--------|
| CF warm | CapSolver `cf_clearance` then Chromium |
| Login | `POST /login.php?action=check_login` → **302** → `/account.php` |
| PDP | `GET /products.php?productId=53116` → 200 |
| ATC | `POST /remote/v1/cart/add` → **200** JSON `cart_id` |
| Cart | `GET /cart.php` → non-empty |
| Checkout | `GET /checkout` → 200 + checkout-js bootstrap |

## Critical requests (build HTTP around these)

### 1. Login
```
POST https://toymate.com.au/login.php?action=check_login
content-type: application/x-www-form-urlencoded
origin/referer: https://toymate.com.au/login.php

login_email=...&login_pass=...&authenticity_token=...&sf_authenticity_token=...
→ 302 Location: /account.php?...
Sets: SHOP_SESSION_TOKEN, SHOP_TOKEN, SHOP_DEVICE_TOKEN, …
```

Note: browser login also sends `sf_authenticity_token` (UUID) in addition to `authenticity_token`.

### 2. ATC (Stencil remote — **not** Storefront `POST /api/storefront/carts`)
```
POST https://toymate.com.au/remote/v1/cart/add
content-type: multipart/form-data
x-requested-with: stencil-utils
x-xsrf-token: <XSRF-TOKEN cookie value>
origin: https://toymate.com.au
referer: <PDP url>

fields:
  action=add
  product_id=<id>
  qty[]=1

→ 200 application/json
{
  "data": {
    "cart_id": "<uuid>",
    "cart_item": { "id": "<uuid>", "product_id": 53116, ... }
  }
}
```

This is the storefront theme path. Our adapter’s Storefront carts API still works with XSRF; HAR proves the native ATC is `/remote/v1/cart/add`.

### 3. Checkout bootstrap
```
GET https://toymate.com.au/api/storefront/checkouts/<cart_id>
x-xsrf-token: …

GET https://toymate.com.au/checkout
→ loads checkout-js (microapps.bigcommerce.com) + bc-checkout-v2
```

Payment-methods (`GET /api/storefront/payments`) did **not** appear in this capture before close — checkout-js chunks were still loading. Prior API probe already locked Adyen `scheme` + `X-API-INTERNAL` for that call.

## Adapter status (built from this HAR)

1. **Done** — primary ATC is `POST /remote/v1/cart/add` (multipart + `stencil-utils`); Storefront carts is fallback (`cart_add` step).
2. **Done** — login sends both tokens: `authenticity_token` ← jar `XSRF-TOKEN`, `sf_authenticity_token` ← jar `SF-CSRF-TOKEN` (HTML hidden fields as fallback). Stencil/API also send `x-sf-csrf-token`.
3. **Done (constraint)** — module place-order is **HTTP-only**. Playwright must not run in adapter flows; UI helpers quarantined under `experiments/`.
4. **HTTP pay wire — PROVEN decline (2026-07-25)** — spam-protection must match checkout-sdk: `POST …/spam-protection` body `{ "token": "<recaptcha>" }` (+ optional GraphQL `applyCheckoutSpamProtection`). Then GraphQL `completeCheckout` → `paymentAccessToken`, or `internalapi/v1/checkout/order` (payment token often in response header `token`). BigPay `POST https://payments.bigcommerce.com/stores/{storeHash}/payments` with `Authorization: PAT …` + card instrument (`adyenv3.card` / `.scheme`).
5. **Live proof** — synthetic Visa `4000000000000002` → BigPay **422 / code 30102 / "The payment was declined."** (`paymentDeclined: true`). Disposable Mastercard → **422 / 30106 insufficient funds** (bank ping). Spam cleared `200 via rest`.
6. **Double-auth bug (fixed)** — CSE fallback used to run on *any* non-2xx BigPay response, including 422 declines → two bank auths per checkout. CSE now only runs on clear method/instrument-shape errors; decline/422 stops after one BigPay POST.
