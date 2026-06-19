## Problem

Two symptoms in the Server test:
1. **`ERR_TUNNEL_CONNECTION_FAILED`** — Browserless's `?externalProxyServer=` query param on the `/function` endpoint does not authenticate the upstream proxy. Chrome receives the proxy via `--proxy-server` but credentials embedded in the URL are ignored by Chromium (it does not parse `user:pass@` from the proxy flag). The CONNECT to `premium-proxy.ipfist.com:1818` is sent without auth, the provider rejects it, and Browserless surfaces it as `ERR_TUNNEL_CONNECTION_FAILED`.
2. **`429 Too Many Requests`** — Browserless free/low tiers cap concurrent sessions at 1. Even with `sleep(500)` between calls, six `/function` invocations can overlap because each takes several seconds and we're still spawning them faster than they finish.

## Fix

### 1. `src/lib/proxy-health.functions.ts`
- Stop relying on `externalProxyServer`. Instead, pass only the host:port to Chrome via `?launch={"args":["--proxy-server=http://host:port"]}` and authenticate inside the function body with `page.authenticate({ username, password })` BEFORE `page.goto`.
- Build the `launch` JSON and url-encode it as a single query param. Keep `token` and `timeout`.
- Pass `username`/`password` through the `context` object of the `/function` request (Browserless injects context into the handler), so creds never appear in the URL/logs.
- Tighten the error mapper: also recognise `ERR_NO_SUPPORTED_PROXIES`, `ERR_PROXY_CONNECTION_FAILED`, and `407` → "Proxy authentication failed".

### 2. `src/routes/_paired/index.tsx`
- Replace the parallel test loop with a strict serial loop that **awaits each test fully before starting the next** and adds a 1500 ms gap between calls. This avoids the 429 even on single-concurrency Browserless plans.
- Show a small "Testing 3/6…" progress indicator while running so the user knows it's intentionally slow.

### 3. `src/lib/proxy-format.ts`
- No change needed; the classifier already returns the right `{user, pass, host, port}` shape. Add a small helper `parseProxyParts(url)` that returns those fields so the health checker can pass them to `page.authenticate` without re-parsing.

### 4. Apply the same auth-via-`page.authenticate` change to `supabase/functions/run-checkout/index.ts`
- The checkout runner has the same bug — `externalProxyServer` with embedded creds will silently drop auth in Chromium. Switch it to `--proxy-server=host:port` + `page.authenticate` so a green Server test result actually reflects what checkout will do.
- Redeploy `run-checkout`.

### 5. Verify
- Run the Server test on the six ipfist proxies one at a time and confirm each returns an AU exit IP. If one still fails, the error message will now correctly say "Proxy authentication failed" vs "tunnel failed" so the user can tell creds vs network.
- Run a checkout job and confirm Browserless no longer 400s on the proxy.

## Out of scope

- No UI redesign, no new proxy provider integration, no changes to the `{url}` template path (already works).
