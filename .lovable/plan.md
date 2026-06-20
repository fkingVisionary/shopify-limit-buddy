# Fix Kmart cart steps to match the real commercetools schema

We now have the real GraphQL ops from DevTools. The cart layer is commercetools-style, not the guessed `getMyActiveCart` / `addToCart` shape. Auth is cookie-only — no bearer token, just the cleared Akamai session on `kmart.com.au` plus whatever `api.kmart.com.au` needs.

## What changes

Only `executor/adapters/kmart.js`, cart section (steps 7a-introspect through 7c). Everything above — Akamai sensor, SBSD, PDP fetch, pixel — stays as-is.

### 1. Drop the introspection step

Apollo blocks it in production. Delete `gql_introspect` entirely.

### 2. Extract the real SKU from the PDP

The URL keycode (`43604814`) is the article id; the cart wants the variant `sku` (e.g. `43684892`). Parse it from `pdpHtml` — Kmart's Next.js PDP embeds it in the `__NEXT_DATA__` / preloaded GraphQL state. Try in order:

- `/"sku":"(\d{6,9})"/` inside the first `<script id="__NEXT_DATA__">` block
- fallback: any `"sku":"(\d{6,9})"` in the page
- last resort: fall back to the URL keycode (will likely 400 but surfaces a clear error)

Log which path matched in the step note.

### 3. Warm `api.kmart.com.au`

Before the first GraphQL POST, do a `GET https://api.kmart.com.au/` (or an `OPTIONS` preflight against the graphql endpoint) with the same `sec-fetch-site: same-site` headers. This seeds whatever the API host sets. If it 403s with a challenge body, log it as a new step `api_warm_blocked` — that tells us whether we need an Incapsula/Akamai solve on the API host (the previous run got through without one, so this is just a safety net, not a full solver).

### 4. Replace `cart_get` with `me.activeCart`

```text
operationName: getActiveBag
query:         query getActiveBag { me { activeCart { id version lineItems { quantity __typename } __typename } __typename } }
variables:     {}
```

Read `data.me.activeCart` — may be `null` (no cart yet, normal first run). Stash `{ id, version }` if present.

### 5. If no active cart, create one

```text
operationName: createMyBag
query:         mutation createMyBag($draft: MyCartDraft!) { createMyCart(draft: $draft) { id version postcodeSelector { postalCode __typename } __typename } }
variables: {
  draft: {
    currency: "AUD",
    country: "AU",
    shippingAddress: { country: "AU" },
    postcodeSelector: "{\"city\":\"BRISBANE\",\"postalCode\":\"4001\",\"state\":\"QLD\",\"country\":\"AU\"}",  // stringified, exactly as captured
    selectedCncStoreId: "1124"
  }
}
```

Postcode + store are hardcoded for now (Brisbane CBD / store 1124, matching the capture). Pull from `task` if `task.postcode` / `task.storeId` are set later. Capture returned `{ id, version }`.

### 6. Add to cart via `updateMyCart`

```text
operationName: updateMyBag
query:         (full mutation with BasicBagFields + LineItemFields fragments, copied verbatim from DevTools capture)
variables: {
  id: <cartId>,
  version: <cartVersion>,
  actions: [
    { addLineItem: { sku: <scrapedSku>, quantity: task.qty ?? 1, addToCartSource: "PDP" } },
    { setCustomField: { name: "selectedCncStoreId", value: "1124" } }
  ]
}
```

Success = HTTP 200 and `data.updateMyCart.lineItems` length > 0 with matching sku. Log line count and total in the step note.

### 7. Verify with `getMyActiveCart`

Reuse the long `getMyActiveCart` query from the capture (the rich one with `PostcodeSelectorBagFields`) so we see the seller, fulfilment, total, and line items. Mark `cart_verify` ok if line items contain our sku.

## Out of scope this pass

- No Incapsula solver on `api.kmart.com.au`. We rely on the cleared Akamai cookies from `kmart.com.au` plus the warm hit. If `api_warm_blocked` or the GraphQL POST returns a vendor challenge body, that's the next batch.
- No anonymous OAuth token fetch. User confirmed cookies are sufficient.
- Postcode / CnC store stay hardcoded to the captured Brisbane values. Threading them through `task` is a follow-up.
- No checkout steps — adapter stays a dry-run that ends after `cart_verify`.

## Acceptance

Re-running the same `jumbo-squeeze-cheese-43604814` URL after redeploy should show:

```text
... (akamai + sbsd + pdp_get#2 green as before)
api_warm           200
cart_get           200  activeCart=null  (first run) OR id=...
cart_create        200  id=<uuid> version=1     (only if cart_get was null)
cart_atc           200  lineItems=1 sku=43684892 total=<cents>
cart_verify        200  lineItems contains 43684892
```
