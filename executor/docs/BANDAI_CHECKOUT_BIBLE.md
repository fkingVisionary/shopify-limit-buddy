# Bandai bible — why it works, how to run it, what not to touch

This is the charge-path contract for **Premium Bandai** (`p-bandai.com`).
If checkout breaks later, read this before changing F5 bridging, HTTP cart
flow, or Global-e pay.

Companion research (payload shapes, agen DTO): [`BANDAI_AU_MODULE.md`](./BANDAI_AU_MODULE.md)  
Build phases / constraints: [`BANDAI_BUILD_HANDOFF.md`](./BANDAI_BUILD_HANDOFF.md)  
Kmart style twin: [`KMART_WINNING_RECIPE.md`](./KMART_WINNING_RECIPE.md)

---

## 0. Win-con (drop timing)

**Cart first. Pay second.**

Bandai keeps a held cart / checkout window for ~**30 minutes** after ATC.
The race that matters on a drop is:

1. **F5 bridge → login → ATC** as fast as possible  
2. Then hydrate / Global-e pay **inside that window** (can be slower, separate)

Payment dual-rail / Revolut pairs are a real follow-up, but they are **not** the
drop win-con. Do not trade ATC speed for pay polish.

| Priority | Metric |
|----------|--------|
| **P0** | Wall time to `addToCart` ok / cart line held |
| P1 | `checkoutSn` + `merchantCartToken` ready to pay |
| P2 | GE issuer / bank (within ~30 min of cart) |

Flags: `bandaiStopAtCart` (hold after ATC), `bandaiFastAtc` (default on —
skip pre-ATC cart peek + skip Playwright `/item/*` nudge; mint ATC sensors from
`/login` or `/cart`). **Do not mint `addToCart` sensors on `/item/*`** — lab
showed zero `p8komysnbc-*` there when PDP `avail=false`.

Lab wall→ATC (`bandaiFastAtc`, sticky AU ISP): ~**15–25s** to `cart_hold`.

---

## 0.1 Checkout pay modes (Fast / Safe / Full)

**ATC/cart_hold is always HTTP + F5.** Modes only change how Global-e pays after
the ~30 min cart window is held. Task field: `bandaiCheckoutMode`.

| Mode | Desktop UI | After cart hold | Engine |
|------|------------|-----------------|--------|
| **fast** (default) | Fast — HTTP GE + risk-hydrate | undici GetCartToken → hydrate → issuer | `bandaiGeHttpPay` + **`bandaiGeRiskHydrate`** |
| **safe** | Safe — Playwright GE | SPA PROCEED → Checkout/v2 → fill → Pay on F5 bridge | `bandaiBrowserCheckout` |
| **full** | (lab only) | Full Playwright login→PDP→GE | `bandaiBrowserFull:true` |

Resolver: `resolveBandaiCheckoutPayPath` in `adapters/bandai.js`.

### Fast (product default)

```
HTTP+F5 → cart_hold / checkoutSn / merchantCartToken
  → GET Checkout/v2 (undici)
  → riskHydrate: live Checkout/v2 mint with GE POSTs muted
       → fresh #ioBlackBox + Forter / GEM risk cookies → merge into undici jar
       → drop page (before hydrate)
  → handleaction 1/2/3 + checkoutv2/save (rich MainForm: ioBlackBox, ForterToken,
       numeric SelectedTaxOption only — never `{{:value}}` placeholders)
  → CreditCardForm → HandleCreditCardRequestV2 (exactly one undici POST)
  → score CCPaymentRedirect JWT
```

**Do not default `bandaiGeNoPage` / stale `/tmp/bandai-ge-machineId.txt`.** That
path reused a blackbox across proxies and scored **`PossibleFraudDetected=True`**
→ `TransactionStatusType=Refused` → bank ping then void/cancel.

Opt into pure noPage only with `BANDAI_GE_NO_PAGE=1` or `bandaiGeNoPage:true`
(labs). Desktop Fast **forces** `bandaiGeRiskHydrate:true` and `bandaiGeNoPage:false`.

### Safe

Same HTTP ATC / cart hold, then Playwright GEM on the F5 bridge
(`bandai-ge-pay.js` / browser checkout). Use when Fast flakes or you want the
browser risk surface. Slower; still one Pay click.

