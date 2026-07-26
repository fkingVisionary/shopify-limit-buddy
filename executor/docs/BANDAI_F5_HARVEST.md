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
node executor/adapters/bandai-harvest-pool.test.mjs

# Cold vs harvested Fast placeOrder (disposable card via BANDAI_CARD_*)
BANDAI_AB_ONLY=both node executor/scripts/bandai-harvest-ab-lab.mjs
```

### Live A/B (2026-07-26, last4 `1806`, empty disposable → AUTH_FAILED)

| | Cold | Harvested |
|--|------|-----------|
| `f5_bridge` | **9710ms** | **4ms** |
| wall→ATC | **21651ms** | **8246ms** |
| Full wall (to issuer) | **95.5s** | **70.4s** |
| Harvest mint (off-path) | — | 8.0s |
| Issuer | tx `171257206` decline | tx `171258063` decline |

Critical-path save ≈ **25s** wall / **~10s** pure F5 launch (rest is proxy/GE variance). Mint stays off-path when armed ahead of drop.

## Cost

Local CPU/RAM only (Playwright). No CapSolver. Keep desired low; arm only for the drop window.
