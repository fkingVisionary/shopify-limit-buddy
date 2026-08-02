# Dual Revolut — investigation bible (handoff)

**Updated:** 2026-08-03  
**PR / branch:** `#150` · `cursor/macro-double-charge-latch-c402`  
**Product to fix:** Bandai checkout (desktop → executor). Other stores = research evidence only.

### VERDICT (updated 2026-08-03 ~04:31 AEST) — PARTIAL

**Toymate:** issuer chrome_131 tls-worker → Revolut×1 (`run_20651586e4b2`).

**Bandai Fast still duals** after full GE tls-worker stack + `ct=false`:
| Field | tx `172528639` @04:25 AEST · last4 `1964` |
|---|---|
| Wire | ha×3+save+issuer **tls-worker** · posts=1 · `ct=false` · fraud=false |
| GE | `sameCart=False` · via=`http-ge-issuer` |
| **Revolut** | **×2** (user 2026-08-03) |

Client forensics: one `HandleCreditCard`. Dual ≠ second app POST.
**Active A/B:** restore **throwaway-cart iovation** (proven single Revolut 2026-07-22 07:24) — stop Playwright `goto` of the **live** pay Checkout/v2 (liveHtml riskHydrate correlated with `sameCart=False`).

---

## 0. Prompt for the next agent (copy-paste)

```text
You are taking over a dual-Revolut investigation on shopify-limit-buddy / J1m's Bot.

READ FIRST: executor/docs/DUAL_REVOLUT_CROSS_MODULE.md (this file). Treat §1–§3 as locked.

LOCKED FACTS — do not re-argue:
- Bot path: 1 instrumented client PSP POST → 2 Revolut lines (same amount, not refund).
- Manual browser on the same merchant sites with the same card: 1 Revolut line.
- Reproduced on Bandai (Global-E), PKC (Global-E), and Toymate (BigPay/Adyen).
- Reproduced across different cards/banks on the bot.
- Direct / no-proxy has ALREADY been tested historically and still dualed — do not burn another direct Bandai bank hit “to check proxy” unless you have a new transport theory.
- Desktop orchestration ruled out on labs: quantity=1, 1 enqueue, 1 run_start, 1 psp_post.
- Soft-retry latch (desktop/payment-latch.cjs) fixed a DIFFERENT dual (RESPONSE_LOST re-entry). Not today’s shape.
- Bandai HandleCreditCard / hydrate / pm / machineId / cookie field roulette FAILED when bank hit. Do not resume it.
- Do NOT implement Toymate/Kmart/Disney product fixes. Toymate/PKC were research controls only.
- Delivery: Bandai must stop dualing. Code changes should be in SHARED layers unless you prove a Bandai-only cause that somehow also explains Toymate (you won’t via GE fields).

PARTIAL FIX (keep; do not revert without wire proof):
- Shared issuer POST via undici → Revolut×2. Issuer via chrome_131 tls-worker → Revolut×1 on **Toymate** @14:54.
- Keep `PAY_ISSUER_TLS_WORKER` default ON. Do not “simplify” back to undici issuer.
- **Bandai Fast counterexample:** issuer/prepay/GE-all tls-worker + ct=false still ×2 (`172528639`). Not fixed for GE yet.
- Keep pay TLS knobs ON. Active A/B: **throwaway iovation** (no Playwright on live pay Checkout/v2).

FORBIDDEN:
- Reverting issuer tls-worker without a new Revolut×2 wire proof on Toymate/Bandai.
- Using Playwright / page-issuer as the Fast dual fix.
- Bandai GE field / form-nav / settle / mute ceremony churn.
- Claiming payment-latch or GE-all-tls solved Bandai dual.
- Re-enabling liveHtml Checkout/v2 iovation without `BANDAI_GE_ALLOW_LIVE_CART_IOVATION=1`.

Lab Bandai confirm: task_c13e31bb45ce, mode **Fast**. Forensics: PAY_FORENSICS_PATH or %TEMP%\j1m-pay-forensics.jsonl.
```

---

## 1. One-paragraph verdict

The bot causes **two Revolut auth/decline lines for one checkout attempt**. A normal browser checkout on the **same site with the same card** causes **one**. This is **not** a Bandai-module bug, **not** Global-E-only, and **not** “the card.” It is a **shared bot-path** effect: forensics show **one** client pay POST while Revolut shows **two**, on **Global-E (Bandai, PKC)** and **BigPay/Adyen (Toymate)**. Fix/measure on **Bandai**; change **shared** infrastructure.

