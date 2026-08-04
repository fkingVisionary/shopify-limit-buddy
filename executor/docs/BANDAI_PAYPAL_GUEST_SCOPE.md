# Bandai AU — PayPal guest checkout (scope)

**Date:** 2026-08-05  
**Goal:** Offer **PayPal guest** alongside card on Bandai Fast, because PayPal
often clears better than card on high-traffic drops.

Lab status **2026-08-05:** wire IDs locked from Checkout/v2 HAR; **Fast HTTP**
minted a live `paypal.com/checkoutnow?token=…` approve URL. Desktop now exposes
**Credit card / PayPal (auto approve) / PayPal (link only)** plus per-region
Bandai modules (`au|us|nz|sg|hk|tw|fr`).

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
| Bandai Fast HTTP | `paymentMethod=paypal_auto\|paypal_manual` → save pm=4/gw=6 → InitPayPalExpress → approve URL; auto runs Playwright login → Pay Now |
| Bandai Full browser HAR | Reached GE; tile click flaky / SoftBlock; IDs from HTML |
| Desktop task UI | Bandai payment dropdown + profile PayPal email/password; region modules |
| Toymate | `paypal_manual` → BigCommerce approve URL |

---

## Payment methods (desktop → executor)

| Value | Behaviour |
|---|---|
| `credit_card` | Existing Fast card path (default) |
| `paypal_guest` | Mint approve URL + PayPal **guest card** checkout using the task billing profile (email / address / card) |
| `paypal_manual` | Mint approve URL only (link-only / human finish) |

Legacy `paypal_auto` normalizes to `paypal_guest`. No separate PayPal login vault.

---

## Recommended v1 — shipped baseline

Bot races cart + checkout setup; PayPal guest completes debit/credit card form
with the **same billing profile** attached to the task. Link-only still supports
human finish.

### Task / UI

- Bandai task field: `paymentMethod: "credit_card" | "paypal_guest" | "paypal_manual"`.
- Desktop: `#taskBandaiPay`; billing comes from the selected profile (no PayPal password fields).
- Persist via `desktop/main.cjs` → `job-runner` → executor `/run`.

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

6. Desktop: `paypal_manual` surfaces approve URL; `paypal_guest` runs
   `executor/adapters/paypal-approve.js` guest card path with billing profile
   (headed by default; `PAYPAL_APPROVE_HEADLESS=1` opt-in).

### Out of scope / later

- PayPal account login / session vault
- Apple Pay / Google Pay
- Changing card Fast defaults

---

## Remaining unknowns

| Item | Status |
|---|---|
| Method / gateway ids | **Done** (4 / 6) |
| Init endpoint + approve URL | **Done** (webservices InitPayPalExpress) |
| Guest vs PayPal login inside approve | Guest card path uses billing profile |
| Cancel / return URLs | Need one completed PP order or cancel |
| SoftBlock under drop load | Same as card ATC — bridge fallback |

---

## Implementation phases

| Phase | Work | Status |
|---|---|---|
| **0 — HAR / wire** | Checkout/v2 + HTTP InitPayPalExpress | **Done** |
| **1 — Fast branch** | PayPal mint + auto-approve in `runBandaiGeHttpPay` | **In** |
| **2 — Desktop** | Pay select + region modules + profile PP creds | **In** |
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
