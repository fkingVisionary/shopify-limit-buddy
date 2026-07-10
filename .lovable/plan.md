Totally fair — you shouldn't need `flyctl` on your phone. The repo already deploys via GitHub Actions, so we'll add Oxylabs the same way: **paste 3 secrets into GitHub, tap Run workflow, done.**

## What you do (5 minutes, phone only)

1. GitHub mobile site → your repo → **Settings → Secrets and variables → Actions → New repository secret**. Add three:
   - `EXECUTOR_HTTP_TRANSPORT` = `oxylabs`
   - `OXYLABS_UNBLOCKER_USER` = (from dashboard.oxylabs.io → Web Unblocker → sub-user)
   - `OXYLABS_UNBLOCKER_PASS` = (same place)
2. GitHub app → **Actions → Deploy executor → Run workflow** (leave `create_app` OFF).
3. Leave `region` as `lax`; Sydney capacity is currently causing the deploy loop.
4. When it finishes, open `https://j1ms-bot-executor.fly.dev/health` in your browser. It should say `"transport":"oxylabs"`.

## What I change in the repo

**`.github/workflows/deploy-executor.yml`** — extend the `fly secrets set` step so it also stages the three new secrets on every deploy, alongside the existing `EXECUTOR_TOKEN` / `HYPER_API_KEY` / `PROXY_URL_RESI`. That's the only code change; the executor already knows how to use them.

Also deploy with `--ha=false` and default `region=lax` so Fly doesn't try to replace two machines in Sydney while that region has no capacity.

**`SETUP.md`** — add a short "Enable Oxylabs" section pointing at the same three GitHub secrets, so future-you doesn't have to remember.

## What I do NOT change

- No `flyctl` needed, ever.
- No frontend / TanStack / checkout job changes.
- Kmart adapter and `executor/http.js` already handle Oxylabs — they just need the env vars, which the workflow will now inject.

## Validation

After the workflow finishes:
1. `/health` reports `"transport":"oxylabs"`.
2. Run one Kmart job. Timeline should start with `unblocker` and have no `akamai_*` steps.
3. If `/health` still says `undici`, the workflow step name tells us which secret is missing — no guessing.

If you want, once you confirm the plan I'll also add an "Oxylabs status" line to the workflow's final log so you can see at a glance whether it picked up the secrets.
