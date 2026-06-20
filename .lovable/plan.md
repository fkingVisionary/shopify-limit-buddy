## Kmart Checkout Flow — Full Submit with Card

### Flow we're implementing

```text
cart_verify (done)
  → checkout_warm           GET /checkout/bag, /checkout/delivery (cookie + referer chain)
  → checkout_set_address    GQL updateMyBagWithoutBagStockAvailability
                            (setShippingAddress + addItemShippingAddress, C&C store 1124)
  → checkout_set_billing    GQL updateMyBagWithoutBagStockAvailability
                            (setShippingAddress + setBillingAddress)
  → checkout_refresh        GQL getMyActiveBag (snapshot version after billing)
  → paydock_tokenize        POST api.paydock.com/v1/payment_sources/tokens
                            → returns oneTimeToken UUID
  → create_3ds_token        GQL create3DSToken(oneTimeToken, gatewayType: "MasterCard")
  → place_order             GQL placeOrder / submitOrder (op name TBD — see gap below)
```

### What I'll add to `executor/adapters/kmart.js`

After `cart_verify` (line 654), append these steps:

**1. `checkout_warm`** — GET `https://www.kmart.com.au/checkout/bag` then `/checkout/delivery` with navigation headers. Establishes the checkout-page referer chain that later GQL calls expect (some GraphQL ops are referer-gated).

**2. `checkout_set_address`** — POST to `gqlUrl` with op `updateMyBagWithoutBagStockAvailability`:
- `setShippingAddress`: `{firstName: "morgan", lastName: "edwards", email: "flowgdesigns@gmail.com", phone: "0429444444", country: "AU"}` (no street/city/state/postcode for C&C)
- `addItemShippingAddress`: store address with `key: "1124"` (or similar — confirmed from earlier capture)
- Bumps `cartVersion` from response.

**3. `checkout_set_billing`** — Same op, with `setShippingAddress` + `setBillingAddress` (same identity, country=AU). Bumps `cartVersion`.

**4. `checkout_refresh`** — `getMyActiveBag` query (no vars). Logs current version + line count + total to confirm state is good.

**5. `paydock_tokenize`** — Direct POST to `https://api.paydock.com/v1/payment_sources/tokens`:
```json
{
  "type": "card",
  "card_name": "morgan edwards",
  "card_number": "<from secret KMART_CARD_NUMBER>",
  "expire_month": "<from secret>",
  "expire_year": "<from secret>",
  "card_ccv": "<from secret>",
  "gateway_id": "",
  "store_ccv": true,
  "meta": {}
}
```
- Headers: `content-type: application/json`, `origin: https://www.kmart.com.au`, `referer: https://www.kmart.com.au/checkout/payment`, UA + Chrome client hints. Likely also needs `x-user-public-key` (Paydock's standard header) — scraped from checkout page JS (see Gap A).
- Parse `resource.data` as `oneTimeToken`.
- Detect gateway type from card BIN (4xxx → Visa, 5xxx → MasterCard, 34/37 → Amex). Your test card starts with `420` so → MasterCard? Actually `420` → Visa. We'll derive correctly.

**6. `create_3ds_token`** — GQL `create3DSToken` mutation:
```json
{
  "oneTimeToken": "<uuid from step 5>",
  "gatewayType": "Visa" (derived from BIN),
  "saveCardOption": false,
  "useSavedCard": false
}
```
- Returns a 3DS challenge URL or a ready-to-use payment token.

**7. `place_order`** — Final mutation. **This op is the Gap B below** — I'll add a placeholder step that logs the response of step 6 so we can see what comes next (likely a `submitOrder` / `placeOrder` mutation, possibly with a 3DS redirect in between).

### Gaps that need your help (Chrome DevTools again)

**Gap A — Paydock public key.** The `tokens` POST you captured almost certainly sent an `x-user-public-key` header. In DevTools, click that same `tokens` request → **Headers** tab → scroll to "Request Headers" → paste anything starting with `x-user-` or `x-pd-`.

**Gap B — Final submit op.** After clicking "Pay" and completing 3DS, there's one more GraphQL POST (likely `placeOrder`, `submitOrder`, `completeOrder`, or `confirmOrder`). Paste its `operationName` + `variables` JSON.

### Secrets I'll request via `add_secret` after you approve

- `KMART_CARD_NUMBER` (full PAN)
- `KMART_CARD_EXPIRY_MONTH` (e.g. `04`)
- `KMART_CARD_EXPIRY_YEAR` (e.g. `28`)
- `KMART_CARD_CVV`
- `KMART_CARD_HOLDER` (e.g. `morgan edwards`)
- `PAYDOCK_PUBLIC_KEY` (only if Gap A confirms one)

### Safety

- All steps run only if previous step succeeded (`pdpStatus < 400`, cart has SKU, etc.).
- `dryRun: true` flag flips to `false` only after `place_order` returns success.
- Adds a `task.placeOrder: boolean` flag so you can run end-to-end without actually submitting (stops after `create_3ds_token`) for dev/test. Default `false` until you explicitly opt in.

### Files changed

- `executor/adapters/kmart.js` — append ~250 lines for steps 1-7, helpers for BIN → gateway detection, Paydock POST, GQL query strings for the new ops.

No frontend, no DB, no edge functions. Pure executor work.
