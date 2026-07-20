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

## What PR #40 changed (minimal)

1. **Jar SoftBlock protect** in `executor/http.js` — refuse `_abck` demotion after `~0~`.
2. **Fly stay warm, monitor off** in `executor/fly.toml` — phone web path without ISP burn.
3. **`gitSha` on `/health`** — bake `GIT_SHA` at deploy so drift is obvious next time.

## Git-cross-reference restores (HTTP sticky, no Playwright)

Cross-reference **all** proven Kmart HTTP lessons — not only proxy wiring:

| Proven source | Restore |
|---|---|
| `7784fab` / `0186ac8` / mriwd1up | GraphQL **baseline-first** (PDP referer + visitor/apollo) when WWW clear — never har_slim-first |
| `a1d9f9c` | Sticky **`api_tunnel_refresh` default ON** before get-token; opt-out `apiTunnelRefresh:false` |
| `a1d9f9c` | get-token referer = **`apiDocReferer`** (not forced homepage) |
| `203950c` | **`pdpHtmlAlreadyOk`** + `pdp_get#2:keep_prior` / `sbsd_pdp:skipped` |
| `aa6352c` | SoftBlock `_abck` jar refuse-demotion (keep) |
| `f3218ef` / `6d0d21a` / `9eadb32` | undici default, XHR Client Hints, ATC homepage-referer retry (keep) |
| `ef84707` | List proxies: `executor/resi.proxies` + `PROXY_RESI_LIST` + `/run` `proxies[]` — not sole `PROXY_URL_RESI` |
| tip `9f9a4da` experiments | **Removed** CORS OPTIONS preflight + sticky home `tokenReferer` + har_slim-first |

Paste Noontide sticky lines into `executor/resi.proxies` (keep issued `session-…-sessTime-…`), redeploy, then `/run` with `useProxy:true`.

## Static ISP handling (19 Jul live)

Bare-IP ISP list (ef84707 shape) must **not** be classified sticky:

| Signal | Bad tip (`stickyUrl=1` on bare IP) | Expected (a1d9) |
|---|---|---|
| Sensors | `rounds=5 sticky=1` → sometimes `akamai_unsolved` | `rounds=3 sticky=0` |
| Before get-token | `api_tunnel_refresh` fires | **no** refresh (warm agent) |
| After GraphQL deny | `cart_get:sticky_sensor_refresh` | skip |
| Soft-API if PDP 403 | gated on sticky only | **d60eeee**: any proxy with abck+bm_sv+sku |

Live on `45.42.47.161` before fix: PDP 200 + get-token 200 + IP hold same=true → all GraphQL profiles Access Denied after `api_tunnel_refresh`.

## GraphQL deny after green get-token (request shape, not proxy blame)

get-token 200 + `/gateway/graphql` AkamaiGHost 403 on the **same jar/IP** means
Akamai scores the GraphQL request differently — not “bad exit.” Tip `#47`
confirmed `__cf_bm` omit + ya29 Bearer do not clear GraphQL; both paths already
shared the soft shopping-agent seed.

### Bug: `6d0d21a` stripped GraphQL cache headers

| Source | `/shopping-agent/v1/get-token` | `/gateway/graphql` |
|---|---|---|
| slim HAR | no `cache-control` / `pragma` | **`cache-control: no-cache` + `pragma: no-cache`** |
| mriwd1up / `7784fab` / `0186ac8` | n/a | **same cache headers** + PDP + visitor + apollo |
| tip after `6d0d21a` | correctly omits | **incorrectly omits** (comment called them hard-reload-only) |

Browser delta after seed: drop `x-visitor-id`, **add** cache headers on GraphQL.
Post-`6d0d21a` tip did the inverse on GraphQL (kept/added visitor+apollo, never
added cache headers). Restore cache headers on **GraphQL profiles only**; keep
get-token without them.

### Also over-corrected by `6d0d21a`: Client Hints on GraphQL

| Source | GraphQL Client Hints |
|---|---|
| slim HAR (real Chrome) | low-entropy trio only |
| mriwd1up / `7784fab` (undici cart_get 200) | **full `CHROME_CH` (high-entropy)** |
| tip after `6d0d21a` | forced `CHROME_CH_XHR` on all api XHRs |