---

## 2. Locked evidence table

| Case | Stack | Client posts | Revolut | Notes |
|---|---|---|---|---|
| Manual browser | Real Chrome/Safari | (browser) | **1** | Same merchants, same cards |
| Bandai bot | Global-E | **1** `psp_post` | **2** | Many GE field levers failed |
| Bandai stock Fast @13:17 | Global-E page issuer | **1** | **2** | tx `172447213` — off Fast product path (Playwright pay) |
| Bandai @13:39 CH A/B | Global-E page issuer | **1** | **2** | tx `172448160` — headers still ×2; Playwright pay |
| PKC bot | Global-E | **1** `psp_post` | **2** | tx `172438100`; not refund |
| Toymate bot | BigPay / Adyen | **1** `psp_post` | **2** | `run_1d56805758fc` ~11:07 AEST 2026-08-02; `422/30106`; CSE skipped after decline |
| Bot, other cards/banks | various | (same shape) | **2** | User history |
| Bot direct / no proxy | various | (tested before) | **2** | **Already done — do not rediscover** |
| Toymate + issuer tls-worker @14:54 | BigPay / shared `http.js` | **1** | **1** | `run_20651586e4b2` · `payTransport=tls-worker` · **FIX PROOF** |

Orchestration labs: `quantity=1`, one `desktop_enqueue_*`, one `run_start`, one `psp_post_*`.

---

## 3. Ruled out (do not reopen without new wire proof)

| Claim | Why dead |
|---|---|
| Bandai adapter / hydrate / `pm` / `machineId` / issuer body shape | Failed when bank hit; PKC duals without Bandai code; browser-like body still dualed |
| Global-E-only dual-rail as the whole story | Toymate BigPay also duals with `posts=1` |
| **`IsTheSameCartToken` / GE JWT cart flags** | GE response field only; Toymate has no such field and still duals. User correction 2026-08-02. |
| Desktop card packaging (duplicate PAN/CVV/token) | Audited clean: one card object on `/run`; latch cannot create posts=1×2 |
| Fat Chromium form-nav + post-issuer settle | tx `172443438` / `172443854` still Revolut×2 with `posts=1` |
| Form-nav settle=0 (`postGeMut=0`) | tx `172445269` @12:39 — user confirmed Revolut×2 |
| Two `/run`s or quantity fan-out | Forensics: one run, one post |
| Soft-retry / RESPONSE_LOST double placeOrder | Fixed by `desktop/payment-latch.cjs`; different shape (`posts≥2` or re-entry) |
| Toymate CSE second BigPay after decline | Fixed (CSE skipped on 422); Toymate dual still happened with one BigPay POST |
| “It’s the Revolut card” | Manual same card = 1; other cards on bot = 2 |
| “Just try direct / no proxy” as a fresh idea | User: already tested, still 2 |
| Undici-TLS-only | Real Chromium document form-nav still dualed |

---

## 4. What is still open (shared bot stack)

Something about **how the bot presents the single pay attempt** makes issuers/acquirers record **two** bank lines, while a real browser’s single attempt records **one**. User timing: the two Revolut lines arrive **together / within seconds** → looks like one merchant request fanning out to two issuer messages, not a slow client retry.

### Leading hypothesis (revised after 12:39 confirm)

**Not** “missing document form-nav / settle / post-issuer GE mutates.” User confirmed settle=0 form-nav tx `172445269` @12:39 was still **Revolut×2** with `postGeMut=0`. Headed Chromium form-nav also dualed. So the dual survives a real browser document POST of HandleCreditCard.

### Active chase — three angles (2026-08-02)

| Angle | Question | Instrumentation / test |
|---|---|---|
| **A — PSP fan-out** | Does one accepted pay POST yield one `transactionId` / redirect while Revolut still shows 2? | `psp_post_end` now logs `transactionId`, `redirectHost`, `statusType`, `locationLooksAcs` (page + undici + Toymate/PKC). |
| **B — Shared pre-pay** | What pay-host mutates happen *before* the charge on undici? | `http.js` always audits GE/BigPay mutates with `stage=prepay\|issuer` + `http_mutate_response` (status/Location). |
| **C — Stock Fast scoreboard** | Score product Fast **undici** (`via=http-ge-issuer`). Playwright pay = Safe only. | Classifier `stockFast` = `http-ge-issuer`. |

