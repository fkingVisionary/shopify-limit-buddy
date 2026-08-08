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

## Task wiring (Desktop)

Bandai mode **Monitor** (optional — not forced on checkout tasks):

| Monitor source | Behavior |
|----------------|----------|
| **Global** | Subscribe/filter only. Task SKU or keywords match against shared `stock_changed` events. Does **not** add keywords to the global poll. |
| **Task-local** | Sidecar/in-process poller using the task’s proxy group + interval/delay. |

Fields: `bandaiMonitorMode`, `bandaiWatchSku`, `bandaiWatchKeywords`, `bandaiMonitorIntervalMs`, `bandaiMonitorDelayMs`.

## Modes lab

```bash
BANDAI_MONITOR_ISP_FILE=/tmp/bandai-proxy-pool.txt \
BANDAI_MONITOR_MAX_POLLS=2 \
  node scripts/bandai-monitor-modes-lab.mjs
```

## Fly vs local

Same `executor/monitor/*` modules. Desktop runs them in-process via the job runner
(dynamic import). Fly can host the same hub later behind `/run` or a monitor
route — no separate checkout fork.

## Next (major: global monitor feed)

After store modules are solid, upgrade Monitor from per-task pollers to a **shared
desktop hub**:

| Piece | Role |
|-------|------|
| One global poll loop | Keywords/catalog search on dedicated monitor proxies (already in `bandai-stock-monitor.js`) |
| Live event feed UI | Tasks/Monitor strip: restock / new-IS cards as they fire (not buried in job logs) |
| Task subscribe | Watch SKU/keywords filter only — does not add load to the poll |
| Watchdog handoff | `stock_changed` → matching monitoring tasks → Autocheckout (+ harvest claim) via bridge |
| Multi-store | **Pokémon Centre** poller shares this host’s SSE (`store=pokemoncentre`) |

### Pokémon Centre (PKC) on the same host

`monitor/pokemoncentre-stock-monitor.js` runs beside Bandai on `monitor-host`:

- Sticky Hyper edge warm (Incapsula Reese84 + DataDome) → BFF `search` + `product/status/{sku}`
- Same `stock_changed` SSE / `/hits` feed (`store`, `locale`, `preorder` / `preorder_live`)
- Locale default **`en-au`** (AU). Watchlist is **admin-dashboard only** (same model as Bandai keywords) — empty until you save PKC keywords/SKUs in `/admin`.
- Env: `PC_MONITOR_ENABLE`, `HYPER_API_KEY` (required for Incapsula/DD), optional `PC_MONITOR_INTERVAL_MS`
- Admin: Pokémon Centre AU section → keywords + SKUs + interval; force poll `POST /monitor/pkc/poll`
- Labs Discord: **Test PKC stock / preload / OOS** → `POST /test-discord?store=pokemoncentre&kind=pkc|pkc-preload|pkc-oos`
  (same webhook as live hits; synthetic SKU OK when catalog empty)
- Lab: `node scripts/pokemoncentre-stock-monitor-lab.mjs`
- Early-signal research (US lead, CMS, why monitors feel late): `docs/POKEMON_CENTRE_MODULE.md` §6a

Catches preload when availability flips to `AVAILABLE` / `AVAILABLE_FOR_PRE_ORDER` or
`addToCartForm` appears — before a public “drop” moment.

V1 already has the executor hub + task-local mode. Desktop still needs the **toggle +
live feed + multi-task subscribe** product layer. Until then, task-local Monitor +
Checkout on restock is the drop path.

## Next (not V1)

- Desktop global monitor toggle + live event feed (see above)
- ~~Wire tasks in `monitoring` via bridge → `runCheckout(task)`~~ **done** (Desktop Monitor + Checkout on restock; claims F5 harvest at trigger; auto-arms harvest at enqueue)
- Pre-warm checkout sessions on subscribe (separate from monitor proxies) — **auto-arm** + Harvest → Bandai

## Monitor → Autocheckout (Desktop)

1. Set sticky **checkout** proxy group on **Harvest → Bandai** (required for auto-arm).
2. Task: Bandai → **Monitor**, set watch SKU/keywords, leave **Checkout on restock** on.
3. Assign vault account + Place order (or off for dry).
4. Run task — harvest auto-arms at enqueue; polls until matching `stock_changed`, claims harvest, Autocheckout.
5. Tasks strip shows Bandai/Toymate/Disney bank ready counts while you wait.

Labs:

```bash
# Dry handoff + hub inject
node executor/scripts/bandai-monitor-checkout-lab.mjs

# Live (inject skipped — uses harvest + Fast GE on watch SKU)
BANDAI_MONITOR_CHECKOUT_LIVE=1 BANDAI_CARD_*=… node executor/scripts/bandai-monitor-checkout-lab.mjs
```
