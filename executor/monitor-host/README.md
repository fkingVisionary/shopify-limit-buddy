# Bandai always-on stock monitor + Vanta Lab (Railway)

Permanent global poller for Premium Bandai AU search/list restocks, plus a
phone **Vanta Lab** for monitor control and remote Bot launches via Fly.

## Phone admin

Open **`/admin/`** (e.g. `https://j1ms-bandai-monitor-production.up.railway.app/admin/`).

Unlock with `MONITOR_TOKEN`.

### Tabs

| Tab | What |
|---|---|
| **Monitor** | Start/stop polling, keywords/SKUs, ISP/DC, interval, OOS toggle, hits |
| **Bot** | Fly executor health, vault (accounts/profile/checkout proxies), launch Bandai / Kmart |
| **Logs** | In-memory monitor / bot / Discord event stream (clears on redeploy) |
| **Labs** | Discord restock/OOS test pings, force monitor poll |

Bot launches call Fly `POST /run` asynchronously and show recent run status on the phone.

## Railway env

| Var | Purpose |
|---|---|
| `MONITOR_TOKEN` | Bearer for admin + APIs |
| `DISCORD_WEBHOOK_URL` | Operator restock / OOS channel |
| `BANDAI_MONITOR_ISP_PROXIES` | Monitor poll ISP list (bootstrap) |
| `BANDAI_MONITOR_DC_PROXIES` | Monitor DC (optional) |
| `BANDAI_MONITOR_KEYWORDS` | Bootstrap keywords |
| `BANDAI_MONITOR_INTERVAL_MS` | Bootstrap interval |
| `BANDAI_MONITOR_NOTIFY_OOS` | `0` to disable OOS Discord |
| `EXECUTOR_URL` | Fly origin, e.g. `https://j1ms-bot-executor.fly.dev` |
| `EXECUTOR_TOKEN` | Same Bearer as Fly executor (required for Bot tab launches) |
| `MONITOR_STATE_PATH` / `BOT_VAULT_PATH` | Optional durable JSON paths (or Railway volume) |

Without `EXECUTOR_TOKEN`, Monitor + Discord labs still work; Bot launches show a setup warning.

## Discord

- Restock — **black** accent  
- OOS — **red** accent + `OOS ·` title  

## Deploy

Root Directory = `executor`. Dockerfile = `monitor-host/Dockerfile`.

**Merging to `main` does not auto-deploy** unless Railway’s GitHub connection is
watching this service, or you run the **Deploy Bandai monitor (Railway)** GitHub
Action (`RAILWAY_TOKEN` secret).

### Redeploy now (phone / dashboard)

1. Railway → project **j1ms-bandai-monitor** → service → **Deployments**
2. **Redeploy** the latest from `main` (or trigger a new deploy from GitHub)
3. Confirm tip moved: open `/health` — should show `gitSha` and `quickTask:"/qt"`
4. Open `/qt?sku=N1` — should be an HTML “Opening Quick Task…” page (not 404)
5. Labs → **Test restock** — Discord embed description includes **⚡ Quick Task**

### Discord Quick Task

Restock (live + lab test) embeds include:

- Description link → `https://<monitor>/qt?sku=…` (always visible)
- LINK button row (when Discord accepts components on your webhook)
- Desktop field with the same link

`/qt` bounces the browser to `http://127.0.0.1:17865/quicktask` (desktop must be open).
