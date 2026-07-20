# AGENTS.md

## Cursor Cloud specific instructions

### Product overview
This repo is **J1m's Bot** — a retail checkout automation dashboard. The root is the
primary product: a TanStack Start + Vite + React 19 web app (the "control plane").
Subdirectories `executor/` (Node/Fastify checkout engine), `runner/` (legacy
Electron Shopify agent), and `desktop/` (Cyber-style local Kmart app) are
**optional** auxiliary services. `supabase/` holds hosted DB
migrations + one Deno edge function.

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

### Kmart executor — do not lose a working direct path
- **Hard gate:** After any `executor/` change that touches Kmart checkout (`adapters/kmart.js`,
  `http.js`, sensor/SBSD/GraphQL), smoke **direct** (no `proxyUrl`) via Lovable
  `POST /api/public/exec-test` before merging or continuing ISP/proxy tips.
- **Pass:** `cart_get` JSON 200 (not AkamaiGHost). Prefer reaching `checkout_*` /
  `place_order` dry-run like artifact `resi-dry-1` (2026-07-19, direct).
- **Fail:** If direct regresses while you are “fixing proxies,” **stop**. Restore the
  last green direct tip first. Never stack GraphQL/header/TLS PRs on a broken baseline.
- Known green morning tip for that artifact: merge `#40` / `b3b7a81` (Fly deploy
  2026-07-19 ~19:51Z). Later tip spiral (#42–#55) kept ISP wiring but lost direct GraphQL.

### Optional services (not required to run/test the web app)
- `executor/`: Node ≥20 Fastify service. Uses **npm** (`cd executor && npm install`,
  then `npm run dev`, listens on `PORT` 8080). Real Kmart checkouts require external
  secrets (`EXECUTOR_TOKEN`, `HYPER_API_KEY`, residential `PROXY_URL_RESI`); see
  `SETUP.md`. Not needed to boot the UI (server fns return a "not configured" message).
- `runner/`: Electron **desktop GUI** app (`cd runner && npm install && npm run
  install-browsers && npm start`). Requires a display; not practical to run headless.
- `desktop/`: **J1m's Bot desktop v1** — local Kmart checkout with profiles/proxies/tasks
  on disk, API-key license (Whop-ready, not gated), localhost proxies. Spawns
  `executor/` as a sidecar so the Kmart flow stays identical to Fly.
  (`cd desktop && npm run setup && npm start`). See `desktop/README.md`.
- Deployment / external wiring (Fly.io, Railway, Oxylabs, Browserless) is documented in
  `SETUP.md`.
