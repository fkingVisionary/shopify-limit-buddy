## Goal

Deploy to Sydney (`syd`) by default so the executor sits close to Kmart AU, but automatically fall back to `lax` if Fly has no capacity. Document a future path to cut latency further when Sydney is chronically full.

## Changes

### 1. `.github/workflows/deploy-executor.yml`

- Change the workflow input `region` default back to `syd`.
- Add a new input `fallback_region` (default `lax`) so you can override from the phone if needed.
- Replace the single `flyctl deploy` step with a "deploy with fallback" step:
  1. Try `flyctl deploy --primary-region $REGION ... --ha=false`.
  2. If it exits non-zero AND the log contains `no capacity` / `capacity` / `unavailable in region`, re-run the same deploy with `--primary-region $FALLBACK_REGION`.
  3. Any other failure (auth, build, secrets) fails the job immediately — no fallback, because retrying in LAX wouldn't fix it.
- After deploy, print which region actually won: `flyctl status --app "$APP" --json | jq -r '.Hostname + " region=" + (.Machines[0].region // "unknown")'`.
- Keep the existing Oxylabs `/health` transport check.

### 2. `executor/fly.toml`

- Set `primary_region = "syd"` again. `fly.toml` only affects the *first* app create; the workflow's `--primary-region` flag drives every subsequent deploy, so the fallback still works.

### 3. `SETUP.md`

- Update the region guidance:
  - Default is `syd`, workflow auto-falls-back to `lax` if Sydney is full.
  - The final log line tells you which region you actually landed in.
  - If you land in `lax`, you can re-run the workflow later to try `syd` again — Fly capacity usually recovers within hours.
- Add a short "Future: sub-50ms options if Sydney is chronically full" section:
  - **Option A — Fly `syd` on a Performance VM** (`performance-1x`). Dedicated CPU tier has separate capacity and almost always deploys in Sydney. Costs a few dollars a month.
  - **Option B — Move executor off Fly to an AU VPS** (Vultr Sydney, DigitalOcean Sydney, Hetzner has no AU region). Same Docker image, same env vars; only the deploy target changes.
  - **Option C — Oxylabs' Realtime API from anywhere.** Since Oxylabs handles the AU IP + Akamai solve on their side, executor location matters mainly for latency to Oxylabs' endpoint, not to Kmart. LAX → Oxylabs AU ≈ 150ms; a Singapore or Tokyo host would be ~100ms.
- These are documented but NOT implemented now — you asked for one option today, more later.

### 4. `.lovable/plan.md`

- Update to reflect the new default (`syd` with `lax` fallback) so the doc matches the workflow.

## What stays unchanged

- No `flyctl` on your phone.
- No frontend / TanStack / checkout / Kmart adapter changes.
- Oxylabs secrets flow is unchanged from the previous plan.

## Validation (after you run the workflow)

1. Job log ends with either `region=syd` (ideal) or `region=lax` (fallback fired).
2. `/health` reports `"transport":"oxylabs"`.
3. If you got `syd`, latency to Kmart should be single-digit ms from the executor.
4. If you got `lax`, re-run the workflow in a few hours to try Sydney again — no code change needed.
