# Disney Store AU stock monitor (V1)

Same shape as Bandai’s global/local monitor: poll **search PLP** (not per-SKU PDP),
diff tealium product cards (`availability: online - in_stock`), emit `stock_changed`.

## Pieces

| Module | Role |
|--------|------|
| `monitor/disney-stock-monitor.js` | Poll `/search?q=` + EventEmitter |
| `monitor/event-filter.js` | `disneyWatchSku` / `disneyWatchKeywords` + `resolveDisneyMonitorMode` |
| `monitor/global-monitor-hub.js` | Inject `createDisneyStockMonitor` as hub monitor |
| `monitor/task-local-monitor.js` | `store: "disney"` → Disney poller on task proxies |

Checkout adapters are **not** imported.

## Env (global poll)

```bash
DISNEY_MONITOR_INTERVAL_MS=10000
DISNEY_MONITOR_KEYWORDS=lorcana,stitch
DISNEY_MONITOR_STICKY_POLLS=6
DISNEY_MONITOR_ISP_PROXIES='…'   # or DISNEY_MONITOR_ISP_FILE
# Falls back to monitor/isp.proxies (+ Bandai monitor lists) when unset.
DISNEY_MONITOR_MAX_POLLS=3       # desktop run stop after N polls
```

## Desktop

Disney mode **Monitor**:

| Monitor source | Behavior |
|----------------|----------|
| **Global** | Subscribe/filter only. Task SKU/keywords match shared `stock_changed`. Does **not** expand the global poll set. |
| **Task-local** | In-process poller using the task’s proxy group + interval/delay. |

Fields: `disneyMonitorMode`, `disneyWatchSku`, `disneyWatchKeywords`, `disneyMonitorIntervalMs`, `disneyMonitorDelayMs`.

One-shot sidecar `disneyMode=monitor` (sitemap + single PDP) remains available for labs; product Autocheckout monitor path uses the in-process stack above.
