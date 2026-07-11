## Root cause
`create3DSToken` fails because the cart's stored billing address is incomplete. In `executor/adapters/kmart.js` line 1171, `contactAddress` is:

```
{ firstName, lastName, email, phone, country: "AU" }
```

commercetools accepts this at `setBillingAddress` time (the fields are optional at the schema level), but Kmart's `create3DSToken` resolver validates that a payment-ready billing address includes `streetName`, `state`, and `postalCode`. Missing those → the exact error we see.

Cart_atc / cart_verify 403 issue is a separate track and stays deferred pending the HAR you're capturing.

## Fix

1. **Extend `contactAddress` in `executor/adapters/kmart.js` (~line 1171)** to include the address fields commercetools needs:
   - `streetName`
   - `streetNumber` (may also be required, include to be safe)
   - `postalCode`
   - `city`
   - `state`
   - `country: "AU"`

2. **Source those from `task.profile` when present, with a safe AU fallback**
   - Prefer `task.profile.address.{streetName, streetNumber, postalCode, city, state}` (or the closest existing field names on the profile — I'll check `src/lib/checkout.functions.ts` / task shape and match).
   - Fallback (only used when the caller sent no address): use the same Brisbane 4001 QLD values already hardcoded in the `postcodeSelector` on line 988 so the pickup postcode and billing address stay consistent.

3. **Apply the same address to both `setShippingAddress` and `setBillingAddress`** in `checkout_set_address` (line 1187) and `checkout_set_billing` (line 1213). Real checkouts store the same full address on both by default.

4. **Do not change the `create3DSToken` mutation itself.** Its signature (4 scalars) is already correct per the schema; the resolver reads the cart's stored addresses server-side.

## Validation
- Re-run the same dry-run.
- Success criteria:
  - `checkout_set_billing` note shows `hasBilling=true` (already the case).
  - `create_3ds_token` returns `status=200` with a non-null `token` and `status="frictionless"` — no `INTERNAL_SERVER_ERROR` about street/state/postcode.
  - `place_order` continues to be gated by `task.placeOrder`, so nothing goes live.

## Not in scope
- The `cart_atc` 403 on `api.kmart.com.au` — waiting on your HAR.
- Any change to the `create3DSToken` GraphQL query shape.