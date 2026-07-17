# Kmart monitor service

Operator-owned global Kmart detector. **Detect + publish only** — never places orders.

**Production:** co-located on `j1ms-bot-executor` (`MONITOR_ENABLE=1`).  
Feed: `https://j1ms-bot-executor.fly.dev/feed` — no separate Fly monitor app.

**Start here (non-dev friendly):** see [HOW-TO-RUN.md](./HOW-TO-RUN.md).

This `monitor/` folder remains for **local laptop testing** only. Desktop Global mode
uses the executor feed by default; override with `MONITOR_FEED_URL` for local ops.

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
| `MONITOR_AUTH_MODE` | `open` (default — any non-empty API key) or `allowlist` |
| `MONITOR_API_KEYS` | Only if mode=`allowlist` |
| `MONITOR_ISP_PROXIES` | Comma-separated http proxies for polling |
| `MONITOR_EXECUTOR_URL` | Checkout executor base URL (required for Hyper probes) |
| `MONITOR_EXECUTOR_TOKEN` | Bearer token matching executor `EXECUTOR_TOKEN` |
| `MONITOR_WATCHLIST` | Path to watchlist JSON (default `./watchlist.json`) |
| `MONITOR_POLL_MS` | SKU poll interval (default `20000`) |
| `MONITOR_DISCOVERY_MS` | Discovery poll interval (default `60000`) |
| `MONITOR_PROBE_TIMEOUT_MS` | Per-SKU Hyper probe timeout (default `90000`) |

## Deploy

Do **not** deploy this folder as its own Fly app anymore.

Redeploy `executor/` (same `j1ms-bot-executor`). Set secrets there:

```bash
# optional ISP pool — otherwise PROXY_URL_RESI is used
fly secrets set MONITOR_ISP_PROXIES=... -a j1ms-bot-executor
```

See `executor/fly.toml` (`MONITOR_ENABLE=1`, `MONITOR_AUTH_MODE=open`, always-on).

## Architecture

- `src/watchlist.cjs` — hot SKUs/PDPs + discovery queries
- `src/proxies.cjs` — AU ISP rotation
- `src/pollers/kmart-sku.cjs` — fast PDP stock poll
- `src/pollers/kmart-discovery.cjs` — search → `new` events + promote to SKU list
- `src/feed.cjs` — SSE broadcast
- `src/events.cjs` — re-exports desktop event helpers
