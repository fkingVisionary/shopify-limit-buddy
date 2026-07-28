# Bandai always-on stock monitor (Railway)

Permanent global poller for Premium Bandai AU search/list restocks.
**No checkout** — Desktop / Fly still claim F5 and ATC on hit.

## Deploy

Root Directory on the Railway service = `executor`.  
Dockerfile = `monitor-host/Dockerfile` (see `railway.toml` / `executor/railway.toml`).

## Phone admin (Vanta Lab)

Open **`/admin/`** on the Railway URL (e.g. `https://…railway.app/admin/`).

Unlock with Bearer `MONITOR_TOKEN`. From your phone you can:

- Edit watch **keywords / SKUs** (live, no redeploy)
- Paste **ISP / DC** proxy lines and poll interval
- Toggle **Discord OOS** pings
- Force a poll, fire **test restock / test OOS** Discord embeds

Runtime edits persist to `MONITOR_STATE_PATH` (default `/tmp/…`, or a Railway volume mount). Without a volume they last until the next redeploy — env vars remain the bootstrap defaults.

## Env

| Var | Purpose |
|---|---|
| `BANDAI_MONITOR_DC_PROXIES` | Multiline DC proxies (optional until you have them) |
| `BANDAI_MONITOR_ISP_PROXIES` | AU ISP slice (current primary) |
| `BANDAI_MONITOR_ISP_RATIO` | Default `0.8` ISP share when both set |
| `BANDAI_MONITOR_KEYWORDS` | Comma list / SKUs in search |
| `BANDAI_MONITOR_INTERVAL_MS` | Poll interval (try `3000`–`5000`) |
| `BANDAI_MONITOR_AREA` | `au` |
| `BANDAI_MONITOR_NOTIFY_OOS` | `0` to disable OOS Discord (default on) |
| `MONITOR_TOKEN` | Bearer for `/status`, `/events`, `/hits`, `/admin` APIs |
| `DISCORD_WEBHOOK_URL` | Operator restock + OOS channel |
| `MONITOR_STATE_PATH` | Optional durable JSON path for admin edits |

## Endpoints

- `GET /admin/` — phone lab UI
- `GET /health` — open (Railway healthcheck)
- `GET /status` — hub + recent hits (auth)
- `GET /hits` — buffer of stock events (auth)
- `GET /events` — SSE `stock_changed` stream (auth)
- `GET|PUT /admin/config` — keywords / proxies / toggles (auth)
- `POST /lab/poll` — force one catalog poll (auth)
- `POST /test-discord?sku=…&kind=restock|oos` — Vanta test ping (auth)

## Discord (operator only)

Set Railway `DISCORD_WEBHOOK_URL` to the **operator** channel webhook.

- **Restock / new in stock** — black accent (brand)  
- **Went OOS** — red accent + `OOS ·` title (toggle in admin)  
- `@role` pings intentionally deferred  

Per-user Discord webhooks live in Desktop Settings and only fire for that user's
checkout success/fail.
