# Kmart winning recipe (lock before local hardware)

Last bank-confirmed payment window: **~07:03–07:04 UTC, 2026-07-20** (Revolut / card ping).  
The HTTP client timed out / returned empty while **Fly kept running**.  
**Do not score that as cart dead.**

## What is actually in play

| Piece | Role |
|--------|------|
| **Fly `j1ms-bot-executor`** | Real checkout — only tip that matters (`/health` → `gitSha`) |
| Local Bun UI / desktop | Optional control plane on your laptop |
| WealthProxies / IPFist / “Test Pool” | **Dead** — Fly refuses these hosts |
| `executor/resi.proxies` | Static AU ISP pool when `useProxy:true` |

Ignore any stale preview host labels (`proxyUsed: Test Pool`). Trust Fly
`resolve_ip`, `proxySource`, steps, and milestones.

## Locked runtime (post #70 / #71)

| Knob | Value |
|------|--------|
| Transport | **undici** default (`tls-worker` opt-in only) |
| Category | **skip** (home→PDP) |
| Dead proxies | refused → ISP pool or direct |
| Card | required for 3DS / bank proof |
| Hyper | ≤3 sensor rounds; stop on `ind=0` |

## Smoke Fly directly (preferred)

Needs `EXECUTOR_TOKEN` (Fly secret / local `.env` — not a public Lovable deploy).

```bash
TASK="juicy-$(date -u +%Y%m%d-%H%M%S)"
# Direct (payment-window class): no proxy field, useProxy omitted/false
curl -sS -m 240 -X POST https://j1ms-bot-executor.fly.dev/run \
  -H "authorization: Bearer $EXECUTOR_TOKEN" \
  -H 'content-type: application/json' \
  -d "{\"taskId\":\"$TASK\",\"storeUrl\":\"https://www.kmart.com.au/product/31-piece-make-it-real:-juicy-couture-diy-floaty-pens-43722280/\",\"variantId\":1,\"dryRun\":true,\"placeOrder\":false,\"card\":{...}}"

# If the client times out — Fly is often still in 3DS:
curl -sS "https://j1ms-bot-executor.fly.dev/milestones?taskId=$TASK&minStage=tokenize" \
  -H "authorization: Bearer $EXECUTOR_TOKEN"
```

ISP pool: `"useProxy": true` (no WealthProxies string). Fly picks `resi.proxies`.

## How to score a run (order of truth)

1. **Bank / Revolut ping**  
2. Fly logs: `kmartMilestone` (`reached3ds` / `stage`)  
3. `GET /milestones?taskId=…`  
4. `/run` JSON body when it returns  
5. **Never** only `failedStep` after a client timeout  

Pass ladder: `akamai_solved` → `pdp_get` 200 → `cart_get` JSON 200 → tokenize → **3DS** → order.

## Before desktop / local executor

1. **Deploy executor** so Fly `gitSha` includes this recipe’s tip.  
2. One Fly `/run` with stable `taskId` + card; confirm milestones if the HTTP client dies.  
3. Point desktop/local at the same Fly tip (or run `executor/` locally with the same defaults).  
4. Do not reintroduce Test Pool, sticky/drift abort gates, or fail-closed deploy gates.

## Hyper (honest)

Long-term: browser TLS (`tls-worker`) for `_abck` per Hyper docs.  
Default stays **undici** until post-solve WWW/api navigation matches the charge path.