### Full

Lab escape hatch only — full browser login/PDP/GE (~minutes). Not for drops.

---

## 1. The proof (not theory)

| Field | Value |
|-------|--------|
| **HTTP path** | undici + F5 sensor bridge → `checkoutSn` / cart hold |
| **When** | 2026-07-22/23 labs on sticky AU ISP |
| **GE Fast (riskHydrate)** | Disposable `…6074`: tx `170729872` / `170739501` — **`PossibleFraudDetected=False`**, `AutherizationFailed`, Revolut ping (~14:07 / ~14:58 AEST) |
| **GE Fast (stale noPage cancel)** | tx `170686478` (~12:45 AEST) — **`PossibleFraudDetected=True`**, `Refused`, `Success=False`, bank ping then void |
| **Card class** | Disposable Revolut — empty / insufficient (issuer hit, no kept order) |
| **SKU used** | `N2542159011` (fraud flip labs); earlier `N2881648001`, `A2849039001` |
| **Transport** | undici for gated POSTs; Playwright F5 mint + Fast riskHydrate mint only |
| **GE path (default)** | **`bandaiGeHttpPay` + riskHydrate** — not stale noPage |
| **Edge** | CloudFront + F5 volt-adc (`TS*` cookies) — **not** Hyper / Akamai |
| **Pay mid** | Global-e merchant **1925** (`8urc`) |

**Bank / issuer JWT is ground truth.** Soft declines fire **without** 3DS/ACS.

### Fraud label vs money

`PossibleFraudDetected` is set on the **issuer JWT**
(`HandleCreditCardRequestV2` → `CCPaymentRedirect`). It is **independent of
funds**:

| Run | Fraud | Status | Meaning |
|-----|-------|--------|---------|
| Stale Fast noPage | **True** | `Refused` | GE risk refuse → cancel/void (even if Revolut pings) |
| RiskHydrate + empty card | **False** | `AutherizationFailed` | Risk cleared; issuer soft-decline (normal GE spelling) |
| Browser HAR soft decline | **False** | `AutherizationFailed` | Same soft-decline label on other declines |

Money does not flip the fraud bit after the fact. Clearing fraud=False is the
gate that killed 12:45 cancels. Funded Fast with fraud=False is the remaining
proof for a **kept** order (`Success=True` / `preComplete` / orderNo).

### Revolut pairs

Client always sends **one** `HandleCreditCardRequestV2` (`posts=1`). GE JWT
returns **one** `TransactionId`. Owner still often sees **two** Revolut lines
(dual-rail / void noise) — including riskHydrate Fast. Score bank carefully;
do not “fix” by posting twice.

**Timing (sticky AU ISP labs):**

| Path | Notes |
|------|-------|
| Fast riskHydrate | Fresh Forter (~60b) + ioBlackBox; GE wall often ~40–55s after cart |
| Stale noPage | Faster iovation (0s) but **fraud=True** — do not ship as default |
| Safe Playwright GE | Slower; browser risk surface |

Full paid order + `preComplete` → `orderNo` is **not** closed yet. Funded
purchase when the owner is ready — not burn disposable empties for Success.

---

## 2. Architecture (two pipelines + pay mode)

Bandai is **not** one monolithic checkout. ATC and pay are separate:

```
┌─────────────────────────────────────────────────────────────┐
│  Pipeline A — HTTP + F5 bridge (all modes)                  │
│  login → ATC → cart_hold (~30 min pay window)               │
└────────────────────────────┬────────────────────────────────┘
                             │
          ┌──────────────────┴──────────────────┐
          ▼                                     ▼
┌─────────────────────────┐       ┌─────────────────────────────┐
│  Fast (default)         │       │  Safe                       │
│  riskHydrate mint       │       │  Playwright on F5 bridge    │
│  undici hydrate→issuer  │       │  PROCEED → GEM → Pay once   │
│  score issuer JWT       │       │  score bank / orderNo       │
└─────────────────────────┘       └─────────────────────────────┘
```

