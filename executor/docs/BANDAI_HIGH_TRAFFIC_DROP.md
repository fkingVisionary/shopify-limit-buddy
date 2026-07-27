# Bandai high-traffic drop runbook

Consistency first, then speed. Use the **existing Fast checkout module** — do not
invent a parallel ATC toy for drops.

Companion: [`BANDAI_CHECKOUT_BIBLE.md`](./BANDAI_CHECKOUT_BIBLE.md) ·
[`BANDAI_F5_HARVEST.md`](./BANDAI_F5_HARVEST.md)

---

## Win-con (unchanged)

1. **wall→ATC / cart hold** inside the drop race (~30 min pay window after).
2. Pay (Fast GE) inside that window.
3. Score `failedStep` + **error/note body** + bank tx — not UI silence.

---

## Pre-drop checklist (T−60 → T−5)

| When | Action |
|------|--------|
| T−60+ | Vault accounts **login-proven** same day (drop SoftBlocked / `needs_sms`) |
| T−30 | Sticky **checkout** proxy group set on Harvest → Bandai (not monitor proxies) |
| T−15 | Desired bank = lane count (1–4). Harvest **retries** transient `ERR_CONNECTION_*` |
| T−5 | Confirm Tasks strip / harvest ready ≥ lanes. Extend TTL if needed (`BANDAI_HARVEST_TTL_MS`) |
| Task setup | PDP `N…` URL **and** Backend PID `NAI…` when known (extension tip under load) |

Do **not** start harvest mint at T0 — that puts Chromium on the critical path.

---

## Fire (T0)

- All checkout lanes at **T0** (small stagger ≤150ms OK). Avoid 40s wave-2 delays.
- Claim harvest at trigger/enqueue — cold only if mint failed after retries.
- Prefer **backend `areaItemNo` / NAI** for ATC when both frontend N-code and NAI are known.
- **ATC retries** (default 3) on congestion / SoftBlock / 5xx — not on SoldOut / MaxPurchaseQty.
- **Login SoftBlock / proxy flake:** rotate sticky exit (default 2), remint cold F5, retry login. Pass `proxyPool` (desktop proxy group / `BANDAI_PROXY_POOL`). Disable with `bandaiLoginProxyRotate:false`.
- **Pay-from-held-cart:** after decline / pay fail, desktop shows **Retry pay**. Adapter sets `bandaiPayFromCart` → login → **live `GET /api/cart/detail`** (source of truth) → skip ATC → checkout → GE. Local ~30 min clock is UI hint only. Gone cart → `held_cart_gone`.
- Ensure shipping address on account (fresh agen) before GE — else `checkout_address` blocker.

---

## After-action (required)

Every failed lane must leave:

- `failedStep`
- `error` / ATC `detail` (SoftBlock, congestion, MaxPurchaseQty, …)
- `f5_bridge` note (harvested vs cold)
- wall times

Desktop now surfaces `failedStep` + a capped `detail:` line in the job log.
Labs: `executor/scripts/bandai-drop-rehearsal-lab.mjs`.

---

## Rehearsal (no new module)

```bash
# Concurrent Fast checkout, harvest retry, full error dump
BANDAI_ACCOUNTS_JSON=/tmp/bandai-drop-1300/roster.json \
BANDAI_SKU=N2542159011 \
BANDAI_AREA_ITEM_NO=NAI… \
BANDAI_LANES=2 BANDAI_CONCURRENCY=2 \
BANDAI_CARD_*=… \
  node executor/scripts/bandai-drop-rehearsal-lab.mjs
```

Use a live SKU / disposable card off the critical drop clock. Goal: every failure
mode is **diagnosable**, and harvest/login flake is rotated away before T0.

---

## What we learned (2026-07-27 13:00 AU Gundam set)

Fired on time; **0/4 carts**. Failures were mixed (adapter throw, ATC, cold F5,
login SoftBlock) — not “all lost ATC to traffic.” Harvest helped F5 claim (~3–11ms)
but did not guarantee login/ATC. Backend NAI was not used. Wave 2 started ~40s late.
Error bodies were under-logged — fixed going forward.
