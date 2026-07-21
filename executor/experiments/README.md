# Executor experiments

Diagnostic / recon modules that are **not** on the checkout path.

| File | Role |
|---|---|
| `kmart-akamai-lab.js` | Akamai sensor-only lab (`POST /akamai/lab`) |
| `jbhifi-recon.js` | JB Hi-Fi Shopify surface recon (`POST /jbhifi/recon`) |
| `jbhifi-probe.js` | JB Hi-Fi per-SKU Algolia/Shopify probe (`POST /jbhifi/probe`) |

Checkout adapters live in `../adapters/` (`kmart.js`, `kmart-playwright.js`, `toymate.js`).
