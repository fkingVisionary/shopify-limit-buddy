# J1m's Bot — Local Runner

Electron desktop app that executes Shopify checkouts on **your** machine
(real residential IP, no Browserless cost). It pairs with the Lovable
control-plane and polls for jobs over HTTPS.

```
┌─────────────────┐    pairing code     ┌──────────────────┐
│  Lovable web    │ ─────────────────▶  │  Runner (this)   │
│  (Settings →    │                     │  Electron +      │
│   Local runner) │ ◀───── jobs ─────── │  Playwright      │
└─────────────────┘    short-poll 2s    └──────────────────┘
        ▲                                       │
        └──────── result + screenshot ──────────┘
```

## Install

```bash
cd runner
npm install
npm run install-browsers   # downloads Chromium for Playwright (~150MB)
```

## Pair

1. Open the Lovable app → **Settings → Local runner** → "Generate pairing code".
2. Run `npm start` in this folder.
3. Paste your control plane URL (e.g. `https://your-project.lovable.app`).
4. Paste the 6-character pairing code, click **Pair**.
5. Click **Start** — the runner begins polling.

Now any task with **Full browser checkout → Local runner** enabled will be
dispatched here instead of Browserless.

## Package (optional)

```bash
npm run package:mac     # .app
npm run package:win     # .exe folder
npm run package:linux   # binary folder
```

## Scaffold limitations (read before production use)

- **In-memory job store on the control plane** — jobs/results live in a per-
  isolate Map. Fine for local testing; lost on isolate recycle. Swap to
  Lovable Cloud tables (`runner_devices`, `runner_jobs`) for production.
- **Single active device** — most-recently-paired device claims all jobs.
  Multi-device round-robin is a 10-line change in `runner-store.server.ts`.
- **No re-pair persistence** — relaunching the Electron app loses the
  `deviceToken`. Add `electron-store` to persist it.
- **Headless = false** by default so you can watch the bot drive — flip in
  `checkout.cjs` for batch mode.
