# Shopify module — add-to-cart + checkout handoff (no payment)

_Status: live. Pre-payment only — this module never places an order._

Generic Shopify adapter for the fast, browserless pre-payment leg: resolve a
variant, add to cart, and hand back a ready-to-pay checkout URL. Payment (card
vault + Checkout One completion) is intentionally **out of scope**.

- Code: [`adapters/shopify.js`](../adapters/shopify.js) (`runShopify` + `shopifyAdapter`)
- Solver: [`adapters/shopify-captcha.js`](../adapters/shopify-captcha.js)
- Tests: `adapters/shopify.test.mjs`, `adapters/shopify-captcha.test.mjs`
- Live smoke: [`scripts/shopify-live-smoke.mjs`](../scripts/shopify-live-smoke.mjs)

## Routing

`pickAdapter` in `adapters/index.js` tries the dedicated retailer adapters
first (kmart/toymate/bandai/pkc/disney), then `shopifyAdapter` for
`*.myshopify.com`. Any other host falls through to the same `runShopify` via
the generic fallback in `checkout.js`, so custom-domain Shopify stores
(allbirds.com, deathwishcoffee.com, …) are covered by one implementation.

## Wire format (all public, documented endpoints)

| Step | Request | Notes |
|---|---|---|
| `warm_home` | `GET /` | seeds `cart_currency` / `_shopify_*`; first place a Cloudflare interstitial appears |
| `product_get` | `GET /products/{handle}.js` | optional (needs `handle`/`pdpUrl`); reports title/price/availability |
| `cart_add` | `POST /cart/add.js` (JSON) | `{"items":[{"id":variantId,"quantity":qty}]}`; errors classified |
| `cart_get` | `GET /cart.js` | the cart-win milestone (`item_count`, `total_price`, `token`) |
| `cart_checkout` | `POST /cart` (`checkout=`) | 302 → resolve the real checkout URL |
| `checkout_page` | `GET /checkouts/cn/{token}` | confirm the page loads; nothing submitted |
| `payment_skipped` | — | explicit boundary marker |

**Checkout URL resolution.** A modern `POST /cart` 302s to the Shop Pay
"universal redirect" on `shop.app`, with the store's real
`/checkouts/cn/{token}` URL in the `ur_back_url` query param. `resolveCheckoutUrl`
extracts that (and forces `skip_shop_pay=true`) instead of following onto
`shop.app`. It also handles a direct same-host `/checkouts/…` redirect.

**`checkoutStage`:** `pre_cart` → `cart_atc` → `checkout_ready`.

**ATC error reasons** (`cart_add` failure): `sold_out`,
`selling_plan_required`, `variant_not_found`, `quantity_limit`,
`rate_limited`, `cart_add_failed`.

## Antibot / solvers

A solver only fires on an actually-blocking response (403/429/503 or
`cf-mitigated: challenge`) — a normal 200 page that merely references a captcha
is never treated as a challenge. Enabled automatically whenever a provider key
is present; `task.captcha:false` disables; `task.captchaProvider` forces one.

| Env var | Provider | Solves |
|---|---|---|
| `TWOCAPTCHA_API_KEY` | 2captcha | reCAPTCHA v2/v3, hCaptcha, Turnstile |
| `CAPSOLVER_API_KEY` | CapSolver | reCAPTCHA (+Enterprise), hCaptcha, Turnstile, Cloudflare (`AntiCloudflareTask`) |
| `UNCAPTCHA_API_KEY` | uncaptcha.io | Cloudflare Turnstile + WAF |
| `HYPER_API_KEY` | Hyper Solutions | Akamai / Incapsula / DataDome (rare for Shopify) |

Auto-routing preference: Turnstile/WAF → uncaptcha → capsolver → 2captcha;
reCAPTCHA/hCaptcha → 2captcha/capsolver; Akamai → hyper.

**Cloudflare note.** `cf_clearance` is bound to the egress **IP + User-Agent**.
The solver is called through `task.proxy` (so the clearance matches your exit),
and the returned `userAgent` is pinned onto the jar for the retry. A hard 403
from a **datacenter IP is not a challenge** — it's an IP block; use a
residential/ISP proxy first, then the solver clears any interstitial.

Optional knobs: `UNCAPTCHA_WAF_TASK_TYPE` (your account's exact Cloudflare-WAF
task string — WAF via uncaptcha is skipped if unset), `CAPTCHA_PROVIDER`,
`CAPTCHA_FIRST_POLL_MS` / `CAPTCHA_POLL_MS`, and `*_BASE` endpoint overrides for
staging.

## Live test (no order placed)

```bash
cd executor
PROXY_URL="http://user:pass@host:port" \
CAPSOLVER_API_KEY=... UNCAPTCHA_API_KEY=... \
node scripts/shopify-live-smoke.mjs https://www.deathwishcoffee.com 39983629828151 1
```

Expect `cart_add` + `cart_get` 200 and a resolved `checkoutUrl`. With a good
residential proxy + solver you also get `checkout_page` 200 and
`checkoutStage=checkout_ready`. From a datacenter IP without a proxy, expect
`warm_home`/`checkout_page` 403/429 and `checkoutStage=cart_atc` — that's the IP,
not the code.

Find a current purchasable `variantId` with:
`curl -s "https://<store>/products.json?limit=50"` (look for `variants[].id`
with `available:true`).

## Boundary

This module does not vault cards, call `deposit.*.shopifycs.com`, or hit the
Checkout One completion GraphQL. It stops at a prepared cart + checkout URL.
