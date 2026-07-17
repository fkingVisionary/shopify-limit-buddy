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
- SoftBlock Access Denied HTML can `Set-Cookie` a fresh `_abck` with `ind=-1`. The
  name-keyed jar in `http.js` **refuses to demote** a solved `~0~` `_abck`.
- `skipCategory` / `KMART_SKIP_CATEGORY=1` skips `/category/*` (home→PDP) when category
  SoftBlock is poisoning the nav chain.
- Hyper (blog + Claude plugin refs): use AI to **build** the request scraper, never
  to run it. If `_abck` solves (`~0~`) but WWW still SoftBlocks, focus TLS /
  header order / CH grease — not more Hyper sensor rounds.
  `forceTls` / `transport: "tls"` uses `node-tls-client` `chrome_131` (not Playwright).
  TLS path requires a **trailing slash** on the proxy URL (bogdanfinn CONNECT quirk);
  undici must keep the URL without it. Undici ignores `CHROME_HEADER_ORDER`; TLS
  honors `cookie` immediately before `priority`.
- Bootstrap from `public/kmart-slim.har`: home SBSD → sensor (pageUrl=`/`) →
  category (prefer `/category/toys/toys-latest-arrivals/`) → PDP. Low-entropy CH
  only on DOC/sensor/SBSD; `sec-ch-ua` grease must match UA major. SBSD `o`:
  `sbsd_o` then `bm_so`. Do **not** leave `KMART_SKIP_CATEGORY=1` on the executor
  unless intentionally testing home→PDP — it overrides `skipCategory: false`.

### Desktop
- `cd desktop && npm run setup && npm start` — local Kmart checkout via executor sidecar.
- See `desktop/README.md`.
