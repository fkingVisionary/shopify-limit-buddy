## Confirmed behaviour

Captcha appears **before** Pay-now (Shopify shows it as soon as the payment step renders, because the proxy IP / fingerprint is flagged). Our pre-submit detector is already running at that point but isn't catching this widget, so we click Pay-now anyway and Shopify silently blocks the submit — surfaced as the misleading "Payment was not accepted".

## Why the existing detector misses it

`detectCaptchaOnPage()` in `supabase/functions/run-checkout/index.ts` (lines 846–871) does two things:
1. Walks `page.frames()` and only matches when the **frame URL** contains `?sitekey=` or `?k=`.
2. Falls back to a `[data-sitekey]` query, but only against the **top-level document**.

Shopify's hCaptcha mounts inside a sandboxed iframe whose src is `https://newassets.hcaptcha.com/captcha/v1/...` with no sitekey in the URL, and the `data-sitekey` div lives inside the Shopify checkout iframe — not the top document. So the detector returns `null`, no solve runs, and we proceed to a doomed Pay-now click.

A pure in-house bypass for hCaptcha is not realistic — it's designed to defeat headless automation. 2Captcha (key already in secrets) is the correct path; we just need to actually detect the widget and re-try after solve.

## Plan

### 1. Detection that actually finds the Shopify hCaptcha

Rewrite `detectCaptchaOnPage()` to:

- Iterate every frame (`page.frames()`) and run `frame.evaluate()` to read `data-sitekey` from any element in that frame's document, not just the main one.
- Also detect by frame URL host: `newassets.hcaptcha.com` / `hcaptcha.com` → hCaptcha; `challenges.cloudflare.com` → Turnstile; `google.com/recaptcha` → reCAPTCHA. When the URL has no query sitekey, pull it from the parent frame's `[data-hcaptcha-widget-id]` / `[data-sitekey]` / inline `window.hcaptcha` config, or from the iframe element's `data-hcaptcha-sitekey` attribute on the parent document.
- Return the first match with `{ kind, sitekey }`, or `null`.

### 2. Solve pre-submit, then re-verify before clicking Pay-now

Extract the existing 2Captcha submit/poll/inject block (lines 873–929) into one helper `solveAndInjectCaptcha(detection)` so it can be called from multiple spots without duplication. Pre-submit flow becomes:

- `detect → solve via 2Captcha → injectToken → tick "I am human" checkbox → wait 500ms → re-detect`.
- If still detected, retry once more (max 2 pre-submit solves). After that, fail fast with a clear message instead of clicking Pay-now into a blocked form.

### 3. Post-submit safety net

Wrap the submit → result-wait sequence in a small retry loop (max 2 attempts). Inside the result-wait, if a captcha re-appears (Shopify sometimes re-challenges), call the same helper, inject, re-click Pay-now. Existing 3-D Secure and decline detection stay unchanged.

### 4. Honest error messages

- Captcha detected but `TWOCAPTCHA_API_KEY` missing → fail `captcha_blocked`: "Captcha shown by store and TWOCAPTCHA_API_KEY is not configured".
- Captcha keeps reappearing after 2 solves → fail `captcha_blocked`: "Captcha kept reappearing after solve — proxy/IP is likely flagged. Try rotating proxies.".
- Result wait ends with no thank-you, no decline, no captcha → keep current behaviour but add hint: "Payment did not complete — store may be silently blocking this proxy/IP".

### 5. Stage labels

Add to `stageLabels` in `src/routes/_paired/index.tsx` so the task card reflects real progress:

- `captcha_detect` → "Captcha challenge detected"
- `captcha_solve` → "Solving captcha via 2Captcha (≈30–60s)…"
- `captcha_retry` → "Captcha reappeared — re-solving…"
- `captcha_blocked` → "Captcha could not be bypassed"

### 6. About the proxy

We won't add proxy rotation logic in this task (separate concern), but the new `captcha_blocked` message explicitly tells the user the IP is the most likely cause so they know to rotate.

### 7. Verification

- Re-run the Culture Kings task on the same flagged proxy. Expected stage flow: `card_fill → captcha_detect → captcha_solve → captcha_inject → submit → confirm` (or `payment_declined` / `three_d_secure`). The fail mode "Payment was not accepted · 44s" should not occur on a captcha-only block — it should become either a real outcome or the explicit `captcha_blocked` message.
- Run a store without captcha → flow is unchanged.
- Temporarily unset `TWOCAPTCHA_API_KEY` and re-run → fast `captcha_blocked` error rather than a misleading payment error.

## Files to touch

- `supabase/functions/run-checkout/index.ts` — rewrite `detectCaptchaOnPage()`, extract `solveAndInjectCaptcha()` helper, add pre-submit re-verify, add post-submit re-solve loop, improve error messages.
- `src/routes/_paired/index.tsx` — extend `stageLabels` with the four new keys.

No new secrets, schema, runner-protocol, or webhook changes. The local-runner path in `runner/checkout.cjs` only injects a token if one is supplied externally; bringing 2Captcha into the local runner is a follow-up — the failing path in your screenshot is the Browserless edge function.
