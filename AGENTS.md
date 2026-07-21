# AGENTS.md

## Cursor Cloud specific instructions

### Product overview
This repo is **J1m's Bot** — a retail checkout automation dashboard. The root is a
TanStack Start + Vite + React 19 UI (run **locally** with Bun — not a public
Lovable deploy). The **real checkout engine** is `executor/` on **Fly.io**
(`j1ms-bot-executor`). `runner/` (legacy Electron), `desktop/` (local Kmart app),
and `supabase/` are optional auxiliaries.

**What matters for Kmart:** Fly tip (`/health` → `gitSha`) via **Deploy executor**.
Do **not** treat `*.lovable.app` as the product control plane or ask to “redeploy
Lovable.” Cloud-agent smokes may hit a stale preview host that still has old
`exec-test` secrets — ignore its `proxyUsed` labels; trust Fly `resolve_ip` /
`proxySource` / milestones. Prefer Fly `/run` + `/milestones` (Bearer
`EXECUTOR_TOKEN`) or local `bun run dev` → Fly.

### Kmart charge path (lock)
Proven tip: undici one-client + ISP (`executor/resi.proxies`). Bank proof
2026-07-21 Revolut on Actions run `29790423175`. See
`executor/docs/KMART_WINNING_RECIPE.md`. Do not default `sensorTls`/`apiTls` on.

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
  confirms a hit (e.g. 13:11 AEST 2026-07-20 on Juicy pens), harden that route.
  Reliability bottleneck is Hyper `_abck` (success grows to `ind=0`; failure
  plateaus ~795b). Fix = script rebind + Hyper context reset on plateau — not
  more blind sensor rounds or proxy spray. Cart→3DS is already proven once solved.
- **Deploy note:** `#62` (milestones) is already on Fly tip `b10bf27`. Merging alone
  does not solidify checkout — ship sensor/milestone harden PRs and wait for the
  Deploy executor workflow (or re-run it) so `gitSha` moves.
- **Winning recipe:** `executor/docs/KMART_WINNING_RECIPE.md` — lock before
  desktop/local hardware. Payment ~07:03–07:04 UTC 2026-07-20: client empty /
  timeout while Fly continued; **bank ping is ground truth**.
- **After each tip:** confirm Fly `gitSha` moved, then smoke **Fly**
  `POST /run` (Bearer) with a stable `taskId` + card; poll
  `GET /milestones?taskId=…&minStage=tokenize`. Score bank ping →
  `kmartMilestone` / milestones → `reached3ds`, **not** only `failedStep`.
- **Card:** pass card on `/run` (or local env `KMART_CARD_*` when using a local
  UI proxy). Revolut / bank pings prove 3DS even when the HTTP client timed out.
- **Pass signals (in order):** `cart_get` JSON 200 → ATC/checkout → tokenize → 3DS →
  `place_order` / order number. Reference morning artifact `resi-dry-1` (2026-07-19,
  direct, tip `#40` / `b3b7a81`) and bank-confirmed charge (~14 Jul).
- **Restore over tip roulette:** If a tip regresses a known-good runtime, restore the
  whole runtime (`http.js` / `checkout.js` / `server.js` / `kmart.js`), not adapter-only
  (#57 was incomplete). Do not open GraphQL/header/TLS spirals without wire proof.
- **Transport:** Kmart **defaults to undici** — that is the path that reached
  `place_order` / 3DS on Fly direct (`89.187.186.9`). `tls-worker` remains opt-in
  (`transport=tls-worker` / `tlsWorker:true` / `KMART_TLS_WORKER=1`): it can solve
  `_abck` then 403 category/PDP on the same IP (handling bug, not SoftBlock).
  In-process TLS (`forceTls`) and Playwright stay opt-in only.
- **Category:** default **skip** (home→PDP). A category 403 is not proof of a
  burnt proxy when sensors just solved on that exit.
- **Native `.so` bake:** `node-tls-client` `process.exit(1)`s if the GitHub native
  download fails (common on Fly via api.github.com 403). Dockerfile must curl the
  pinned release asset into `/app/vendor/tls-client-x64.so` and seed `TMPDIR`.
  If `transport_select` shows `tls-worker init failed → undici`, check that bake.
- **Proxies:** WealthProxies / IPFist / Supabase “Test Pool” are **dead** (subs
  cancelled). Fly `/run` refuses those hosts → `executor/resi.proxies` or direct.
  Do not gate runs on sticky/drift IP checks.
- **Capture:** milestones on Fly disk + `kmartMilestone` log lines survive client
  timeouts. Always use a stable `taskId`.
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
