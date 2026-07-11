# HAR diff machine

Compare a real browser HAR against the executor's current implementation to
find gaps in the Kmart checkout chain. This is a diagnostic tool, not a
patcher — its output drives one change at a time in `executor/adapters/kmart.js`.

## Usage

```bash
# Checklist only (which golden steps exist in the HAR):
node --max-old-space-size=4096 executor/scripts/har-diff.mjs <har-path>

# Byte-level diff against an executor run:
node --max-old-space-size=4096 executor/scripts/har-diff.mjs <har> --json run.json
```

Grab an executor run JSON by calling `/run` with `debugTrace: true`. The
trace is redacted before it leaves the executor: card data, JWTs/tokens,
email/phone and cookie values are replaced with safe placeholders or cookie
names only.

## What the byte-level diff reports (per golden step)

- **Method / host / path / GraphQL query hash** — surface schema drift.
- **Headers** — presence, value equality for stable headers, length-shape
  check for volatile ones (`newrelic`, `traceparent`, `tracestate`,
  `x-visitor-id`). Ignored: `content-length`, `cookie`, HTTP/2 pseudo-headers.
- **Cookie names** — which cookie names the HAR sent but we didn't (and
  vice versa). Values are never compared or logged.
- **Request body** — structural JSON diff with per-path notes for
  missing/extra keys, type mismatches, array-length changes, and
  **object key order** (Akamai fingerprints on byte order).
- **`requiredHeaders` / `requiredVariables`** — hard rules per step; a
  missing one is always red.

Bottom line: `Summary: N/12 steps green.`

## Golden checklist (from `www.kmart.com.au.har_1.json`)

| step                  | HAR entry | note                                                   |
| --------------------- | --------- | ------------------------------------------------------ |
| seed                  | #25       | POST /shopping-agent/v1/get-token — API-host BM seed   |
| cart_get              | #114      | getMyActiveCart guest probe                            |
| cart_create           | #343      | createMyBag with postcodeSelector JSON string          |
| cart_probe1           | #357      | getActiveBag between create and ATC                    |
| cart_probe2           | #366      | getMyActiveCart between create and ATC                 |
| cart_atc              | #368      | updateMyBag addLineItem + setCustomField (cnc store)   |
| addr_shipping         | #599/677  | setShippingAddress (streetName full "<num> <street>")  |
| addr_billing          | #690      | setShippingAddress + setBillingAddress                 |
| paydock_tokenize      | #764      | PAN → oneTimeToken (origin=widget.paydock.com!)        |
| create_3ds            | #766      | Kmart mutation → base64(JSON{content:JWT,format})       |
| paydock_3ds_handle    | #788      | POST /handle?x-access-token=JWT event=InitAuthTimedOut  |
| paydock_3ds_process   | #802      | POST /process x-access-token header, {charge_3ds_id}    |
| soh_event             | #805      | final stock-event custom field before order submission   |
| place_order           | #807      | chargePayDockWithToken → orderNumber                    |

## The one-variable-at-a-time loop (do not skip)

The chain is implemented in `executor/adapters/kmart.js`. `place_order` is
gated behind `task.placeOrder === true`, and address/payment run only after
`cart_verify` shows the SKU actually made it into the cart.

When something is failing (today: `cart_atc` returns 403 Akamai *Access
Denied* even though four preceding GraphQL POSTs succeed), the process is:

1. Run the executor once with `debugTrace: true`, save the response JSON.
2. `har-diff.mjs <har> --json run.json` → read the report.
3. Pick **one** red line from the failing step and change the adapter to
   fix only that line. Never stack two changes in one attempt.
4. Redeploy, rerun, re-diff. If the failing step is still red, revert if
   the change added surface area; keep it if it removed a real delta.
5. Only advance to the next step once the current one is `✓ GREEN` and
   returns 200 with the expected shape on three consecutive runs against
   fresh proxy IPs.

Rule of thumb: nothing gets added to `kmart.js` that doesn't correspond to
a red line in a diff report. No cargo-culted headers, cookies, or fields.
