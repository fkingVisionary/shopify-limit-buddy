# Bandai AU — PayPal guest checkout (scope)

**Date:** 2026-08-05  
**Goal:** Offer **PayPal guest** alongside card on Bandai Fast, because PayPal
often clears better than card on high-traffic drops.

This is a **scope / design note**, not an implementation.

---

## Why

- Card path is solid enough to race ATC → GE hydrate → issuer, but issuer /
  acquirer / soft-decline behaviour (incl. Revolut dual on **manual and bot**)
  can still burn attempts under load.
- Operators already use **PayPal (manual)** on Toymate when card rails flake.
- Bandai GE mid **1925** exposes PayPal in the live checkout UI; we currently
  hard-select **card** (`SelectedPaymentMethodID` / `pm=1`, gateway `2`).

---

## Current state

| Surface | PayPal |
|---|---|
| Bandai Fast (`bandai-ge-http.js`) | None — card form + HandleCreditCard only |
| Bandai Safe / Full UI pay | Explicitly **excludes** PayPal/Apple/Google Pay buttons |
| Desktop task UI | Pay method select is **Toymate-only** (`credit_card` / `paypal_manual`) |
| Toymate | `paymentMethod: "paypal_manual"` → BigCommerce `paypalcommerce` → returns `paypalApproveUrl` for human approve |

No Bandai GE PayPal wire capture exists in-repo yet. Open question in
`BANDAI_AU_MODULE.md`: “3DS / ApplePay / PayPal express behaviour on mid 1925 AU”.

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

## Wire unknowns (must capture before coding)

One live Bandai AU checkout HAR (or Desktop DevTools) selecting **PayPal**:

| Capture | Why |
|---|---|
| `SelectedPaymentMethodID` / gateway id for PayPal on mid 1925 | Form fields |
| Which GE call starts PayPal (save vs handleaction vs dedicated endpoint) | Branch point |
| Approve / EC-token / redirect URL shape | Return to UI |
| Whether guest PayPal needs BNID login or email-only | Account gate |
| Risk scripts still required (iovation / Forter) before PP redirect | Keep or skip hydrate |
| Success / cancel return URLs back to p-bandai / GE | Completion signal |
| Behaviour under SoftBlock / drop load vs card | Ops guidance |

Until that HAR exists, treat method ids and endpoints as **unknown**.

---

## Implementation phases

| Phase | Work | Risk |
|---|---|---|
| **0 — HAR** | Manual PayPal guest on Bandai AU; save HAR + note method ids | Blocker for code |
| **1 — Fast branch** | `paypal_guest` in `runBandaiGeHttpPay` after hydrate; return approve URL | Low if wire clear |
| **2 — Desktop** | Bandai pay select + open/copy approve URL in job UI | Low |
| **3 — Ops** | Document “use PP on contested drops”; optional monitor auto-start still card-default | — |
| **4 — later** | PayPal session vault / relogin (multi-store) | Higher product scope |

Rough invasiveness: **Phase 1–2** touch `bandai-ge-http.js`, `bandai.js` return
passthrough (already has `paypalApproveUrl` in `checkout.js`), and desktop task
form — no shared card issuer changes.

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
