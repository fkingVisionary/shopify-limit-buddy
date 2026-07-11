## Plan: HAR-first repair pass

### Goal
Make the executor follow the successful Kmart HAR as the source of truth, instead of guessing individual fixes. The first target is to unblock `api_get_token` and `cart_atc`; 3DS should only be evaluated after the cart actually contains the SKU.

### What the latest evidence shows
- `api_get_token` is returning `400` with `Missing required header: x-visitor-id`.
- The successful HAR sends `x-visitor-id`, `newrelic`, `traceparent`, `tracestate`, `priority`, and browser identity cookies on `POST /shopping-agent/v1/get-token`.
- Our current `get-token` code does not send `x-visitor-id` or New Relic headers.
- `cart_atc` still returns Akamai Access Denied, likely because the API BotManager seed is incomplete or invalid.
- `create_3ds_token` is currently noise while `cart_atc` fails: the flow should not continue to payment when `cart_verify` says the SKU is absent.

### Implementation steps after approval

1. **Build a proper HAR diff machine**
   - Extend `executor/scripts/har-diff.mjs` from a checklist into a strict comparator.
   - Extract the golden sequence from the uploaded HAR:
     - `get-token`
     - early `getMyActiveCart` reads
     - `createMyBag`
     - `getActiveBag`
     - pre-ATC `getMyActiveCart`
     - `updateMyBag` ATC
     - post-ATC verify
     - address/billing mutations
     - Paydock tokenize
     - `create3DSToken`
     - Paydock handle/process
     - final pre-order custom-field step
   - Compare method, URL path, operationName, variables shape, normalized query hash, required headers, referer/origin, cookie names present, response status, and set-cookie names.
   - Redact card numbers, JWTs, tokens, email/phone, and full cookie values.

2. **Add executor trace output for diffing**
   - Add a debug trace mode that records each critical request in the same shape as the HAR diff expects.
   - Keep normal user output concise, but return a machine-readable trace when debugging is enabled.
   - This gives us an actual “HAR vs current executor” report instead of relying on screenshots.

3. **Fix API BotManager seed exactly from HAR**
   - Derive `x-visitor-id` from the `_ga` cookie in the HAR-compatible format, e.g. `_ga=GA1.1.1948965462.1758342961` → `1948965462.1758342961`.
   - If `_ga` is absent, create a coherent browser identity set before `get-token` rather than sending no visitor ID.
   - Send New Relic headers on `get-token` using the HAR’s `ap=1834777981` for that endpoint.
   - Align `get-token` headers with HAR: `priority`, `origin`, `referer`, `sec-fetch-*`, language, and browser client hints.
   - Treat `get-token` as a hard gate: if it does not return `200` and valid API BotManager cookies, stop before cart mutation.

4. **Repair `cart_atc` only from measured HAR deltas**
   - Run the new diff against the current flow trace.
   - Patch only the mismatches that appear before `cart_atc`.
   - Preserve the HAR action shape for ATC:
     - `addLineItem { sku, quantity, addToCartSource: "PDP" }`
     - `setCustomField { name: "selectedCncStoreId", value: "1241" }`
   - Confirm `cart_atc` returns `200` and `cart_verify` has `hasSku=true` before touching payment again.

5. **Stop payment when cart failed**
   - Change checkout gating so address/payment/3DS runs only if `cart_atc` succeeded and `cart_verify` confirms the SKU is in the cart.
   - This prevents misleading 3DS errors caused by an empty cart.

6. **Then fix address and 3DS against HAR**
   - Compare address mutation variables against HAR entries `#599` and `#690`.
   - Preserve full street/city/state/postcode on billing before `create3DSToken`.
   - Compare `create3DSToken` query/variables and Paydock handle/process headers/body against HAR entries `#766`, `#788`, and `#802`.
   - Add the HAR’s final `sohEvent` custom-field mutation before real order submission if the diff shows it is required.

7. **Validation criteria**
   - `api_get_token`: `200`, no “missing x-visitor-id”, expected BotManager cookie names present.
   - `cart_atc`: `200`, no Access Denied HTML.
   - `cart_verify`: `lines > 0`, `hasSku=true`.
   - `checkout_set_billing`: billing has `streetName`, `state`, and `postalCode`.
   - `create_3ds_token`: non-null JWT / charge ID.
   - `paydock_3ds_process`: frictionless success or a clearly classified challenge state.
   - `place_order` remains dry-run gated unless explicitly enabled.

### First concrete code changes I expect
- Add `x-visitor-id` generation/derivation.
- Reuse New Relic header generation for `get-token`, with endpoint-specific app ID from the HAR.
- Gate cart/payment progression on successful upstream steps.
- Upgrade `har-diff.mjs` and executor tracing so future fixes come from exact deltas, not guesswork.