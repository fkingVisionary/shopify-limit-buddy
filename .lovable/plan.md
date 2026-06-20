# Pass card per-request from Lovable to the executor

## Context

Fly deploys via GitHub Actions have been working all along — the Fly UI's "unable to detect runtime" error happened because its launcher scans the repo root, but our Dockerfile lives in `executor/`. That path was never the intended one.

`PAYDOCK_PUBLIC_KEY` is now set on Fly, so the executor can read it from `process.env`. The remaining gap is **card details**: they live in Lovable Cloud and should be sent to the executor per-request (so the PAN never sits in Fly's secret store). This also lines up with the future plan to source card data from user profiles instead of env vars.

## What changes

### 1. Control plane (Lovable Cloud) — `src/lib/executor.functions.ts`

Extend `runOnExecutor` so the server-side handler reads card fields from `process.env` and includes them in the `/run` payload sent to Fly:

- `KMART_CARD_NUMBER`
- `KMART_CARD_CVV`
- `KMART_CARD_EXPIRY_MONTH`
- `KMART_CARD_EXPIRY_YEAR`
- `KMART_CARD_HOLDER`

`PAYDOCK_PUBLIC_KEY` is **not** included — executor reads it from its own Fly env.

Payload shape (new optional `card` block; omitted entirely when any required field is missing, so dry-runs still work):

```json
{
  "taskId": "...",
  "storeUrl": "...",
  "variantId": 123,
  "qty": 1,
  "proxy": "...",
  "dryRun": false,
  "card": {
    "number": "...",
    "cvv": "...",
    "expMonth": "04",
    "expYear": "28",
    "holder": "morgan edwards"
  }
}
```

Validation: extend the Zod `InputSchema` with an optional `card` object (string fields, length-bounded). If the caller passes a `card` we use it as-is (this is the seam future profile-sourced cards plug into); otherwise we fall back to the env-injected one.

Same change applied to `src/routes/api/public/exec-test.ts` so smoke tests forward the card too.

### 2. Executor (Fly) — `executor/server.js` + `executor/adapters/kmart.js`

- `server.js`: accept the optional `card` field on `/run`, validate shape, pass it through to the kmart adapter on the task object. Logging masks the number to last 4 and never logs the CVV.
- `executor/adapters/kmart.js`: in the `paydock_tokenize` step, prefer `task.card.*` over `process.env.KMART_*`. `PAYDOCK_PUBLIC_KEY` continues to come from `process.env`. Existing skip-with-reason logic remains as the fallback when neither source has a value.

No Fly secrets need to change. The existing `EXECUTOR_TOKEN` bearer already authenticates the POST, so the card travels over TLS inside an already-authenticated request.

### 3. Verification

After the executor redeploy:
1. Hit `POST /api/public/exec-test` with the Fisher-Price URL.
2. Expect the chain to advance past `paydock_tokenize` (real `oneTimeToken` returned) and into `create_3ds_token`.
3. Confirm executor logs show only `card: { last4: "XXXX", holder: "..." }` — never full PAN or CVV.

Final `placeOrder` mutation stays gated behind `task.placeOrder: true` (Gap B from the plan — out of scope here).

## Future hook (not built now)

When card data moves to user profiles, the only change is in `runOnExecutor`: replace the `process.env.KMART_CARD_*` reads with a Supabase lookup for the calling user's profile card. The wire format, executor code, and adapter logic stay identical.

## Out of scope

- Capturing the `placeOrder` GraphQL mutation (Gap B).
- Profile-based card storage UI/schema.
- Any change to Fly secrets, the GitHub Actions workflow, or the Dockerfile.

## Files touched

- `src/lib/executor.functions.ts` — add card injection + schema
- `src/routes/api/public/exec-test.ts` — forward `card` field
- `executor/server.js` — accept + validate `card`, masked logging
- `executor/adapters/kmart.js` — prefer `task.card.*` over env in tokenize step

After the executor file changes you'll re-run the **Deploy executor** workflow once so Fly picks up the new code.
