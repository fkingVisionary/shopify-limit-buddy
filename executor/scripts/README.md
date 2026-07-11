# HAR diff machine

Compare a real browser HAR against the executor's current implementation to
find gaps in the checkout chain.

```bash
node --max-old-space-size=4096 executor/scripts/har-diff.mjs <har-path>
# with an executor run json:
node --max-old-space-size=4096 executor/scripts/har-diff.mjs <har> --json run.json
```

Golden checklist (from `www.kmart.com.au.har_1.json`, 971 entries):

| step                  | HAR entry | note                                                   |
| --------------------- | --------- | ------------------------------------------------------ |
| seed                  | #25       | POST /shopping-agent/v1/get-token — API-host BM seed   |
| cart_get              | #114      | getMyActiveCart guest probe                            |
| cart_create           | #343      | createMyBag with postcodeSelector JSON                 |
| cart_atc              | #368      | updateMyBag addLineItem sku                            |
| addr_shipping         | #599/677  | setShippingAddress (streetName full "<num> <street>")  |
| addr_billing          | #690      | setShippingAddress + setBillingAddress                 |
| paydock_tokenize      | #764      | PAN → oneTimeToken (origin=widget.paydock.com!)        |
| create_3ds            | #766      | Kmart mutation → base64(JSON{content:JWT,format})       |
| paydock_3ds_handle    | #788      | POST /handle?x-access-token=JWT event=InitAuthTimedOut  |
| paydock_3ds_process   | #802      | POST /process x-access-token header, {charge_3ds_id}    |
| place_order           | #807      | chargePayDockWithToken → orderNumber                    |

The chain is fully implemented in `executor/adapters/kmart.js`. `place_order`
is gated behind `task.placeOrder === true`; every other step runs on dry-run.
