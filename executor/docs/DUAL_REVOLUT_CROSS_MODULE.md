# Dual Revolut auths — cross-module investigation brief

**Status:** Cross-PSP dual confirmed (GE + BigPay/Adyen) — outside store modules  
**Date:** 2026-08-02  
**Delivery target:** **Bandai only.** Toymate / PKC were research controls to prove the dual is not Bandai-module-specific. Do **not** spend implementation effort fixing Toymate (or other stores) unless explicitly asked — use them only if a shared-layer experiment needs a control.  
**Working rule:** Prefer shared layers over store-specific adapters. Bandai field roulette is **suspect by default** once a shared pay-hop cause is in play.

## Verdict (2026-08-02)

**Not a store-module bug. Not Global-E-only.** Three modules, two issuer stacks, same shape: **1 client PSP POST → 2 Revolut lines** (user-confirmed, same amount, not refund).

| Store | Issuer stack | Client posts | Revolut | Notes |
|---|---|---|---|---|
| Bandai Fast / Autocheckout test | Global-E `HandleCreditCard` | 1 `psp_post` | **2** | Many Bandai field levers failed |
| Pokémon Centre HTTP | Global-E | 1 `psp_post` | **2** | tx `172438100`; same processor name; **not** refund/void |
| Toymate guest HTTP | BigCommerce BigPay / Adyen `scheme` | 1 `psp_post` | **2** | `run_1d56805758fc` ~11:07 AEST; BigPay `422/30106`; `bigpayAuthPosts=1`; CSE skipped |

Desktop orchestration ruled out on these labs (`quantity=1`, 1 enqueue, 1 `/run`, 1 instrumented issuer POST). Soft-retry latch is a separate bug (already fixed) and is **not** today’s shape.

**Ruled out as root:**
- Bandai / PKC / Toymate adapters
- Global-E-only dual-rail (Toymate BigPay duals too)
- BigPay CSE double-post (skipped after decline)
- Desktop orchestration double `/run` / quantity fan-out (`posts=1`, 1 enqueue)
- **Card / bank / Revolut-PAN quirk** — user: same card on the **merchant website manually = 1**; bot = 2; reproduced across **different cards and banks** over the testing history

**Still plausible (shared bot path, outside store modules):**
1. **Shared HTTP pay transport** (`executor/http.js` / undici / TLS / headers / cookie jar) — one intentional issuer POST that PSPs turn into two issuer auths when the request doesn’t look like a browser form navigate.
2. **Shared bot identity in front of the PSP** — sticky proxy / datacenter-vs-home / JA3 / missing browser Client Hints — manual is usually direct home browser; bot is proxy+undici.
3. **Shared card/billing payload shape** built once in desktop→executor (not store-specific fields) that both GE and Adyen treat as “retry/auth twice” server-side while our wire count stays 1.
4. **Uninstrumented second wire** — low probability after GE + BigPay hooks both show `posts=1`.

**Implication:** Stop store-field / GE-hydrate / Toymate-adapter roulette and stop “try another card.”

## Next ladder — **Bandai only** (one fork each)

1. **Browser HAR vs bot GE pay hop (primary)**  
   Manual Bandai Namco AU checkout → DevTools → the **one** `HandleCreditCard` / GE issuer POST. Diff against bot Bandai `psp_post` / Fast path (headers, `sec-fetch-*`, content-type, body keys, cookie count, `pm` / machineId only as parity fields). Align **shared HTTP / Bandai pay request** to browser one delta at a time. Score with Revolut 1 vs 2.

2. **Proxy / home egress on Bandai**  
   Manual = home; bot = proxy. If Bandai can placeOrder direct from this machine, A/B Revolut. Do not derail into Toymate CF/CapSolver work for this fork.

3. **Bandai full-browser issuer (only if HAR inconclusive)**  
   Headed Chrome/Playwright for the GE pay hop on home IP (not Toymate).  
   - Revolut **1** → undici/TLS/proxy presentation.  
   - Revolut **2** → automation/session/pre-pay state.

Research note (do not expand): GE Chromium form-nav already dualed while proxied; Toymate BigPay also dualed with `posts=1` — shared bot path, but **ship the fix on Bandai**.

