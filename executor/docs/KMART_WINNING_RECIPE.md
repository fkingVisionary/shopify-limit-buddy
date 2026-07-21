# Kmart bible — why it works, how to run it, what not to touch

This is the charge-path contract. If something breaks later, read this before
changing transport, sensors, or GraphQL.

---

## 1. The proof (not theory)

| Field | Value |
|-------|--------|
| **Bank** | Revolut 3DS push (operator confirmed) |
| **When** | 2026-07-21 ~00:30–00:31 UTC |
| **Actions run** | [`29790423175`](https://github.com/fkingVisionary/shopify-limit-buddy/actions/runs/29790423175) |
| **Task** | `smoke-isp-20260721-002925` |
| **Fly tip** | `9a7e895` (undici one-client #81 + smoke YAML #82) |
| **Proxy?** | **YES — ISP pool, not local / not Fly direct** |
| **`proxySource`** | `file:resi.proxies` |
| **`resolveIp`** | `45.42.47.235` |
| **Transport** | `undici` end-to-end (no `sensor_tls_*`, no `api_tls_*`) |
| **SKU / cart** | `43722280` · $20.00 · ATC + address + Paydock tokenize |
| **3DS** | `create_3ds_token` → `charge_3ds_id=f31c879c-…` → Canvas3ds challenge |

**Proxy is required for the live charge class.** The win was `useProxy:true` /
Smoke ISP mode picking a line from `executor/resi.proxies`. Fly datacenter
direct (`89.187.186.9`) SoftBlocks BM often and is **not** the charge recipe.

Lovable never ran a separate Kmart engine — phone UI → Fly `/run` only.

---

## 2. Why it works (the actual mechanism)

Akamai scores **session consistency**: one HTTP client, one egress IP, one
cookie jar, one UA — from homepage warm through GraphQL and Paydock.

### What the successful session does

```
ISP exit (resi.proxies)
  → undici warm_home          (seed bm_* / discover sensor path)
  → Hyper sensors ×≤3         (same undici, stop on _abck ~0~)
  → SBSD home (if script)     (same undici)
  → PDP (+ SBSD pdp if tag)   (same undici)
  → api get-token             (same undici, same jar)
  → GraphQL cart_get / ATC    (same undici — TRUST WALL)
  → checkout address/billing
  → Paydock tokenize
  → create_3ds_token          (Revolut / issuer push)
  → (operator Approve on bank) → Kmart/Paydock complete charge
```

### Why GraphQL clears

`api.kmart.com.au/gateway/graphql` trusts cookies that were minted and used on
the **same client + same IP** as the WWW Bot Manager phase. get-token alone is
not enough — we proved get-token 200 + GraphQL Ghost when JA3 was split.

### Why Revolut fired

`create_3ds_token` + Canvas3ds challenge is a real issuer auth. Bank push =
challenge started. Operator Approve/Reject is on the bank side; reject yields
`chargeAuthReject` in our widget (expected). Approve is assumed to let
Kmart/Paydock finish without further bot magic for a frictionless-enough path.

### Score order of truth

1. **Bank / Revolut push**  
2. Fly `/milestones` (`reached3ds`, stage)  
3. `/run` JSON / smoke artifacts  
4. Never “failedStep after timeout” alone  

---

## 3. Locked knobs (charge path)

| Knob | Value | Why |
|------|--------|-----|
| Engine | Fly `j1ms-bot-executor` | Only real checkout |
| Transport | **undici** whole session | Proven cart + 3DS on ISP |
| `sensorTls` | **OFF** (opt-in only) | See §5 |
| `apiTls` | **OFF** (opt-in only) | See §5 |
| Proxy | `useProxy:true` → `resi.proxies` | Charge class |
| Hyper | ≤3 rounds, stop `ind=0` | Hyper docs |
| Monitor | **off** | Don’t burn ISP |
| Card | secrets or task.card | Needed for 3DS |

`/health` must show a tip that still has these defaults (post-#81).  
If someone turns `sensorTls`/`apiTls` default on again, treat as regression.

---

## 4. How to run it (phone)

1. Deploy executor if tip drifted; check `/health` → `gitSha`, `monitorEnabled:false`.  
2. Actions → **Smoke executor** → Run  
   - `skip_direct`: on  
   - `with_card`: on for bank proof  
3. Open artifact `*.summary.json`  
   - Expect: `proxySource=file:resi.proxies`, `transport=undici`, `resolveIp` set  
   - Ladder through `create_3ds_token`; Revolut may fire  
4. Approve on Revolut to complete; Reject will show widget reject (not a cart bug)

```bash
SMOKE_USE_PROXY=1 ./executor/scripts/fly-probe-once.sh
```

---

## 5. What NOT to do (regressions we already paid for)

| Don’t | What happened |
|-------|----------------|
| Default **tls-worker for sensors** then undici PDP then tls api | get-token 200, **every GraphQL profile Ghost** |
| **Keep** tls for PDP after solve | PDP #1–#3 Access Denied |
| Blame **egress class** when other bots clear same ISP | It was our JA3/cookie split |
| SoftBlock-**poll** Fly direct for hours | Burns time; charge path is ISP undici |
| Treat Lovable as the executor | UI only; Fly runs Kmart |
| Turn monitor on in prod | Burns `resi.proxies` |
| “Fix” GraphQL with more header profiles first | Exhausted; one-client fixed it |
| Delete SoftBlock `_abck` jar protect | Demotes solved cookie |

---

## 6. If it breaks later — triage (in order)

### A. Confirm tip + mode

- `/health` `gitSha` still undici-default tip?  
- Smoke summary: `proxySource=file:resi.proxies`, `transport=undici`?  
- Any `sensor_tls_handoff` / `api_tls_handoff`? → **turn them off**

### B. Where did the ladder die?

| Wall | Likely cause | First move |
|------|----------------|------------|
| `akamai_unsolved` | IP SoftBlock / Hyper / script | One retry other ISP exit; do **not** enable tls by default |
| `pdp_get` Ghost | SBSD / cookie | Ensure SBSD ran; same undici |
| `cart_get` Ghost after get-token | Burnt exit **or** client split / jar break | `/run` auto-rotates pool (see `proxyAttempts`); if **many** exits fail the same way, diff tip vs bible — not one IP |
| `cart_get` Ghost on **many** ISP + sticky exits, tip still undici | Not request-shape / not undici-only JA3 (see below) | Keep undici bible; cool pool / wait — do **not** default tls-worker |
| Dies before tokenize | Profile/address | Check task.profile / fixtures |
| `create_3ds_token` ok, no Revolut | Card/Paydock | Card secrets / gateway |
| Revolut then widget reject | Operator Reject or ACS timeout | Approve promptly; not cart regression |

### GraphQL-moment diff (2026-07-21) — wins vs current Ghosts

Compared charge-path wins (`29790423175`, `29792597295`) vs Ghost fails (ISP rotate + fresh Noontide sticky) at the **exact** `cart_get` call:

| Signal | Win | Ghost fail |
|--------|-----|------------|
| Transport | undici | undici |
| `api_get_token` | 200 + `bm_sv` | 200 + `bm_sv` |
| GraphQL `authorization` | absent (same as slim HAR) | absent |
| `cart_get:hdrs` headerKeys | baseline apollo set | **identical** |
| Cookie names at GraphQL | `_abck` `bm_sv` `ak_bmsc` `bm_sz` … | **identical** (no `ko_token` on either) |
| `_abck` marker | `ind=0` / `~0~` | `ind=0` / `~0~` |
| Step gap token → cart | sensor skipped → cart_get | **identical** |
| Response | JSON 200 (`srv=-`) | AkamaiGHost HTML 403 |

**Conclusion:** nothing app-layer (headers / cookie names / auth / step order) explains the break.

### Lever 4 — all-`chrome_131` tls-worker end-to-end (2026-07-21)

Opt-in only: `transport:"tls-worker"` with `sensorTls`/`apiTls` off so there is **no** undici PDP swap (`sensor_tls_*` steps absent). Bible defaults unchanged.

| Probe | Exit | Result |
|-------|------|--------|
| sticky s15 | `1.41.92.30` | tls-worker kept; `akamai_solved`; **PDP Ghost** (classic keep-tls WWW deny); token later; GraphQL Ghost |
| sticky s10/s20 | — | tunnel EOF before warm |
| ISP `175.29.3.99` | static | tls-worker kept; akamai+PDP+token OK; **GraphQL Ghost** |
| ISP `193.30.101.82` | static | tls-worker kept; akamai+PDP+token OK; **GraphQL Ghost** |

**Conclusion:** switching the whole session to chrome_131 JA3 does **not** clear the GraphQL wall (and often worsens WWW/PDP on sticky). Do **not** change undici defaults. Edge denial is independent of undici-vs-tls at this tip.

### C. Rollback

Redeploy tip **`9a7e895`** or **`56abec1`** (#81 undici defaults).  
Do **not** “fix” with tls park. Re-smoke ISP + card; score bank / milestones.

### D. Compare to known-good

Artifact shape to match: run `29790423175` summary — ISP, undici, ladder through
`create_3ds_token`, `paymentSummary.charge3dsId` set.

---

## 7. Architecture reminder

```
Phone / UI  →  EXECUTOR_URL  →  Fly j1ms-bot-executor (this recipe)
                                      ↓
                               resi.proxies exit
                                      ↓
                          www.kmart.com.au + api.kmart.com.au
                          (one undici dispatcher, one jar)
```

Desktop/Electron later must use **this same tip and knobs** — not a fork with
tls defaults.

---

## 8. Related docs

- `HYPER_HAR_ALIGNMENT.md` — tls-park autopsy + undici proof matrix  
- `KMART_REGRESSION_FORENSICS.md` — older spirals  
- `CHECKOUT_HANDOFF.md` — `/run` task contract  

Phases when ready: ACS polish → Electron on this tip → speed (see prior recipe
freeze). Speed changes must not alter §3 knobs without a new bank proof.