**How to test (desktop):**
1. Task `bandaiCheckoutMode=fast` (default). Do **not** use Autocheckout test or Safe/Playwright pay.
2. One placeOrder run → confirm `via=http-ge-issuer` (undici), not `page-ge-issuer`.
3. `node executor/scripts/score-stock-fast-angles.mjs` (or `classify-pay-forensics.mjs`).
4. User: Revolut **1 or 2** for the printed `transactionId`.

### Product lock (2026-08-02 ~13:54) — Fast ≠ Playwright

User correction:
- **Fast: hard no Playwright pay** (speed / CPU). Playwright checkout fingerprinting = **Safe mode only**.
- Dual is confirmed on shared paths (Bandai + Toymate); Playwright does **not** live in that shared surface — do not chase Playwright stealth/page-issuer as the fix.
- Restored product Fast → **undici issuer** (`via=http-ge-issuer`). Page issuer is Safe/opt-in only.

### Page-issuer labs (evidence only — off Fast product path)

| Time | tx | Notes |
|---|---|---|
| 13:17 | `172447213` | page-ge-issuer, posts=1, Revolut×2 |
| 13:39 | `172448160` | CH+Sec-Fetch+Win UA on page issuer, posts=1, Revolut×2 |

Header cosmetics on Playwright pay do not fix the dual and were the wrong Fast workshop.

### Shared undici presentation still shipped (valid for Fast + Toymate)

In `executor/http.js` (applies to Bandai Fast undici pay + Toymate BigPay):
- Platform-matched Chrome 131 UA on win32
- `chromeClientHints()` when omitted (`PAY_CHROME_CH=0` to opt out)
- `chromePayFetchHeaders()` for pay-host mutates incl. handleaction/save

### Kmart clue (user 2026-08-02) — shared executor, not post-Kmart modules

- When Kmart worked: charges were **single-firing**. Dual shows on modules built **after** Kmart.
- Kmart cart used undici; **bank** hop was Paydock Canvas3ds (Playwright Chromium TLS) — not undici PAN→PSP.
- Bandai Fast / PKC / Toymate BigPay charge the bank through **shared `executor/http.js` undici** — the post-Kmart shared path. Matches “old Fly / shared executor layer” suspicion.
- Do **not** resurrect Kmart product work; use the clue to justify shared TLS A/Bs only.

### Active A/B — payHost tls-worker (global `http.js`)

| Knob | Default | Meaning |
|---|---|---|
| `PAY_ISSUER_TLS_WORKER` | ON (`=0` off) | Issuer-stage POST/PUT/PATCH/DELETE → chrome_131 tls-worker |
| `PAY_PAYHOST_TLS_WORKER` | ON (`=0` off) | GE/BigPay **prepay** mutates → chrome_131 (Bandai dual A/B after 16:44) |
| `PAY_ISSUER_FRESH_UNDICI` | OFF (`=1` on) | Recreate ProxyAgent before issuer undici POST (test alone with tls-worker off) |

Forensics: `http_mutate_response.payTransport` = `tls-worker` \| `undici` \| `undici-fallback` on prepay **and** issuer.

**PayHost tls wire (2026-08-02 ~17:40 AEST):** tx `172460612` / `run_27ef1bff8056` — handleaction×3 + save + HandleCreditCard all `payTransport=tls-worker`, posts=1, `possibleFraudDetected=false`, `createTransaction=true`. Revolut score was entangled with later card misreads — **re-score on fresh disposable**.

**GE-all-tls + ct=false FAIL (locked):** tx `172528639` @04:25 — Revolut **×2** (user). posts=1, fraud=false, `sameCart=False`. TLS-stack + ct knobs insufficient for Bandai.

**Active A/B:** throwaway CartToken iovation mint (never Playwright-open pay guid). Keep `PAY_GE_TLS_WORKER` ON. Opt into liveHtml only via `BANDAI_GE_ALLOW_LIVE_CART_IOVATION=1`.

### Lab 2026-08-02 ~14:54 AEST — Toymate WIN (issuer tls-worker)

| Field | Value |
|---|---|
| Run | `run_20651586e4b2` |
| Card | `3083` |
| Transport | `issuer_tls_worker_ready` → `payTransport=tls-worker` |
| Client posts | **1** (`chargeReqCount=1`, `bigpayAuthPosts=1`) |
| PSP | BigPay `422` / `30106` insufficient funds · `bankSignal=true` |
| Payment id | `6fcce371-fcff-46cd-b169-819681ee68b8` |
| **Revolut** | **×1** (user confirmed 2026-08-02) |