---

## 1. Symptom (what the human sees)

On checkout with the bot, Revolut shows **two declines / auth attempts of the same amount within seconds**.

On the **same card**, a normal browser checkout (Safari / Chrome / manual) shows **one**.

This has been reported on modules built **before Bandai** and **after Bandai**. That is the primary constraint on root-cause search.

---

## 2. Working hypothesis (priority order)

| Priority | Hypothesis | Why it fits cross-module | Current evidence |
|---|---|---|---|
| **D (primary)** | Global-E / acquirer double-auths from **one** client `HandleCreditCard` | Bandai + PKC share GE; same processor; not refund | **Confirmed** — both stores: `posts=1` + Revolut dual (user) |
| **A** | Shared desktop / executor orchestration fires pay twice (or two `/run`s) | Same for every store | **Ruled out** Bandai + PKC: quantity=1, 1 enqueue, 1 `run_start`, 1 `psp_post` |
| **B** | Shared soft-retry / sticky-rotate re-enters `placeOrder` after wire touch | Same job-runner + latch for all stores | **Fixed separately** (`payment-latch.cjs`). Not today’s shape |
| **C** | Shared HTTP client / retry / proxy tunnel duplicates a mutation | All adapters use `executor/http.js` + undici | **Ruled out** for these labs (`undiciAttempts=1`, `retry:false`) |
| **E** | Store adapter “extra” step arms a second auth (Bandai hydrate, iovation, save, pm id, …) | Bandai-specific | **Rejected as root** — PKC duals without Bandai code path; Bandai levers all failed when bank hit |

**Agent process error to avoid:** treating (E) as primary because Bandai is the only live test bed. Live test bed ≠ root cause location.

---

## 3. Proven facts (Bandai lab bed — still useful as instrumentation)

These are true for Autocheckout / Fast labs on SKU `N2847904001`, task `task_c13e31bb45ce`, card last4 `3083`, mode `autocheckout_test`:

1. **Task quantity = 1** — not desktop “Task quantity” fan-out.
2. **Forensics:** typically **1** `run_start` + **1** `psp_post_start` while Revolut shows **2**.
3. **`chargeReqCount` / `undiciAttempts` = 1** on bank-hitting declines.
4. **Stop before issuer** (`BANDAI_GE_TEST_STOP_BEFORE_ISSUER=1`): hydrate + save + CreditCardForm, **no** HandleCreditCard → **no Revolut activity** (user confirmed; last bank was prior run ~08:54).
5. Therefore: hydrate alone does not charge; **one** intentional issuer POST is enough to produce **two** bank lines (on Bandai/GE).
6. Browser Chromium HAR (force CreditCardForm submit): **exactly 1** HandleCreditCard on the wire. Forced submit on a stale cart returned DataCorruption / TxnId=0 (no bank) — so we have network parity proof, not yet a Revolut-confirmed browser single in the same session.

### Recent Bandai GE txs (all dual when bank hit, per user)

| Time (AEST ~) | Lever | GE tx | Body | Revolut |
|---|---|---|---|---|
| ~08:54 | pay-guid rebind | `172432955` | ~2574 | dual |
| ~09:14 | skip handleaction 2/3 | `172434407` | ~2573 | dual |
| ~09:40 | `paymentMethodId=2` | `172436112` | ~2573 | dual |
| ~09:50 | `pm=2` + empty `machineId` | `172436586` | **1061** | dual |

---

## 4. Bandai-specific levers tried (treat as failed / low priority)

All on `bandai-ge-http-test.js` / Autocheckout test unless noted. Production Fast (`bandai-ge-http.js`) left untouched for experiments.

| Lever | Result |
|---|---|
| Per-run payment latch (desktop, cross-store) | Stops retry re-entry; **not** today’s posts=1 dual |
| Mute GEM + blank Checkout before unmute | iframe dual-rail mitigation; dual remained on undici path |
| `createTransaction=false` probe | Did not solve |
| Empty issuer `machineId` alone | Bank + dual |
| Slim cookies + navigate `sec-fetch-*` on undici | Bank + dual |
| Chromium form-nav issuer (not undici) | Bank + dual |
| Pay-guid rebind after risk hydrate | Bank + dual |
| Stop before issuer | **No bank** (control) |
| Skip all hydrate mutations (no handleaction/save) | DataCorruption / no bank |
| Skip save only | DataCorruption / no bank |
| Skip all handleaction | Save fails (no shipping) / no issuer |
| Skip handleaction 2/3 only | Bank + dual |
| Force `paymentMethodId=2` (browser form) | Bank + dual |
| `pm=2` + empty `machineId` (browser body ~1064) | Bank + dual |

