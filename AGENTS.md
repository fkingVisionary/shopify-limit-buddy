# AGENTS.md

## Cursor Cloud specific instructions

### Product overview
This repo is **J1m's Bot** — retail checkout automation. Root = TanStack control plane.
`executor/` = Node/Fastify checkout engine. `desktop/` = local Electron Kmart app
(spawns executor as sidecar). `runner/` = legacy Electron Shopify agent.

**Kmart product module = undici path from PR #32 (`600b40f`).** Do not invent SoftBlock
retry towers, HAR rewrites, or Playwright recovery. Prove checkout on **desktop + sticky
ISP**, not by adding loops in Cloud Agent.

### Root web app
- Package manager **Bun**. Dev: `bun run dev` → http://localhost:8080/
- Lint/build/format: see `package.json`.

### Executor (Kmart — undici, PR #32 baseline)
- `cd executor && npm install && npm run dev` (default PORT 8080).
- Cloud smoke: `PORT=8081 EXECUTOR_TOKEN=devtoken HYPER_API_KEY=… node server.js`
- **No Playwright** (`kmartMode: "playwright"` out of scope).
- Bootstrap (PR #32): warm home → sensor (`pageUrl` = PDP) → SBSD home → category → PDP.
- `http.js` uses ProxyAgent connect timeout `20s` (ISP tunnel); keep undici network
  retries at the PR #32 budget (3). Do not add SoftBlock page retries.

### Desktop (where this product is proven)
- `cd desktop && npm run setup && npm start` — see `desktop/README.md`.
- Use sticky ISP proxy + Hyper key. One clean pass > flaky retry ladders.
