## What’s most likely happening

The current code has a mismatch:

- `executor/http.js` says the stable default is `undici` unless `EXECUTOR_HTTP_TRANSPORT=tls`.
- `executor/checkout.js` overrides that and defaults every `/run` task to TLS unless `EXECUTOR_HTTP_TRANSPORT=undici` is explicitly set.
- `executor/http.js` also forces TLS whenever any proxy URL is present.

So deleting the transport secret did not fully revert to stable behavior. `/run` still uses the native TLS client, and proxied runs always use it. An empty 502 strongly suggests the native TLS process/library is crashing before Fastify can return JSON.

## Plan

1. **Make transport behavior explicit and non-crashy**
   - Stop `/run` from silently forcing TLS by default.
   - Default to `undici` unless the env var or request explicitly asks for TLS.
   - Keep TLS available for Kmart experiments, but make it opt-in rather than implicit.

2. **Add a controlled TLS flag per task**
   - Allow request bodies like `transport: "tls"` or `forceTls: true` for one-off tests.
   - Allow `transport: "undici"` / `forceUndici: true` to force the stable path even when a proxy is supplied.
   - Return the selected transport in the `/run` response/timeline so we know what actually ran.

3. **Wrap top-level `/run` failures**
   - Add an outer catch around `runCheckout` in `server.js` so normal JS errors return JSON instead of opaque failures.
   - This will not catch a true native hard-crash, which is useful signal: if it is still an empty 502 after this, we know the process is dying below JS.

4. **Add a lightweight transport diagnostic endpoint**
   - Add or extend a safe diagnostic route that initializes the chosen transport and performs one simple fetch.
   - This lets us test direct/proxy + undici/tls separately without running the full Kmart chain.

5. **Update executor docs/secrets guidance**
   - Document the immediate safe setting:
     - set `EXECUTOR_HTTP_TRANSPORT=undici` to recover JSON responses
     - only set `tls` when specifically testing native TLS
   - Clarify that card secrets are unrelated to this failure.

## How to proceed right now on Fly

Before code changes, the fastest test is to set this secret back explicitly:

```bash
EXECUTOR_HTTP_TRANSPORT=undici
```

Then re-run.

Expected outcome:
- If the empty 502 disappears and you get a normal JSON timeline/403, the TLS native path is confirmed as the crash source.
- If the empty 502 continues even with `undici`, the crash is outside the Kmart TLS path and we should inspect Fly logs/startup next.