**Conclusion for Bandai knobs:** matching browser issuer body shape did not stop dual. Continuing to tweak Bandai hydrate / issuer fields is **unlikely** if the same dual appears on non-GE modules.

---

## 5. Shared architecture (where to look next)

```text
Desktop Start
  → job-runner (quantity N jobs; outer retries; sticky rotate)
    → payment-latch (per-run only — after wire touch, no retry)
      → executor-sidecar POST /run
        → executor/server.js (no idempotency lock on taskId)
          → checkout.js → store adapter
            → executor/http.js (undici / jar / proxy)
              → store PSP (GE / Paydock / BigPay / …)
                → Revolut
```

### Shared files that touch every (or most) pay paths

| Layer | Path | Role |
|---|---|---|
| Desktop fan-out | `desktop/main.cjs` (`task.quantity`) | N jobs per Start |
| Queue / retries | `desktop/job-runner.cjs` | Outer retry, sticky rotate |
| Pay latch | `desktop/payment-latch.cjs` | Stop retry after posts≥1 (**per run only**) |
| Sidecar | `desktop/executor-sidecar.cjs` | `POST /run` |
| Executor entry | `executor/server.js` | Inflight cap only; no pay idempotency |
| Transport | `executor/http.js` | Shared undici + jar |
| Forensics | `executor/pay-forensics.js` | `run_start` / `run_end`; `psp_post_*` mostly Bandai-wired today |

### Store PSPs (different rails — same bank UX)

| Module | Payment rail | Note |
|---|---|---|
| Bandai | Global-E `HandleCreditCardRequestV2` | Live lab bed |
| Pokémon Centre | Global-E (same family) | Same rail as Bandai — **poor control** |
| Disney | Global-E | Benched |
| Toymate | BigCommerce BigPay / Adyen | Benched; needs 2captcha; had CSE double (fixed) |
| Kmart | Paydock + 3DS `/process` then charge | Benched; process#1+#2 is intentional 3DS |

---

## 6. Context clues (do not ignore)

1. **User observation:** dual on modules **before and after** Bandai → search shared desktop/executor/PSP patterns, not Bandai hydrate.
2. **Lab constraint:** Kmart / Disney / Toymate currently benched; PKC ≈ GE → Bandai is the only easy live bed, which **biases agents into Bandai diffs**. That bias is a process bug.
3. **Forensics gap:** `psp_post_*` is largely Bandai-instrumented. Other modules do not emit the same issuer POST rows → hard to prove `posts=1` cross-store without new shared instrumentation.
4. **Two different dual bugs already existed:**
   - Retry / RESPONSE_LOST re-entry → fixed by payment latch (cross-store).
   - Toymate CSE fallback on 422 → second auth (store-specific, fixed).
   - Today’s Bandai case is a **third shape**: one client POST, two Revolut lines.
5. **GE bible / PKC docs** already normalize “Revolut two lines, posts=1” as possible GE dual-rail. If pre-GE modules truly dual with one client mutation, that GE-only story is incomplete.
6. **Latch scope is intentional:** no profile/card global lock (10× same profile must still pay in parallel). Dual from two concurrent jobs would look like “cross-module” if users Start multiple tasks — but Bandai labs used quantity=1 and one `run_start`.

---

## 7. Detection plan (shared-first)

Stop Bandai issuer body roulette until shared detection is in place.

### Step 1 — Universal pay forensics — **DONE (2026-08-02)**

Helper: `pspPostForensics()` in `executor/pay-forensics.js`.

