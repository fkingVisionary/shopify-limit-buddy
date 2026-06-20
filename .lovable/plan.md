# Plan: Replace `undici` with `node-tls-client` in the executor

Hyper Solutions explicitly recommends `bogdanfinn/tls-client` and rejects native Node clients (axios/node-fetch/undici). Without a Chrome-matching JA3/JA4 + header order, AkamaiGHost 403s before sensor evaluation. This plan rewires `executor/http.js` to use the Node binding of bogdanfinn's tls-client, so every adapter inherits the fix.

## What changes

### 1. Dependencies (`executor/package.json`)
- Add `node-tls-client` (Node wrapper around bogdanfinn's Go shared lib; ships precompiled binaries for linux-x64/arm64, macOS, Windows).
- Keep `undici` for now — `src/lib/*` server functions in the TanStack app still use it (they aren't behind Akamai). Remove from executor only after migration is verified.

### 2. `executor/Dockerfile`
- Switch base from `node:20-alpine` to `node:20-bookworm-slim`. The bogdanfinn shared library is glibc-built and does not load on Alpine/musl.
- Add `ca-certificates` apt package (TLS roots for the proxy CONNECT).

### 3. `executor/http.js` — rewrite around `node-tls-client`
- New module surface (keeps the same exports so adapters don't change):
  - `makeDispatcher(rawProxy)` → now returns a small `{ proxy, sessionOpts }` descriptor instead of an undici `ProxyAgent`. Each task still gets one descriptor.
  - `createJar()` → unchanged API (`ingest`, `header`, `has`, `get`, `dump`). Internally we ignore tls-client's built-in jar (it's domain-aware and we currently treat cookies name-globally to handle the api.kmart.com.au scope flip in kmart.js) and continue to drive cookies manually via the existing jar.
  - `request(url, opts, ctx)` → builds a per-call `Session` from `node-tls-client` with:
    - `clientIdentifier: "chrome_124"` (matches our UA + sec-ch-ua)
    - `proxy: ctx.dispatcher?.proxy` (http://user:pass@host:port string)
    - `headerOrder: [...]` — explicit Chrome 124 nav-request order: `host, connection, cache-control, sec-ch-ua, sec-ch-ua-mobile, sec-ch-ua-platform, upgrade-insecure-requests, user-agent, accept, sec-fetch-site, sec-fetch-mode, sec-fetch-user, sec-fetch-dest, accept-encoding, accept-language, cookie`
    - `followRedirects: false` (we still capture redirects manually)
    - `insecureSkipVerify: false`
  - Set-Cookie capture: tls-client returns headers as a plain object — read `res.headers["set-cookie"]` (array) and feed each entry into `jar.ingest(...)` via a small adapter that mimics the `getSetCookie()` shape.
- Response shape: return a Fetch-Response-like wrapper with `status`, `text()`, `json()`, and a `headers` object exposing `.get(name)` and `.getSetCookie()` so `kmart.js`, `index.js`, `checkout.js` need no changes.
- Keep `UA` export identical.

### 4. `executor/server.js` and adapters
- No changes required. They consume `request`, `createJar`, `makeDispatcher`, `UA` — surface preserved.

### 5. `executor/ip-resolve.js`
- Already calls `request(...)` — inherits the new TLS client. No code change. (Bonus: the egress IP we report to Hyper now comes from a Chrome-fingerprinted handshake too.)

## Validation
1. After deploy:
   - Hit `/exec/test` with `mode=recon` against `https://api.ipify.org?format=json` through a wealthproxies entry → confirm egress IP comes back (proves proxy still works through the new client).
   - Hit `/exec/test` with the Kmart PDP → expect `pdp_get` to return 200 (or at minimum HTML, not the AkamaiGHost reference-code body).
2. If `pdp_get` still 403s but with a different/full Akamai challenge HTML (not the bare reference-code page), TLS is no longer the blocker and the next step is sensor/SBSD tuning rather than fingerprint.

## Out of scope (explicitly)
- No changes to `src/lib/*` (TanStack server functions, paydock, shopify, browserless ping) — none of those hit Akamai.
- No Browserless wiring. We're committing to the TLS-client approach end-to-end.
- No proxy-group/UI changes.
- No new env vars or secrets.

## Risks / things to watch
- **Docker base change** (alpine → bookworm-slim) increases image size by ~80MB. Acceptable; Fly cold starts are unaffected for a long-running machine.
- **`node-tls-client` native binary** must match the runtime arch. Fly executor runs linux/amd64 — the package ships that prebuild. If we later add arm64 machines, the postinstall will fetch the right binary automatically.
- **Header casing**: tls-client preserves lowercase header keys we send (good — matches Chrome). Adapters already lowercase everything. No edge case there.
- **Cookie jar**: we deliberately keep the name-keyed jar to preserve the current `www.kmart.com.au` → `api.kmart.com.au` `_abck` overwrite behavior. If we later need domain-scoped cookies, that's a separate change.