### Lab 2026-08-02 ~16:44 AEST — Bandai FAIL (issuer tls-worker insufficient)

| Field | Value |
|---|---|
| Run | `run_efb49f4c05df` · attempt `bandai#7` |
| GE tx | `172456937` |
| Wire | `via=http-ge-issuer` · issuer `payTransport=tls-worker` · **posts=1** |
| Prepay | handleaction/save still **undici** |
| PSP | `AuthorizationFailed` · `possibleFraudDetected=false` · bankSignal |
| **Revolut** | **×2** (user confirmed 2026-08-02) |

### Lab 2026-08-02 ~17:40 AEST — Bandai payHost tls wire (Revolut TBD)

| Field | Value |
|---|---|
| Run | `run_27ef1bff8056` |
| GE tx | `172460612` |
| Prepay | handleaction 1/2/3 + save → **tls-worker** |
| Issuer | HandleCreditCard → **tls-worker** · posts=1 · `createTransaction=true` |
| PSP | `AuthorizationFailed` · `possibleFraudDetected=false` |
| **Revolut** | **re-score** (fresh disposable; do not inherit 18:44 misread) |

### Lab 2026-08-02 ~18:44 AEST — createTransaction=false VOID (no bank)

| Field | Value |
|---|---|
| GE tx | `172465275` |
| Wire | posts=1 · `ct=false` · tls-worker prepay+issuer |
| **Revolut** | **no fire** (user 2026-08-03: card rotated; ×2 was misread of earlier txs) |

### Lab 2026-08-02 ~19:10 AEST — GE-all-tls wire OK / Revolut VOID on old card

| Field | Value |
|---|---|
| Run | `run_725a0664a334` · attempt `bandai#3` |
| GE tx | `172467620` |
| Wire | ha×3+save+issuer **tls-worker** · posts=1 · `ct=false` · fraud=false |
| Card | last4 `3083` (rotated — do not score Revolut) |
| **Revolut** | **re-run on last4 `1964`** |

### Lab 2026-08-03 ~04:25 AEST — GE-all-tls + ct=false FAIL

| Field | Value |
|---|---|
| Run | e2e `j1m-e2e-bandai-ge-all-tls3` · card last4 **`1964`** |
| GE tx | **`172528639`** |
| Wire | ha×3 + save + HandleCreditCard → **tls-worker** · posts=1 · `ct=false` |
| PSP | `AutherizationFailed` · `possibleFraudDetected=false` · `sameCart=False` |
| Via | `http-ge-issuer` · bankSignal · iovation `liveHtml+geMute` |
| **Revolut** | **×2** (user 2026-08-03 ~04:31) |

**Next:** throwaway iovation (commit `9d313ae` recipe) — mint snare on disposable GetCartToken guid; forterToken-only jar attach; no live Checkout/v2 in Playwright.

### Ruled out / parked

| Lever | Result |
|---|---|
| GE field / form-nav / settle | Revolut×2 |
| Page-issuer baseline / CH A/B | ×2 — and off Fast product path |
| Playwright stealth as dual fix | parked — not shared; Fast no-PW pay |
| Bandai issuer-only tls-worker | ×2 (`172456937`) |
| Bandai GE-all-tls + `ct=false` | ×2 (`172528639`) — liveHtml riskHydrate still on |

**Bandai is the scoreboard** (Revolut 1 vs 2 + forensics). **Shared code is the workshop.**

### Shipped shared instrumentation / guards (this branch)

- `executor/http.js`: mutations never retry unless `allowMutationRetry:true` (ignores bare `retry:true`).
- `executor/http.js`: `http_mutate` — all pay-host mutates (`stage=prepay|issuer`); `http_mutate_response` with status/Location.
- `executor/http.js`: `chromeIssuerNavigateHeaders` — Chrome `Sec-Fetch-*` on issuer-like POSTs when omitted (`PAY_ISSUER_CHROME_NAV=0` to opt out).
- `psp_post_end` fan-out fields (page + undici).
- Classifier / scoreboard: Fast = `http-ge-issuer` only (`score-stock-fast-angles.mjs`).
- Do **not** treat Revolut×2 as “expected GE dual-rail” in Bandai bible anymore.

