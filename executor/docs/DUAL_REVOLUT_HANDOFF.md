# Dual Revolut — developer handoff

**Status:** Open / unresolved  
**Updated:** 2026-08-03 ~16:08 AEST  
**Product:** J1m's Bot (`shopify-limit-buddy`) — Bandai checkout is the delivery target  
**Deep archive:** `executor/docs/DUAL_REVOLUT_CROSS_MODULE.md` (session notes, Safe workshop, PR trail)  
**Working PR:** [#151](https://github.com/fkingVisionary/shopify-limit-buddy/pull/151) · branch `cursor/safe-pay-wire-fix-c402`

---

## 1. The bug (one paragraph)

For **one** bot checkout attempt, Revolut shows **two** auth/decline lines (same amount, not a refund). A **manual** browser checkout on the **same merchant + same card** shows **one**.

Wire forensics show **one** client payment POST (`HandleCreditCard` / BigPay). The second bank line is **not** explained by a second instrumented client POST.

This is **not** “the Revolut card,” **not** Bandai-only adapter fields, and **not** fixed by switching Bandai Fast / Safe / Full modes.

---

## 2. Ground truth (locked)

| Fact | Evidence |
|---|---|
| Manual browser → Revolut **×1** | Same Bandai / other merchants, same cards |
| Bot → Revolut **×2** | Repeated user bank confirms |
| Client charge posts = **1** | `psp_post_*` / `chargeReqCount=1` / desktop enqueue labs |
| Dual timing | Two Revolut lines arrive together / within seconds |
| Cross-stack | Bandai (Global-E), PKC (Global-E), Toymate (BigPay/Adyen) |
| Cross-card | Reproduced on multiple cards/banks on the bot |
| Direct / no-proxy | Already tested historically → still **×2** (do not rediscover casually) |
| Orchestration | `quantity=1`, one enqueue, one `run_start`, one `psp_post` |

**Lab Bandai task (current):** `task_c13e31bb45ce`  
**Profile:** `prof_4c10061c8213` · card last4 **`1964`** (empty account — declines OK; count of Revolut lines is what matters)  
**SKU used recently:** `N2847904001`  
**Proxy group used for Safe/Full dual labs:** `px_noontide_resi_dual`

**Forensics log:** `PAY_FORENSICS_PATH` or `%TEMP%\j1m-pay-forensics.jsonl`  
Classifier: `node executor/scripts/classify-pay-forensics.mjs`

---

## 3. Scoreboard — tried and failed as “the fix”

Do **not** re-run these as the dual fix without new wire proof.

| # | Lever | Key evidence | Revolut |
|---|---|---|---|
| 1 | Clean undici Fast (Bandai GE issuer) | tx `172442728`, posts=1 | **×2** |
| 2 | Form-nav / settle / headed Playwright issuer | `172443438`…`172445269` | **×2** |
| 3 | Page-issuer / Client Hints (off Fast product path) | `172447213`, `172448160` | **×2** |
| 4 | Issuer tls-worker only (prepay still undici) | `172456937` | **×2** |
| 5 | PayHost + issuer tls stack | `172460612` wire (score later muddied) | re-score voided |
| 6 | GE-all-tls + `createTransaction=false` + liveHtml | `172528639` | **×2** |
| 7 | Throwaway iovation + tls | `172538665` | **×2** |
| 8 | Sec-Fetch form-as-cors | `172548067` | **×2** |
| 9 | Cold issuer tls (split workers) | `172549600` | **×2** |
| 10 | CCForm GET on cold issuer tls | `172557593` | **×2** |
| — | PKC Global-E control | `172438100` | **×2** |
| — | Toymate undici BigPay | `run_1d56805758fc` | **×2** |
| 11 | **Safe hybrid** (HTTP ATC + GetCartToken → Playwright Checkout/v2 Pay) | `run_b61668a5693e` @13:25, chargeReq=1 | **×2** |
| 12 | **Full browser** (all-Playwright, no HTTP GetCartToken) | `run_e664ed0c11e5` @14:04, chargeReq=1 | **×2** |
| 13 | **Full + chrome pay stealth** | tx **`172578128`** / `run_3efebe56be2b` @~14:50, chargeReq=1, stealth=true | **×2** |
| ★ | **Toymate issuer chrome_131 tls-worker** | `run_20651586e4b2` @14:54 | **×1** (only confirmed single) |

### Also closed / void (not dual scores)

| Item | Notes |
|---|---|
| Desktop soft-retry latch (`desktop/payment-latch.cjs`) | Fixed a **different** dual (`posts≥2` / RESPONSE_LOST re-entry) |
| GE field / hydrate / `pm` / `machineId` / cookie roulette | Failed whenever bank actually hit |
| “It’s SoftBlock / dirty session” as the dual explanation | Same Noontide proxies bank on Fast; dual still present |
| July commit `9d313ae` “Bandai ×1” | Unconfirmed agent folklore — **retracted** |
| `BANDAI_GE_SKIP_CC_FORM=1` / `createTransaction=false` | No bank fire — unscored for dual |
| Fast vs Safe vs Full as the dual fix | All three **×2** with one client charge |
| Basic Playwright stealth (`webdriver` / `chrome` / plugins) | Full2 still **×2** |

---

## 4. What has **not** been finished (open queue)

Prioritized for the next developer:

| Priority | Work | Why it still matters |
|---|---|---|
| **1** | **Manual vs bot HAR** on the same SKU/card | Manual=×1, bot Full=×2 in real Chromium. Diff HandleCredit body/headers, Forter/iovation/risk hosts, Sec-Fetch / UA-CH |
| **2** | **PSP fan-out forensics** | Full2: one GE tx `172578128` → Revolut ×2. Correlate Revolut pair timestamps vs single `transactionId` / redirect JWT |
| **3** | Deeper identity (real Chrome channel / CDP / fingerprint) | Only after HAR shows a concrete automation/risk gap; basic stealth already failed |
| **4** | Explain / generalize **Toymate tls-worker ×1** | Only confirmed single anywhere. Bandai counterexample on same knobs + Full Chromium Pay |
| Skip | More Fast/Safe/Full mode banks, GE field roulette, basic stealth A/B, “try direct again” | Closed or historically dualed |

### Bot HAR tooling (already wired)

```text
# Full-browser e2e with HAR dump
BANDAI_DUAL_HAR=1 BANDAI_CHECKOUT_MODE=full BANDAI_E2E_SKU=N2847904001
DESKTOP_E2E_AUTORUN=1 DESKTOP_E2E_PLACE_ORDER=1 DESKTOP_E2E_TASK_ID=task_c13e31bb45ce
# from desktop/: npm start
# HAR → %TEMP%\bandai-full-dual.har

# Diff bot vs manual Chrome DevTools export
node executor/scripts/bandai-dual-har-summary.mjs --bot %TEMP%\bandai-full-dual.har --manual path\to\manual.har
```

Safe/Full also emit `psp_post_end` with `transactionId` (same angle-A shape as Fast).

---

## 5. Architecture map (where to look)

```text
desktop/  (Electron UI)
  → executor sidecar POST /run
    → adapters/bandai.js
        Fast  = HTTP+F5 ATC → undici GE issuer (product speed path)
        Safe  = HTTP ATC + GetCartToken → Playwright Checkout/v2 fill/Pay
        Full  = all-Playwright lab (no HTTP GetCartToken)
    → adapters/bandai-ge-http.js   (Fast GE HTTP pay)
    → adapters/bandai-ge-pay.js    (Safe Playwright pay)
    → adapters/bandai-browser-checkout.js  (Full journey)
    → executor/http.js             (SHARED transport — undici / tls-worker)
    → executor/pay-forensics.js    (psp_post_* JSONL)
```

**Product constraint:** Fast must stay **no Playwright pay** (speed/CPU). Playwright pay is Safe/lab only.

**Shared knobs still ON by default** (do not “simplify” off without Toymate×1 + Bandai×1 proof):

| Env | Default | Role |
|---|---|---|
| `PAY_ISSUER_TLS_WORKER` | ON | Issuer POST via chrome_131 tls-worker (Toymate ×1 proof) |
| `PAY_PAYHOST_TLS_WORKER` | ON | GE/BigPay prepay mutates via tls-worker |
| `PAY_ISSUER_COLD_TLS` | ON | Separate issuer worker vs prepay |
| `PAY_ISSUER_FORM_AS_CORS` | ON | Sec-Fetch cors/empty — Bandai still ×2 |
| `PAY_CHROME_STEALTH` | Full defaults ON; F5 opt-in `=1` | Basic stealth — Bandai Full2 still ×2 |

---

## 6. Leading hypotheses (after Full2)

Ordered by current strength:

1. **PSP / acquirer fan-out** — one accepted HandleCredit / BigPay yields two bank auth messages. Supported by: posts=1, one GE `transactionId`, Revolut ×2 with near-simultaneous lines.
2. **Bot risk identity** — Forter / iovation / TLS / fingerprint presentation differs from manual Chrome such that the merchant/PSP dual-auths. Supported by: manual ×1; Toymate undici ×2 vs tls-worker ×1; **not** explained by Bandai GE body fields alone.
3. **Something still missing in shared `http.js` presentation** for GE even when Playwright Full also duals — Full dualing means it is **not only** undici; identity/PSP side remains.

**Weak / dead as sole cause:** checkout mode, GetCartToken handoff, GE `pm`/`machineId`/hydrate, basic `navigator.webdriver` stealth, desktop double-enqueue.

---

## 7. Do / don’t for the incoming developer

### Do

- Treat **bank line count** (Revolut 1 vs 2) as ground truth; declines on empty accounts are fine.
- Prefer **one bank score per lever** with a GE `transactionId` or Toymate run id.
- Change **shared** layers (`http.js`, TLS, forensics) unless you prove a Bandai-only cause that also explains Toymate.
- Keep Fast free of Playwright pay.
- Read forensics JSONL + milestones; client HTTP timeouts can lie.

### Don’t

- Claim a Bandai ×1 win without user Revolut confirm + tx/run id.
- Revert issuer tls-worker as product default without Toymate×1 + Bandai×1.
- Resume GE field / form-nav / mute ceremony churn.
- Burn more Fast/Safe/Full mode switches “to check dual.”
- Treat July `9d313ae` folklore as proof.
- Turn Toymate/PKC/Kmart into product rabbit holes (research controls only).
- Re-enable liveHtml Checkout/v2 iovation without `BANDAI_GE_ALLOW_LIVE_CART_IOVATION=1`.

---

## 8. Suggested starting points (not a schedule)

Highest-value next work, in no particular cadence:

1. **Reproduce once** on Bandai Full or Fast; confirm Revolut ×2 and capture `transactionId` from forensics.
2. **Manual HAR** on same SKU/card (Chrome DevTools → Export HAR, sanitize PAN).
3. **Bot HAR** with `BANDAI_DUAL_HAR=1` on Full; run `bandai-dual-har-summary.mjs`.
4. From the diff, pick **one** concrete delta (risk host, issuer headers, TLS JA3/shape, fingerprint script) and A/B it with a single bank score.
5. Keep the Toymate tls-worker ×1 result in mind as the only positive control — what shared property does that path have that Bandai Full Chromium still lacks?

---

## 9. Key file index

| Path | Why |
|---|---|
| `executor/docs/DUAL_REVOLUT_CROSS_MODULE.md` | Full investigation bible / session log |
| `executor/docs/DUAL_REVOLUT_HANDOFF.md` | This document |
| `executor/pay-forensics.js` | `psp_post_start/end`, redirect fan-out fields |
| `executor/http.js` | Shared undici / tls-worker pay transport |
| `executor/chrome-pay-stealth.js` | Basic Playwright stealth (Full2 still ×2) |
| `executor/adapters/bandai.js` | Mode routing (fast/safe/full) |
| `executor/adapters/bandai-ge-http.js` | Fast GE HTTP issuer |
| `executor/adapters/bandai-ge-pay.js` | Safe Playwright pay + issuer forensics |
| `executor/adapters/bandai-browser-checkout.js` | Full journey + HAR opt-in |
| `desktop/payment-latch.cjs` | Different dual (retry re-entry) — keep |
| `executor/scripts/bandai-dual-har-summary.mjs` | Bot vs manual HAR summary |
| `executor/scripts/classify-pay-forensics.mjs` | JSONL classifier |

---

## 10. Latest locked lab (as of 2026-08-03)

| Lab | Result |
|---|---|
| Fast smoke ~10:35 | tx `172564570` · posts=1 · Revolut **×2** |
| Safe13 hybrid ~13:25 | `run_b61668a5693e` · chargeReq=1 · Revolut **×2** |
| Full1 ~14:04 | `run_e664ed0c11e5` · chargeReq=1 · Revolut **×2** |
| Full2 stealth ~14:50 | tx **`172578128`** · `run_3efebe56be2b` · stealth=true · Revolut **×2** |

**Verdict entering handoff:** Dual survives every Bandai pay shape tested. Next high-value work is **manual vs bot HAR + PSP fan-out correlation**, not another checkout-mode experiment.
