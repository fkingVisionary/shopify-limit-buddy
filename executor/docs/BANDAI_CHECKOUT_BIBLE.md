# Bandai bible — why it works, how to run it, what not to touch

This is the charge-path contract for **Premium Bandai** (`p-bandai.com`).
If checkout breaks later, read this before changing F5 bridging, HTTP cart
flow, or Global-e pay.

Companion research (payload shapes, agen DTO): [`BANDAI_AU_MODULE.md`](./BANDAI_AU_MODULE.md)  
Build phases / constraints: [`BANDAI_BUILD_HANDOFF.md`](./BANDAI_BUILD_HANDOFF.md)  
Kmart style twin: [`KMART_WINNING_RECIPE.md`](./KMART_WINNING_RECIPE.md)

---

## 1. The proof (not theory)

| Field | Value |
|-------|--------|
| **HTTP path** | undici + F5 sensor bridge → `checkoutSn` (e.g. `1512700` / `1514416` / `1515791`) |
| **When (HTTP)** | 2026-07-22 labs on sticky AU ISP |
| **GE wire** | Revolut declined **A$317** to **Globale /bandai Spirit** (~11:36 AEST 2026-07-22) |
| **Card class** | Disposable Mastercard `…0501` — insufficient funds (issuer hit, no order) |
| **SKU used** | `A2880191001` → `AAI0013787AU` |
| **Transport** | undici for gated POSTs; Playwright only mints `p8komysnbc-*` (probe aborted) |
| **GE path** | Playwright SPA → Checkout/v2 → nested CreditCardForm → Pay |
| **Edge** | CloudFront + F5 volt-adc (`TS*` cookies) — **not** Hyper / Akamai |
| **Pay mid** | Global-e merchant **1925** |

**Bank / issuer notification is ground truth.** Lab status can under-report
(`pay_clicked_no_payment_request`) while Revolut still auths. Soft declines
can fire **without** 3DS/ACS.

Full paid order + `preComplete` → `orderNo` is **not** closed yet. Do not
burn another A$317 charge until there is a SKU the owner wants and a funded card.

---

## 2. Architecture (two pipelines)

Bandai is **not** one monolithic checkout. It is two pipelines glued at cart / GE:

```
┌─────────────────────────────────────────────────────────────┐
│  Pipeline A — HTTP + F5 bridge (mint only, undici POSTs)    │
│  login → ATC → cart                                         │
└────────────────────────────┬────────────────────────────────┘
                             │ same Chromium (F5 bridge page)
┌────────────────────────────▼────────────────────────────────┐
│  Pipeline B — GE on that page (placeOrder drop path)        │
│  /cart → PROCEED → Checkout/v2 → fill → Pay once            │
│  Score: bank ping → orderNo / decline → not client ok alone │
└─────────────────────────────────────────────────────────────┘
```

**Drop timing:** `placeOrder` + `bandaiBrowserCheckout` uses **http+ge** on the
F5 bridge — **not** a second full-browser login/PDP (that path was ~5 minutes
to Revolut). Escape hatch only: `bandaiBrowserFull:true`.

**Desktop end-state:** Electron on the user’s machine + **local** `executor/`
sidecar on `127.0.0.1` (not a shared Fly executor). Fly remains lab/cloud only.

| Flag | Meaning |
|------|---------|
| `bandaiF5Bridge` (default **true**) | Mint sensors in Chromium; undici does real POSTs |
| `bandaiBrowserCheckout` | With `placeOrder`: HTTP→cart then GE on F5 bridge (`via=http+ge`) |
| `bandaiBrowserFull` | Slow full Playwright login→PDP→GE — labs only, not drops |
| Desktop `placeOrder` | Forces `bandaiBrowserCheckout: true` → http+ge path |
| `bandaiStopAtCart` | HTTP early exit after cart detail |
| `forceUndici: true` | Desktop payload — keep undici |

---

## 3. Why it works (the actual mechanism)

### 3.1 F5 Shape Defense

Gated calls need request headers matching **`/^p8komysnbc-/i`**, minted by
`/_ui/responsive/common/js/common.js` in a real DOM. Cookie handoff alone
(`SESSION` + `TS*`) is **not** enough — login/ATC still 501.

**Working pattern:**

