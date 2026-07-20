# Kmart winning recipe (lock before local hardware)

Last bank-confirmed payment window: **~07:03–07:04 UTC, 2026-07-20** (Revolut / card ping).  
The HTTP client timed out / returned empty while **Fly kept running**.  
**Do not score that as cart dead.**

## Reality check (live Fly tips 2026-07-20)

| Tip | Path | Result |
|-----|------|--------|
| Jul 19 green | Direct undici on `89.187.186.9` | Full dry `place_order` |
| Tonight | Same IP + undici **or** tls BM | SoftBlock plateau — egress burned |
| `d167b78` | ISP tls-before-warm → **restore undici** PDP | **`akamai_solved`** → PDP#2 HTML → get-token 200 → GraphQL Ghost |
| `5dc0cee` | ISP tls → **keep tls** for PDP | **`akamai_solved`** → PDP#1–#3 **all Ghost** (regression) |

Charge path today: **ISP + chrome_131 for BM**, **undici for PDP**, then **reuse the same parked tls-worker for api.*** — not a fresh worker, not tls for WWW documents.

## What is actually in play

| Piece | Role |
|--------|------|
| **Fly `j1ms-bot-executor`** | Real checkout — only tip that matters (`/health` → `gitSha`) |
| `executor/resi.proxies` | Static AU ISP pool when `useProxy:true` |
| WealthProxies / Test Pool | **Dead** |

## Locked runtime

| Knob | Value |
|------|--------|
| Sensor TLS | **ON when proxied** — before warm through sensors/SBSD |
| After solve | **`sensor_tls_park`**: undici for PDP; park tls-worker |
| api.* | **Reuse parked sensor tls** (same chrome session as `_abck`) |
| Category | **skip** |
| Hyper | ≤3 rounds; stop on `ind=0` |

## Score a smoke

1. `sensor_tls_handoff` → `akamai_solved` → `sensor_tls_park` (not `keep`)  
2. `pdp_get#2` HTML megabytes (first may Ghost)  
3. `api_tls_handoff` note **`reuse parked sensor`**  
4. `cart_get` **JSON** 200 → tokenize → 3DS → bank  

Direct SoftBlock on Fly egress is expected until that IP recovers — do not SoftBlock-poll.
