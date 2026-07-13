# J1m's Bot — Node Executor Service

A tiny Node service that runs the checkout HTTP chain through a residential proxy.
The Lovable app (control plane / UI) calls this service over HTTPS; this service
makes the actual outbound requests through `undici` + `ProxyAgent`, so Shopify /
Cloudflare / Akamai see the residential IP, not a Cloudflare datacenter IP.

## Why this exists

Cloudflare Workers' `fetch()` has no per-request HTTP proxy support. Every
request from the Lovable backend leaves from a Cloudflare datacenter, which
Cloudflare itself instantly 403s. Moving the actual fetches onto a Node host
with `undici` unblocks the proxy.

## Endpoints

- `GET  /health` → `{ ok: true, transport, hyperApiKey, proxyConfigured, … }`
- `POST /health/diagnose` (auth) → deep health: TLS fingerprint + proxy CONNECT probe + direct target fetch. Use this before `/run` when diagnosing `ERR_CONNECTION_CLOSED`.
- `POST /run` (auth: `Authorization: Bearer $EXECUTOR_TOKEN`)
  ```json
  {
    "taskId": "abc",
    "storeUrl": "https://www.kmart.com.au/product/…",
    "variantId": 1,
    "qty": 1,
    "proxy": "user:pass@host:port",
    "dryRun": true,
    "kmartMode": "current"
  }
  ```
  Returns a per-step timeline. Set `kmartMode:"playwright"` for the Chromium fallback lane.
- `POST /transport/diagnose` — authenticated one-fetch transport check.
- `POST /akamai/lab` — Akamai-only sensor lab (see `experiments/`).
- `POST /jbhifi/recon` / `POST /jbhifi/probe` — JB Hi-Fi recon (not on checkout path).

## Env vars

- `EXECUTOR_TOKEN` — shared secret. The Lovable app sends this in the
  `Authorization` header. Generate with `openssl rand -hex 32`.
- `PORT` — default `8080`.
- `EXECUTOR_HTTP_TRANSPORT` — `undici` (default) or `tls`.
  Keep this set to `undici` when recovering from empty 502s. Use `tls` only for
  deliberate Chrome TLS impersonation experiments; proxied runs do not force TLS
  unless this env var or the request body opts in.
- `/run` request override — pass `"transport":"tls"` / `"forceTls":true` for
  a single TLS test, or `"transport":"undici"` / `"forceUndici":true` to force
  the stable path even with a proxy.
- `POST /transport/diagnose` — authenticated one-fetch transport check for
  isolating direct/proxy + undici/tls without running the checkout chain.

## Deploy note

If you explicitly set `EXECUTOR_HTTP_TRANSPORT=tls`, the Docker image
prewarms `node-tls-client` during build, but an instant empty `502` still
means the native TLS process path crashed before Fastify could serialize
an error.

Card secrets are unrelated to startup or empty-502 transport failures. They are
only used later when a task actually reaches tokenization/place-order.

## Local run

```bash
cd executor
npm install
EXECUTOR_TOKEN=devtoken node server.js
# in another shell:
curl -s http://localhost:8080/run \
  -H "authorization: Bearer devtoken" \
  -H "content-type: application/json" \
  -d '{"taskId":"t1","storeUrl":"https://www.jbhifi.com.au","variantId":1,"qty":1,"proxy":"user:pass@premium-proxy.ipfist.com:1818","dryRun":true}'
```

## Deploy to Fly.io

See `SETUP.md` in the project root for a step-by-step walkthrough.
