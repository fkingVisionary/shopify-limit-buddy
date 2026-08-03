# Dual Revolut issue — scoping brief (pre-hire)

**Purpose of this doc:** Give you enough context to discuss the problem, ask questions, and come back with a commercial proposal (fixed price, capped T&M, hourly, etc.).  
**This is not a contract and not a commitment to hire.**

**Date:** 2026-08-04  
**Product:** J1m’s Bot — local desktop checkout automation for retail drops (Bandai AU is the main store we care about here).  
**Repo (private):** `shopify-limit-buddy`  

If engaged later, the deeper technical handoff is `executor/docs/DUAL_REVOLUT_HANDOFF.md`.

---

## 1. Problem in plain English

When our bot runs a checkout, the customer’s **Revolut** app often shows **two** payment attempts (auth/decline) for what should be **one** checkout.

When the same person checks out **manually in a normal browser** on the same website with the same card, Revolut shows **one**.

So this is not “Revolut is broken for this card.” Something about the **bot’s checkout path** is causing a double bank-side attempt.

We have instrumented the bot heavily. In the bad cases we usually see:

- **One** payment request leaving our client
- **Two** Revolut lines appearing (same amount, close together in time)
- Not a refund pair

We use empty / low-balance cards for labs on purpose. Success is measured by **line count in Revolut (1 vs 2)**, not by getting a paid order through.

---

## 2. Why this matters

- Double bank attempts are bad UX and look like double charging / double declines.
- It burns trust and can cause card/issuer friction.
- It has shown up on more than one store integration, so we suspect a **shared bot/payment-transport problem**, not a one-line Bandai typo.

**Primary delivery goal if hired:** Bandai checkouts produce **one** Revolut line per intentional attempt, like a manual browser.

---

## 3. Where it shows up

Confirmed by the product owner against Revolut:

| Path | Stack | Client payment posts (our logs) | Revolut |
|---|---|---|---|
| Manual Chrome/Safari | Real browser | n/a | **1** |
| Bandai Fast (product path) | Global-E over our HTTP client | **1** | **2** |
| Bandai Safe | Global-E via Playwright pay UI | **1** | **2** |
| Bandai Full (lab) | Full Playwright journey | **1** | **2** |
| Bandai Full + basic anti-automation stealth | Playwright | **1** | **2** |
| Pokemon Centre | Global-E | **1** | **2** |
| Toymate (undici) | BigPay / Adyen | **1** | **2** |
| Toymate (issuer via chrome TLS worker) | BigPay / Adyen | **1** | **1** (only confirmed single) |

So:

- It’s **not Global-E-only** (Toymate duals too).
- It’s **not fixed by switching Bandai modes** (Fast/Safe/Full all dual).
- There **is** at least one bot path (Toymate + specific TLS worker for the issuer POST) that produced a single Revolut line. That is our best positive control — but the same idea has **not** fixed Bandai.

---

## 4. What we already ruled out (high level)

You should assume these are already explored. Re-doing them from scratch is low value unless you have a new theory.

- Two desktop jobs / quantity > 1 enqueueing two checkouts
- A separate soft-retry bug that could re-enter place-order (that one was fixed; different log shape)
- “Just the Revolut card”
- “Just try without proxy” as a new idea (already dualed historically)
- Bandai Global-E form field tweaks (`machineId`, payment method ids, hydrate quirks, etc.) as the whole answer
- Basic Playwright stealth (`navigator.webdriver` hiding, etc.) — still dualed on a full browser path
- “It’s only because we hand off an HTTP cart token into Playwright” — full Playwright journey still dualed

There is a longer scoreboard with transaction IDs / run IDs in the handoff doc if useful during a later engagement.

---

## 5. Example evidence (one recent lab)

**2026-08-03 ~14:50 AEST — Bandai Full browser + stealth**

- Run id: `run_3efebe56be2b`
- Global-E transaction id: `172578128`
- Our client charge count: **1**
- Pay clicks: **1**
- Stealth helpers: **on**
- Owner Revolut: **2 lines**

Desktop result excerpt:

```json
{
  "runId": "run_3efebe56be2b",
  "transactionId": "172578128",
  "via": "browser",
  "chargeReqCount": 1,
  "paymentStatus": "pay_submitted_no_3ds_seen",
  "note": "chargeReq=1; tx=172578128; stealth=true"
}
```

This is the shape of the bug: **one client charge, two bank lines**.

---

## 6. Current best guesses (not gospel)

