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

## Verify a solver key (quick)

Confirm a provider key + the wiring work, independent of any store, against a
public Turnstile demo (Cloudflare's `3x…FF` interactive test sitekey):

```bash
cd executor
UNCAPTCHA_API_KEY=... node -e '
import("./adapters/shopify-captcha.js").then(async (m) => {
  const r = await m.solveChallenge(
    { type: "turnstile", siteKey: "3x00000000000000000000FF" },
    { pageUrl: "https://2captcha.com/demo/cloudflare-turnstile", provider: "uncaptcha" });
  console.log(r.ok ? `ok via ${r.via}, tokenLen=${String(r.token).length}` : `FAIL: ${r.error}`);
});'
```

Verified 2026-10: uncaptcha returns a ~770-char Turnstile token. Swap the key
env + `provider` for `capsolver` / `2captcha` to check those.

> Residential-proxy runs cannot be tested from a restricted cloud sandbox
> (outbound is locked to an allowlist). Run the full `scripts/shopify-live-smoke.mjs`
> command where the executor runs (Fly / desktop), which is also where the
> proxies are reachable.

## Fraud / risk tracking (buyer-side, read-only)

`adapters/shopify-risk.js` watches an order **after** it's been submitted (by the
full desktop bot — this executor's adapter stops before payment) and records
when it gets flagged. It only reads order state and appends a quiet JSONL line
(`SHOPIFY_RISK_LOG`, default `<tmpdir>/j1m-shopify-risk.jsonl`) — no alerts, no
store writes.

**Buyer vs merchant (important).** Shopify's actual fraud score and the exact
indicators that fired (CVV/AVS, "high risk internet connection", billing≠shipping,
device velocity) are **merchant-only** (`order.risk` on the Admin API). From the
buyer side you only ever see the *downstream effect*: the order flipping to
cancelled / refunded / held. So `correlateFlag()` yields *likely causes* at
`low`/`medium` confidence, never ground truth — and says so.

| Function | Does |
|---|---|
| `parseOrderStatus(input)` | order JSON **or** order-status HTML → `{ financialStatus, cancelled, cancelReason, flagged, flagSignal }` (`cancelled_fraud` / `refunded` / `payment_review` / `cancelled` / `paid`) |
| `riskSignalsFromRun(result, task)` | buyer-visible pre-submission signals: `three_ds_stepup`, `captcha_rechallenge`, `billing_shipping_mismatch`, `proxy_used`, `declined` |
| `classifyOutcome(prev, curr)` | flip detection (`paid → cancelled/refunded/held`) |
| `correlateFlag(outcome, signals)` | maps a flag + run signals → likely-cause lines + honest confidence + merchant-side caveat |
| `pollOrderStatus({orderStatusUrl, ctx, ...})` | polls the order-status URL until flagged/terminal, logging each change |
| `recordRiskEvent(taskId, event, fields)` | quiet JSONL append + one console line |

**Watch an order (no store changes):**

```bash
cd executor
PROXY_URL="http://user:pass@host:port" \
RUN_SIGNALS='["proxy_used","billing_shipping_mismatch"]' \
node scripts/shopify-order-watch.mjs "<order_status_url>" 30 60
```

`<order_status_url>` is the buyer link Shopify returns after an order; `30` =
poll seconds, `60` = max minutes. `RUN_SIGNALS` seeds what the checkout run saw
so a later flag can be correlated to it.

> To trace a flag to its *exact* indicator you need the merchant/Admin-API side
> (`order.risk.assessments { riskLevel, facts { description sentiment } }`),
> which is only available on a store you own — e.g. a dev store set up for
> testing. That path is intentionally not built here (buyer-side scope).

## Boundary

This module does not vault cards, call `deposit.*.shopifycs.com`, or hit the
Checkout One completion GraphQL. It stops at a prepared cart + checkout URL.
The risk tracker only *reads* order state and logs — it never cancels or refunds.
