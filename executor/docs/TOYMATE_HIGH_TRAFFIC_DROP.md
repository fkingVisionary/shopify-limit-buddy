# Toymate high-traffic drop runbook

Consistency first, then speed. Use the **existing HTTP checkout module**
(`adapters/toymate.js` + desktop Harvest) — do not invent a Playwright path for drops.

Companion: [`toymate-recon.md`](./toymate-recon.md) · harvest proof
[`toymate-harvest-checkout-proof.json`](./toymate-harvest-checkout-proof.json)

---

## Win-con

1. **CF + spam off the critical path** via Harvest bank (sticky AU ISP/resi).
2. **ATC** (`POST /remote/v1/cart/add`) under congestion → checkout → BigPay.
3. Score bank/Revolut + BigPay code (`30102` decline wiring / `30106` issuer) —
   not client ok alone. Synthetic Visa `…0002` only proves wire.

Checkout wall with harvest: **~36s** vs **~144s** on-demand CapSolver (~4×).

---

## Why harvest matters at scale

| Bottleneck | Without bank | With bank |
|------------|--------------|-----------|
| CF `cf_clearance` | ~45s CapSolver on critical path | **0ms** (claimed session) |
| Spam reCAPTCHA | ~30–70s CapSolver | **~1.3s** apply REST |
| Spam TTL | n/a | **~100s** — claim at **run-start**, not enqueue |
| Bank fill | serial mint (~1×80s) | **parallel** CapSolver (default ×3, max ×8) |

Sessions are **single-use + IP-bound**. Empty bank → cold CapSolver fallback (still works, slower).

---

## Pre-drop checklist (T−60 → T−5)

| When | Action |
|------|--------|
| T−60+ | CapSolver key in Settings; sticky **checkout** AU proxy group (session-style lines) |
| T−60+ | Vault accounts login-proven same day (or guest checkout) |
| T−30 | Harvest → Toymate: pick proxy group · **Sessions = lane count** (≤48) · **Parallel 3–6** · Solve spam on · **Start** |
| T−15 | Confirm Ready / With spam ≈ lanes. Raise Settings **max concurrent** (≥ lanes); restart Engine |
| T−5 | Tasks: Toymate Autocheckout · PDP URL · profiles with cards · same sticky group |
| T−5 | Arm Smart Action **stagger_start_task_group** (gap ≤150ms) or Start group at T0 |

Do **not** start CapSolver mint at T0 — fill the bank ahead. Spam tokens expire ~100s; keep Harvest running so parallel refill replaces claimed slots.

### Desktop ops

1. **Harvest tab → Toymate** — bank + parallel mints
2. **Tasks** — one Autocheckout lane per intended cart (unique profile/card)
3. **Settings → max concurrent** — match lanes (1–200)
4. **Smart Actions** — schedule / stagger fire at T0
5. Claim is automatic at **run-start**; harvest refill **pauses** while a checkout lane is live (CapSolver quota → cold lanes)

---

## Fire (T0)

- Fire all checkout lanes together (stagger ≤150ms OK).
- Prefer harvested sessions (log: `Using harvested CF session`).
- ATC retries 429/5xx (default 4) — OOS/`sold out` fails closed, no spray.
- Cold path only if bank empty after retries.

---

## After-action

Every failed lane must leave:

- `failedStep` (`cf_warm`, `cart_add`, `spam_protection`, `place_order`, …)
- `error` / ATC detail (stock, 429, CF)
- harvest note (harvested vs cold)
- wall times / BigPay code

Labs (CapSolver + sticky proxy):

```bash
# Dry: CF → login → ATC → address (no charge)
CAPSOLVER_API_KEY=… PROXY_LINE='host:port:user:pass' \
ACCOUNT_EMAIL=… ACCOUNT_PASS=… \
  node executor/scripts/toymate-checkout-dry-once.mjs

# Live decline wire (synthetic or TOYMATE_CARD_*)
CAPSOLVER_API_KEY=… PROXY_LINE=… \
  node executor/scripts/toymate-checkout-live-once.mjs

# Harvest A/B proof
CAPSOLVER_API_KEY=… PROXY_LINE=… \
  node executor/scripts/toymate-harvest-checkout-proof.mjs
```

Fixture tests (no CapSolver):

```bash
node --test executor/adapters/toymate-account-form.test.mjs
node --test desktop/toymate-harvest.test.cjs
```

---

## Scale knobs

| Knob | Where | Notes |
|------|-------|-------|
| Sessions (desired) | Harvest UI / `desired` | Match lane count; max **48** |
| Parallel mints | Harvest UI / `parallel` | Default **3**, max **8** (CapSolver rate) |
| Engine concurrency | Settings `maxConcurrent` | Must cover simultaneous `/run` |
| ATC retries | `task.toymateAtcRetries` | Default 4; congestion only |
| Executor cap | `MAX_CONCURRENT` (sidecar) | Default 120 — harvest counts as inflight |
| BigPay TLS | (fixed undici) | Do not force `PAY_ISSUER_TLS_WORKER` for Toymate — tls-worker times out on WealthProxies issuer |

### Proxies (2026-08-16 lab)

| Provider | Egress | CapSolver AntiCloudflare | Notes |
|----------|--------|--------------------------|-------|
| WealthProxies AU sticky | OK | OK (retry on flake) | Use for drop bank + checkout |
| Baked `resi.proxies` ISP | OK from desktop | **Refuse** from CapSolver DC | Keep for non-CF paths; not CapSolver mint |

Hard-refuse of WealthProxies was removed so sticky harvest sessions are not silently swapped to ISP.

---

## Isolation

- No Hyper / Akamai / Paydock. No Playwright in module place-order.
- Do not gate Kmart on CapSolver; do not gate Toymate on Hyper.
- IPFist stays refused. WealthProxies OK when the sub is live — sticky AU session lines recommended.
