# Kmart winning recipe (lock before local hardware)

Last bank-confirmed payment window: **~07:03–07:04 UTC, 2026-07-20** (Revolut / card ping).  
Client saw Cloudflare **524** + empty steps; Fly kept running. **Do not score that as cart dead.**

## Architecture (do not confuse)

| Piece | Role |
|--------|------|
| Lovable app (`*.lovable.app`) | Control plane / `exec-test` — often **stale**; may still *label* “Test Pool” |
| Fly `j1ms-bot-executor` | Real checkout engine — tip must move via **Deploy executor** |
| WealthProxies / IPFist / Supabase “Test Pool” | **Dead** — cancelled. Fly refuses those hosts |
| `executor/resi.proxies` | Live static AU ISP pool (19 exits) when `useProxy:true` |

## Locked runtime (post #70)

| Knob | Value | Why |
|------|--------|-----|
| Transport | **undici** (default) | Path that reached place_order / 3DS historically; `tls-worker` opt-in only until WWW/api nav matches |
| Category | **skip** (home→PDP) | Category 403 looks like “burnt proxy” after a clean sensor solve |
| Dead proxies | refused → ISP pool or direct | Stale Lovable still injects Test Pool on `useProxy:true` |
| Card | `withCard:true` or `placeOrder:true` | Needed for 3DS / bank proof |
| Hyper | ≤3 sensor rounds; stop on `ind=0` | Docs: more rounds won’t fix TLS/headers/IP |

`tls-worker` / Hyper TLS remains available: `transport=tls-worker` or `KMART_TLS_WORKER=1`. Sensors often solve on it; default stays undici until post-solve nav is proven equal.

## Smoke that matches the payment window

Prefer a stable `taskId` so you can recover after timeout:

```bash
TASK="juicy-$(date -u +%Y%m%d-%H%M%S)"
curl -sS -m 200 -X POST https://shopify-limit-buddy.lovable.app/api/public/exec-test \
  -H 'content-type: application/json' \
  -d "{\"storeUrl\":\"https://www.kmart.com.au/product/31-piece-make-it-real:-juicy-couture-diy-floaty-pens-43722280/\",\"dryRun\":true,\"taskId\":\"$TASK\",\"withCard\":true,\"useProxy\":false}"
# If 524 / empty steps — poll milestones (same taskId):
curl -sS "https://shopify-limit-buddy.lovable.app/api/public/exec-milestones?taskId=$TASK&minStage=tokenize"
```

- **Direct** (`useProxy:false`): Fly egress `89.187.186.9` — payment-window candidate; sensors can flake by hour.  
- **ISP pool** (`useProxy:true`): Fly refuses WealthProxies → `resi.proxies`. Often `akamai_solved` + **PDP 200**; watch `api.*` GraphQL next.

## How to score a run (order of truth)

1. **Bank / Revolut ping** (highest)  
2. Fly logs: `kmartMilestone` with `reached3ds` / `stage`  
3. `GET /api/public/exec-milestones?taskId=…` (or Fly `GET /milestones` with Bearer)  
4. exec-test JSON `stage` / `reached3ds` / `paymentStatus` / `orderNumber`  
5. **Never** only `failedStep` after a client timeout or Cloudflare 524  

Pass ladder: `akamai_solved` → `pdp_get` 200 → `cart_get` JSON 200 → tokenize → **3DS** → place_order / order number.

## Capture hardening (why we kept missing payments)

- Cloudflare ~100s 524 kills the Lovable request; **Fly does not stop**.  
- exec-test must use a known `taskId`, budget `/run` under CF, then **poll milestones**.  
- Live milestones flush at cart / tokenize / 3DS / order before `/run` returns.

## Before local desktop / hardware

1. Tip on Fly includes this recipe’s capture PR + `#70` undici/skip-category defaults.  
2. One smoke with stable `taskId` + card; if 524, milestones still show 3DS.  
3. Only then point desktop/local executor at the same recipe (same `kmart.js` / transport defaults / skip category).  
4. Do not reintroduce Test Pool, sticky/drift abort gates, or fail-closed deploy gates.

## Hyper alignment (honest)

- Hyper: browser TLS + header discipline for `_abck`.  
- We keep that as the long-term target (`tls-worker` opt-in).  
- Production default is **undici** because it is the path that already charged; fix TLS nav to match before flipping the default again.
