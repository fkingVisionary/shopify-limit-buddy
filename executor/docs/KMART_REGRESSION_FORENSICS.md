# Kmart regression forensics — Jul 14 → Jul 19

## Bank-statement anchor

- **Last fully successful charged checkout:** 14 Jul ~10:03 (operator bank statement).
- At that wall-clock, tip was still the **web dashboard → Fly** / pre-desktop lane
  (Paydock Canvas3ds / PR #26–#27 era). Desktop app landed later the same afternoon
  (PR #31 ~15:17 AEST).

## The large tip: `a1d9f9c` (“Electron Update”, 15 Jul 18:52 AEST)

| | |
|---|---|
| SHA | `a1d9f9c957965fb96b4f271aef4792dfa756248e` |
| Parent | `3468a48` (desktop logs + Akamai WWW 403 retry notes) |
| Size | ~+1568 / −277 across desktop sidecar + `kmart.js` / `kmart-playwright.js` / `http.js` / `ip-resolve.js` |
| Intent | Sticky ISP ProxyAgent, homepage sensors, `skipCategory`, SBSD follow_get — desktop local executor |

`origin/main` was later **force-reset** to this tip (Phase 0). Soft file restores of
`kmart.js` alone had already failed (PR #37) because sidecar / surrounding tip files
also mattered.

## Six-day spiral (lessons, do not re-run blindly)

| Era | What happened | Lesson |
|---|---|---|
| PR #10–#13 | GraphQL header / ATC experiments → 403s | Pin **mriwd1up** cart baseline (PDP referer + visitor/apollo) |
| PR #11 | TLS auto-force + proxy → empty 502s | Stay **undici** for HTTP lane; TLS opt-in only |
| PR #17 | `operationName` ≠ document name | Keep mutation name aligned (`updateMyBag`) |
| `a1d9f9c` | Huge sticky/desktop rewrite | Treat as tip; do **not** soft-replace single files |
| `741b107`–`ef84707` | Monitor + stock probe co-located on Fly | **Deploy drift**: Fly last shipped `ef84707` with `MONITOR_ENABLE=1` burning ISP every ~4s |
| PR #35–#36 | Roll to PR #32 undici, SoftBlock research, hard-reset | Rolling to PR #32 **undoes** Electron Update |
| `203950c` | SoftBlock Set-Cookie demotes solved `_abck` | **Keep jar refuse-demotion** (name-keyed jar clobber) |
| PR #37–#38 | Restore a1d9 files + verbose logs | Tip already had `kmart.js`; still red → env or Fly mismatch |
| Hard reset | `main` → `a1d9f9c` | Prove on sticky AU ISP; no new adapters until green |

## Deploy drift (active today)

```
git  origin/main  = a1d9f9c  (Electron Update, no monitor)
Fly  live health  = monitorEnabled:true  (image from ef84707 “proxies”, 17 Jul)
```

Desktop after `git reset --hard origin/main` runs **a1d9**.  
Lovable / phone web dashboard still calls **Fly**, which is **not** a1d9.

That alone can make “web worked originally, desktop broken / rollbacks failed”
look like a pure code mystery.

## Cloudflare / Lovable path (phone testing)

Architecture (from `CHECKOUT_HANDOFF.md` + `checkout-jobs.functions.ts`):

```
Lovable UI (Cloudflare Workers / Nitro)  →  EXECUTOR_URL
        https://shopify-limit-buddy.lovable.app
                    │
                    ▼
        Fly Node executor  POST /run
        https://j1ms-bot-executor.fly.dev
```

Supabase `run-checkout` edge is the **older Browserless/Shopify** job worker
(CF Worker 30s limit → Deno enqueue). Kmart HTTP+Hyper uses **Fly**, not that edge.

### Phone checklist (after this PR is deployed)

1. GitHub app → **Actions → Deploy executor → Run workflow** on this branch (or `main` after merge).
2. Confirm `https://j1ms-bot-executor.fly.dev/health` shows:
   - `"gitSha":"<this tip>"`
   - `"monitorEnabled":false`
3. Open `https://shopify-limit-buddy.lovable.app` → pair → **Kmart**.
4. **Executor diagnose** with the same sticky AU ISP string desktop used.
5. Dry-run one PDP URL (`kmartMode=current`, undici). Expect `akamai_solved` + PDP 200 before blaming ATC.

If diagnose fails CONNECT / `proxy_egress same=true` → fix proxy, not adapter.
If Fly `gitSha` still missing or `monitorEnabled:true` → deploy did not land.

## What this PR changes (minimal)

1. **Jar SoftBlock protect** in `executor/http.js` — refuse `_abck` demotion after `~0~`.
2. **Fly stay warm, monitor off** in `executor/fly.toml` — phone web path without ISP burn.
3. **`gitSha` on `/health`** — bake `GIT_SHA` at deploy so drift is obvious next time.
