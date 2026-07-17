# Kmart monitor — how it works

## Zephyr-style model (what we run now)

Kmart does **not** push restocks to anyone. Fast monitors poll light endpoints hard, then push to you.

```
Fly executor (same app as checkout)
  ├─ discovery: search HTML every ~8s (keywords in watchlist)
  ├─ confirm: light PDP HTML via resi/ISP (~seconds, NOT Hyper)
  ├─ SKU re-probe: promoted products every ~4s
  └─ /feed SSE → desktop
         │
         ▼
Desktop Global tasks filter with keywords (pokemon,etb,-plush)
```

Hyper checkout path is **not** used for routine detect. Optional only:

`MONITOR_HYPER_FALLBACK=1`

## Catch restocks + filter

| Layer | Who | What |
|-------|-----|------|
| Net | Operator `executor/watchlist.json` | discovery queries (+ optional pinned SKUs) |
| Detect | Fly pollers | new / restock when stock flips to in-stock |
| Filter | Your Global task | keywords / URL / SKU |

Widen coverage = add more `discovery` queries.  
Your keywords only decide which feed events start checkout.

## Deploy

Commit → push → GitHub Actions → **Deploy executor**.

Health: `https://j1ms-bot-executor.fly.dev/health` → `"monitorEnabled": true`

### ISP fleet

List lives in `executor/isp.proxies` (one per line) and deploys with the executor image.  
Edit that file → commit → redeploy. Rotation is automatic — no Fly secret.

## Desktop

1. Settings → API key  
2. Task → Monitor on → **Global** → e.g. `pokemon,etb,-plush`  
3. Start task — waits on feed; matching in-stock events fire checkout  

Monitor tab search = browse/filter the feed only.