**Desktop:** Electron + **local** `executor/` sidecar on `127.0.0.1`.
UI **Checkout pay path** → `bandaiCheckoutMode` → `buildBandaiPayload` in
`desktop/job-runner.cjs`. Fly remains lab/cloud only.

| Flag | Meaning |
|------|---------|
| `bandaiCheckoutMode` | `fast` \| `safe` (desktop + task) |
| `bandaiGeHttpPay` | Fast pay — undici issuer |
| `bandaiGeRiskHydrate` | Fast default — fresh Forter/iovation mint (desktop forces on) |
| `bandaiGeNoPage` | Lab-only stale blackbox — **off** on desktop Fast |
| `bandaiBrowserCheckout` | Safe pay — Playwright GE after cart |
| `bandaiBrowserFull` | Slow full Playwright — labs only |
| `bandaiF5Bridge` (default **true**) | Mint sensors in Chromium; undici does real POSTs |
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

## 4. Who handles what (Playwright vs HTTP)

| Stage | Engine | What it does |
|--------|--------|----------------|
| **F5 warm** | **Playwright** | Open `/{area}/login` once → seed `SESSION` / `TS*` / CSRF. **No** full browse. |
| **Sensor mint** | **Playwright probe** | Short aborted XHR to capture `p8komysnbc-*` for the *next* HTTP POST only. |
| **Login / ATC / cart / checkoutSn** | **HTTP undici** | All JSON APIs (all modes). |
| **Fast risk mint** | **Playwright (brief)** | Checkout/v2 with GE muted → Forter/ioBlackBox → drop; undici pays. |
| **Fast Pay** | **HTTP undici** | hydrate → save → CreditCardForm → issuer. |
| **Safe Pay** | **Playwright** | `/cart` → PROCEED → Checkout/v2 → fill → Pay on F5 bridge. |

```
All modes:
  Playwright F5 mint → undici login/ATC/cart_hold

Fast:
  brief Playwright riskHydrate → undici GE hydrate → issuer JWT

Safe:
  Playwright GEM Pay on same F5 bridge (after cookie sync)
```

**Rule:** after warm cookies for login, **business Bandai APIs stay HTTP**.
Do not browser-POST `/login` again before GE (opt-in `bandaiBridgeRelogin` only).

### Can GE Pay skip Playwright?

**Yes — that is Fast (`bandaiGeHttpPay` + riskHydrate).** Orchestrator:
`runBandaiGeHttpPay` in `bandai-ge-http.js`. Safe keeps Playwright GE.

```
HTTP checkoutSn + merchantCartToken
  → GET gepi…/Checkout/GetCartToken?MerchantCartToken=…&MerchantId=1925&…   ✅ HTTP
  → CartToken GUID
  → GET webservices…/Checkout/v2/8urc/{guid}                               ✅ HTTP
  → riskHydrate: Playwright mint on Checkout/v2 (GE POSTs muted)           ⚠ brief DOM
       → #ioBlackBox + Forter/GEM cookies → merge → drop page
  → POST checkoutv2/handleaction/{1,2,3} with Action+Token+ShippingData    ✅ HTTP
  → POST checkoutv2/save/{8urc}/{guid} urlencoded MainForm + X-merchantId  ✅ HTTP
  → GET secure-bandai…/payments/CreditCardForm/{guid}/{gatewayId}          ✅ HTTP
  → POST …/Payments/HandleCreditCardRequestV2/8urc/{guid}                  ✅ HTTP undici
  → decode CCPaymentRedirect JWT → PossibleFraudDetected / StatusType
```

**`machineId` is iovation** (`snare.js` → `#ioBlackBox`). Forter is a separate
risk cookie/token — riskHydrate mints both. Stale noPage (cached blackbox only)
is lab-only and caused fraud=True cancels.

**False success:** 302 → `CCPaymentRedirect` with `RedirectErrorType=DataCorruption`
+ `TransactionId=0` is **not** a bank hit. Score `ge_reload_only_no_bank`.

**Real bank (even on decline):** `TransactionId≠0` + usually
`AutherizationFailed` (GE spelling) + `PossibleFraudDetected=False` + MerchantId=1925.
Score `declined_or_auth_failed`. Check Revolut.

