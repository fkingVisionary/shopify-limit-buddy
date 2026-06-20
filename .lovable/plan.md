
## Goal

Stop hardcoding any proxy at the executor or in code. For testing, store the proxy pool in the existing `proxy_groups` table and have `/api/public/exec-test` pick one at random per call. Keep Fly's `PROXY_URL_RESI` as a last-resort fallback so nothing breaks mid-transition.

## Why reuse `proxy_groups`

The table already exists with `workspace_id`, `name`, `proxies text[]`. The eventual "proxy group attached to a task" flow will read from this same table, so the testing path and the production path stay on one schema — no throwaway work.

## Changes

### 1. Seed a test proxy group (migration)

Insert one `proxy_groups` row named `Test Pool` containing the 10 `residential.wealthproxies.com:3128:...` lines. Workspace: the existing single workspace in `workspaces` (if multiple exist, I'll ask before seeding).

Format stored in `proxies[]`: keep the raw `host:port:user:pass` lines exactly as provided. A small `toProxyUrl()` helper converts each to `http://user:pass@host:port` at request time.

### 2. `src/routes/api/public/exec-test.ts`

- Accept new optional body fields:
  - `proxyGroupId?: string` — pick random from this group
  - `proxyGroupName?: string` — pick random from group with this name (default: `"Test Pool"`)
  - `proxyUrl?: string` — explicit override, wins over group
- Resolution order per call:
  1. `proxyUrl` (explicit) → use it
  2. Look up group → pick random proxy from `proxies[]`, convert to URL
  3. If group empty/missing → omit proxy from payload (executor falls back to its env)
- Use `supabaseAdmin` server-side to read `proxy_groups` (read is server-only, no client exposure).
- Echo the chosen proxy's host + session tag (last segment after `-S`) in the response under `proxyUsed` so we can see which one ran without leaking creds.

### 3. `executor/server.js` + `executor/adapters/kmart.js`

Already accept `proxyUrl` per request. No behavior change needed beyond confirming that when `proxyUrl` is absent, the executor still falls back to `process.env.PROXY_URL_RESI`. (Current code already does — keeping as fallback per your choice.)

### 4. No Fly redeploy required

All swapping happens by editing the `Test Pool` row in the DB (or passing `proxyUrl` directly). `PROXY_URL_RESI` on Fly is untouched.

## Out of scope (for the eventual main flow)

- Wiring `proxy_groups` to `tasks` (task → group → random proxy per checkout).
- UI to manage proxy groups.
- Health/burn tracking per proxy.

Those land when we move past testing.

## Confirmation needed before I build

1. There's one workspace, right? If multiple, which `workspace_id` should own `Test Pool`?
2. Confirm the proxy line format — `host:port:user:pass` where `pass` contains `-Sxxxx-akamai-AU` as the sticky session tag (so user=`j1mcollects`, pass=`cz2M462wInWnVvq3-Sacfd102e5e0-akamai-AU`). Correct?
