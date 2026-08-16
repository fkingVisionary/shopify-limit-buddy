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

Non-technical users should **not** use this folder. Send them to:

**`https://<monitor-or-dashboard>/download`**

That page has one big **Download Vanta Beta** button. Releases publish
`Vanta-Beta-Setup.exe` + `latest.yml` so the **installed** app can auto-update.

Operators:

```bash
cd desktop
npm ci
npm run dist:win
```

Bump `version` in `desktop/package.json` before shipping so updaters see a newer build.

## Security lock (anti-intercept)

If HTTP Toolkit, Fiddler, Charles, mitmproxy, Wireshark, etc. are detected
(or TLS key-log / local MITM proxy env), **all tasks and harvest stop** until
the tooling is closed. This is a product integrity gate against signal scraping.

## API key

Settings → paste API key. Empty control plane URL = local open mode. With a
control plane / monitor URL, the app calls `POST /api/public/desktop/validate-key`.

## Toymate / Bandai / Kmart

See earlier sections in git history / `executor/docs/` for store-specific runbooks.
Drop runbook: `executor/docs/TOYMATE_HIGH_TRAFFIC_DROP.md`.
