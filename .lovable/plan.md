
## Where we're at right now

**App shell**
- The whole app is gated behind `/_paired`. On load it checks for a device token in `localStorage` and bounces to `/pair`, where you have to "Create workspace", "Join with code", or "Recover". Until that's done you can't see Tasks, Profiles, Proxies, Settings, etc.
- `useCloudSync` syncs local data to a workspace row in the backend, keyed off that device token.

**Create Tasks UI**
- Single‑page Create Tasks drawer is in place: Store, Input (URL/SKU/keywords), Profile, Proxies, Qty per checkout, Task Quantity, Sizes picker, and Mode (Fast / Fast+Preload / Safe / Safe+Preload).
- Webhook test layout matches the SecuredBot reference (blue linked title, clean key/value rows, J1m's logo).

**Auto‑checkout pipeline — honest status**
There are four code paths, none of them are a single working push‑button flow yet:

| Path | File | What it actually does today | Gaps |
|---|---|---|---|
| Edge cart‑warm | `src/lib/checkout.functions.ts` | POSTs `/cart/add.js`, reads `/cart.js`, builds a prefilled cart‑permalink URL + attaches captcha token. | No proxy support (Workers `fetch` can't proxy), does NOT submit shipping/payment. Only warms the cart and opens checkout. |
| Shopify HTTP checkout | `shopify-http-checkout.functions.ts`, `checkout-one-graphql.functions.ts` | Scripts the Checkout One GraphQL flow. | Untested end‑to‑end on a live store; no proxy from the edge; will lose against Cloudflare/Kasada fingerprinting without a real browser. |
| Fly.io executor | `executor.functions.ts` + `runOnExecutor` | Forwards the job to an external Node service that runs the chain through a residential proxy. | Requires you to deploy the `/executor` service and set `EXECUTOR_URL` / `EXECUTOR_TOKEN`. Not deployed. |
| Paired‑PC runner | `runner-dispatch.functions.ts`, `runner-store.ts`, `runner-protocol.ts` | Enqueues a job for a paired desktop runner to claim, execute locally, and report back. Captcha and Browserless helpers exist. | Needs the user to install + pair a desktop runner. This is the blocker you're calling out.|

So end‑to‑end "click Start Tasks → card charged" does not work in‑app today. Cart‑warm + prefilled checkout works from the edge; full submission requires one of the runner paths.

---

## What this change does

1. **Remove the pairing gate** so the dashboard is usable standalone.
2. **Pick one default checkout path** that runs without any external setup, and clearly label the others as optional upgrades.
3. **Leave the runner/executor code in place** so we can switch back on later — just not required to use the app.

### 1. Drop the pairing requirement

- Replace the `/_paired` gate with a passthrough that auto‑provisions a local workspace on first load (generate a device id in `localStorage`, call `createWorkspace` silently in the background for cloud sync, but don't block the UI on it).
- If cloud sync fails (offline, no backend), fall back to pure local storage — the app keeps working.
- Keep `/pair` reachable from Settings as "Link another device" for later, but it's no longer the front door.
- Effect: opening the app lands you straight on Tasks. No code to enter, no "Create workspace" screen.

### 2. Pin the default checkout path to "Edge cart‑warm + open checkout"

- Hook the Create Tasks "Start" button to `runCheckout` (the edge cart‑warm function).
- For each task: add to cart through `/cart/add.js`, build the prefilled cart‑permalink URL (with profile + optional captcha token), and open it in a new tab so the user finishes payment manually.
- Mode selector still passes through (`Fast` / `Fast+Preload` / `Safe` / `Safe+Preload`) — Preload modes call the captcha pool first, non‑Preload modes skip it.
- This is the only mode that works with zero external setup. It's a "cart sniper", not a full ATC bot, and we'll label it that way in the UI so expectations are right.

### 3. Surface the upgrade paths clearly, but don't require them

- In Settings → "Auto‑checkout" add three optional toggles:
  - **Fly.io executor** — paste `EXECUTOR_URL` + `EXECUTOR_TOKEN`, enables full HTTP submission with proxies.
  - **Desktop runner** — link to `/pair` to install + pair a local runner for browser‑based submission with captcha solving.
  - **Browserless** — paste a Browserless token to run headed checkout from the cloud.
- When any of these is configured, the task runner uses it instead of the edge cart‑warm.

### Technical notes (for me, not the user)

- Files to edit: `src/routes/_paired.tsx` (remove gate), `src/routes/__root.tsx` if it references pair, `src/routes/_paired/index.tsx` Start‑task handler, Settings page for the optional toggles. Keep `/pair`, `workspace.functions.ts`, runner files, executor file all intact.
- Cloud sync: change `useCloudSync` to no‑op when not paired instead of throwing.
- No DB schema changes needed.

---

## What I'm NOT doing in this pass

- Not removing the runner/executor code.
- Not building a new server‑side full checkout submitter — the edge path can't beat Cloudflare without a real browser or a proxy, and we already have two unfinished paths for that.
- Not touching webhook layout, Create Tasks form, or Sizes picker.

Want me to go ahead?
