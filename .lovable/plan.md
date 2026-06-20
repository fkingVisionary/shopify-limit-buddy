## Goal
Stop burning residential proxy data during Kmart/Akamai testing. Run all dry-runs direct from Fly's egress IP until the sensor pipeline is verified, then re-enable the proxy for production runs.

## Why this is safe
Hyper's `ip` field is already derived dynamically: `resolveEgressIp(ctx)` reads the dispatcher off the task context and asks ipify through that same dispatcher. With no proxy, it returns Fly's egress IP and Hyper fingerprints against that. Nothing in the adapter or antibot layer hardcodes the proxy IP.

## Changes

1. **`src/routes/api/public/exec-test.ts`**
   - Default `proxy` to `null` for both `run` and `recon` modes.
   - Add an optional `useProxy: true` flag in the request body to opt back in (reads `PROXY_URL_RESI` only when set). Default off.

2. **`executor/server.js` `/recon` handler**
   - Same change: only use `PROXY_URL_RESI` when the request explicitly opts in (`useProxy: true`). Default to direct.

3. **No executor adapter changes.** `kmart.js` already passes `task.proxy` through unchanged; null = direct dispatcher = Fly egress IP, and `resolveEgressIp` follows the dispatcher automatically.

## Test plan after build
- Fire `/api/public/exec-test` with `{ mode: "recon", reconUrl: "https://www.kmart.com.au/" }` (no proxy) → expect 200 + script list so we can find the real Akamai sensor path.
- Fire dry-run on a Kmart PDP (no proxy) → expect sensor solve to progress further than the proxied attempt, since Fly's IP is clean and ipify will report it correctly to Hyper.
- When ready for production, send `{ useProxy: true, ... }` to flip back to residential without code changes.

## Out of scope
- No changes to `kmart.js`, `antibot.js`, `http.js`, or `ip-resolve.js`.
- Production checkout wiring stays on the residential path via the explicit flag.