**GE fraud refuse (cancel path):** `PossibleFraudDetected=True` +
`TransactionStatusType=Refused` → score `ge_fraud_refused` (bank may still ping then void).

**Wire knobs:** CreditCardForm URL path = **gatewayId** (usually `/2`), body
`paymentMethodId` usually `1`. Save must include `ioBlackBox` / `ForterToken`
when present; **omit** invalid `SelectedTaxOption={{:value}}` placeholders
(broke save and blocked a real decline JWT).

**Lab:** `node executor/scripts/bandai-ge-http-lab.mjs` (defaults Fast riskHydrate)  
**Safe:** `bandaiCheckoutMode=safe` / `bandaiBrowserCheckout` (SPA PROCEED + Playwright Pay).

### HTTP default (`bandai.js`, F5 on)

```
bandai_region
  → f5_bridge          # Playwright: goto /{area}/login; seed cookies + CSRF — NO warm after this
  → login              # mint → undici POST /login
  → member_refresh     # GET /api/context/member/refresh
  → [bridge.goto PDP]  # cookie/CSRF nudge only
  → product_get        # GET /api/products/{code} → areaItemNo
  → addToCart          # mint → POST /api/cart/addToCart
  → cart_detail
  → [cart_qty_normalize]
  → [bandaiStopAtCart?]
  → extract PRELOAD suffix
  → cart_checkout      # mint → POST …/checkout → checkoutSn
  → stage=tokenize
```

### Fast placeOrder (`bandaiCheckoutMode=fast`)

```
(HTTP path above through cart + merchantCartToken)
  → runBandaiGeHttpPay (riskHydrate) → issuer JWT score
```

### Safe placeOrder (`bandaiCheckoutMode=safe` / `bandaiBrowserCheckout`)

```
(HTTP path above through cart)
  → bridge_cookie_sync   # HTTP jar → Playwright (no browser re-login)
  → cart UI → PROCEED → ge_payment → (3DS | decline | order)
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
| GE Pay click / issuer POST | **once** | Never double-submit; Revolut may still show two lines (dual-rail) |
| Fast default | **riskHydrate** (not stale noPage) | Stale blackbox → `PossibleFraudDetected=True` / cancels |
| Desktop Fast | `bandaiGeRiskHydrate:true`, `bandaiGeNoPage:false` | Do not inherit lab shell env |
| Save tax option | numeric only — omit `{{:value}}` | Placeholder broke save / blocked decline JWT |
| Score fraud JWT | `PossibleFraudDetected` → `ge_fraud_refused` | Independent of funds; set at issuer response |
| GE charge POSTs | **exactly one** undici `HandleCreditCardRequestV2` | `posts=1` locked |
| Browser re-login before GE | **off** (HTTP jar sync) | Login stays HTTP; `bandaiBridgeRelogin` opt-in only. |
| GEM boot | preload mid **1925** js/css + prefetcher iframe before Proceed; poll frames without blocking on `waitForURL` | Biggest remaining latency after Proceed (~40s cold); serial URL wait killed frame listeners early |
| Post-Pay observe | **≤45s**, exit on auth wire (~12s more) | Do not burn 3min ACS wait after Pay already hit the bank |
| Card expiry SELECT | DOM `value` + `input`/`change` events | Playwright `selectOption` on mismatch burned **~90s×N** and looked like “Pay blocked for 3 min” |
| Pay enable poll | ≤12s after fill + T&Cs tick | Diagnose checkboxes/errors; do not sit in 90s locator timeouts |

---

## 6. Score order of truth

1. **Bank / Revolut / issuer notification** (charge, decline, or void)  
2. **Issuer JWT:** `PossibleFraudDetected`, `TransactionStatusType`, `Success`, `TransactionId`  
3. Adapter: `ge_issuer_risk` / `ge_fraud_refused` / `declined_or_auth_failed` / `pay_submitted_http` / `orderNumber`  
4. Lab JSON / milestones — never “client timed out” alone  

Pass ladder:

```
login 200 + NoRestriction
  → ATC / cart_hold / checkoutSn + merchantCartToken
  → (Fast) riskHydrate forter=true → issuer JWT fraud=False
       → AutherizationFailed (empty) OR Success=True (funded — TBD)
  → (Safe) Checkout/v2 + Pay → issuer ping or orderNo
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
| `checkoutSn` ok, no pay UI | Expected on Fast HTTP GE | Fast does not need SPA PROCEED |
| No PROCEED button (Safe) | Empty cart / PreOrder unticked / CMP | Cart UI + OneTrust dismiss |
| GE iframe never ready (Safe) | Prefetcher mistaken for ready / OneTrust | Wait **Checkout/v2** + CreditCardForm |
| Pay no-ops (Safe) | T&Cs unticked / invalid form / captcha empty | Form inspect lab |
| `pay_clicked_no_payment_request` | Filter too narrow or GEM not ready | Broaden GE net; **check bank** |
| Soft decline, no 3DS | `AutherizationFailed` + fraud=False | Normal frictionless decline — scrape JWT |
| Bank ping then cancel | Often `PossibleFraudDetected=True` / `Refused` | Use Fast riskHydrate; do not stale noPage |
| Save fails after riskHydrate | `SelectedTaxOption={{:value}}` | Omit placeholders (fixed in adapter) |
| Revolut two lines, posts=1 | GE/PSP dual-rail | Expected; one TransactionId |
| Agen login 501 | Agen path may lack F5 mint | Harden agen with bridge |

