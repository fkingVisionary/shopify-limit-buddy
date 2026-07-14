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

### Runtime (dashboard Railway service)

| Name | Value |
|---|---|
| `EXECUTOR_URL` | **Fly** origin only, e.g. `https://j1ms-bot-executor.fly.dev` (no `/health`, not a `*.up.railway.app` URL) |
| `EXECUTOR_TOKEN` | **Exact** same string as Fly `EXECUTOR_TOKEN` (no quotes, no trailing space/newline) |
| `SUPABASE_URL` / service role / etc. | copy from Lovable server secrets as needed |

### Not needed on the dashboard

| Name | Where it belongs |
|---|---|
| `HYPER_API_KEY` | **Fly executor** only (also on Railway **only if** you enable desktop `DESKTOP_HYPER_PROVISION=1`) |
| `PROXY_URL_RESI` | **Fly executor** only |
| `KMART_CARD_*` | **Fly executor** only |

### Optional — desktop app license (Whop-ready, default open)

| Name | Value |
|---|---|
| `DESKTOP_AUTH_MODE` | `open` (default) · `allowlist` · `whop` (stub) |
| `DESKTOP_API_KEYS` | comma-separated keys when mode=`allowlist` |
| `DESKTOP_HYPER_PROVISION` | `1` to allow licensed desktop apps to fetch operator Hyper key |

See `desktop/README.md`.

### Fixing HTTP 401 `unauthorized`

The dashboard reached an executor, but the Bearer token did not match.

1. Confirm `EXECUTOR_URL` is the **Fly** URL (`*.fly.dev`), not Railway.
2. On Fly: `fly secrets list -a j1ms-bot-executor` (or dashboard) — note `EXECUTOR_TOKEN` is set.
3. Paste the **same** token into Railway `EXECUTOR_TOKEN` (re-paste carefully; rotating GitHub without updating Fly leaves Fly on the old value).
4. Redeploy **dashboard** after changing Railway vars (runtime vars apply on next deploy/restart).
5. Quick check from your phone/laptop:
   ```bash
   curl -sS -o /dev/null -w "%{http_code}\n" \
     -X POST "https://YOUR-FLY-APP.fly.dev/akamai/lab" \
     -H "authorization: Bearer YOUR_TOKEN" \
     -H "content-type: application/json" \
     -d '{"url":"https://www.kmart.com.au/"}'
   ```
   Expect `200` (or a lab JSON body), not `401`.

---

## Verify

- `https://<railway-domain>/` → **pair / dashboard UI** (not JSON)
- `/kmart` → Executor diagnose hits **Fly**

If you still see JSON like `{"service":"j1ms-bot-executor"...}`, Root Directory is still `executor` — clear it and redeploy.
