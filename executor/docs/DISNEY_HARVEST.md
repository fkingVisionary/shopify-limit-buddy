# Disney Akamai + CapSolver harvest

Opt-in pre-warm so Disney Autocheckout can skip Hyper `_abck` sensor warm and
(optionally) CapSolver AddToCart on the drop critical path.

Borrowed from **Toymate** (serializable jar + captcha TTL), not Bandai F5
(live Playwright bridges — Disney has no F5 login tax).

## What is banked

| Banked | Not banked |
|--------|------------|
| Sticky proxy + jar (`_abck` ~0~, `bm_*`, SFCC sid) | GE Forter / iovation (pay-time opt-in) |
| CapSolver reCAPTCHA Enterprise AddToCart token (~100s TTL) | Live Chromium |
| | Checkout GUID / cart (needs ATC) |

## Expected save

Cold best path was ~23s wall (warm+captcha overlapped). Harvest ahead of drop:

| Phase | Cold | Harvested claim |
|-------|------|-----------------|
| Akamai warm | 5–12s | **~0** (reuse jar) |
| CapSolver | ~8s (often hidden under warm) | **~0** if token fresh |
| Start → ATC | ~15–17s | **target ~3–8s** (PDP + ATC) |

Mint stays **off-path**. Miss / expired → unchanged cold path.

## Isolation / safety

- Harvest **off** by default.
- Stale `_abck` / expired captcha → cold warm + CapSolver.
- Same sticky proxy must be used at claim (exit-bound Akamai).
- Do not bank GE Checkout/v2 (needs a cart).

## Executor API

```
GET  /disney/harvest
POST /disney/harvest          { proxy, solveCaptcha?, bank?, pdpUrl?, ttlMs? }
POST /disney/harvest/claim    { id }     → full session blob
POST /disney/harvest/release  { id }
POST /disney/harvest/clear
```

Checkout consumes via `task.harvestedSession` (blob) or `task.harvestedSessionId` (pool claim) on `POST /run`.

## Desktop Harvest tab

Desktop owns the bank (`desktop/disney-harvest.cjs`), same shape as Toymate:

1. **Settings** → Hyper + CapSolver → start engine.
2. **Harvest** → **Disney Store Harvest** → pick sticky AU ISP/resi proxy group → Start harvest (or Harvest one now).
3. Leave **Drop pressure** on (default) so the bank refills faster while below desired and immediately after each claim.
4. **Tasks** → Disney Autocheckout options:
   - **Use harvested session when available** (default on)
   - **Require fresh CapSolver token on claim** (default off — warm-only claim OK, CapSolver on path)
   - **Prefer last-good sticky exit when cold** (default on)
5. Run — main `take()`s when opted in; near-expiry captcha is discarded (not claimed) → cold path.
6. **Empty bank / harvest off / Stop / Clear** → `harvestedSession: null` → cold warm + CapSolver. Still works.

### Monitor feed · Quick Task

Disney/Bandai monitor matches land on **Results → Monitor feed**. Set Quick Task profile/proxy/qty/place-order/harvest toggles, then press **Quick Task** on a hit to launch Autocheckout for that SKU with those defaults (ephemeral run — not saved to the task list).

Sessions are single-use and exit-bound. Do not rotate sticky session after claim.

## Lab

```bash
# Mint only
PROXY='host:port:user:pass' node experiments/disney-harvest-lab.mjs

# Mint → claim → fake-decline pay (A/B timing)
PROXY=… DISNEY_HARVEST_PAY=1 node experiments/disney-harvest-lab.mjs
```
