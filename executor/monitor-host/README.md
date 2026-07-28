# Bandai always-on stock monitor (Railway)

Permanent global poller for Premium Bandai AU search/list restocks.
**No checkout** — Desktop / Fly still claim F5 and ATC on hit.

## Deploy

Root Directory on the Railway service = `executor`.  
Dockerfile = `monitor-host/Dockerfile` (see `railway.toml`).

## Env

| Var | Purpose |
|---|---|
| `BANDAI_MONITOR_DC_PROXIES` | Multiline unlimited DC proxies (primary) |
| `BANDAI_MONITOR_ISP_PROXIES` | Optional AU ISP slice |
| `BANDAI_MONITOR_ISP_RATIO` | Default `0.8` ISP share when both set — lower for drip hunting |
| `BANDAI_MONITOR_KEYWORDS` | Comma list / SKUs in search |
| `BANDAI_MONITOR_INTERVAL_MS` | Poll interval (try `3000`–`5000`) |
| `BANDAI_MONITOR_AREA` | `au` |
| `MONITOR_TOKEN` | Bearer for `/status`, `/events`, `/hits` |

## Endpoints

- `GET /health` — open (Railway healthcheck)
- `GET /status` — hub + recent hits (auth)
- `GET /hits` — buffer of in-stock events (auth)
- `GET /events` — SSE `stock_changed` stream (auth)
- `POST /test-discord?sku=N2890904001` — operator Vanta restock test ping (auth)

## Discord (operator only)

Set Railway `DISCORD_WEBHOOK_URL` to the **operator** restock channel webhook.
This is not user-configurable from Desktop — stops the shared poller being piped
into third-party groups.

Per-user Discord webhooks live in Desktop Settings and only fire for that user's
checkout success/fail.
