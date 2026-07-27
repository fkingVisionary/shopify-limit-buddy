# Pokémon Centre AU — High-traffic drop runbook

_Date: 2026-07-27_  
_Status: drop-ops harden (harvest + adapter)_

## Win-con (≠ Bandai)

| | **Bandai** | **Pokémon Centre AU** |
|---|---|---|
| Cart hold | ~30 min held cart → Retry pay | **No hold** — cart dies with session |
| Race | Login/ATC then GE when ready | **Wall → edge clear → Cortex ATC → GE pay in one continuous sticky session** |
| Harvest banks | F5 login bridges | **Incapsula Reese + DataDome jar** (± hCaptcha) on sticky AU ISP |
| Score | Bank / JWT / milestones | Same — not UI silence |

Consistency over raw speed. Prefer logging successful milestones over fail-closed gates.

## Stack under load

- Imperva Incapsula (site **2682446**) + DataDome (`hsh` 5B4587…) + optional hCaptcha
- IP-sticky queue — **same exit must harvest and checkout**
- Transport: **tls-worker** preferred (undici often `view=captcha`)
- Hyper slider `t=bv` = hard IP block → rotate sticky (bounded). Do **not** spray SoftBlock/CONNECT flake.
- GE: HTTP Fast only (`pokemoncentre-ge-http.js`, mid **1634**, merchant **8u22**). riskHydrate + **one** issuer POST (`retry:false`). Never Bandai mid 1925.

## Pre-drop (T−10 … T−2)

1. Settings: Hyper key (+ CapSolver if harvesting hCaptcha) → start engine.
2. Proxies: sticky AU ISP/resi group (checkout lanes will use the same group).
3. **Harvest tab → Pokémon Centre** — desired = lane count (1–3), Start harvest.
   Or Tasks → **Arm Drop Mode** (sets desired = lanes and starts mint).
4. Tasks: PC Autocheckout armed; optional **Arm schedule** AEST T0 (≤150ms stagger).
5. Confirm harvest Ready ≥ lanes; refill **pauses** while lanes run.

## Fire (T0)

1. Autocheckout claims one harvested session **at run-start** (not enqueue) so TTL stays fresh through the queue.
2. Same sticky proxy locked — no rotate on claim.
3. If claimed jar is dead/missing cookies → **reclaim next bank slot** then cold warm (diagnosable `failedStep`).
4. Path: seed jar → skip edge warm → public token → ATC (retries on 5xx/transient DD) → GE issuer.
5. SoftBlock / cookie flake: bounded sticky rotate (default **2**) + remint edge — pass `proxyPool`; don’t spray.
6. Hard `t=bv` / sold-out / true OOS: **no** ATC retry loop — rotate or stop.
7. Monitor → checkout: restock hit claims harvest at trigger; do **not** mint harvest on monitor-only proxies (set Harvest → PC checkout ISP / `pcHarvestProxyGroupId`).

## After-action

Score in order:

1. Bank ping / Revolut (if card used)
2. GE JWT: `TransactionId≠0`, `PossibleFraudDetected`, `TransactionStatusType` (`AutherizationFailed` = soft decline OK)
3. Milestones / `failedStep` + full note bodies (`detail`)
4. Harvest claim age + egress IP match (`harvestUsed` / `harvestId`)

Decline card is a green GE wire. Client timeout ≠ failure if JWT/bank moved.

## Explicit non-goals

- No Japan `pokemoncenter-online.com`
- No Kmart
- No Playwright product pay / Safe cart-hold
- No fail-closed CI gates that only block a path that already ATCs
- No Lovable redeploy — desktop + local/Fly executor is control plane

## Related

- Module research: `POKEMON_CENTRE_MODULE.md`
- Harvest ops: `POKEMON_CENTRE_HARVEST.md`
- Bandai harvest (F5, different shape): `BANDAI_F5_HARVEST.md`
- GE HTTP: `adapters/pokemoncentre-ge-http.js`
