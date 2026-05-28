# Pivot: HTTP-mode checkout engine + concurrent task pool

Move off visible-browser checkout to a fetch-chain state machine that runs server-side, takes a proxy per task, and runs N in parallel. Keep the Electron runner around as a fallback (checkpoint solver / residential worker), repurposed to consume the same HTTP task spec instead of Playwright jobs.

## What gets built

### 1. HTTP checkout engine (`src/lib/shopify-http-checkout.functions.ts`)

A server function that executes one task end-to-end as a chain of fetches:

```text
GET  /products/{handle}.js          (resolve variant + price)
POST /cart/add.js                   (variant → cart, capture cookies)
GET  /cart                          (extract checkout token / authenticity_token)
GET  /checkouts/{token}             (load contact step, scrape form tokens)
PATCH /checkouts/{token}            (submit email + shipping address)
GET  /checkouts/{token}/shipping_rates.json (poll until rates ready)
PATCH /checkouts/{token}            (pick first/cheapest shipping rate)
POST https://elb.deposit.shopifycs.com/sessions  (vault card → session id)
PATCH /checkouts/{token}            (attach payment session, total, captcha)
POST /checkouts/{token}/payments    (submit)
GET  /checkouts/{token}/payments/{payment_id}  (poll until done)
```

Each step:
- Uses a shared cookie jar (Map) collected via `Headers.getSetCookie()`.
- Sends realistic UA + `referer`/`origin`/`accept` headers.
- Returns a step record `{ step, ms, ok, status, note }` for the live timeline.
- On failure, returns `{ ok:false, failedStep, error, steps }` — no throw, so the pool can keep going.

Input shape:
```ts
{ taskId, storeUrl, variant: { id, qty }, profile, card, proxy?, captchaToken?, dryRun }
```

`dryRun: true` stops after the PATCH that loads shipping rates — proves the chain works without charging a card.

### 2. Task pool (`src/lib/task-pool.server.ts` + serverFn wrappers)

In-memory pool keyed by `poolId`:
- `createTaskPool({ storeUrl, variantId, qty, profile, card, proxies[], concurrency })` → returns `poolId` and seeded `tasks[]` (one per proxy, or N copies if no proxies).
- `startTaskPool(poolId)` → kicks off a worker loop that runs `concurrency` tasks in parallel using `Promise.all` over a queue; each task calls the HTTP engine.
- `getTaskPool(poolId)` → returns full state for live UI polling: per-task `{ id, proxy, status, currentStep, steps[], elapsedMs, error?, orderId? }`.
- `stopTaskPool(poolId)` → marks remaining queued tasks as cancelled.

Pool lives in module-scope `Map<string, Pool>` (same pattern as `runner-store.server.ts`). Edge runtime is fine for short bursts; long pools should set a max wall time.

### 3. UI: Task Pool card in the Settings/main tab

Add a new section to `src/routes/index.tsx`:
- Inputs: store URL, variant ID, qty, profile picker, card picker, proxy list textarea (one per line, `user:pass@ip:port` or `ip:port`), concurrency slider (1–30), dry-run toggle.
- "Launch pool" button → calls `createTaskPool` then `startTaskPool`, stores `poolId` in component state.
- Live table polled every 750 ms: row per task with proxy, current step badge, elapsed, and final status (`ok #order`, `dry-run ok`, `failed: <step>`).
- "Stop" button.

### 4. Repurpose the Electron runner

Update `runner/runner-loop.cjs` + `runner/checkout.cjs`:
- Replace Playwright `runCheckout` with a Node fetch-chain identical to the server engine (port the file, swap `fetch` for `undici` so per-request proxies work via `Agent`/`ProxyAgent`).
- Runner still polls `/api/public/runner.poll`, but jobs sent to it are the same HTTP task spec — laptop just runs the chain using its own IP / proxy.
- Keep a `mode: "browser"` fallback (current Playwright path) for checkpoint/PX-walled stores; only used when the server engine reports `failedStep: "checkpoint"`.

### 5. Browserless becomes warmer only

`src/lib/browserless.functions.ts` keeps existing flow but is no longer the main path. Add a `warmCookies(storeUrl, proxy)` exported helper for when the HTTP engine hits a Cloudflare/PX challenge — server fn calls Browserless once, grabs cookies, hands them back to the HTTP chain.

## Files to add / change

Add:
- `src/lib/shopify-http-checkout.functions.ts` — engine
- `src/lib/task-pool.server.ts` — in-memory pool store
- `src/lib/task-pool.functions.ts` — create/start/get/stop server fns
- `src/components/TaskPoolCard.tsx` — UI

Change:
- `src/routes/index.tsx` — mount `<TaskPoolCard />`
- `runner/checkout.cjs` → split into `runner/checkout-http.cjs` (new default) + keep existing as `runner/checkout-browser.cjs` fallback
- `runner/runner-loop.cjs` — pick mode based on job spec
- `runner/package.json` — add `undici`

No DB changes. No new secrets needed (proxies come from the user textarea).

## Verification plan

1. After engine lands: call it via `stack_modern--invoke-server-function` against a real Shopify store in `dryRun: true` mode, confirm steps reach `shipping_rates` and screenshot/step log is clean.
2. After pool lands: launch a 5-task dry-run pool with no proxies, confirm UI shows 5 rows progressing in parallel and all land on `dry-run ok`.
3. After runner update: re-pair runner, send a test job, confirm the same task spec runs on the laptop and reports back.

## Out of scope (next pivot)

- Anti-bot bypass for PX/Kasada/Shopify Checkpoint (needs warmer + TLS fingerprint tuning — only worth doing once we hit a wall on a real drop).
- Persistent pool history in DB.
- Per-task discount codes / raffle entries.
- Stripe Radar / 3DS handling (will surface as a `failedStep: "payments_3ds"` for now).
