# Bandai global stock monitor (V1)

Decoupled from checkout. Polls **list/search** endpoints (not per-SKU PDP),
diffs a catalog snapshot, and emits `stock_changed`.

## Why not per-product ping?

Restocks + new drops are covered by search/list cards that already expose
`purchaseAvailable` / `flags` / `saleStatus`. One keyword page (~40 SKUs) is
cheaper and broader than N PDP polls. Tune `BANDAI_MONITOR_KEYWORDS`.

## Pieces

| Module | Role |
|--------|------|
| `monitor/bandai-stock-monitor.js` | Poll loop + EventEmitter (`stock_changed`, `poll`, `error`) |
| `monitor/monitor-proxy-pool.js` | Dedicated ISP+DC lists (not `resi.proxies`) |
| `monitor/task-state-machine.js` | `idle→monitoring→triggered→checking_out→success/failed` (for later task wire) |
| `monitor/stock-checkout-bridge.js` | Thin listener — V1 logs only; later calls `runCheckout` |

**Checkout is not imported.** Bridge accepts an optional `runCheckout(taskId)` later.

## Proxy policy (don’t burn the pool)

- Separate env/files from checkout ISP.
- Default **80% ISP / 20% DC** (`BANDAI_MONITOR_ISP_RATIO=0.8`).
- **Sticky window**: reuse one exit for `BANDAI_MONITOR_STICKY_POLLS` (default 6) then rotate — fewer warms, less fingerprint thrash.
- On failure: cooldown that URL (`BANDAI_MONITOR_COOLDOWN_MS`, default 5m) and rotate.
- Rotate mode: `roundrobin` (default) or `random`.

## Env

```bash
BANDAI_MONITOR_INTERVAL_MS=10000          # V1 test default 10s
BANDAI_MONITOR_KEYWORDS=ONE PIECE,GUNDAM
BANDAI_MONITOR_AREA=au
BANDAI_MONITOR_SEARCH_LIMIT=40
BANDAI_MONITOR_STICKY_POLLS=6
BANDAI_MONITOR_ISP_RATIO=0.8
BANDAI_MONITOR_ROTATE=roundrobin          # or random
BANDAI_MONITOR_COOLDOWN_MS=300000

# Lists (multiline) OR files:
BANDAI_MONITOR_ISP_PROXIES='host:port:user:pass
…'
BANDAI_MONITOR_DC_PROXIES='…'
# or
BANDAI_MONITOR_ISP_FILE=/path/to/isp.proxies
BANDAI_MONITOR_DC_FILE=/path/to/dc.proxies
# defaults: executor/monitor/isp.proxies + dc.proxies
```

## Lab

```bash
cd executor
# put monitor proxies in monitor/isp.proxies (and optional dc.proxies)
BANDAI_MONITOR_MAX_POLLS=3 BANDAI_MONITOR_INTERVAL_MS=10000 \
  node scripts/bandai-stock-monitor-lab.mjs
```

First poll builds a **baseline** (no events). Later polls emit `stock_changed` on
restock (`false→true`) or newly seen in-stock cards.

## Next (not V1)

- Desktop global monitor toggle + live event feed
- Wire tasks in `monitoring` via bridge → `runCheckout(task)`
- Pre-warm checkout sessions on subscribe (separate from monitor proxies)
