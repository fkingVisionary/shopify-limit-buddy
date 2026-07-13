# Deploy the dashboard to Railway (control plane)

The **dashboard** (TanStack Start UI) and the **executor** (checkout Node service) are separate.

| Piece | Host | Root Directory |
|---|---|---|
| Dashboard / UI | **Railway** (this guide) | repo root `/` |
| Executor | **Fly.io** (existing) | `executor/` |

Do **not** point the Railway dashboard service at `executor/` — that is what caused the `/app/dist` failure and the blank API-only site.

## 1. Railway service settings

1. New Railway service → Deploy from this GitHub repo (or retarget the existing one).
2. **Root Directory:** leave blank / `/` (repo root).
3. **Builder:** Dockerfile (uses root `Dockerfile` + `railway.toml`).
4. Generate a public domain (Networking). Leave target port default — Nitro binds `PORT`.

## 2. Variables

### Build-time (mark “Available at Build Time” in Railway)

Vite bakes these into the client bundle:

| Name | From Lovable |
|---|---|
| `VITE_SUPABASE_URL` | same as Lovable |
| `VITE_SUPABASE_PUBLISHABLE_KEY` | same as Lovable |
| `VITE_SUPABASE_PROJECT_ID` | same as Lovable |

### Runtime

| Name | Value |
|---|---|
| `EXECUTOR_URL` | your Fly executor origin, e.g. `https://j1ms-bot-executor.fly.dev` |
| `EXECUTOR_TOKEN` | same shared secret as Fly |
| `SUPABASE_URL` / service keys | whatever server fns already use (see Lovable secrets) |
| `NITRO_PRESET` | optional; Dockerfile already sets `node-server` at build |

Copy any other server secrets you use today on Lovable (`KMART_CARD_*` is on the **executor**, not required here unless the dashboard injects cards).

## 3. Verify

After deploy:

1. Open `https://<railway-domain>/` — you should see the **pair / dashboard UI**, not JSON.
2. Pair a device, open `/kmart`.
3. **Executor diagnose** should hit Fly (`EXECUTOR_URL`).

Local check:

```bash
NITRO_PRESET=node-server npm run build
npm start   # serves .output/server/index.mjs
```

## 4. Cut over from Lovable

1. Confirm Railway UI works against Fly executor.
2. Point any bookmarks / Discord links at the Railway domain.
3. Keep Lovable as a backup until you’re happy, then stop using it for day-to-day.
