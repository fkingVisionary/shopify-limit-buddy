# Executor experiments

Diagnostic / recon modules that are **not** on the checkout path.

| File | Role |
|---|---|
| `kmart-akamai-lab.js` | Akamai sensor-only lab (`POST /akamai/lab`) |
| `jbhifi-recon.js` | JB Hi-Fi Shopify surface recon (`POST /jbhifi/recon`) |
| `jbhifi-probe.js` | JB Hi-Fi per-SKU Algolia/Shopify probe (`POST /jbhifi/probe`) |
| `pokemoncentre-isp-capture.mjs` | PC AU Playwright HAR via `PROXY=host:port:user:pass` |
| `pokemoncentre-isp-dwell.mjs` | Single-page dwell (Reese/DD settle) |
| `pokemoncentre-undici-probe.mjs` | Cookie/CSP/Cortex soft probes via undici+proxy |
| `pokemoncentre-hyper-capture.mjs` | HTTP sticky + Hyper Reese/DD (classify via Hyper docs — not proxy-blame) |
| `pokemoncentre-hyper-pw-capture.mjs` | Hyper Playwright `IncapsulaHandler` + `DataDomeHandler` |
| `pokemoncentre-atc-capture.mjs` | HTTP edge warm → Playwright ATC (cookies don’t transfer across TLS; prefer BFF ATC) |

**PC failure triage:** see `docs/POKEMON_CENTRE_MODULE.md` §3.4 and Hyper [DataDome](https://docs.hypersolutions.co/datadome/getting-started.md) / [header order](https://docs.hypersolutions.co/request-based-basics/header-order.md) / [TLS](https://docs.hypersolutions.co/request-based-basics/tls-fingerprinting.md). Rotate sticky only for documented slider `t=bv`.

Checkout adapters live in `../adapters/` (`kmart.js`, `kmart-playwright.js`, `toymate.js`, `bandai.js`, `pokemoncentre.js`).
