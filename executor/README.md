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

- `GET  /health` → `{ ok: true }`
- `POST /run` (auth: `Authorization: Bearer $EXECUTOR_TOKEN`)
  ```json
  {
    "taskId": "abc",
    "storeUrl": "https://www.jbhifi.com.au",
    "variantId": 1234567890,
    "qty": 1,
    "proxy": "user:pass@host:port",
    "dryRun": true
  }
  ```
  Returns a per-step timeline: `warm_home → cart_add → cart_redirect → checkout_page`.

## Env vars

- `EXECUTOR_TOKEN` — shared secret. The Lovable app sends this in the
  `Authorization` header. Generate with `openssl rand -hex 32`.
- `PORT` — default `8080`.
- `EXECUTOR_HTTP_TRANSPORT` — default `undici`. Set to `tls` only for controlled
  `node-tls-client` experiments; the native TLS path can crash the process and
  show up as an empty `502` from `/run`.

## Important deploy note

The default executor path is now `undici`, not native TLS, so `/run` should
return a JSON step timeline even when Kmart blocks a request. If you explicitly
set `EXECUTOR_HTTP_TRANSPORT=tls`, the Docker image prewarms `node-tls-client`
during build, but an instant empty `502` still means the native TLS process path
crashed before Fastify could serialize an error.

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
