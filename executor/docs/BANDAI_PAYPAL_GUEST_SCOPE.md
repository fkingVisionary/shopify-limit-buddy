# Bandai AU — PayPal guest checkout (scope)

**Date:** 2026-08-05  
**Goal:** Offer **PayPal guest** alongside card on Bandai Fast, because PayPal
often clears better than card on high-traffic drops.

Lab status **2026-08-05:** wire IDs locked from Checkout/v2 HAR; **Fast HTTP**
minted a live `paypal.com/checkoutnow?token=…` approve URL (disposable profile
last4 `3562`). Desktop UI select still TODO.

---

## Why

- Card Fast works (hydrate → issuer). Soft-decline Revolut ×2 is treated as
  **rail behaviour** — not a reason to keep dual-hunt knobs.
- PayPal often clears better on contested drops; Toymate already has manual PP.
- Bandai GE mid **1925** exposes PayPal in Checkout/v2.

---

## Wire (captured)

| Field | Value |
|---|---|
| `SelectedPaymentMethodID` / `data-id` | **4** |
| Gateway (`data-gw`) | **6** |
| Mode | `fullredirect` + `data-newwindow=true` |
| Tile | `.payMet[title="PayPal"]` / `.payMet[data-id="4"]` (sprite, not text label) |
| Init (works) | `GET webservices.global-e.com/Payments/InitPayPalExpressProcess?cartToken={guid}` |
| Init (404) | `secure-bandai…/Payments/InitPayPalExpressProcess` |
| Approve shape | `https://www.paypal.com/checkoutnow?token=…` |

Artifacts: `artifacts/bandai-paypal-wire.json`, `artifacts/bandai-paypal-guest.har`
(Checkout/v2), `artifacts/bandai-paypal-http-probe.json` (Fast approve mint).

---

## Current state

| Surface | PayPal |
|---|---|
| Bandai Fast HTTP | **Lab path:** `paymentMethod=paypal_guest` → save pm=4/gw=6 → InitPayPalExpress → `paypalApproveUrl` |
| Bandai Full browser HAR | Reached GE; tile click flaky / SoftBlock; IDs from HTML |
| Desktop task UI | Still Toymate-only pay select |
| Toymate | `paypal_manual` → BigCommerce approve URL |

---

## Recommended v1 — PayPal guest / manual approve (Toymate-shaped)

Mirror Toymate’s proven ops loop: bot races cart + checkout setup; human finishes
PayPal in a browser when the approve URL is ready.

### Task / UI

- Extend Bandai task field: `paymentMethod: "credit_card" | "paypal_guest"`
  (default `credit_card`).
- Desktop: show a Bandai pay-method select (same pattern as `#taskToymatePay`).
- Pass through `desktop/main.cjs` → executor `/run` like Toymate already does.

### Executor Fast branch

After GetCartToken + address/shipping hydrate (same as card):

1. Discover PayPal method id from Checkout/v2 HTML / handleaction options  
   (do **not** assume `pm=1`; capture live mid-1925 IDs).
2. Set `CheckoutData.SelectedPaymentMethodID` (+ any GE gateway / PayPal-specific
   fields from HAR) on save / pay-start.
3. Skip CreditCardForm + HandleCreditCard.
4. Extract PayPal redirect / approve URL from GE response (JSON or HTML).
5. Return Toymate-compatible shape:

```js
{
  ok: true,
  dryRun: true,           // or checkoutStage: "tokenize"
  paymentMethod: "paypal_guest",
  paypalApproveUrl,
  finalUrl: paypalApproveUrl,
  cartToken: guid,
  // …existing steps/timing
}
```

6. Desktop surfaces the URL (open / copy) — **no** in-bot PayPal password vault in v1.

### Out of scope for v1

- PayPal account vault / auto-relogin (BUTT gap — later product)
- Fully headless PayPal login + approve (fragile, ToS-heavy)
- Apple Pay / Google Pay
- Changing card Fast defaults

---

## Remaining unknowns

| Item | Status |
|---|---|
| Method / gateway ids | **Done** (4 / 6) |
| Init endpoint + approve URL | **Done** (webservices InitPayPalExpress) |
| Guest vs PayPal login inside approve | Human finishes in browser (v1) |
| Cancel / return URLs | Need one completed PP order or cancel |
| SoftBlock under drop load | Same as card ATC — bridge fallback |

---

## Implementation phases

| Phase | Work | Status |
|---|---|---|
| **0 — HAR / wire** | Checkout/v2 + HTTP InitPayPalExpress | **Done** |
| **1 — Fast branch** | `paypal_guest` in `runBandaiGeHttpPay` | **Lab in** |
| **2 — Desktop** | Bandai pay select + open/copy approve URL | Next |
| **3 — Ops** | “Use PP on contested drops” | — |
| **4 — later** | PayPal session vault / relogin | Later |

---

## Risks / decisions

1. **GE may require a browser hop** for PayPal buttons (SDK). If HTTP cannot mint
   an approve URL, v1 falls back to Safe/Playwright “click PayPal → capture URL”
   while keeping ATC on Fast.
2. **Dual Revolut** is largely a **card/issuer** story; PayPal is a different rail —
   still validate “one PayPal attempt / one capture” under load.
3. Keep **card as default**; PayPal is an operator choice for drops, not a replace.
4. Do not block Fast card trim / shipping on this work — ship scope doc first,
   implement after HAR.

---

## Acceptance (v1)

- Task set to `paypal_guest` reaches GE pay select without card PAN.
- Desktop shows a usable `paypalApproveUrl` within the normal Fast hydrate budget.
- Human approve completes a real Bandai AU order (or clear decline) at least once
  in lab.
- Card Fast path unchanged when `paymentMethod` is unset / `credit_card`.

---

## References

- Toymate pattern: `executor/adapters/toymate.js` (`paypal_manual`)
- Checkout passthrough: `executor/checkout.js` (`paypalApproveUrl`)
- Fast product trim: `BANDAI_FAST_TRIM.md`
- Module open Q: `BANDAI_AU_MODULE.md` §12
