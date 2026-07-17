# J1m's Bot — Desktop (v1)

Cyber-style local app: **must stay open** to run checkouts. Kmart full flow
(Akamai → cart → Paydock → 3DS → place order) runs on **this machine** via the
existing `executor/` engine as a local sidecar — same checkout code as Fly.

Profiles, cards, proxies (including `127.0.0.1`), and tasks are stored **locally**.

The web dashboard Kmart/Fly path is **unchanged**. This is an additive product surface.

## Quick start

```bash
cd desktop
npm run setup          # install Electron + executor deps + Chromium
npm start
```

1. **Settings** — paste any API key (local/open mode), paste your **Hyper API key** (BYO).
2. **Start engine** — boots local executor on `127.0.0.1`.
3. Add a **profile**, optional **proxy group** (`127.0.0.1:PORT` OK), **Kmart task**.
4. **Run** — watch stages in Results. Close the app → nothing runs.

## Architecture

```
┌─────────────────────────┐     localhost HTTP      ┌──────────────────────┐
│  Electron UI            │ ─────────────────────▶  │  executor/ (sidecar) │
│  profiles / proxies /    │     POST /run           │  kmart adapter       │
│  tasks / job queue      │ ◀──── progress ──────── │  Hyper + Playwright  │
└──────────┬──────────────┘                         └──────────────────────┘
           │ optional
           ▼
┌─────────────────────────┐
│  Control plane          │  validate-key (Whop-ready)
│  (Railway dashboard)    │  hyper-provision (opt-in)
└─────────────────────────┘
```

## API key / Whop (not gated yet)

- No pairing codes.
- App sends `API key` to `POST /api/public/desktop/validate-key`.
- Server default: `DESKTOP_AUTH_MODE=open` — any non-empty key works.
- Later: `allowlist` via `DESKTOP_API_KEYS`, or `whop` once Whop is wired in
  `src/lib/desktop-license.ts`.

Optional Hyper hand-off (prefer BYO in the app):

```bash
DESKTOP_HYPER_PROVISION=1
HYPER_API_KEY=...   # on the control plane only
```

## Future stores

Add an adapter under `desktop/adapters/` and extend `buildPayload` in
`job-runner.cjs`. Same profiles/proxies/tasks UI.

## Debugging a failed run

Logs are **oldest → newest** (scroll to bottom for latest).

Each attempt prints:
1. `proxy=` / `transport=` / `mode=`
2. Stage changes with **step name + detail**
3. On failure: `checkoutStage` + failed step notes
4. Full step timeline + Akamai signals (`abck` / `bm_sv` / denied)
5. JSON artifact under `userData/j1ms-desktop/runs/<runId>.json`

Verbose / headless e2e:

```bash
# Full timeline in UI + console + run JSON
DESKTOP_VERBOSE=1 npm start

# Autorun enabled tasks (dry-run), write e2e-last.json, quit
DESKTOP_E2E_AUTORUN=1 DESKTOP_VERBOSE=1 DESKTOP_E2E_OUT=/tmp/kmart-e2e.json npm start
```

### Access Denied on category/PDP

This is **not** a broken payload vs the web app. The same `executor/` hits Akamai
`Access Denied` from this PC’s egress (`verify_ip` / `resolve_ip` show your home IP).
Fly works because Linux undici + AU egress is a different trust path.

- **`proxy_egress`**: when a proxy is set, the executor compares proxied vs direct
  ipify. If `same=true`, the run **fails before** warm/sensors — fix the proxy
  entry or local manager so exit IP actually changes.
- Confirm exit change in the attempt log: `proxy_egress proxied=… direct=… same=false`.
- SBSD can return HTTP 200 while `bm_sv=false` — that usually precedes hard 403s.
- Desktop uses the **same undici `kmartMode=current` path** as the dashboard → Fly.
  No TLS/Playwright auto-retry ladder (not scalable).

## Package

```bash
npm run package:win    # .exe folder
npm run package:mac
npm run package:linux
```

Packaged builds still need the `executor/` tree + Node available for the
sidecar in v1 (or bundle Node later). For day-to-day use, `npm start` from
this repo is the supported path.
