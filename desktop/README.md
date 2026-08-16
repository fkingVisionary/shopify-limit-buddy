# Vanta Beta — Desktop

Local Windows app for checkout ops. Profiles, cards, proxies, and tasks stay on
this machine. The checkout engine runs as a local `executor/` sidecar.

## Quick start (from source)

```bash
cd desktop
npm run setup
npm start
```

## Windows installer (beta users)

Non-technical users should **not** use this folder. Send them to the admin
dashboard:

**`https://<your-dashboard>/download`**

That page has one big **Download Vanta Beta** button. The file is published via
GitHub Releases (`Vanta-Beta-Setup.exe`) by the **Build desktop Windows**
workflow.

Operators:

```bash
cd desktop
npm ci
npm run dist:win
# → release/Vanta-Beta-Setup.exe
# → release/Vanta-Beta-Portable.exe
```

Then run the workflow (or tag `vanta-v*`) so `/download` resolves to the latest
release. Optional Railway override: `VANTA_WIN_SETUP_URL=https://…/Vanta-Beta-Setup.exe`.

## API key

Settings → paste API key from the dashboard. Empty control plane URL = local open
mode. With a control plane URL, the app calls
`POST /api/public/desktop/validate-key`.

## Toymate / Bandai / Kmart

See earlier sections in git history / `executor/docs/` for store-specific runbooks.
Drop runbook: `executor/docs/TOYMATE_HIGH_TRAFFIC_DROP.md`.
