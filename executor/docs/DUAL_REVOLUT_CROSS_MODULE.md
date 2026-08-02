# Dual Revolut — investigation bible (handoff)

**Updated:** 2026-08-02  
**PR / branch:** `#150` · `cursor/macro-double-charge-latch-c402`  
**Product to fix:** Bandai checkout (desktop → executor). Other stores = research evidence only.

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

YOUR JOB:
1. Accept the dual is outside store modules and outside “GE issuer body”.
2. Find what the shared bot stack does that a real browser does not, such that ONE outbound pay POST becomes TWO issuer/bank auths.
3. Change shared code (executor/http.js, TLS/client choice, proxy binding, desktop card packaging, sidecar /run semantics — as justified by evidence).
4. Score success ONLY on Bandai + Revolut (1 vs 2) with forensics posts=1 on **stock Fast** (page issuer). Do not invent a new Bandai pay mode to “fix” the dual.

FORBIDDEN:
- Rewriting Bandai Fast defaults (page issuer → undici, blank-under-mute ceremony, form-nav, settle, headed Chrome, GE field A/B) as the main strategy. User correction 2026-08-02 PM: that is dismantling Bandai again; dual is outside that scope.
- Editing `bandai-ge-http.js` / `bandai-ge-http-test.js` pay ceremony except for inert forensics / latch signals.
- Chasing `IsTheSameCartToken` or other GE JWT flags.
- “Let’s just fix Toymate too” product work.
- Claiming payment-latch solved this dual.
- Re-running direct/no-proxy as step 1 without reading that it already dualed.

START HERE (SHARED ONLY):
- Bandai is the **scoreboard** only. Product Fast = riskHydrate + **page issuer** (restored). Workshop = `executor/http.js`, TLS/client, desktop sidecar `/run`, proxy binding.
- Form-nav / settle / mute / undici-default labs are **closed digressions** — evidence only; they dualed too.
- Next change must be justifiable for Bandai **and** Toymate BigPay. If it only lives in Bandai GE code, stop.

Lab Bandai scoreboard: task_c13e31bb45ce, mode **Fast** (not autocheckout_test). Forensics: PAY_FORENSICS_PATH or %TEMP%\j1m-pay-forensics*.jsonl.
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
| PKC bot | Global-E | **1** `psp_post` | **2** | tx `172438100`; not refund |
| Toymate bot | BigPay / Adyen | **1** `psp_post` | **2** | `run_1d56805758fc` ~11:07 AEST 2026-08-02; `422/30106`; CSE skipped after decline |
| Bot, other cards/banks | various | (same shape) | **2** | User history |
| Bot direct / no proxy | various | (tested before) | **2** | **Already done — do not rediscover** |

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
| Two `/run`s or quantity fan-out | Forensics: one run, one post |
| Soft-retry / RESPONSE_LOST double placeOrder | Fixed by `desktop/payment-latch.cjs`; different shape (`posts≥2` or re-entry) |
| Toymate CSE second BigPay after decline | Fixed (CSE skipped on 422); Toymate dual still happened with one BigPay POST |
| “It’s the Revolut card” | Manual same card = 1; other cards on bot = 2 |
| “Just try direct / no proxy” as a fresh idea | User: already tested, still 2 |
| Undici-TLS-only | Real Chromium document form-nav still dualed |

---

## 4. What is still open (shared bot stack)

Something about **how the bot presents the single pay attempt** makes issuers/acquirers record **two** bank lines, while a real browser’s single attempt records **one**. User timing: the two Revolut lines arrive **together / within seconds** → looks like one merchant request fanning out to two issuer messages, not a slow client retry.

### Leading hypothesis (2026-08-02 evening)

**Naked CNP / incomplete SCA ceremony.** Bot never shows an in-app 3DS challenge; pay goes straight to decline/auth. Manual browser often also frictionless, but still completes the browser 3DS2 data exchange (document form-nav + land `CCPaymentRedirect`). Incomplete SCA data can make some issuer rails emit two near-simultaneous notifications. Fits cross-PSP + simultaneous duals + `posts=1`.

### Other candidates

1. **`executor/http.js` / undici / TLS** — fingerprint, connection reuse. Mutation auto-retry is now hard-blocked (`allowMutationRetry` only); historical RST-replay duals are documented.
2. **Uninstrumented second pay hop** — `http_mutate` forensics now logs every POST/PUT/PATCH/DELETE to known pay hosts. Classifier warns if `payHostMutates > psp_post_start`.
3. **Desktop → executor card packaging** — only with proof.
4. **Proxy** — weak; direct already dualed historically.

