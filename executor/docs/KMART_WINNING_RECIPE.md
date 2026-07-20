# Kmart winning recipe (lock before local hardware)

Last bank-confirmed payment window: **~07:03–07:04 UTC, 2026-07-20** (Revolut / card ping).  
The HTTP client timed out / returned empty while **Fly kept running**.  
**Do not score that as cart dead.**

## Reality check (2026-07-20 ~23:00Z tip `d167b78`)

| Path | Result |
|------|--------|
| Direct Fly egress `89.187.186.9` + undici BM | SoftBlock plateau (`793b ind=-1`) — same IP that green’d Jul 19 |
| Direct + tls-worker BM | Same SoftBlock plateau |
| ISP (`resi.proxies`) + tls-worker **before** warm | **`akamai_solved` in 3 rounds** |
| Then restore undici for PDP/api | PDP#2 HTML OK + get-token 200 + **GraphQL all Ghost-denied** |

So: the Jul 19 **direct undici bible still describes the shape**, but that egress no longer clears BM. Live path is **ISP + one chrome_131 client for warm→sensors→PDP→api**.

## What is actually in play

| Piece | Role |
|--------|------|
| **Fly `j1ms-bot-executor`** | Real checkout — only tip that matters (`/health` → `gitSha`) |
| Local Bun UI / desktop | Optional control plane on your laptop |
| WealthProxies / IPFist / “Test Pool” | **Dead** — Fly refuses these hosts |
| `executor/resi.proxies` | Static AU ISP pool when `useProxy:true` |

Ignore any stale preview host labels (`proxyUsed: Test Pool`). Trust Fly
`resolve_ip`, `proxySource`, steps, and milestones.

## Locked runtime (post sensor-tls-keep)

| Knob | Value |
|------|--------|
| Transport | **undici** bootstrap; proxied runs hand off to **tls-worker chrome_131** before warm |
| Sensor TLS | **ON when `useProxy`** (warm→script→sensors→SBSD); opt-in on direct via `sensorTls:true` |
| After solve | **KEEP tls-worker** for PDP + `api.*` (do not restore undici). Opt out: `sensorTlsKeep:false` |
| api.* TLS | Skipped when already on tls-worker; otherwise handoff when proxied |
| Category | **skip** (home→PDP) |
| Dead proxies | refused → ISP pool or direct |
| Card | required for 3DS / bank proof |
| Hyper | ≤3 sensor rounds; stop on `ind=0` |

## Smoke Fly directly (preferred)

Needs `EXECUTOR_TOKEN` (Fly secret / local `.env` — not a public Lovable deploy).

**One shot only — do not poll/loop SoftBlocked hours:**

```bash
# Charge-path class today = ISP pool
SMOKE_USE_PROXY=1 ./executor/scripts/fly-probe-once.sh
```

Or raw curl:

```bash
TASK="juicy-$(date -u +%Y%m%d-%H%M%S)"
curl -sS -m 240 -X POST https://j1ms-bot-executor.fly.dev/run \
  -H "authorization: Bearer $EXECUTOR_TOKEN" \
  -H 'content-type: application/json' \
  -d "{\"taskId\":\"$TASK\",\"useProxy\":true,\"storeUrl\":\"https://www.kmart.com.au/product/31-piece-make-it-real:-juicy-couture-diy-floaty-pens-43722280/\",\"variantId\":1,\"dryRun\":true,\"placeOrder\":false,\"card\":{...}}"
```

Score steps: `sensor_tls_handoff` → `akamai_solved` → `sensor_tls_keep` (not restore) → `pdp_get` / `#2` HTML → `api_get_token` → **`cart_get` JSON** → tokenize → **3DS**.

## How to score a run (order of truth)

1. **Bank / Revolut ping**  
2. Fly logs: `kmartMilestone` (`reached3ds` / `stage`)  
3. `GET /milestones?taskId=…`  
4. `/run` JSON body when it returns  
5. **Never** only `failedStep` after a client timeout  
6. Smoke ladder: first `pdp_get` Ghost-deny + `pdp_get#2` OK counts as PDP pass  

Pass ladder: `akamai_solved` → PDP HTML → `cart_get` JSON 200 → tokenize → **3DS** → order.

## Before desktop / local executor

1. **Deploy executor** so Fly `gitSha` includes this recipe’s tip.  
2. One Fly `/run` with `useProxy:true` + card; confirm milestones if the HTTP client dies.  
3. Point desktop/local at the same Fly tip.  
4. Do not reintroduce Test Pool, sticky/drift abort gates, or SoftBlock-poll loops.

## Hyper (honest)

Browser TLS (`tls-worker` chrome_131) for the **whole** BM + api session on ISP.  
Do not mint `_abck` on chrome_131 then navigate GraphQL on Node undici.
