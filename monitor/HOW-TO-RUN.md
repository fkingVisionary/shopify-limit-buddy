# Kmart monitor — how to run (plain English)

## The short version

You do **not** need a new executor product.

1. Your **Fly checkout executor already exists** and already has Hyper  
   (`https://j1ms-bot-executor.fly.dev` — health checks OK).
2. The monitor reuses that same Kmart + Hyper code from the `executor/` folder.
3. On your PC, one command starts everything:

```powershell
cd monitor
npm start
```

That auto-starts the local checkout engine using the Hyper key already saved in
your desktop Settings.

## What you should see

When it starts:

- `Executor: local-sidecar → http://127.0.0.1:….`
- `listening on :8091`
- Feed URL: `http://127.0.0.1:8091/feed`

Test in a browser:

`http://127.0.0.1:8091/probe`

## See it in the desktop Monitor tab

```powershell
cd desktop
$env:MONITOR_FEED_URL="http://127.0.0.1:8091/feed"
npm start
```

Open the **Monitor** tab.

## Edit what it watches

Edit `monitor/watchlist.json` (product URLs), then restart `npm start`.

## Honest status (read this)

The wiring is done. What still bites us is **Akamai on the proxy exits**:

- Hyper sensors often succeed
- Kmart PDP / GraphQL still returns Access Denied on the ISP list and on the
  desktop proxies we tried from this machine
- Your **Fly** executor checkouts work because Fly has a known-good residential
  proxy (`PROXY_URL_RESI`) baked into that server

So for a monitor that actually detects stock reliably, the next move is:

### Option A — use the Fly executor for probes (best)

1. Redeploy `executor/` to Fly so it includes the new `/kmart/stock-probe` route  
   (right now Fly returns 404 for that path — old deploy).
2. Put this in `monitor/.env`:

```
EXECUTOR_TOKEN=same_token_as_fly
```

3. Run `npm start` again — it will call Fly instead of the local sidecar.

### Option B — keep running locally

Leave `npm start` running on a PC that stays on. It will keep probing. As soon
as a proxy exit clears Akamai, events show up on the feed.

## Files that matter

| File | What |
|------|------|
| `monitor/watchlist.json` | SKUs / URLs to watch |
| `monitor/isp.proxies` | ISP list (gitignored) |
| `monitor/.env` | optional `EXECUTOR_TOKEN` or `HYPER_API_KEY` |
| desktop Settings → Hyper | already used automatically |
