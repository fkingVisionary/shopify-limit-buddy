# Bandai always-on stock monitor + Vanta Lab (Railway)

Permanent global poller for Premium Bandai AU search/list restocks, plus a
phone **Vanta Lab** for monitor control and remote Bot launches via Fly.

## Phone admin

Open **`/admin/`** (e.g. `https://j1ms-bandai-monitor-production.up.railway.app/admin/`).

Unlock with `MONITOR_TOKEN` (operator/admin only).

Desktop consumers need **no token**: `GET /events` (SSE), `GET /hits`,
`GET /preset-catalog`, and `GET /product-cache` are public by default
(`MONITOR_FEED_PUBLIC=1`). Set `MONITOR_FEED_PUBLIC=0` to lock those behind Bearer.

### Tabs

| Tab | What |
|---|---|
| **Monitor** | Start/stop polling, watch keywords/SKUs, **Action Store presets**, ISP/DC, interval, OOS toggle, hits |
| **Bot** | Fly executor health, vault (accounts/profile/checkout proxies), launch Bandai / Kmart |
| **Logs** | In-memory monitor / bot / Discord event stream (clears on redeploy) |
| **Labs** | Discord restock/OOS test pings, force monitor poll |

**Watch keywords** = what the poller searches. **Action Store presets** = SKU library
Desktop pulls via public `GET /preset-catalog` for Smart Action packs.

Paste SKU / `bandai SKU` / Bandai PDP link — **Save & fetch names** pulls product
titles + backend PIDs (NAI) from `p-bandai.com` into a **shared product cache**
(`GET/POST /product-cache`). Every Desktop member pulls that cache on engine start /
Action Store refresh so task start can skip public N→NAI resolve.

Bot launches call Fly `POST /run` asynchronously and show recent run status on the phone.

## Railway env

| Var | Purpose |
|---|---|
| `MONITOR_TOKEN` | Bearer for admin / bot / writes (not required for Desktop SSE) |
| `HYPER_API_KEY` | Pokémon Centre AU edge (Incapsula Reese84 + DataDome); Bandai polls without it |
| `PC_MONITOR_ENABLE` | `1` (default) = PKC poller on when admin watchlist is set |
| `MONITOR_FEED_PUBLIC` | `1` (default) = public SSE + catalog/cache reads; `0` = require Bearer |
| `DISCORD_WEBHOOK_URL` | Operator restock / OOS channel |
| `BANDAI_MONITOR_ISP_PROXIES` | Monitor poll ISP list (bootstrap / env OSPs) |
| `BANDAI_MONITOR_DC_PROXIES` | Monitor DC (optional bootstrap) |
| `BANDAI_MONITOR_KEYWORDS` | Bootstrap keywords |
| `BANDAI_MONITOR_INTERVAL_MS` | Bootstrap interval |
| `BANDAI_MONITOR_NOTIFY_OOS` | `0` to disable OOS Discord |
| `MONITOR_STALE_LIMIT_MS` | Watchdog: max quiet time before restart (default ~6× interval, ≥120s) |
| `EXECUTOR_URL` | Fly origin, e.g. `https://j1ms-bot-executor.fly.dev` |
| `EXECUTOR_TOKEN` | Same Bearer as Fly executor (required for Bot tab launches) |
| `MONITOR_DATA_DIR` / `MONITOR_STATE_PATH` / `BOT_VAULT_PATH` | Durable JSON paths |
| `RAILWAY_VOLUME_MOUNT_PATH` | Set automatically when a Railway volume is attached |

### Overnight hangs

If polls go quiet (proxy tunnel stuck, Discord webhook hang, loop exit), a **watchdog**
restarts the monitor in-process and clears proxy cooldowns. `/health` reports
`healthy:false` + HTTP **503** when stale so Railway can bounce the service as a
backstop. Admin **Stop** is intentional — health stays green while stopped.

### Proxy rotation (thin)

- Round-robin ISP/DC (default **80% ISP / 20% DC**)
- Sticky window: **3 polls** or **75s** wall-clock (whichever first), then rotate + re-warm
- Fail → cooldown that exit (~5 min) and pick the next
- If the whole pool is cooling → clear cooldowns once and keep polling (no dead wait)
- Env knobs: `BANDAI_MONITOR_STICKY_POLLS`, `BANDAI_MONITOR_STICKY_MAX_MS`, `BANDAI_MONITOR_ISP_RATIO`, `BANDAI_MONITOR_COOLDOWN_MS`

### Proxy persistence (important)

Admin **ISP / DC** lines are saved to disk (`vanta-monitor-state.json`), not into Railway env.
Hardcoded env OSPs (`BANDAI_MONITOR_ISP_PROXIES`) always come back on boot as the bootstrap list.

Default write path is **`/data`** (container layer → survives process restart). **`/tmp` is ephemeral**
and will drop admin-added proxies after a restart — only env OSPs remain.

For **redeploy-safe** saves: Railway → service → **Volumes** → mount at `/data`
(or set `MONITOR_DATA_DIR` / `RAILWAY_VOLUME_MOUNT_PATH`). The admin Monitor tab shows a
persistence warning when saves would not survive.

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
