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

### Kmart executor — capture wins, don’t gate them away
- Checkout can intermittently push to `cart_get` → checkout → 3DS / `place_order`.
  Prefer **logging and tracking successful milestones** over fail-closed deploy gates
  that turn sensor flake into a red CI and block ships of code that already works.
- **Do not add gates on a path that is already placing orders / reaching 3DS.** A gate
  that only fails closed cannot invent wins; it can only take deploys away.
- **Do not brute-force proxy lists** as the product strategy. When Revolut / bank
  confirms a hit (e.g. 13:11 AEST 2026-07-20 on Juicy pens), harden that route
  (sensor recovery on direct, mid-run milestones). Proxy swaps are secondary.
- **Deploy note:** `#62` (milestones) is already on Fly tip `b10bf27`. Merging alone
  does not solidify checkout — ship sensor/milestone harden PRs and wait for the
  Deploy executor workflow (or re-run it) so `gitSha` moves.
- **After each tip:** smoke via `POST /api/public/exec-test` (wait ≥180s; client
  timeouts often hide payment). Score the **furthest stage**, not only `failedStep`.
  Check Fly logs for `kmartMilestone` (including `live:true` mid-run) and
  `GET /milestones` on the executor.
- **Card:** `exec-test` auto-injects `KMART_CARD_*` when secrets exist (pass
  `noCard:true` to skip). Revolut / bank pings are useful third-party proof the
  path still reaches 3DS — prefer that over scoring only `failedStep` after a
  client timeout. Still wait ≥180s and check `kmartMilestone` / `/milestones`.
- **Pass signals (in order):** `cart_get` JSON 200 → ATC/checkout → tokenize → 3DS →
  `place_order` / order number. Reference morning artifact `resi-dry-1` (2026-07-19,
  direct, tip `#40` / `b3b7a81`) and bank-confirmed charge (~14 Jul).
- **Restore over tip roulette:** If a tip regresses a known-good runtime, restore the
  whole runtime (`http.js` / `checkout.js` / `server.js` / `kmart.js`), not adapter-only
  (#57 was incomplete). Do not open GraphQL/header/TLS spirals without wire proof.
- Deploy workflow may run `direct-cart-gate.sh` as **advisory** (`continue-on-error`);
  do not re-harden it into a fail-closed merge blocker without an explicit ask.

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
