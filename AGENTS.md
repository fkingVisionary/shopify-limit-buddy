# AGENTS.md

## Cursor Cloud specific instructions

### Product overview
This repo is **J1m's Bot** — a retail checkout automation dashboard. The root is the
primary product: a TanStack Start + Vite + React 19 web app (the "control plane").
Subdirectories `executor/` (Node/Fastify checkout engine) and `runner/` (Electron
desktop agent) are **optional** auxiliary services. `supabase/` holds hosted DB
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

### Optional services
- `executor/`: Node ≥20 Fastify service. Uses **npm** (`cd executor && npm install`,
  then `npm run dev`, listens on `PORT` 8080). Real Kmart checkouts require external
  secrets (`EXECUTOR_TOKEN`, `HYPER_API_KEY`, residential `PROXY_URL_RESI`); see
  `SETUP.md`. Not needed to boot the UI (server fns return a "not configured" message).
- `runner/` (Electron desktop agent): uses **npm** (has its own `package.json`, no lockfile
  committed). See `runner/README.md` for pairing flow.
  - Install: `cd runner && npm install`. For actual checkout job execution also run
    `npm run install-browsers` (Playwright Chromium → `~/.cache/ms-playwright`, ~300MB).
  - **Launch in Cloud Agent VMs** (sandbox is required off, otherwise Chromium fails):
    ```bash
    cd runner
    DISPLAY=:1 ELECTRON_DISABLE_SANDBOX=1 ./node_modules/.bin/electron . --no-sandbox
    ```
    Plain `npm start` without `--no-sandbox` will not work in this environment. D-Bus /
    GPU init errors in the log are expected and harmless; the window still opens.
  - Pairing: web app → **Settings → Local runner → Generate pairing code**, then paste
    control-plane URL (`http://localhost:8080` for local) + code into the Electron UI
    and click **Pair**, then **Start**.
- Deployment / external wiring (Fly.io, Railway, Oxylabs, Browserless) is documented in
  `SETUP.md`.
