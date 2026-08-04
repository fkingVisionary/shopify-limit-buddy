# Bandai Fast — product trim (2026-08-05)

Solidify **Autocheckout / Fast** after the dual-Revolut hunt. Dual on Bandai is
now known to also happen on **manual phone checkout** — stop leaving dual-hunt
knobs ON in the product path.

## Product Fast path (keep)

1. HTTP + F5 bridge ATC / cart
2. `GetCartToken` → Checkout/v2 → handleaction → save → CreditCardForm
3. Risk hydrate: throwaway CartToken iovation/Forter mint when a bridge page exists
4. Browser issuer block (prevent GEM iframe second HandleCreditCard)
5. Undici issuer POST with **`PAY_ISSUER_TLS_WORKER` default ON** (Toymate ×1 proof)
6. Cheap `payForensics` lines (no /tmp dumps)
7. Payment-latch / Safe / Full stay separate — do not rip for dual reasons

## Dual-hunt knobs — OFF by default (opt in `=1`)

| Knob | Product default | Notes |
|---|---|---|
| `PAY_ISSUER_TLS_WORKER` | **ON** (`=0` off) | Keep — only proven ×1 lever (Toymate) |
| `PAY_PAYHOST_TLS_WORKER` | OFF | Prepay chrome_131 — scored ×2 on Bandai |
| `PAY_ISSUER_CCFORM_TLS` | OFF | CreditCardForm GET on tls-worker |
| `PAY_ISSUER_COLD_TLS` | OFF | Split prepay/issuer workers |
| `PAY_ISSUER_FORM_AS_CORS` | OFF | GE form Sec-Fetch cors like BigPay |
| `PAY_ISSUER_GET_FETCH` | OFF | CreditCardForm GET Sec-Fetch |
| `PAY_GE_TLS_WORKER` | OFF | All GE hops on tls-worker (flake + ×2) |
| `BANDAI_GE_WIRE_TAP` | OFF | `/tmp/bandai-*` wire dumps |

Lab re-enable example:

```
PAY_PAYHOST_TLS_WORKER=1 PAY_ISSUER_COLD_TLS=1 PAY_ISSUER_CCFORM_TLS=1 \
PAY_ISSUER_FORM_AS_CORS=1 PAY_ISSUER_GET_FETCH=1 BANDAI_GE_WIRE_TAP=1
```

## Removed / gated bloat

- Dead `synthesizeIovationMerchantCartToken` (never called; throwaway mint uses a
  second GetCartToken on the real MCT).
- Always-on `/tmp/bandai-ge-boot-capture.json`, `bandai-cc-form*`,
  `bandai-ge-issuer-last.json`, `bandai-ge-browser-wire.json` — now require
  `BANDAI_GE_WIRE_TAP=1`.
- Shared `http.js` mutate wire append to `/tmp/bandai-ge-wire.json` already gated.

## Do not trim (still product-useful)

- Throwaway iovation mint + browser issuer block
- `PAY_ISSUER_TLS_WORKER` default ON
- Platform-matched Chrome UA / client hints
- Fail-closed blockers (JWT, machineId, Forter when riskHydrate)
- Safe / Full / payment-latch code paths

## Related

- Dual handoff (merchant/issuer behaviour): `DUAL_REVOLUT_HANDOFF.md`
- PayPal guest option (next product lever for drops): `BANDAI_PAYPAL_GUEST_SCOPE.md`