1. Launch Chromium (+ sticky proxy), `goto` login/PDP/cart.
2. Wait ~2.2s for `common.js` XHR hooks.
3. In-page XHR to the gated path with area + CSRF headers.
4. Playwright `route` **aborts** the probe after capturing `p8komysnbc-*`.
5. Undici performs the **real** POST on the same cookie jar + same exit IP.
6. Mint **fresh** sensors per gated call (login, ATC, modify, checkout).

Gated matrix (`BANDAI_F5_GATED` in `adapters/bandai-f5.js`):

| Method | Path |
|--------|------|
| `POST` | `/login` |
| `POST` | `/api/cart/addToCart` |
| `PUT` | `/api/cart/modifyCartItem` |
| `POST` | `/api/cart/{cartSn}/checkout` |

### 3.2 Session / area

- Host: **`https://p-bandai.com/{area}/`** — never `www.bandai.com.au`.
- Regions: `au|us|nz|sg|hk|tw|fr`. **JP out of scope.**
- Every `/api/*` needs **`X-G1-Area-Code: {area}`** (missing → HTTP 500).
- CSRF from HTML `USER_DATA` / meta → `GET /api/context/member` → response
  header `x-csrf-token` (refresh after login).
- Sticky ISP/resi proxy for bridge + undici. Hyper not required.

### 3.3 Cart → checkoutSn

```
POST /api/cart/addToCart  [{ areaItemNo, qty }]
GET  /api/cart/detail     → cartSn, cartId, cartItemSn
PUT  /api/cart/modifyCartItem?cartItemSn=&qty=   (optional normalize)
Scrape PRELOAD_DATA.globaleMerchantCartTokenSuffix from cart HTML
POST /api/cart/{cartSn}/checkout
     {
       merchantCartToken: `${cartId}_Checkout_${suffix}`,
       shippingAreaCode: area,
       items: [{ cartItemSn }]   // NOT areaItemNo
     }
→ checkoutSn
```

Cart lines nest under:
`cart.detail.subCarts[].combinedShippings[].lineItems[]`

### 3.4 Global-e Pay

Raw `checkoutSn` from HTTP often leaves `/orderdetails` **without** a payment
iframe. The SPA button **PROCEED TO CHECKOUT** is what boots GEM.

```
dismiss OneTrust
  → /cart tick shipping-area checkboxes (skip ot-*)
  → PROCEED TO CHECKOUT → /orderdetails
  → wait frames: Checkout/v2 + CreditCardForm (not prefetcher)
  → fill nested secure-bandai form (cardNum, SELECT month/year, cvdNumber)
  → tick GE T&Cs
  → Pay / Place Order
  → wait 3DS ACS **or** decline copy **or** order number
```

Hosts: `gem-bandai.global-e.com`, `webservices.global-e.com/Checkout/v2`,
`secure-bandai.global-e.com/payments/CreditCardForm`, mid **1925**.

Hidden later tokens: `recapchaToken`, Forter, FingerprintJS `fpId` — may
populate after form fill; do not assume Pay works before GEM is ready.

---

## 4. Stage order (locked)

### HTTP default (`bandai.js`, F5 on)

```
bandai_region
  → f5_bridge          # goto /{area}/login; seed cookies + CSRF — NO warm after this
  → login              # mint → undici POST /login
  → member_refresh     # GET /api/context/member/refresh
  → [bridge.goto PDP]
  → product_get        # GET /api/products/{code} → areaItemNo
  → addToCart          # mint → POST /api/cart/addToCart
  → cart_detail
  → [cart_qty_normalize]
  → [bandaiStopAtCart?]
  → extract PRELOAD suffix
  → cart_checkout      # mint → POST …/checkout → checkoutSn
  → stage=tokenize
```

### Browser GE (`bandaiBrowserCheckout` / desktop placeOrder)

```
login_browser → product_get → addToCart → cart_detail
  → cart UI → PROCEED → ge_payment → (3DS | decline | order)
  → preComplete NOT wired yet
```

Login body (`application/x-www-form-urlencoded`):

```
grantType=password&memberId=<email>&password=<pw>&saveLoginId=false&autoLogin=false
```

Watch **`x-restricted-type`**: `SMSVerificationPending|Outdated`,
`TermsPending|Outdated`, `TemporaryPassword`, or `NoRestriction`.

