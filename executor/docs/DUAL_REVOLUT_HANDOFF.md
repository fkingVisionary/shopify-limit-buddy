# Dual Revolut bug — contractor handoff

**Status:** Open  
**Last updated:** 2026-08-04  
**Repo:** `shopify-limit-buddy` (J1m's Bot)  
**Related PR (investigation work):** https://github.com/fkingVisionary/shopify-limit-buddy/pull/151  

If you are reading this after being hired: this is the working brief.  
If you are still in the scoping chat: use **`DUAL_REVOLUT_SCOPING_BRIEF.md`** instead (same problem, written for quoting).

Longer session notes (messy, agent-era): `DUAL_REVOLUT_CROSS_MODULE.md`.

---

## What is broken

When the bot places a Bandai (or related) checkout, **Revolut shows two auth/decline lines for one attempt** — same amount, not a refund.

When a normal person checks out in Chrome/Safari on the **same site with the same card**, Revolut shows **one** line.

Important nuance from our instrumentation:

- The bot sends **one** payment request that we can see (`HandleCreditCard…` for Global-E, or one BigPay post for Toymate).
- Revolut still shows **two**.
- So this is usually **not** “the bot double-clicked Pay” or “two `/run` jobs.” We already checked that shape.

Empty / low-balance cards are fine for testing. We care about **how many Revolut lines appear**, not whether the charge succeeds.

---

## What “fixed” looks like

Bandai checkout through the desktop app → executor path produces **one** Revolut line per intentional place-order attempt, matching a manual browser on the same card.

We are **not** asking you to rebuild Bandai checkout from scratch, or to “productize” Toymate/Kmart/Disney as part of this engagement unless that is explicitly agreed.

---

## Product context (short)

| Piece | Role |
|---|---|
| `desktop/` | Electron app operators use locally |
| `executor/` | Checkout engine (also deployed on Fly for some stores) |
| Bandai **Fast** | Product path: HTTP + F5 for ATC, **undici** for Global-E pay. Must stay fast — **no Playwright on the pay path** |
| Bandai **Safe** | Slower path: HTTP cart mint, then Playwright fills Global-E Checkout/v2 and clicks Pay |
| Bandai **Full** | Lab-only: entire journey in Playwright (no HTTP GetCartToken). Used to prove dual is not “HTTP handoff” |

Operators run tasks from the desktop UI. Data (profiles, proxies, tasks) lives in local desktop storage.

---

## Locked facts

These have been confirmed repeatedly. Please treat them as given unless you produce new wire proof.

1. **Manual browser = 1 Revolut line** on the same merchants/cards.
2. **Bot = 2 Revolut lines** across Bandai, Pokemon Centre (Global-E), and Toymate (BigPay/Adyen).
3. **One client payment POST** in our logs when dual happens (`chargeReqCount` / `psp_post` = 1).
4. The two Revolut lines usually show up **together / within a few seconds**.
5. Happens on **multiple cards**, not only one Revolut PAN.
6. **Direct / no-proxy** was already tried historically and still dualed — don’t burn a bank hit just to rediscover that unless you have a new theory.
7. Desktop was **not** enqueueing two jobs for these labs (`quantity=1`, one run start, one payment post).
8. There was a *different* double-charge bug from soft retries (`RESPONSE_LOST` re-entry). That was fixed in `desktop/payment-latch.cjs`. Today’s bug is the `posts=1` / `chargeReq=1` shape.

---

## What we already tried (and it still dualed)

Please don’t re-run these as “maybe the fix” without a new angle. Each row was bank-confirmed ×2 unless noted.

### Bandai / Global-E presentation experiments

| Attempt | Result |
|---|---|
| Clean undici Fast issuer | ×2 — e.g. tx `172442728`, later `172564570` |
| Form navigation / settle timing / headed Playwright issuer | ×2 |
| Page-issuer + Client Hints / Sec-Fetch tweaks | ×2 — tx `172447213`, `172448160` |
| Issuer via chrome_131 tls-worker (prepay still undici) | ×2 |
| Broader GE-all-tls / cold TLS / form-as-cors / CCForm-on-cold-TLS | ×2 |
| Throwaway iovation, liveHtml iovation experiments | ×2 or no bank |
| Global-E body/field roulette (`pm`, `machineId`, hydrate, cookies…) | Failed whenever a real bank hit occurred |
| **Safe hybrid** (HTTP GetCartToken → Playwright Pay) | ×2 — `run_b61668a5693e` @ ~13:25 AEST 2026-08-03, `chargeReqCount=1` |
| **Full Playwright journey** (no HTTP GetCartToken) | ×2 — `run_e664ed0c11e5` @ ~14:04 |
| **Full + basic stealth** (hide `webdriver`, stub `chrome`, etc.) | ×2 — tx **`172578128`**, `run_3efebe56be2b` @ ~14:50, `stealth=true` |

### Cross-store controls

| Attempt | Result |
|---|---|
| Pokemon Centre (Global-E) | ×2 — tx `172438100` |
| Toymate BigPay via undici | ×2 — `run_1d56805758fc` |
| **Toymate issuer via chrome_131 tls-worker** | **×1** — `run_20651586e4b2` @ ~14:54 (2026-08-02). **Only confirmed single anywhere.** |

That Toymate ×1 is important: same shared transport layer can produce a single bank line on BigPay. Bandai Global-E still duals even when we push similar TLS / browser-ish knobs, and Full Chromium Pay also duals — so “just turn on tls-worker” is **not** a Bandai fix by itself.

### Things that looked related but weren’t this bug

- SoftBlock / login 501 noise on Bandai — ops/proxy minting issue; same proxies can bank on Fast.
- July folklore that commit `9d313ae` “fixed Bandai to ×1” — **not trusted**; never bank-confirmed.

---

## What is still open (highest value)

1. **Manual vs bot HAR** on the same SKU + card  
   Diff Global-E `HandleCreditCard` request/response, Forter/iovation/risk calls, Sec-Fetch / Client Hints, anything the merchant/PSP sees before/during charge.

2. **PSP fan-out**  
   We already have cases with **one Global-E `transactionId`** and **two Revolut lines** (e.g. `172578128`). Worth correlating Revolut timestamps against that single tx / redirect JWT.

3. **Why Toymate tls-worker is ×1 and Bandai isn’t**  
   Best positive control we have. Figure out what property that path has that Bandai Fast *and* Bandai Full still lack.

4. **Deeper browser identity** only if HAR shows a real gap  
   Basic Playwright stealth already failed on Full2.

Tooling already in the repo:

```text
# Dump a Full-browser HAR
BANDAI_DUAL_HAR=1 BANDAI_CHECKOUT_MODE=full ... (desktop e2e)

# Summarize / diff
node executor/scripts/bandai-dual-har-summary.mjs --bot %TEMP%\bandai-full-dual.har --manual path\to\manual.har
```

Payment forensics JSONL: `%TEMP%\j1m-pay-forensics.jsonl` (or `PAY_FORENSICS_PATH`).

---

## Example logs (sanitized)

### A) Full + stealth run that still double-charged (2026-08-03 ~14:50 AEST)

Desktop e2e result (`e2e-full2.json`):

```json
{
  "ok": true,
  "bankHit": true,
  "results": [
    {
      "ok": true,
      "taskId": "task_c13e31bb45ce",
      "runId": "run_3efebe56be2b",
      "paymentStatus": "pay_submitted_no_3ds_seen",
      "transactionId": "172578128",
      "via": "browser",
      "chargeReqCount": 1,
      "note": "GE UI handoff; paymentStatus=pay_submitted_no_3ds_seen; chargeReq=1; tx=172578128; stealth=true",
      "lastSteps": [
        { "step": "login_browser", "ok": true, "note": "member 20004671014" },
        { "step": "addToCart", "ok": true },
        { "step": "cart_checkout", "ok": true, "note": "checkoutSn 1912412 geIframe=true frames=8" },
        {
          "step": "ge_payment",
          "ok": true,
          "note": "pay_submitted_no_3ds_seen; reached3ds=false; payClicks=1; chargeReq=1; ... clicked pay#1 ..."
        }
      ]
    }
  ]
}
```

Owner confirmed Revolut **two lines** for this attempt (~14:50).  
So: one Playwright Pay click, one HandleCredit on the wire, one Global-E tx id, two bank lines.

### B) Forensics shape we instrument for (example Fast-style lines)

```json
{"event":"desktop_enqueue_job","desktopTaskId":"task_c13e31bb45ce","desktopRunId":"run_3efebe56be2b","store":"bandai","quantity":1,"cardLast4":"1964"}
{"event":"desktop_run_start","desktopAttempt":"bandai#1","placeOrder":true,"cardLast4":"1964"}
{"event":"psp_post_start","via":"browser-full","store":"bandai","issuerHost":"secure-bandai.global-e.com","chargeN":1}
{"event":"psp_post_end","via":"browser-full","status":302,"ok":true,"transactionId":"172578128","isPaymentRedirect":true}
{"event":"run_end","paymentStatus":"pay_submitted_no_3ds_seen","chargeReqCount":1,"transactionId":"172578128"}
```

(Exact JSONL rows for Full2 may live in the executor process log / temp forensics file from that session; the e2e JSON above is the durable desktop artifact.)

### C) Older Fast example with the same dual shape

```json
{"event":"psp_post_start","via":"http-ge-issuer","store":"bandai","issuerHost":"secure-bandai.global-e.com","bodyBytes":2577,"createTransaction":"true"}
{"event":"psp_post_end","via":"http-ge-issuer","status":302,"ok":true,"undiciAttempts":1,"bankSignal":true}
{"event":"run_end","paymentStatus":"declined_or_auth_failed","chargeReqCount":1,"transactionId":"172428338","cardLast4":"3083"}
```

Again: one post, one tx, bank saw activity — and in the dual cases the owner sees two Revolut lines.

---

## Lab setup we used

| Item | Value |
|---|---|
| Desktop task | `task_c13e31bb45ce` |
| Profile | `prof_4c10061c8213` |
| Recent SKU | `N2847904001` |
| Card last4 (current lab) | `1964` (intentionally empty / decline-friendly) |
| Proxy group (Safe/Full dual labs) | `px_noontide_resi_dual` (Noontide residential) |

How we score a run:

1. Note `transactionId` / `runId` / timestamp (AEST).
2. Owner checks Revolut: **1 or 2** lines for that moment/amount.
3. Confirm client `chargeReqCount` / `psp_post` stayed at 1.

---

## Code map

| Path | Why it matters |
|---|---|
| `executor/http.js` | Shared HTTP/TLS for pay hosts (undici + optional tls-worker) |
| `executor/pay-forensics.js` | Append-only payment forensics JSONL |
| `executor/adapters/bandai.js` | Fast / Safe / Full routing |
| `executor/adapters/bandai-ge-http.js` | Fast Global-E HTTP pay |
| `executor/adapters/bandai-ge-pay.js` | Safe Playwright pay |
| `executor/adapters/bandai-browser-checkout.js` | Full Playwright journey + optional HAR |
| `executor/chrome-pay-stealth.js` | Basic stealth helpers (already scored ×2 on Full) |
| `desktop/payment-latch.cjs` | Separate retry dual — leave in place |
| `executor/scripts/bandai-dual-har-summary.mjs` | Bot vs manual HAR summary |
| `executor/scripts/classify-pay-forensics.mjs` | Forensics classifier |

Defaults currently left ON in shared pay transport (because of the Toymate ×1 result). Don’t rip them out “for cleanliness” without a Bandai ×1 proof:

- `PAY_ISSUER_TLS_WORKER` (default on)
- `PAY_PAYHOST_TLS_WORKER` (default on)
- `PAY_ISSUER_COLD_TLS` (default on)

---

## Working hypotheses (current)

1. **Merchant / PSP fan-out** — one accepted payment creates two issuer/acquirer messages. Fits “one tx id, two Revolut lines, near-simultaneous.”
2. **Bot presentation / risk identity** — something about TLS, fingerprint, or risk scripts makes Global-E (and BigPay undici) behave differently than a real browser. Fits manual ×1 and Toymate tls-worker ×1.
3. **Not** “wrong Bandai checkout mode,” **not** GetCartToken handoff alone, **not** basic `navigator.webdriver` hiding.

---

## Constraints / preferences from the product owner

- Delivery target is **Bandai** stopping the dual.
- Prefer fixes in **shared** infrastructure when the bug also shows on Toymate/PKC.
- **Fast must not depend on Playwright for pay** (CPU/speed).
- Declines on empty test cards are acceptable; don’t need live successful paid orders to prove a lever.
- Don’t expand into unrelated store product work unless agreed.

---

## If you need more detail

1. This file (handoff after hire).  
2. `DUAL_REVOLUT_SCOPING_BRIEF.md` (pre-hire / quoting).  
3. `DUAL_REVOLUT_CROSS_MODULE.md` (full investigation dump — denser, less polished).  
4. PR #151 for the recent Safe/Full/forensics/HAR wiring.