| Store | Instrumented mutation | File |
|---|---|---|
| Bandai | `HandleCreditCard` (already) | `bandai-ge-http.js` / test fork |
| Pokémon Centre | `HandleCreditCard` | `pokemoncentre-ge-http.js` |
| Disney | `HandleCreditCard` | `disney-ge-http.js` |
| Toymate | BigPay + CSE fallback | `toymate-adyen.js` |
| Kmart | Paydock `/process` + `chargePayDockWithToken` | `kmart.js` |

Classifier: `node executor/scripts/classify-pay-forensics.mjs [path.jsonl]`  
→ `two_runs` | `two_psp_posts` | `one_post_two_bank_suspect` | `no_psp`

### Step 2 — Desktop Start audit — **DONE**

`desktop/pay-forensics-audit.cjs` + `job-runner.enqueue` emits:

- `desktop_enqueue_batch` (jobCount, taskIds, quantities)
- `desktop_enqueue_job` (taskId, store, quantity, profileId, cardLast4)

Same JSONL as executor (`PAY_FORENSICS_PATH` or `%TEMP%\j1m-pay-forensics.jsonl`).

### Step 3 — Live non-Bandai smokes (in progress)

| Store | Feasible now? | Notes |
|---|---|---|
| **PKC** | **Dual confirmed (user)** | Hyper + PDP `72-10917-101`. 1 enqueue / 1 `run_start` / 1 `psp_post` (body 2581), GE tx **`172438100`**, class `one_post_two_bank_suspect`. Revolut: **2** same amount, same processor, **not** refund. |
| **Toymate** | **Blocked on proxy↔CapSolver** (2026-08-02) | CapSolver key OK (balance ~$9.7). Only proxy group `royal` (ISP). CapSolver `AntiCloudflareTask` → **`custom proxy connect failed`** on every probed exit; local Chromium also stuck on “Just a moment…”. Need CapSolver-reachable sticky/resi proxies (or whitelist CapSolver IPs on the proxy provider). Hooks ready on BigPay. |
| Kmart / Disney | Benched | Hooks compile only; no product fix work in this PR. |

### Step 4 — Classify then act

| Class | Signature | Likely layer |
|---|---|---|
| Two `run_start` within seconds, same card | Orchestration / quantity / double Start | Desktop |
| One `run_start`, two `psp_post_*` | Adapter retry / fallback / 3DS ladder | Adapter or shared http |
| One `run_start`, one `psp_post_*`, two Revolut | PSP / acquirer dual-rail | Outside our second POST |

- If class = orchestration → fix job-runner / quantity UX / duplicate Start (shared).
- If class = two PSP posts → find shared retry or per-store fallback; fix at that layer.
- If class = one PSP post, two Revolut on **multiple PSPs** → escalate as acquirer/PSP behavior; stop burning Revolut on Bandai form-field A/B tests.
- If class = one PSP post, two Revolut **only on GE stores** → then GE dual-rail is the shared root for Bandai/PKC/Disney.

---

## 8. What not to do (until Step 1–3)

- More Bandai-only issuer field A/B (`pm`, `machineId`, cookies, hydrate skips, guid rebind) as the main strategy.
- “Fix” benched Kmart/Disney/Toymate product paths just to chase duals (unless needed for a single forensics smoke).
- Treat PKC as an independent control (same Global-E family).
- Assume payment latch “solved dual” — it solved retry duals only.

---

## 9. Lab profile / artifacts (reference)

- Task: `task_c13e31bb45ce` · Profile: `prof_4c10061c8213` · SKU: `N2847904001`
- Mode: `bandaiCheckoutMode=autocheckout_test` → `executor/adapters/bandai-ge-http-test.js`
- Forensics: `%TEMP%\j1m-pay-forensics*.jsonl` or `PAY_FORENSICS_PATH`
- Browser HARs: `artifacts/bandai-chrome-browser.har`, `artifacts/bandai-ccform-force-submit.har`
- Diff tool: `node executor/scripts/bandai-issuer-har-diff.mjs --har …`
- PR lab branch: `cursor/macro-double-charge-latch-c402` (#150)

---

## 10. One-sentence brief for the next agent

**Cross-PSP dual is proven (GE + BigPay research). Ship the fix on Bandai only: browser HAR vs bot `HandleCreditCard` / shared HTTP pay hop — not more Bandai field roulette and not Toymate product work.**
