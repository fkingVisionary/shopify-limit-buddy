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

Checkout adapters live in `../adapters/` (`kmart.js`, `kmart-playwright.js`, `toymate.js`, `bandai.js`, `pokemoncentre.js`).