### Wire-audit result (Bandai clean, 2026-08-02 ~11:48 AEST)

- Cleared leftover lab env that was blanking `machineId` / forcing `pm=2`.
- Run `run_0d541b37c80f` / GE tx **`172442728`**: **exactly one** `HandleCreditCard` (`bodyBytes≈2575`, iovation kept), `posts=1`, `undiciAttempts=1`.
- Other GE mutates were hydrate/save only (`issuerLike=false`) — not a second issuer POST.
- So dual (if Revolut still shows 2 on this tx) is **not** a hidden second HTTP from our client.

### Digression closed — stop dismantling Bandai / stop Playwright-on-Fast dual hunt

User corrections:
- Dual is **outside** Bandai GE ceremony.
- Fast has **hard no Playwright pay**; Safe owns Playwright checkout fingerprinting.
- Playwright is not the shared dual surface (Toymate proves it).

**Product Fast (locked):** undici issuer. Page-issuer / stealth / form-nav = not the Fast dual workshop.

Research evidence kept:

| Lab | tx | Notes |
|---|---|---|
| Clean undici | `172442728` @11:48 | posts=1, Revolut×2 |
| Form-nav / settle / headed | various | Revolut×2 — closed |
| Page-issuer + CH | `172447213` / `172448160` | Revolut×2 — off Fast path |

Also parked: `IsTheSameCartToken`; card packaging; Playwright stealth as dual fix.

Next edits = **shared undici/http only**. Score on Fast undici.

---

## 5. Architecture (shared path)

```text
Desktop Start
  → job-runner (quantity, retries, sticky rotate)
    → payment-latch (per-run; blocks retry after wire touch)
      → executor-sidecar POST /run
        → executor/server.js
          → checkout.js → store adapter
            → executor/http.js  ← SHARED TRANSPORT
              → PSP (GE / BigPay / …)
                → bank (Revolut etc.)
```

| Layer | Path |
|---|---|
| Queue / retries | `desktop/job-runner.cjs` |
| Pay latch (other bug) | `desktop/payment-latch.cjs` |
| Sidecar | `desktop/executor-sidecar.cjs` |
| Transport | `executor/http.js` |
| Forensics | `executor/pay-forensics.js` · `desktop/pay-forensics-audit.cjs` |
| Classifier | `node executor/scripts/classify-pay-forensics.mjs [file.jsonl]` |

---

## 6. Bandai lab reference (measurement only)

- Task `task_c13e31bb45ce` · Profile `prof_4c10061c8213` · SKU `N2847904001`
- Score on **`bandaiCheckoutMode=fast`** → undici `via=http-ge-issuer` (hard no Playwright pay)
- Safe = Playwright checkout fingerprinting; not the dual workshop
- Forensics: `PAY_FORENSICS_PATH` or `%TEMP%\j1m-pay-forensics*.jsonl`
- Failed / parked: GE field roulette, form-nav, page-issuer CH A/B, Playwright stealth as dual fix

---

## 7. Research-only notes (do not expand into product work)

- **PKC** dual confirmed; same GE family — good cross-check, bad “non-GE control.”
- **Toymate** `run_1d56805758fc`: non-GE control that dualed; CapSolver + Noontide resi used for that lab; Draculaura was OOS; LEGO van PDP worked. **No further Toymate implementation.**
- Kmart / Disney: benched; hooks exist; leave alone. Kmart clue (single-fire when bank was Chromium TLS) informs the issuer tls-worker A/B only.

---

## 8. Agent anti-patterns (this investigation’s scars)

1. Treating Bandai as the bug because it is the product → endless GE field roulette.  
2. Suggesting “fix HandleCreditCard” after proving Toymate duals too.  
3. Turning research controls (Toymate) into multi-hour product debugging.  
4. Re-proposing direct/no-proxy after the user already said it duals.  
5. Confusing payment-latch success with fixing `posts=1` / Revolut×2.  
6. Using Playwright / page-issuer / stealth as the Fast dual fix — Fast hard no-PW pay; dual is shared undici.  
7. Treating page-issuer CH labs as Fast product scores.

---

## 9. Definition of done

- Bandai bot checkout: forensics **`psp_post` count = 1`** and user reports **one** Revolut line for that attempt (decline or auth).  
- Manual Bandai still **one**.  
- No requirement to “fix” Toymate product for done — optional re-smoke only if shared transport change warrants it.
