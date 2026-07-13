# Deploy the dashboard to Railway (control plane)

## You do **not** have to start over

Keep the same Railway project/service. The only fix is **where** it builds from.

| Wrong (what you had) | Right |
|---|---|
| Root Directory = `executor` | Root Directory = **blank** (repo root) |
| You get the API / blank JSON | You get the dashboard UI |

Railway will **auto-detect** the root `Dockerfile`. You do not need a “change Dockerfile” UI option.

### Exact clicks

1. Open the Railway **service** (same one is fine).
2. **Settings → Root Directory** → delete `executor` / leave empty → Save.
3. If **Config as Code** points at `/executor/railway.toml`, change it to `/railway.toml` (or clear the override).
4. Merge/deploy branch `cursor/railway-dashboard-deploy-424d` (PR #3).
5. **Variables** (see below) → Redeploy.

That’s it. No new project required.

---

## What goes where

| Piece | Host | Root Directory |
|---|---|---|
| Dashboard / UI | **Railway** | repo root (blank) |
| Executor | **Fly.io** (keep) | n/a on Railway |

---

## Variables

### Build-time (enable “Available at Build Time”)

| Name | From Lovable |
|---|---|
| `VITE_SUPABASE_URL` | same |
| `VITE_SUPABASE_PUBLISHABLE_KEY` | same |
| `VITE_SUPABASE_PROJECT_ID` | same |

### Runtime

| Name | Value |
|---|---|
| `EXECUTOR_URL` | Fly origin, e.g. `https://j1ms-bot-executor.fly.dev` |
| `EXECUTOR_TOKEN` | same secret as Fly |
| Other Lovable server secrets | copy across as needed |

---

## Verify

- `https://<railway-domain>/` → **pair / dashboard UI** (not JSON)
- `/kmart` → Executor diagnose hits **Fly**

If you still see JSON like `{"service":"j1ms-bot-executor"...}`, Root Directory is still `executor` — clear it and redeploy.