**Bandai is the scoreboard** (Revolut 1 vs 2 + forensics). **Shared code is the workshop.**

### Shipped shared instrumentation / guards (this branch)

- `executor/http.js`: mutations never retry unless `allowMutationRetry:true` (ignores bare `retry:true`).
- `executor/http.js`: `http_mutate` audit — always for **issuer-like** paths; optional full dump via `PAY_WIRE_AUDIT=1`.
- `executor/http.js`: `chromeIssuerNavigateHeaders` — fills Chrome `Sec-Fetch-*` navigate defaults on issuer-like POSTs when the adapter omitted them (`PAY_ISSUER_CHROME_NAV=0` to opt out).
- Classifier reports `issuerLikeMutates` vs `pspPostStarts`.
- Do **not** treat Revolut×2 as “expected GE dual-rail” in Bandai bible anymore.

### Wire-audit result (Bandai clean, 2026-08-02 ~11:48 AEST)

- Cleared leftover lab env that was blanking `machineId` / forcing `pm=2`.
- Run `run_0d541b37c80f` / GE tx **`172442728`**: **exactly one** `HandleCreditCard` (`bodyBytes≈2575`, iovation kept), `posts=1`, `undiciAttempts=1`.
- Other GE mutates were hydrate/save only (`issuerLike=false`) — not a second issuer POST.
- So dual (if Revolut still shows 2 on this tx) is **not** a hidden second HTTP from our client.

### Digression closed (2026-08-02 PM) — stop dismantling Bandai

User correction: dual Revolut is **outside** Bandai. Form-nav / settle / mute / headed Chrome / flipping Fast to undici inside Bandai adapters is dismantling the module again.

**Restored product Fast (do not re-break):**
- Desktop + `bandai.js` + `bandai-ge-http.js`: riskHydrate → **page issuer** default.
- Undici issuer / autocheckout_test fork = opt-in research only.
- Blank-under-mute + always-park-before-page-issuer digressions reverted on prod Fast.

Research evidence kept (not a Bandai fix path):

| Lab | tx | Notes |
|---|---|---|
| Clean undici | `172442728` @11:48 | posts=1, Revolut×2 |
| Fat form-nav | `172443438` @12:02 | posts=1, Revolut×2 |
| Form-nav + settle | `172443854` @12:09 | postGeMut=6, Revolut×2 |
| Headed Chrome form-nav | `172444504` @12:23 | ~5s Revolut gap |
| Form-nav settle=0 | `172445269` @12:39 | postGeMut=0 |

Also parked: `IsTheSameCartToken` (GE-only); desktop card packaging (audited clean).

Next edits = **shared stack only**. Score on stock Fast.

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
- Score on **`bandaiCheckoutMode=fast`** → `bandai-ge-http.js` page issuer (product path)
- `autocheckout_test` / form-nav = parked research fork only — not the workshop
- Forensics: `PAY_FORENSICS_PATH` or `%TEMP%\j1m-pay-forensics*.jsonl`
- Failed Bandai levers (do not resume): empty `machineId`, slim cookies, pay-guid rebind, skip hydrate, `pm=2`, form-nav/settle/mute, Fast→undici default flip

---

## 7. Research-only notes (do not expand into product work)

- **PKC** dual confirmed; same GE family — good cross-check, bad “non-GE control.”
- **Toymate** `run_1d56805758fc`: non-GE control that dualed; CapSolver + Noontide resi used for that lab; Draculaura was OOS; LEGO van PDP worked. **No further Toymate implementation.**
- Kmart / Disney: benched; hooks exist; leave alone.

---

## 8. Agent anti-patterns (this investigation’s scars)

1. Treating Bandai as the bug because it is the product → endless GE field roulette.  
2. Suggesting “fix HandleCreditCard” after proving Toymate duals too.  
3. Turning research controls (Toymate) into multi-hour product debugging.  
4. Re-proposing direct/no-proxy after the user already said it duals.  
5. Confusing payment-latch success with fixing `posts=1` / Revolut×2.  
6. Flipping production Fast defaults (page issuer → undici, park/mute ceremony) “to chase dual” — user: stop dismantling Bandai.

---

## 9. Definition of done

- Bandai bot checkout: forensics **`psp_post` count = 1`** and user reports **one** Revolut line for that attempt (decline or auth).  
- Manual Bandai still **one**.  
- No requirement to “fix” Toymate product for done — optional re-smoke only if shared transport change warrants it.
