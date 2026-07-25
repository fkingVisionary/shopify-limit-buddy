# Toymate AU — Module notes

_Status: adapter restored (isolated from Kmart)_

## Platform

| Signal | Finding |
|--------|---------|
| Host | `toymate.com.au` / `www.toymate.com.au` |
| Stack | BigCommerce (Stencil) + Cloudflare |
| Adapter | `executor/adapters/toymate.js` |
| CF solve | CapSolver `AntiCloudflareTask` (`toymate-cf-solve.js`) |

**Hyper / Akamai / Paydock are not used.** Kmart paths stay untouched.

## Modes (`task.toymateMode`)

1. **`account_gen`** — CapSolver CF warm → create-account form → POST `login.php?action=save_new_account` → save `{ email, password }`.
2. **`checkout`** — CF warm → optional login (XSRF + SF-CSRF) → PDP → **`POST /remote/v1/cart/add`** ATC → Storefront checkout → spam reCAPTCHA → **Adyen v3 `scheme` HTTP place-order** (BigPay). **No Playwright in the module path** — browser is research-only (`experiments/toymate-checkout-ui-research.mjs`, HAR capture scripts). **Decline proven** on synthetic card (BigPay 422 / 30102); real paid order still needs a live card + bank monitor.
3. **`monitor`** — keyword search hit/miss.

### Payment notes
- Methods: `GET /api/storefront/payments?cartId=…` with `Accept: application/vnd.bc.v1+json` + `X-API-INTERNAL: This API endpoint is for internal use only and may change in the future`.
- Card gateway on Toymate tip: Adyen v3 `scheme` (not raw Storefront PAN POST).
- Spam body (checkout-sdk): `{ "token": "<recaptcha>" }` — nested `spamProtection` shape fails silently / 429s.
- CLI live decline: `scripts/toymate-checkout-live-once.mjs` / rotate `scripts/toymate-http-decline-rotate.mjs` (CapSolver + optional `TOYMATE_CARD_*`; do not commit card).
- **Proven:** 2026-07-25 HTTP path → `paymentDeclined: true` / BigPay `30102 The payment was declined.`

### HAR capture
- `scripts/toymate-capture-har.mjs` — login → ATC → checkout (no charge).
- Wire notes: `docs/toymate-har-wire.md` · redacted index: `docs/toymate-har-summary.json`.
- Native ATC is `POST /remote/v1/cart/add` (`x-requested-with: stencil-utils`), not Storefront carts.

## Desktop

- Task store option: **Toymate AU**
- Settings: **CapSolver API key** (passed to sidecar as `CAPSOLVER_API_KEY`)
- **Accounts** tab stores generated logins (`storeId` + email)

## Isolation rules

- Registry: `adapters/index.js` only adds `toymateAdapter` next to `kmartAdapter`.
- Desktop: `buildToymatePayload` is a separate branch from `buildKmartPayload`.
- Do not gate Kmart engine start on CapSolver; do not gate Toymate on Hyper inside the adapter.
- **No Playwright (or any browser automation) inside adapter/module flows.** Browser is for HAR/recon scripts under `scripts/` + `experiments/` only.
