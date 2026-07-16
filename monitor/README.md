# Kmart monitor service

Operator-owned global Kmart detector. **Detect + publish only** — never places orders.

**Start here (non-dev friendly):** see [HOW-TO-RUN.md](./HOW-TO-RUN.md).

Desktop apps can subscribe to a local feed (`MONITOR_FEED_URL=http://127.0.0.1:8091/feed`)
or later to a Fly-hosted feed. Users never configure a monitor URL in the UI.

## Quick start

```bash
cd monitor
npm install
# watchlist.json + isp.proxies should already exist
npm start
```

`npm start` auto-boots the existing `executor/` with Hyper (from desktop Settings)
and polls Kmart. No separate “new executor release” required for local use.

- Health: `GET /health`
- Feed: `GET /feed` with `Authorization: Bearer <key>` or `?access_token=`
- Manual probe: `GET /probe?url=...` (Hyper via executor)
- Watchlist is **operator-only** (file / env). Users cannot mutate it.

## Env

| Var | Purpose |
|-----|---------|
| `PORT` | Listen port (default `8091`) |
| `MONITOR_API_KEYS` | Comma-separated API keys (or `MONITOR_AUTH_MODE=open`) |
| `MONITOR_AUTH_MODE` | `allowlist` (default) or `open` |
| `MONITOR_ISP_PROXIES` | Comma-separated http proxies for polling |
| `MONITOR_EXECUTOR_URL` | Checkout executor base URL (required for Hyper probes) |
| `MONITOR_EXECUTOR_TOKEN` | Bearer token matching executor `EXECUTOR_TOKEN` |
| `MONITOR_WATCHLIST` | Path to watchlist JSON (default `./watchlist.json`) |
| `MONITOR_POLL_MS` | SKU poll interval (default `20000`) |
| `MONITOR_DISCOVERY_MS` | Discovery poll interval (default `60000`) |
| `MONITOR_PROBE_TIMEOUT_MS` | Per-SKU Hyper probe timeout (default `90000`) |

## Deploy (Fly Sydney)

```bash
fly apps create j1ms-kmart-monitor   # once
fly secrets set MONITOR_API_KEYS=... MONITOR_ISP_PROXIES=...
fly deploy
```

See `fly.toml`. Keep this process separate from the checkout executor so poll rate ≠ checkout budget.

## Architecture

- `src/watchlist.cjs` — hot SKUs/PDPs + discovery queries
- `src/proxies.cjs` — AU ISP rotation
- `src/pollers/kmart-sku.cjs` — fast PDP stock poll
- `src/pollers/kmart-discovery.cjs` — search → `new` events + promote to SKU list
- `src/feed.cjs` — SSE broadcast
- `src/events.cjs` — re-exports desktop event helpers
