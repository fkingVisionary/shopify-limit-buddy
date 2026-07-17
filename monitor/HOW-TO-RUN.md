# Kmart monitor — how to run (plain English)

## The short version

There is **no separate monitor Fly app**.

Global feed runs on the **same** executor you already have:

`https://j1ms-bot-executor.fly.dev/feed`

Desktop Global mode is already pointed there.

## Secrets

Already on Fly (unchanged): `EXECUTOR_TOKEN`, `HYPER_API_KEY`, `PROXY_URL_RESI`.

Feed auth matches desktop: **any non-empty API key** works (`MONITOR_AUTH_MODE=open`).  
No separate monitor whitelist.

Optional later: `MONITOR_ISP_PROXIES` if you want a dedicated ISP pool (else uses `PROXY_URL_RESI`).

`MONITOR_ENABLE=1` is baked into `executor/fly.toml`.

Redeploy executor after pulling this change:

```powershell
# From GitHub Actions: Actions → Deploy executor → Run workflow
# or locally if you have flyctl:
cd executor
fly deploy
```

## Check it’s alive

- Health: `https://j1ms-bot-executor.fly.dev/health` → `"monitorEnabled": true`
- Monitor detail: `https://j1ms-bot-executor.fly.dev/monitor/health`
- Manual probe (any desktop API key as Bearer / `?access_token=`):  
  `https://j1ms-bot-executor.fly.dev/probe?url=https://www.kmart.com.au/product/...`

## Local-only (optional)

`monitor/` is still useful as a **standalone local** poller for laptop testing:

```powershell
cd monitor
npm start
```

That starts a local sidecar + `:8091` feed. Point desktop at it only if needed:

```powershell
cd desktop
$env:MONITOR_FEED_URL="http://127.0.0.1:8091/feed"
npm start
```

Desktop’s own executor sidecar does **not** run the global poller (`MONITOR_ENABLE` off by default).

## Edit what it watches

Edit `executor/watchlist.json` (deployed with the executor image), then redeploy.
Or set `MONITOR_WATCH_SKUS` / `MONITOR_DISCOVERY_QUERIES` secrets.

## Honest status

Akamai on proxy exits is still the hard part. Hyper + a known-good `PROXY_URL_RESI` on Fly is why cloud probes work better than burned ISP exits.