---

## 8. File map

| Path | Role |
|------|------|
| `adapters/bandai.js` | Modes + HTTP orchestration + `resolveBandaiCheckoutPayPath` |
| `adapters/bandai-ge-http.js` | Fast: riskHydrate, hydrate, issuer, JWT fraud score |
| `adapters/bandai-ge-pay.js` | Safe: Playwright GEM Pay helpers |
| `adapters/bandai-session.js` | Region, CSRF, warm, apiJson, login |
| `adapters/bandai-f5.js` | Sensor bridge (mint + abort) |
| `adapters/bandai-cart.js` | Nested cart line helpers |
| `adapters/bandai-browser-checkout.js` | Safe SPA → GE Pay |
| `adapters/bandai-agen.js` | Account gen (IMAP + SMSPool/OnlineSim) |
| `scripts/bandai-ge-http-lab.mjs` | Fast placeOrder lab (default riskHydrate) |
| `scripts/bandai-http-checkout-lab.mjs` | Dry-run → `checkoutSn` |
| `scripts/bandai-charge-lab.mjs` | placeOrder + card env |
| `scripts/bandai-ge-pay-debug.mjs` | Frames/network around Pay |
| `scripts/bandai-f5-probe.mjs` | Detect Shape / common.js drift |
| `desktop/job-runner.cjs` | `buildBandaiPayload` → local sidecar |
| `desktop/bandai-pay-path.cjs` | Desktop Fast/Safe + riskHydrate flag resolution |
| `desktop/renderer/*` | Checkout pay path select |
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
| Funded Fast Success | fraud=False proven; `Success=True` / kept order TBD |
| `preComplete` | `POST /api/checkout/{checkoutSn}/preComplete` not wired after GE success |
| Paid order / orderNo | Soft-decline + fraud flip proven; success path open |
| Revolut dual-rail | posts=1 still pairs — park; don’t double-post |
| Bandai milestones | Prefer `ge_issuer_risk` / JWT fields over Kmart-centric names |
| Agen under Shape | Ensure agen login/signup POSTs mint F5 when gated |
| Chance scale | Multi-account `applyDraw` not proven at pool size |
| Region matrix | Code supports 7 areas; labs AU-centric |
| Shape rename | `bandai-f5-probe` if `p8komysnbc-` header names change |

---

## 11. Restore rule

If a tip regresses a known-good Bandai run, restore the **whole Bandai runtime**
(`bandai.js` / `bandai-ge-http.js` / `bandai-ge-pay.js` / `bandai-session.js` /
`bandai-f5.js` / `bandai-browser-checkout.js` / `bandai-cart.js`), not a single
helper. Do not open GE iframe / header spirals without wire proof (lab JWT +
bank ping).

**Bottom line:** HTTP+F5 ATC always; Fast = riskHydrate undici issuer (default);
Safe = Playwright GE after cart; never stale noPage as product default; score
issuer JWT fraud + bank first.