Guest ATC → **501 PAGE NOT AVAILABLE**. Login + F5 required.

---

## 5. Locked knobs (do not “improve” without wire proof)

| Knob | Value | Why |
|------|--------|-----|
| HTTP transport | **undici** + F5 bridge | Proven `checkoutSn` |
| Full browser default | **off** | Product default is HTTP; GE opt-in |
| Warm after F5 seed | **never** | Rotates session → login **501** |
| Sensor reuse across gated calls | **never** | Stale `p8komysnbc-*` → 501 |
| Probe fate | **abort** after header capture | Real POST is undici |
| `X-G1-Area-Code` | always set | Else 500 |
| Checkout `items` | `[{ cartItemSn }]` | Not `areaItemNo` |
| `merchantCartToken` | `${cartId}_Checkout_${suffix}` | Needs PRELOAD scrape |
| Hyper | not required | Not Akamai BM |
| JP / bandai.com.au | out of scope | Wrong stack / cert |
| Fail-closed deploy gates on F5 flake | **no** | Same philosophy as Kmart |
| GE Pay click | **once**, Checkout/v2 only | Never click `secure-bandai` submit / nested Complete — double issuer charge |
| GE charge POSTs | **`handleaction/1` always; first `≥2` to issuer; later `≥2` fulfilled locally** (not aborted) | Revolut pairs = `/2`+`/3`. Aborting `/3` leaves Pay/T&Cs broken; local fulfill keeps UI alive with one issuer hit. |
| GEM boot | preload mid **1925** js/css + prefetcher iframe before Proceed; poll frames without blocking on `waitForURL` | Biggest remaining latency after Proceed (~40s cold); serial URL wait killed frame listeners early |
| Post-Pay observe | **≤45s**, exit on auth wire (~12s more) | Do not burn 3min ACS wait after Pay already hit the bank |
| Card expiry SELECT | DOM `value` + `input`/`change` events | Playwright `selectOption` on mismatch burned **~90s×N** and looked like “Pay blocked for 3 min” |
| Pay enable poll | ≤12s after fill + T&Cs tick | Diagnose checkboxes/errors; do not sit in 90s locator timeouts |

---

## 6. Score order of truth

1. **Bank / Revolut / issuer notification** (charge or decline)  
2. Adapter milestones: `checkoutSn` → `reached3ds` / `declined_or_auth_failed` / `orderNumber`  
3. Lab JSON / `geNet` tails  
4. Never “client timed out” or narrow `payNet===0` alone  

Pass ladder:

```
login 200 + NoRestriction
  → ATC / cart_detail with cartItemSn
  → cart_checkout → checkoutSn
  → (GE) Checkout/v2 + CreditCardForm visible
  → Pay → issuer ping or orderNo
```

---

## 7. Failure matrix

| Symptom | Likely cause | Fix / check |
|---------|--------------|-------------|
| API **500** | Missing/wrong `X-G1-Area-Code` | Headers on failing call |
| Login/ATC **501** “PAGE NOT AVAILABLE” | Missing/stale sensors, or warm-after-seed | Mint ok? Jar has `SESSION`+`TS*`? No warm after bridge |
| Login 200 but stuck | `x-restricted-type` SMS/terms/temp-pw | Complete gate or use verified vault account |
| ATC business error JSON | MaxPurchaseQty / OOS / EndOfSale | Soft-ok if line already in cart; else new SKU |
| `missing merchantCartToken` | PRELOAD suffix not scraped | Cart HTML / `globaleMerchantCartTokenSuffix` |
| `checkoutSn` ok, no pay UI | Expected on HTTP-only | Need `bandaiBrowserCheckout` |
| No PROCEED button | Empty cart / PreOrder unticked / CMP | Cart UI + OneTrust dismiss |
| GE iframe never ready | Prefetcher mistaken for ready / OneTrust | Wait **Checkout/v2** + CreditCardForm |
| Pay no-ops | T&Cs unticked / invalid form / captcha empty | Form inspect lab |
| `pay_clicked_no_payment_request` | Filter too narrow or GEM not ready | Broaden GE net; **check bank** |
| Soft decline, no 3DS | Frictionless issuer decline | Still wire proof — scrape decline copy |
| Agen login 501 | Agen path may lack F5 mint | Harden agen with bridge |

---

## 8. File map

