# Dual Revolut auths — cross-module investigation brief

**Status:** open  
**Date:** 2026-08-02  
**Working rule:** Prefer shared layers over store-specific adapters. Bandai-only edits are **suspect by default** unless a shared control is proven missing there.

---

## 1. Symptom (what the human sees)

On checkout with the bot, Revolut shows **two declines / auth attempts of the same amount within seconds**.

On the **same card**, a normal browser checkout (Safari / Chrome / manual) shows **one**.

This has been reported on modules built **before Bandai** and **after Bandai**. That is the primary constraint on root-cause search.

---

## 2. Working hypothesis (priority order)

| Priority | Hypothesis | Why it fits cross-module | Current evidence |
|---|---|---|---|
| **A** | Shared desktop / executor orchestration fires pay twice (or two `/run`s) | Same for every store | **Ruled out for Bandai labs** with quantity=1, forensics `run_start=1`, `psp_post=1` |
| **B** | Shared soft-retry / sticky-rotate re-enters `placeOrder` after wire touch | Same job-runner + latch for all stores | **Partially fixed** (`desktop/payment-latch.cjs`, commit `5e214c3`). Explains RESPONSE_LOST doubles; does **not** explain today’s `posts=1` dual |
| **C** | Shared HTTP client / retry / proxy tunnel duplicates a mutation | All adapters use `executor/http.js` + undici | Mutations default `retry:false` on issuer paths we checked; still dual with `undiciAttempts=1` |
| **D** | Issuer / PSP side double-auths from **one** client POST (GE dual-rail, Adyen, Paydock 3DS ladder, etc.) | Different PSPs, similar bank UX | GE docs already say `posts=1` can still pair; Toymate had CSE fallback double (fixed); Kmart has intentional 3DS process×2 |
| **E** | Store adapter “extra” step arms a second auth (Bandai hydrate, iovation, save, pm id, …) | Bandai-specific — **weak** if pre-Bandai modules dual the same way | Many Bandai levers tried; **none** stopped dual when bank hit |

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
| **PKC** | **Bank hit 2026-08-02 ~10:18 AEST** | Hyper via env + PDP `72-10917-101`. Forensics: 1 enqueue job, 1 `run_start`, 1 `psp_post` (body 2581), `bankSignal=true`, GE tx **`172438100`**, class **`one_post_two_bank_suspect`**. **Need Revolut 1 vs 2.** Same Global-E family as Bandai (not an independent PSP control). |
| **Toymate** | Likely blocked | Guest checkout may work if already registered; **account_gen / CF** needs CapSolver / 2captcha credits (not in env). Do not burn time on gen until captcha is wired. Hooks ready on BigPay. |
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

**Dual Revolut with `posts=1` is confirmed on Bandai; user reports the same across modules before/after Bandai — so instrument shared forensics and classify duals (2 runs vs 2 PSP posts vs 1 post/2 bank) before any further Bandai-specific payment-field experiments.**
