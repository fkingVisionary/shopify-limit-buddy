# AGENTS.md

## Cursor Cloud specific instructions

### Product overview
This repo is **J1m's Bot** — a retail checkout automation dashboard. The root is the
primary product: a TanStack Start + Vite + React 19 web app (the "control plane").
Subdirectories `executor/` (Node/Fastify checkout engine), `runner/` (legacy
Electron Shopify agent), `desktop/` (Cyber-style local Kmart app), and
`monitor/` (operator Kmart stock feed) are **optional** auxiliary services.
`supabase/` holds hosted DB migrations + one Deno edge function.

### Root web app (primary service)
- Package manager is **Bun** (`bun.lock`, `bunfig.toml`); do not use npm/pnpm here.
  Bun installs to `~/.bun/bin/bun`.
- Standard commands live in `package.json`:
  - Dev server: `bun run dev` → Vite on **http://localhost:8080/**.
  - Lint: `bun run lint`, Build: `bun run build`, Format: `bun run format`.
- Non-obvious notes:
  - The app runs **standalone**: dashboard data (profiles, tasks, stores, proxies)
    is persisted in the **browser's localStorage**, so no backend/login is needed to
    use and test the UI. Cloud/Supabase sync only runs opportunistically.
  - The dev server prints repeated `"[Supabase] Missing ... SUPABASE_SERVICE_ROLE_KEY"`
    warnings. This is **expected and harmless** for local UI work — server admin data
    paths degrade gracefully. Only add that secret if you specifically need server-side
    Supabase admin operations.
  - A "Welcome to J1m's Bot" wizard modal appears on first load; click **Skip** to
    dismiss (completion is stored in localStorage).
  - `bun run lint` currently reports **many pre-existing** `prettier/prettier` and other
    errors across `executor/`, `runner/`, and `src/` (eslint lints the whole repo).
    These are pre-existing repo state, not a setup problem; `bun run format` would
    rewrite files, so don't run it unless intentionally reformatting.

### Optional services (not required to run/test the web app)
- `executor/`: Node ≥20 Fastify service. Uses **npm** (`cd executor && npm install`,
  then `npm run dev`, listens on `PORT` 8080). Real Kmart checkouts require external
  secrets (`EXECUTOR_TOKEN`, `HYPER_API_KEY`, residential `PROXY_URL_RESI`); see
  `SETUP.md`. Not needed to boot the UI (server fns return a "not configured" message).
- `runner/`: Electron **desktop GUI** app (`cd runner && npm install && npm run
  install-browsers && npm start`). Requires a display; not practical to run headless.
- `desktop/`: **J1m's Bot desktop v1** — local Kmart checkout with profiles/proxies/tasks
  on disk, API-key license (Whop-ready, not gated), localhost proxies. Spawns
  `executor/` as a sidecar so the Kmart flow stays identical to Fly. Supports
  Cyber-style monitor input (keywords/URL/SKU) with Private or Global source.
  (`cd desktop && npm run setup && npm start`). See `desktop/README.md`.
- `monitor/`: **Operator Kmart monitor** — ISP poll + SSE `/feed` (detect only, never
  checkout). Deploy on Fly `syd`. (`cd monitor && npm install && npm start`).
  See `monitor/README.md`.
- Deployment / external wiring (Fly.io, Railway, Oxylabs, Browserless) is documented in
  `SETUP.md`.

### Kmart Akamai regression note (code, not proxies)
ISP checkouts cleared WWW→cart around **PR #32** (`600b40f`). The later **Electron Update**
(`a1d9f9c`) and monitor soft-API work regressed Akamai trust in `executor/adapters/kmart.js`
even when `_abck` still solved. When WWW stays Access Denied after a clean solve, treat it as
a **code path / solve-context** bug first — do not default to blaming proxy quality.

Proven-path anchors to keep (see PR #35 restore work):
- Hyper sensor `pageUrl` + sensor POST referer = **PDP URL** (not homepage `/`)
- SBSD `o` cookie = **`bm_so` first**, then `sbsd_o`
- No SBSD `follow_get` re-document after passive rounds
- `resetUndici` between SBSD rounds and before `category_browse`
- Soft `verify_ip` **after first PDP**, not a hard ISP abort before category
- GraphQL only after real PDP HTML (`wwwHtmlOk`); soft-API home-referer entry hides WWW failure
- `http.js`: string-form `new ProxyAgent(proxyUrl)` (not `{ uri, connect }` object form)

Local executor smoke (avoid clashing with Vite on 8080):
`PORT=8081 EXECUTOR_TOKEN=devtoken HYPER_API_KEY=… MONITOR_ENABLE=0 node server.js`
(from `executor/`).
