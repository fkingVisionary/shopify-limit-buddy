# Executor Setup — Phone-Only via GitHub Actions

You can deploy the Kmart/Hyper executor to Fly.io entirely from your phone — no laptop, no PowerShell, no `flyctl` install. A GitHub Actions workflow does the build and deploy; you just tap "Run workflow" in the GitHub mobile app.

Final state:
- Fly.io app `j1ms-bot-executor` running `executor/`
- 3 secrets on Fly: `EXECUTOR_TOKEN`, `HYPER_API_KEY`, `PROXY_URL_RESI`
- 2 secrets in Lovable: `EXECUTOR_URL`, `EXECUTOR_TOKEN`

Cost: Fly small VM (~$0–3/mo, free tier covers most usage) + your residential proxy + Hyper Solutions usage.

---

## 1. Connect this project to GitHub

In Lovable: **+ menu → GitHub → Connect project** → authorize on github.com (works in mobile browser) → Create repository.

Once synced, install the **GitHub mobile app** (iOS / Android). You'll use it to trigger deploys.

---

## 2. Create a Fly.io account

In your mobile browser:
1. Go to <https://fly.io/app/sign-up>
2. Sign up and add a payment card (Hobby tier; small VM is free)
3. Go to **Account → Access Tokens → Create deploy token**
   - Name: `github-actions`
   - Scope: your default org (usually `personal`)
   - Copy the token (you only see it once)

---

## 3. Add GitHub repo secrets

On github.com mobile site (the mobile app doesn't expose secrets UI):

Repo → **Settings → Secrets and variables → Actions → New repository secret**

Add all four:

| Name | Value |
|---|---|
| `FLY_API_TOKEN` | Deploy token from step 2 |
| `EXECUTOR_TOKEN` | Any random 32+ char string (use your password manager's generator) |
| `HYPER_API_KEY` | Your Hyper Solutions key (Kmart-whitelisted) |
| `PROXY_URL_RESI` | `http://user:pass@host:port` — your AU residential proxy |

---

## 4. Run the deploy workflow

GitHub mobile app → your repo → **Actions** tab → **Deploy executor** → **Run workflow**.

**First time only:** toggle `create_app` ON. Subsequent deploys: leave it off.

Leave `region` as `lax`. Sydney often has no spare Fly capacity; the executor now deploys as a single machine (`--ha=false`) so it avoids the two-machine replacement loop shown by `machine is replacing` / `no capacity available in syd`.

Tap **Run workflow**. ~2 minutes later the job finishes and the logs print:

```
Executor hostname:
j1ms-bot-executor.fly.dev

Health check:
{"ok":true}
```

If the health check fails, open the job log and look for the failing step.

---

## 5. Wire the executor into Lovable

Back in Lovable chat, say:

> "Add the executor secrets"

Lovable will open a secure form. Paste:
- `EXECUTOR_URL` → `https://j1ms-bot-executor.fly.dev`
- `EXECUTOR_TOKEN` → the same value you put in GitHub secrets in step 3

---

## 6. Smoke test

In Lovable chat:

> "Dry-run a Kmart product URL through the executor"

Success looks like a step chain ending with `akamai_solved` and a `pdp_get` returning **200**. A 403 means the proxy isn't residential AU — swap providers.

---

## Enable Oxylabs Web Unblocker (recommended for Kmart)

Oxylabs handles Akamai TLS/JA3, sensor generation, and residential IP rotation on their side, so we don't have to chase Akamai updates ourselves.

1. Create a Web Unblocker sub-user at <https://dashboard.oxylabs.io> → **Web Unblocker**. Copy the username and password.
2. On the github.com mobile site, add three more repo secrets in **Settings → Secrets and variables → Actions**:

   | Name | Value |
   |---|---|
   | `EXECUTOR_HTTP_TRANSPORT` | `oxylabs` |
   | `OXYLABS_UNBLOCKER_USER` | Oxylabs sub-user username |
   | `OXYLABS_UNBLOCKER_PASS` | Oxylabs sub-user password |

3. GitHub app → **Actions → Deploy executor → Run workflow** (leave `create_app` OFF).
4. When the job finishes, the last log line says `Oxylabs Web Unblocker: ACTIVE`. You can also visit `https://<your-app>.fly.dev/health` — it should return `"transport":"oxylabs"`.

To disable Oxylabs, delete any one of those three repo secrets and re-run the workflow. The executor falls back to the default undici transport.

---

## Updating later

- **Executor code changes** (anything under `executor/`): re-run the **Deploy executor** workflow from the GitHub app. `create_app` stays OFF.
- **Rotate a secret** (e.g. new Hyper key): update the GitHub repo secret, then re-run the workflow — the workflow restages secrets on Fly every deploy.
- **Check executor logs**: Fly dashboard → your app → Live logs (works in mobile browser).


---

## Troubleshooting

| Symptom | Fix |
|---|---|
| Workflow fails on "Verify FLY_API_TOKEN" | Secret not set or misnamed — check repo Settings |
| Workflow fails on "Create Fly app" | App name taken globally — pick a unique name and pass it as the `app_name` workflow input |
| Workflow fails with `machine is replacing` or `no capacity available in syd` | Re-run the workflow with `create_app` OFF and leave `region` as `lax` |
| `pdp_get` returns 403 | Proxy isn't residential AU — swap proxy provider |
| `antibot_misconfigured` in chain output | `HYPER_API_KEY` missing or rejected on Fly — re-check the GitHub secret and re-run workflow |
| Want to scale down / stop spending | Fly dashboard → app → Scale → set min machines to 0 (already the default) |

---

## Notes on scope

- **Kmart AU only** for now — that's the only domain whitelisted on the current Hyper key.
- **Browserless** stays in the codebase but is recon-only; it is NOT in the checkout path.
- **JB Hi-Fi / Shopify** flows are paused until Hyper whitelists those Akamai/Shopify profiles.
