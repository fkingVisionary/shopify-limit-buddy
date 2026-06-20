# Phone-only Fly deploy via GitHub Actions

You don't need a computer. We'll deploy the `executor/` folder to Fly using a GitHub Actions workflow you trigger from the GitHub mobile app (or mobile browser). Fly account creation, secrets, and "Run workflow" all work from a phone.

## What I'll add to the repo

**`.github/workflows/deploy-executor.yml`** — manually-triggered workflow that:
1. Checks out the repo
2. Installs `flyctl` (`superfly/flyctl-actions/setup-flyctl@master`)
3. Runs `flyctl deploy --remote-only --config executor/fly.toml --dockerfile executor/Dockerfile` from the repo root
4. Authenticates with `FLY_API_TOKEN` from GitHub repo secrets

A second workflow step (gated behind a `workflow_dispatch` input `create_app: true`) runs `flyctl apps create j1ms-bot-executor --org personal` first time only, so you don't need to run `flyctl launch` locally.

## What you do from your phone

1. **Connect repo to GitHub** — in Lovable, + menu → GitHub → Connect project (one tap, OAuth in mobile browser).
2. **Make a Fly account** — fly.io/app/sign-up in mobile browser, add card.
3. **Mint a deploy token** — Fly dashboard → Tokens → Create deploy token (scope: this org). Copy it.
4. **Add GitHub repo secrets** (Settings → Secrets and variables → Actions on github.com mobile site):
   - `FLY_API_TOKEN` — from step 3
   - `HYPER_API_KEY` — your Kmart Hyper key
   - `PROXY_URL_RESI` — `http://user:pass@host:port` for your AU residential proxy
   - `EXECUTOR_TOKEN` — any random string (use a password manager to generate)
5. **Run workflow** — GitHub mobile app → Actions tab → "Deploy executor" → Run workflow → tick `create_app` (first time only).
6. **Get the URL** — workflow logs print the hostname (`j1ms-bot-executor.fly.dev`). I confirm it with a `/health` curl from the Lovable backend.
7. **Wire Lovable** — I trigger the `add_secret` form here for `EXECUTOR_URL` + `EXECUTOR_TOKEN`; you paste in the chat.
8. **Dry-run Kmart** — I call `runOnExecutor` against a Kmart PDP and we read the chain output.

## Secrets sync to Fly

The workflow also runs `flyctl secrets set EXECUTOR_TOKEN=... HYPER_API_KEY=... PROXY_URL_RESI=... --app j1ms-bot-executor --stage` before deploy, so the Fly app picks them up from the same GitHub secrets — you never have to run `flyctl secrets` from a terminal.

## Doc update

I'll rewrite `SETUP.md` for the phone-only path (drop PowerShell/flyctl-local sections, add GitHub Actions screenshots-style steps, drop 2Captcha, add Hyper).

## What I need before building

Confirm:
- (a) The project is already connected to GitHub, or you're happy to connect it now.
- (b) You have (or will create) a Fly account before I add the workflow — the workflow itself doesn't need the account to exist, but step 5 does.

Reply "go" and I'll add the workflow + updated SETUP.md in one batch.
