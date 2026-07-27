# Pokémon Centre AU — Edge harvest bank

_Date: 2026-07-27_

## What is banked

| Field | Notes |
|---|---|
| `cookies.reese84` + Incapsula `visid_incap_*` / `incap_ses_*` | Imperva clear |
| `cookies.datadome` | DataDome clear (interstitial `view=redirect`) |
| Sticky `proxy` + `egressIp` | **Must** be the checkout exit |
| Optional `captchaToken` | CapSolver hCaptcha when drop protection escalates |

**Not banked:** Cortex public token, cart-guid, GE CartToken, riskHydrate blackbox, card.

TTL: edge ~**3 min**; hCaptcha ~**100s**. Single-use claim.

## Desktop

- Pool: `desktop/pokemoncentre-harvest.cjs`
- Harvest tab card + Tasks strip chip (`PkC N ready/armed`)
- **Claim at Autocheckout run-start** (job-runner), not enqueue — TTL stays fresh through queue wait
- `pause()` while PC checkout lanes in-flight; reclaim next bank slot if claimed session dead/missing cookies
- Auto-arm when Monitor→checkout / Drop Mode armed (`pokemoncentre-harvest-autoarm.cjs`)
- Empty bank → cold path (edge warm on critical path) — unchanged

## Executor

- Mint: `POST /pokemoncentre/harvest` `{ proxy, solveCaptcha?, locale?, bank:false }`
- In-process bank (optional): `mint` / `claim` / `release` / `clear` / `GET` snapshot
- Adapter seeds `task.harvestedSession.cookies` into jar and skips `warmPokemonCentre` when fresh

## Ops

Arm ~5 min before drop on the **same** sticky group Autocheckout will use. Stop or pause after T0. See `POKEMON_CENTRE_HIGH_TRAFFIC_DROP.md`.