Tip `#48` restored cache headers; `#49` restored full CH on GraphQL + HAR body —
still GraphQL 403 after green get-token. Remaining mriwd delta vs tip:

| Field | mriwd1up / `7784fab` | tip `#49` |
|---|---|---|
| `accept-encoding` on api XHRs | **omitted** | `gzip, deflate, br, zstd` (from `6d0d21a` HAR) |
| get-token Client Hints | **full `CHROME_CH`** | `CHROME_CH_XHR` |

Restore exact mriwd api header construction (no accept-encoding; full CH on
get-token + GraphQL). Do not treat same-jar get-token/GraphQL split as proxy blame.

### Tip `#50`: undici still injects Accept-Encoding; real delta was SBSD skip

Omitting `accept-encoding` from our header object is a no-op — undici `fetch`
always sends `gzip, deflate, br, zstd` unless overridden. Header churn was not
the remaining lever.

Diff vs last `cart_get` 200 artifact (`kmart-resi-run.json`):

| Step | cart_get 200 | tip `#50` ISP fail |
|---|---|---|
| `sbsd_home` | ran | ran |
| `sbsd_pdp` | **ran** (bm_* mint + `pdp_get#2`) | **`sbsd_pdp:skipped`** (`pdpHtmlAlreadyOk`) |
| `api_get_token` | 200 | 200 |
| `cart_get` | JSON 200 | AkamaiGHost 403 |

`203950c` skipped SBSD when PDP HTML was already clear to protect SoftBlock
wipes — but that also skipped PDP SBSD cookie minting. Fix: always `runSbsd`
when the tag is present; keep clear HTML via existing `pdp_get#2:keep_prior`.

### Tip `#51`: SBSD runs again; GraphQL still 403 — header drift vs success artifact

With `sbsd_pdp` restored, tip still denies GraphQL. Diff vs `resi-dry-1`
(`cart_get` JSON 200):

| Field | Success artifact | Tip `#51` |
|---|---|---|
| Client Hints | **low-entropy trio only** | full `CHROME_CH` |
| `accept-encoding` in adapter | present | omitted (undici still injects) |
| `cache-control` / `pragma` | **absent** | present |
| `__cf_bm` on GraphQL Cookie | **present** | omitted (#47) |
| query | minimal ~220b | HAR fragments ~2.4kb |
| `explicitProxy` | false | true |

Realign baseline to the success artifact.

### Tip `#52` made the gap worse (`api_conn_refresh`)

`#52` reset ProxyAgent **after** get-token for every proxied run. That is the
same failure class already documented for mistaken `api_tunnel_refresh` on ISP
(get-token 200 → every GraphQL profile AkamaiGHost). a1d9 only paused after
get-token for **soft-entry**, and only sensor-refreshed on **sticky** deny.

Restore a1d9 get-token→GraphQL gap: no post-seed `resetUndici`, soft-entry sleep
only, sticky-only `cart_get:sticky_sensor_refresh`. Keep SoftBlock jar protect +
always-run `sbsd_pdp` + bare-IP not sticky.

### Tip `#54`: api.* chrome_131 TLS handoff (HTTP-only)

Post-`#53` redeploy (gitSha `5e137f1`): direct + ISP still get-token 200 → every
GraphQL profile AkamaiGHost. Diff vs `resi-dry-1` (`cart_get` JSON 200 ~5h earlier
on the same Fly egress `89.187.186.9`):

| Field | Success artifact | Tip `#53` fail |
|---|---|---|
| GraphQL headerKeys | low-entropy CH + visitor/apollo | **identical** |
| Cookie names on GraphQL | `__cf_bm` + bm_* + visitors | **identical** |
| Path | sbsd_home → sbsd_pdp → get-token → cart_get | **identical** |
| Akamai sensor script | **531365b** | **557069b** |
| SBSD script | **465299b** | **424780b** |

Header/SBSD/conn experiments are exhausted against that artifact. Next lever is
TLS fingerprint on `api.*` (Hyper docs: JA3/JA4 scored before sensor content),
without Playwright: keep WWW+Hyper on undici, hand off to `node-tls-client`
`chrome_131` **before get-token** so api BM seed + GraphQL share Chrome JA3.
Step: `api_tls_handoff`. Opt out: `apiTls: false`. Proxy+TLS can still empty-502
on native crash — handoff eagerly opens the Session and reverts to undici on
thrown errors.