| Path | Role |
|------|------|
| `adapters/bandai.js` | Modes + HTTP orchestration |
| `adapters/bandai-session.js` | Region, CSRF, warm, apiJson, login |
| `adapters/bandai-f5.js` | Sensor bridge (mint + abort) |
| `adapters/bandai-cart.js` | Nested cart line helpers |
| `adapters/bandai-browser-checkout.js` | SPA → GE Pay |
| `adapters/bandai-agen.js` | Account gen (IMAP + OnlineSim) |
| `scripts/bandai-http-checkout-lab.mjs` | Dry-run → `checkoutSn` |
| `scripts/bandai-charge-lab.mjs` | placeOrder + card env |
| `scripts/bandai-ge-pay-debug.mjs` | Frames/network around Pay |
| `scripts/bandai-ge-form-inspect.mjs` | CreditCardForm DOM dump |
| `scripts/bandai-f5-probe.mjs` | Detect Shape / common.js drift |
| `desktop/job-runner.cjs` | `buildBandaiPayload` → local sidecar |
| `desktop/executor-sidecar.cjs` | Spawn executor on `127.0.0.1` |

Labs read creds from env / `/tmp/bandai-lab-creds.env` + `/tmp/bandai-card.env` —
**never commit secrets or PANs.**

---

## 9. How to smoke (without Electron)

Local executor (Node ≥20), sticky AU proxy, test account:

```bash
cd executor && npm install
# export BANDAI_EMAIL / BANDAI_PASSWORD / PROXY_URL (or lab env files)
node scripts/bandai-http-checkout-lab.mjs          # → checkoutSn
# funded card only when intentional:
# node scripts/bandai-charge-lab.mjs
```

Assert sequence: `f5_bridge` → `login` → `addToCart` → `cart_checkout` + `checkoutSn`.

Offline invariants (no network / no Electron):

```bash
node adapters/bandai-region.test.mjs
node adapters/bandai-flow.test.mjs
node adapters/bandai-password.test.mjs
```

On desktop later: **Start engine** → Bandai task → runs hit local sidecar only.

---

## 9.1 Before you have Electron / your PC

High leverage without the desktop app:

1. **Re-run HTTP lab** when you have a shell + proxy + test account — prove `checkoutSn` still lands after any Shape/CDN drift.
2. **Fund card + wanted SKU only** for charge lab — close orderNo / decline scrape; don’t burn A$317 on throwaways.
3. **Capture a logged-in HAR** (login → ATC → cart → PROCEED → GE Pay) once you can — locks payloads if F5/GE change.
4. **Wire `preComplete`** in executor after a GE success blob (lab-first; no Electron required).
5. **Bandai-specific milestones** on disk (`checkoutSn`, `ge_payment`, `reached3ds`, decline) so client timeouts don’t erase wins.
6. **Agen F5** — mint sensors on agen login if Shape starts 501’ing signup/login.
7. **Keep this bible updated** when a tip changes F5 gated paths or GE frame hosts.

Do **not** add fail-closed CI gates on sensor flake.

---

## 10. Still soft (harden here first)

| Gap | Notes |
|-----|--------|
| `preComplete` | `POST /api/checkout/{checkoutSn}/preComplete` not wired after GE success |
| Paid order / orderNo | Issuer decline proven; success path open |
| Bandai milestones | Don’t rely on Kmart-centric `cart_get` / `paydock_3ds` names |
| GE decline scrape | Persist decline copy so bank declines aren’t “unknown fail” |
| Agen under Shape | Ensure agen login/signup POSTs mint F5 when gated |
| Chance scale | Multi-account `applyDraw` not proven at pool size |
| Region matrix | Code supports 7 areas; labs AU-centric |
| Shape rename | `bandai-f5-probe` if `p8komysnbc-` header names change |

---

## 11. Restore rule

If a tip regresses a known-good Bandai run, restore the **whole Bandai runtime**
(`bandai.js` / `bandai-session.js` / `bandai-f5.js` / `bandai-browser-checkout.js` /
`bandai-cart.js`), not a single helper. Do not open GE iframe / header spirals
without wire proof (lab `checkoutSn` + bank ping).

**Bottom line:** undici + abort-minted `p8komysnbc-*` through cart checkout;
never warm after F5 seed; GE via SPA Proceed → Checkout/v2; bank first.
