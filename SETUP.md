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

Leave `region` as `syd` (Sydney — closest to Kmart AU, fastest checkouts) and `fallback_region` as `lax`. If Sydney has no spare Fly capacity, the workflow automatically retries the deploy in the fallback region so you're never stuck. The executor deploys as a single machine (`--ha=false`) to avoid two-machine replacement loops.

Tap **Run workflow**. ~2 minutes later the job finishes and the logs print:

```
j1ms-bot-executor.fly.dev  region=syd  (requested=syd, fallback=lax)

Health check:
{"ok":true,"transport":"oxylabs"}
Oxylabs Web Unblocker: ACTIVE
Region: Sydney (ideal for Kmart AU latency)
```

The `region=` line tells you where you actually landed. If it says `region=lax` the fallback fired (Sydney was out of capacity) — the executor still works via Oxylabs' AU IPs, just with ~150ms extra latency. Re-run the workflow later to try Sydney again; capacity usually recovers within hours.

If the health check fails, open the job log and look for the failing step.

---

## Optional: Deploy executor to Railway instead of Fly

If you prefer Railway over Fly for the Node executor:

1. New Railway project → Deploy from GitHub → this repo.
2. **Critical:** Service → Settings → **Root Directory** = `executor`  
   (If this is blank, Railway builds the Lovable UI at the repo root, looks for `/app/dist`, and fails with `"/app/dist": not found`.)
3. Builder: Dockerfile (see `executor/railway.toml`).
4. Variables (same as Fly secrets):

   | Name | Value |
   |---|---|
   | `EXECUTOR_TOKEN` | shared secret (32+ chars) |
   | `HYPER_API_KEY` | Hyper Solutions key |
   | `PROXY_URL_RESI` | `http://user:pass@host:port` (optional default proxy) |
   | `PORT` | Railway sets this; leave alone |

5. After deploy, open `https://<your-service>.up.railway.app/health` (JSON).  
   Visiting `/` alone used to look blank — it now returns a small JSON index.  
   In Networking, do **not** force a custom target port unless it matches `PORT` (Railway injects this). Prefer the default public domain routing.
6. In Lovable secrets set `EXECUTOR_URL` to that origin (no trailing path) and the same `EXECUTOR_TOKEN`.

Quick checks after connect:
```bash
curl -sS https://<your-service>.up.railway.app/health
curl -sS -X POST https://<your-service>.up.railway.app/health/diagnose \
  -H "authorization: Bearer $EXECUTOR_TOKEN" -H "content-type: application/json" \
  -d '{"proxy":null}'
```

The Playwright base image is large (~2GB+). Railway hobby plans can deploy it, but first builds are slow. If the build OOMs, bump the service memory or stick with Fly (`SETUP.md` steps 1–4).

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

Success looks like a step chain ending with `akamai_solved` and a `pdp_get` returning **200**. The timeline must show `transport mode=tls` for sticky residential proxy runs; a residential IP alone is not enough if the HTTP client fingerprint is non-browser.

---

## Optional: Enable Oxylabs Web Unblocker

The current Kmart route is sticky residential proxy + Chrome TLS transport + Hyper. Oxylabs Web Unblocker is optional and should not be mixed into normal Hyper debugging unless you are deliberately testing that transport.

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
| Workflow fails with `machine is replacing` or `no capacity available in syd` | Nothing to do — the workflow auto-falls-back to `lax`. Re-run later to try Sydney again. |
| `pdp_get` returns 403 | Proxy isn't residential AU — swap proxy provider |
| `antibot_misconfigured` in chain output | `HYPER_API_KEY` missing or rejected on Fly — re-check the GitHub secret and re-run workflow |
| Want to scale down / stop spending | Fly dashboard → app → Scale → set min machines to 0 (already the default) |
| `ERR_CONNECTION_CLOSED` / pages never load | In the Kmart UI click **Executor diagnose**, or `POST /health/diagnose` with the same proxy. If the CONNECT probe fails, fix proxy auth/plan before retrying checkout. |

---

## Notes on scope

- **Kmart AU only** for now — that's the only domain whitelisted on the current Hyper key.
- **Browserless** stays in the codebase but is recon-only; it is NOT in the checkout path.
- **JB Hi-Fi / Shopify** flows are paused until Hyper whitelists those Akamai/Shopify profiles.

---

## Future: lower-latency options if Sydney is chronically full

The workflow's `syd → lax` fallback keeps you running, but LAX adds ~150ms per request round-trip vs Sydney. If Sydney capacity stays bad for days at a time, these are the escape hatches (documented now, not implemented until you ask):

- **Option A — Fly Sydney on a Performance VM.** In `executor/fly.toml` change `[[vm]] size` from `shared-cpu-2x` to `performance-1x`. Dedicated-CPU tier has separate capacity and almost always deploys in `syd`. Adds a few dollars a month. One-line change, still phone-deployable via the same workflow.
- **Option B — Move the executor off Fly to an AU VPS.** Vultr Sydney or DigitalOcean Sydney both take the same Docker image + env vars. Only the deploy target changes; the executor code stays identical. Slightly more setup (one-time), but you own the region.
- **Option C — Reduce dependency on executor location.** Oxylabs handles the AU IP + Akamai solve on their side, so what actually matters is latency between the executor and Oxylabs' endpoint, not between the executor and Kmart. A Singapore or Tokyo Fly region (`sin` / `nrt`) is ~100ms to Oxylabs AU vs ~150ms from LAX — better than LAX and usually has capacity when `syd` doesn't. To try it: re-run the workflow with `region=sin` and `fallback_region=lax`.

None of these require code changes to the checkout logic — they're deploy-target choices.
