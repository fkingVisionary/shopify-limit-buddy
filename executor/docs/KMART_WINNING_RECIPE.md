# Kmart winning recipe (lock before local hardware)

Last bank-confirmed payment window: **~07:03–07:04 UTC, 2026-07-20** (Revolut).  
**Do not score client timeout as cart dead** — check Fly milestones.

## What actually cleared (Lovable era = Fly undici)

Lovable never ran a separate Kmart engine. The UI called Fly. The tip that
cleared was **one undici client** for the whole session (`#40` / `resi-dry-1`).

| Tip experiment | Result |
|----------------|--------|
| tls BM → undici PDP → parked tls api (#74–#78) | get-token 200 → **GraphQL Ghost** |
| **undici only** (`sensorTls:false` `apiTls:false`) ISP 2026-07-20 | **`cart_get` JSON 200 ×4** across exits |

Other bots clear the same ISP/resi because they keep **one TLS/client** for
warmed cookies + GraphQL — not because they need a different egress class.

## Locked runtime

| Knob | Value |
|------|--------|
| Transport | **undici** end-to-end (WWW + api) |
| `sensorTls` | **OFF** (opt-in `true` / `KMART_SENSOR_TLS=1`) |
| `apiTls` | **OFF** (opt-in `true`) |
| Category | skip OK; green also ran category — either clears on undici |
| Card | required for 3DS / bank proof |
| Hyper | ≤3 sensor rounds; stop on `ind=0` |

## Smoke

```bash
SMOKE_USE_PROXY=1 ./executor/scripts/fly-probe-once.sh
```

Score: `akamai_solved` → PDP HTML → `api_get_token` → **`cart_get` JSON** → tokenize → 3DS.

No `sensor_tls_handoff` / `api_tls_handoff` on the charge path.
