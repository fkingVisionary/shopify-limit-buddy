# AGENTS.md

## Cursor Cloud specific instructions

### Product overview
This repo is **J1m's Bot** — a retail checkout automation dashboard. The root is the
primary product: a TanStack Start + Vite + React 19 web app (the "control plane").
`executor/` is the Node/Fastify checkout engine. `desktop/` is the local Electron
Kmart app (spawns executor as a sidecar). `runner/` is the legacy Electron Shopify agent.

The operator **monitor** service was removed from this branch to recover a working
undici Kmart checkout path (it can be reintroduced later once checkout is stable).

### Root web app
- Package manager is **Bun** (`bun.lock`). Dev: `bun run dev` → http://localhost:8080/
- Lint/build/format: see `package.json`. Standalone localStorage UI; Supabase optional.

### Executor (Kmart checkout — undici only)
- `cd executor && npm install && npm run dev` (default PORT 8080).
- Cloud smoke without clashing Vite: `PORT=8081 EXECUTOR_TOKEN=devtoken HYPER_API_KEY=… node server.js`
- **Do not use Playwright** for Kmart (`kmartMode: "playwright"`) — out of scope.
- Checkout adapter baseline on this branch is **PR #32** `executor/adapters/kmart.js`
  (`600b40f`) after stripping Electron Update + monitor regressions.

### Desktop
- `cd desktop && npm run setup && npm start` — local Kmart checkout via executor sidecar.
- See `desktop/README.md`.
