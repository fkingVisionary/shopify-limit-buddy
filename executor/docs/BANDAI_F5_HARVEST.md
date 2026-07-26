# Bandai F5 Harvest

Opt-in pre-warm of Playwright F5 login bridges so Bandai Autocheckout can skip
Chromium launch on the drop critical path.

## What is banked

| Banked | Not banked |
|--------|------------|
| Live Chromium on `/{area}/login` + `SESSION` / `TS*` / CSRF | `p8komysnbc-*` sensors (mint fresh per gated POST) |
| Sticky proxy binding | GE Forter / ioBlackBox (riskHydrate at pay time) |
| | Logged-in BNID (login still on checkout path) |

## Isolation / safety

- Harvest **off** by default (desired bank empty).
- `task.harvestedBridgeId` miss / expired / dead page → **cold** `createBandaiF5Bridge` (unchanged).
- Never `session.warm()` after F5 seed.
- Stop engine clears the executor bank.

## Desktop

1. Start engine.
2. **Harvest** tab → pick sticky proxy group → desired 1–2 → **Start harvest** ~5 min before drop.
3. Run Bandai Autocheckout — each job claims one bridge + locks that proxy.
4. **Stop** after the drop (CPU).

## Executor API

```
GET  /bandai/harvest
POST /bandai/harvest          { proxy, area? }
POST /bandai/harvest/release  { id }
POST /bandai/harvest/clear
```

Checkout consumes via `task.harvestedBridgeId` on `POST /run`.

## Lab

```bash
PROXY='host:port:user:pass' node executor/scripts/bandai-harvest-lab.mjs
PROXY=… BANDAI_HARVEST_CLAIM=1 node executor/scripts/bandai-harvest-lab.mjs
node --test executor/adapters/bandai-harvest-pool.test.mjs
# or:
node executor/adapters/bandai-harvest-pool.test.mjs
```

## Cost

Local CPU/RAM only (Playwright). No CapSolver. Keep desired low; arm only for the drop window.
