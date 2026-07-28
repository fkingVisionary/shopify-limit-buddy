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

## Bandai F5 Harvest (opt-in)

Before a Bandai drop: **Harvest** tab (Bandai bank section) → sticky proxy group →
desired 1–2 → **Start harvest**. Autocheckout claims a warm F5 login bridge (skips
Chromium launch). Empty bank = normal cold checkout. Stop harvest after the drop to
free CPU. See `executor/docs/BANDAI_F5_HARVEST.md`.

The same **Harvest** tab also has the **Toymate** CF + spam bank (CapSolver) above
the Bandai section — arm each independently.

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

## Toymate harvest (CF + spam)

Desktop is the product surface for Toymate. Use the **Harvest** tab to pre-warm
Cloudflare `cf_clearance` (+ optional checkout reCAPTCHA) on sticky AU ISP/resi
proxies so Autocheckout skips ~45s CF + ~30s spam CapSolver on the critical path.

1. **Settings** → CapSolver API key → save.
2. **Proxies** → sticky AU group (session-style lines).
3. **Harvest** → pick that group → desired sessions (2–4) → leave Solve spam on → **Start harvest**.
4. When Ready / With spam look good, run **Toymate → Autocheckout** tasks as usual.

Sessions are single-use and IP-bound. Checkout auto-claims a session, forces the
harvested proxy, and skips proxy rotate on that run. Empty bank falls back to
on-demand CapSolver (slower, still works). CF ~25 min TTL · spam ~100s.

Executor: `POST /toymate/harvest` · adapter skips warm when `harvestedSession` is fresh.

**Proof (2026-07-26):** harvested checkout **36s** → BigPay decline vs baseline **144s** on-demand CapSolver (~4×). See `executor/docs/toymate-harvest-checkout-proof.json`.

## Bandai (Premium Bandai / p-bandai.com)

Shipped in the same Electron → local `executor/` sidecar path as Kmart.

| UI field | Payload | Behavior |
|----------|---------|----------|
| Mode **Autocheckout** | `bandaiMode=checkout` | Login → ATC → cart hold (HTTP + F5) |
| Pay path **Fast** (default) | `bandaiCheckoutMode=fast` + riskHydrate + **page issuer** | Fresh Forter/iovation mint; issuer POST from same Playwright context (avoids RELOAD_ONLY) |
| Pay path **Fast undici** (A/B) | `bandaiCheckoutMode=fast_undici` | Same mint, undici issuer after page-drop (lab compare) |
| Pay path **Safe** | `bandaiCheckoutMode=safe` + `bandaiBrowserCheckout` | Same cart hold, Playwright GEM Pay on F5 bridge |
| Account gen / monitor / chance | `bandaiMode=…` | See executor Bandai bible |

ATC is always HTTP+F5. Sticky AU ISP/resi proxy recommended. Place order needs a
complete card on the profile. Score bank/Revolut + issuer JWT
(`PossibleFraudDetected`, `TransactionStatusType`) — not client ok alone.

**Accounts:** Account gen upserts into the Accounts tab with status truth
(`ready` / `created` SoftBlock / `needs_sms` / `needs_terms`). Auto-checkout
only picks `ready`/`active`. Exact emails already vault-registered for Bandai
cannot be registered again (catchall `+tag` uniquify still mints fresh aliases).

Contract: `executor/docs/BANDAI_CHECKOUT_BIBLE.md`.

## Future stores

Add an adapter under `desktop/adapters/` and extend `buildPayload` in
`job-runner.cjs`. Same profiles/proxies/tasks UI.

### Bandai monitor (opt-in)

Task mode **Bandai — Monitor** with source:

- **Global** — filter shared executor monitor events by SKU/keywords (does not expand the global poll)
- **Task-local** — poll with this task’s proxy group + interval/delay

Same `executor/monitor/*` code whether Desktop sidecar or Fly later.


## Debugging a failed run

Logs are **oldest → newest** (scroll to bottom for latest).

Each attempt prints:
1. `proxy=` / `transport=` / `mode=`
2. Stage changes with **step name + detail**
3. On failure: `checkoutStage` + failed step notes

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