1. **PSP / acquirer fan-out** — one accepted merchant payment produces two bank messages.
2. **Bot identity / TLS / risk fingerprint** — something about how the bot presents (HTTP client, Playwright, risk scripts like Forter/iovation) causes dual auth where a real browser does not.
3. Something in our **shared payment transport** — because undici vs a Chrome-like TLS worker changed Toymate’s Revolut count, but Bandai still duals even in a real Chromium pay UI.

We do **not** currently believe the remaining fix is “change Bandai checkout mode again.”

---

## 7. Suggested scope options (for quoting)

You can propose one of these, or a hybrid.

### Option A — Investigation spike (time-boxed)

- Reproduce on Bandai with our desktop/executor setup
- Capture manual vs bot HAR (same SKU/card)
- Identify the most likely root cause class (fan-out vs fingerprint/TLS vs something else)
- Written findings + recommended fix path
- **Exit:** clear diagnosis and estimate for Option B

### Option B — Fix Bandai dual (outcome-based)

- Implement and prove Bandai produces Revolut **×1** on the product path we agree on (almost certainly **Fast**, unless we jointly decide otherwise)
- Keep Fast free of Playwright pay if at all possible (performance constraint)
- Include logging/proof so we can verify without guessing
- **Exit:** owner-confirmed single Revolut line on Bandai lab card(s), plus notes on residual risk

### Option C — Shared transport hardening

- Treat Bandai as the acceptance store, but fix/shared-harden the common payment layer so Toymate/PKC don’t regress
- Useful if your diagnosis says the bug lives below Bandai-specific code

Please say which option you’re pricing, what’s included/excluded, and what you need from us.

---

## 8. Constraints you should price around

| Constraint | Detail |
|---|---|
| Primary store | Bandai AU (Global-E) |
| Product Fast path | Should stay HTTP-based for pay (no Playwright on Fast) |
| Test cards | We can use decline-friendly / empty-balance cards; bank line count is the metric |
| Proxies | Residential proxies are part of the real path; direct-without-proxy already dualed historically |
| Access | Private GitHub repo; local Windows desktop app; no need for a public Lovable deploy |
| Secrets | Card data / API keys stay local; don’t commit secrets |
| Out of scope unless agreed | Rebuilding whole bot UI; Kmart product work; turning research stores into full product epics |

---

## 9. What we can provide if we proceed

- Repo access
- The technical handoff + investigation archive
- A known lab task/profile/SKU setup on the desktop app
- Recent run IDs / Global-E transaction IDs
- Help confirming Revolut 1 vs 2 after your test runs (owner has the bank app)
- Existing forensics tools (`j1m-pay-forensics.jsonl`, HAR dump helpers)

We may **not** hand over live funded cards. Decline-lab is enough for this bug.

---

## 10. Questions we’d like you to answer in your proposal

1. Have you worked on similar “one client charge → two issuer/bank attempts” problems (Adyen, Global-E, Stripe, etc.)?
2. Which scope option (A/B/C) are you quoting, and why?
3. Fixed price, hourly, or capped T&M?
4. Rough effort band (even if wide), and what would make it grow?
5. What do you need in week one / first engagement days to start (access, HAR from us, pairing, etc.)?
6. How will you prove success without requiring a fully paid successful order?
7. Any risks you see from the brief that we haven’t named?

---

## 11. Commercial notes (from our side)

- Prefer a proposal that separates **diagnosis** from **fix** if you’re unsure of root cause.
- Happy to pay for a short paid spike if that’s how you de-risk a fixed quote.
- We care about a real fix and proof, not a long speculative rewrite.
- Please don’t pad the quote by re-running experiments we already closed unless you explain the new angle.

---

## 12. One-line summary you can reuse

> Our checkout bot triggers two Revolut auth/decline lines for a single attempt while a normal browser on the same site/card triggers one. Client logs show a single payment POST. Reproduced on Global-E and BigPay. Mode switches and basic stealth didn’t fix it. We want Bandai back to one bank line, preferably on the fast HTTP pay path.

---

## Appendix — useful IDs (for discussion)

| Label | ID |
|---|---|
| Latest dual Full+stealth run | `run_3efebe56be2b` |
| Latest dual Global-E tx | `172578128` |
| Earlier Fast dual tx | `172564570` |
| Safe hybrid dual run | `run_b61668a5693e` |
| Full dual run (no GetCartToken) | `run_e664ed0c11e5` |
| Only confirmed single (Toymate) | `run_20651586e4b2` |
| Lab task id | `task_c13e31bb45ce` |

More detail, file paths, and the full tried/failed scoreboard are in `DUAL_REVOLUT_HANDOFF.md` once we’re past scoping.
