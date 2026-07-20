# Fly one-shot probe

**Do not loop SoftBlocked hours.** One intentional `/run`:

```bash
EXECUTOR_TOKEN=... ./executor/scripts/fly-probe-once.sh
SMOKE_USE_PROXY=1 ./executor/scripts/fly-probe-once.sh   # ISP + apiTls handoff
API_TLS=0 SMOKE_USE_PROXY=1 ./executor/scripts/fly-probe-once.sh  # undici api.*
```

# Fly ladder smoke (optional Actions helper)

One-tap from GitHub: **Actions → Smoke executor → Run workflow**.

Or locally (needs `EXECUTOR_TOKEN`):

```bash
EXECUTOR_URL=https://j1ms-bot-executor.fly.dev \
EXECUTOR_TOKEN=... \
./executor/scripts/fly-smoke.sh

SMOKE_USE_PROXY=1 ./executor/scripts/fly-smoke.sh   # ISP pool
```

Writes `*.json` + `*.summary.json` + `*.milestones.json` under `SMOKE_OUT_DIR`
(default `/tmp/fly-smoke`). Scores furthest stage / milestones — not only
`failedStep` after a client timeout.

---

# HAR diff machine

Compare a real browser HAR against the executor's current implementation to
find gaps in the checkout chain.

```bash
node --max-old-space-size=4096 executor/scripts/har-diff.mjs <har-path>
# with an executor run json:
node --max-old-space-size=4096 executor/scripts/har-diff.mjs <har> --json run.json
```

For an executor run JSON, call `/run` with `debugTrace:true`. The trace is
redacted before it leaves the executor: card data, JWTs/tokens, email/phone and
cookie values are replaced with safe placeholders or cookie names only.

The diff now has two sections:

- **Checkout/API sequence** — GraphQL, `get-token`, Paydock, and order-step
  method/path/header/query/variable deltas.
- **Akamai/SBSD trust** — Kmart same-origin script fetches, Akamai
  `sensor_data` POSTs, and SBSD JSON `body` POSTs. Executor traces include
  only safe hashes/lengths for SBSD inputs and payloads, plus cookie markers and
  set-cookie names.

Use `kmartMode:"cart-baseline" | "current" | "diagnostic"` on `/run` to make
the requested/normalized mode visible in trace output. The current checkpoint
still routes through the same adapter branch; this field is for reliable
comparison logging before behavior is split again.

Golden checklist (from `www.kmart.com.au.har_1.json`, 971 entries):

| step                  | HAR entry | note                                                   |
| --------------------- | --------- | ------------------------------------------------------ |
| seed                  | #25       | POST /shopping-agent/v1/get-token — API-host BM seed   |
| cart_get              | #114      | getMyActiveCart guest probe                            |
| cart_create           | #343      | createMyBag with postcodeSelector JSON                 |
| cart_atc              | #368      | updateMyCart addLineItem sku                            |
| addr_shipping         | #599/677  | setShippingAddress (streetName full "<num> <street>")  |
| addr_billing          | #690      | setShippingAddress + setBillingAddress                 |
| paydock_tokenize      | #764      | PAN → oneTimeToken (origin=widget.paydock.com!)        |
| create_3ds            | #766      | Kmart mutation → base64(JSON{content:JWT,format})       |
| paydock_3ds_handle    | #788      | POST /handle?x-access-token=JWT event=InitAuthTimedOut  |
| paydock_3ds_process   | #802      | POST /process x-access-token header, {charge_3ds_id}    |
| soh_event             | #805      | final stock-event custom field before order submission   |
| place_order           | #807      | chargePayDockWithToken → orderNumber                    |

The chain is implemented in `executor/adapters/kmart.js`. `place_order` is gated
behind `task.placeOrder === true`; cart/address/payment run only after the cart
mutation verifies that the SKU is actually present.
