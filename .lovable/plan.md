# JB Hi-Fi checkout support (Browserless)

JB Hi-Fi is **Shopify Plus** but everything user-facing is custom: the cart is a React app mounted at `#cart-services`, the PDP is a `theme-jbhifi` Liquid template, and checkout runs on a JB-branded host (not `*.myshopify.com`). Standard selectors from the generic Browserless script will not work. Akamai (`_abck`, `bm_sz`) sits in front of every page, so the bot has to behave like a real browser from page one — no raw `fetch('/cart/add.js')` from a cold context.

The plan is three small phases: a one-off recon pass to capture real selectors/endpoints, a per-store "adapter" abstraction so JB Hi-Fi doesn't pollute the generic Shopify path, then the JB Hi-Fi adapter itself.

## Phase 1 — Recon (one Browserless run, no commit yet)

Add a temporary `recon` mode to `supabase/functions/run-checkout/index.ts` that, given a JB Hi-Fi product URL:

1. Loads the PDP with a real UA + viewport, waits for `#cart-services` React to mount, screenshots.
2. Clicks the real "Add to cart" button (not `/cart/add.js`) and screenshots the resulting cart drawer.
3. Clicks "Checkout", follows redirects, and records: final checkout host, whether it's classic Shopify `/checkouts/cn/<token>` or Shopify's new one-page checkout, and the DOM structure of each step.
4. For each step (contact, shipping address, shipping method, payment), dumps: every visible `<input>`/`<select>` with its `name`, `id`, `aria-label`, and the surrounding label text; every `<button>` with its text and `data-*` attributes; every `<iframe>` `name`/`src`.
5. Detects payment provider iframes (Stripe `card-fields-*`, Adyen `adyen-checkout`, Braintree `braintree-hosted-field`) and BNPL tiles (Afterpay/Zip/humm/PayPal/Apple Pay).

Output is a JSON blob written to the job's `result` column and screenshots base64'd in `session`. We read it once and throw the recon code away.

## Phase 2 — Store-adapter abstraction

Right now `run-checkout/index.ts` hardcodes the generic Shopify flow. Refactor so the worker picks an **adapter** by hostname:

```text
adapters/
  shopify-generic.ts   // current behavior, default
  jbhifi.ts            // new
```

Each adapter exports the same interface:

```ts
type Adapter = {
  matches: (storeUrl: string) => boolean
  addToCart: (page, job) => Promise<void>
  gotoCheckout: (page, job) => Promise<void>
  fillContact: (page, profile) => Promise<void>
  fillAddress: (page, profile) => Promise<void>
  selectShipping: (page) => Promise<void>
  fillPayment: (page, card) => Promise<void>
  submit: (page) => Promise<void>
  detect3DS: (page) => Promise<boolean>
  detectDecline: (page) => Promise<string | null>
  detectSuccess: (page) => { ok: boolean; orderId?: string }
}
```

The worker calls `writeStage()` between steps (`cart_add`, `checkout_load`, `address`, `shipping`, `payment_submitting`, `three_d_secure`, `confirm`) so the UI stage labels already added last turn light up uniformly across adapters. No UI changes this turn.

## Phase 3 — JB Hi-Fi adapter

Built from Phase 1 recon output. Expected shape (will be verified, not assumed):

- **addToCart**: navigate to PDP, wait for `#cart-services` mount, click the in-page add-to-cart button via Playwright/Puppeteer click (not XHR) so Akamai sees a real user gesture. Wait for cart drawer state.
- **gotoCheckout**: click the cart's "Checkout" button, wait for navigation to the JB-branded checkout host, capture the checkout token from the URL.
- **fillContact / fillAddress**: single-pass `page.evaluate` (same pattern as last turn's optimization) using JB-specific selectors discovered in recon. AU address: `country=AU` preselected, `province` is state code (`NSW`/`VIC`/etc.), `zip` is 4 digits.
- **selectShipping**: pick first available rate; JB usually offers Standard + Express + Click & Collect — default to Standard.
- **fillPayment**: detect provider from recon. If Stripe iframes, reuse existing card-iframe fill; otherwise branch (Adyen/Braintree).
- **submit + detect3DS**: same loop as today but with 3DS frame URL patterns confirmed for JB's PSP, and decline phrases tuned to JB's actual error copy.

## Anti-bot hardening (applies to both adapters)

- Set UA + `sec-ch-ua` + `accept-language: en-AU` and viewport `1440x900`.
- Use `--disable-blink-features=AutomationControlled` (already set) and add `navigator.webdriver=false` + plausible `navigator.languages` via `evaluateOnNewDocument`.
- Always load the PDP first (warms `_abck`) before touching cart — never POST `/cart/add.js` from a cold context against JB.
- Route the Browserless session through the AU residential proxy (`PROXY_URL_RESI`) if it's AU-exit; if it isn't, flag that we need an AU proxy before JB will be reliable.

## Webhooks + stages

No changes — `fireTerminalWebhook` and the `writeStage` calls added last turn already cover the new adapter as long as it emits the same stage strings.

## Files to change (Phase 2 + 3)

- `supabase/functions/run-checkout/index.ts` — switch to adapter dispatch.
- `supabase/functions/run-checkout/adapters/shopify-generic.ts` — extract current logic verbatim.
- `supabase/functions/run-checkout/adapters/jbhifi.ts` — new, built from Phase 1 output.

## Open questions for you

1. **Proxy**: is `PROXY_URL_RESI` an AU exit? JB will geo-fence / Akamai-flag non-AU IPs quickly.
2. **BNPL**: do you only care about card checkout, or do you also want Afterpay/Zip flows?
3. **Recon run**: OK for me to ship Phase 1 first as a throwaway `mode: "recon"` job, run it once against the Pokemon URL, then build Phases 2–3 from the captured DOM? That's far more reliable than guessing selectors.
