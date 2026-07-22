# Handoff: Build Premium Bandai AU (agen + checkout)

_Date: 2026-07-21_  
_Audience: Cloud / coding agent starting implementation_  
_Owner goal: **account gen + checkout** on Premium Bandai AU, with **OnlineSim (SMS) + IMAP (email)** OTP._  
_HAR status: **not available yet** — build from JS-derived research; owner can supply APIs, proxies, and test accounts. Capture HAR later to harden gated POSTs / Global-e._

---

## 0. Read these first (in order)

| Doc | Why |
|---|---|
| **This file** | Build scope, phases, constraints, acceptance |
| [`BANDAI_AU_MODULE.md`](./BANDAI_AU_MODULE.md) | Full API map, signup DTO, ATC/Chance/GE payloads |
| [`NEXT_STORE_MODULES.md`](./NEXT_STORE_MODULES.md) | Priority context (Bandai-first) |
| [`AGENTS.md`](../../AGENTS.md) | Repo layout; **do not break Kmart** |

Canonical storefront: **`https://p-bandai.com/au/`**  
Do **not** use `www.bandai.com.au` (cert mismatch).

---

## 1. Non-negotiable constraints

1. **Branch off current `main`.** New work only: `cursor/bandai-au-module-<suffix>` (or repo’s required `cursor/…-709b` pattern if still enforced).
2. **Do not modify `adapters/kmart.js` or Kmart desktop checkout path** unless fixing an accidental break. Kmart is production-green.
3. **HTTP-first checkout.** Default path is undici + F5 sensor bridge (`adapters/bandai-f5.js`): Playwright only mints `p8komysnbc-*` headers (probe XHR aborted); real `/login`, ATC, `modifyCartItem`, and `cart/{sn}/checkout` POSTs stay on HTTP. Full Playwright checkout is **opt-in only** (`bandaiBrowserCheckout:true`) for GE decline labs. Do not make browser the product default.
4. Hyper is **not** required for Bandai edge (F5/Volterra). Good TLS + cookie jar + sticky AU proxy + F5 sensors.
5. Secrets (**OnlineSim key, IMAP app password, test accounts**) come from owner / Desktop Settings — never commit them.

---

## 2. End state (definition of done)

| Capability | Done when |
|---|---|
| **Shared OTP** | `executor/otp/imapInbox.js` + `executor/otp/onlinesim.js` work standalone |
| **Desktop Settings** | User can paste OnlineSim API key + IMAP host/port/user/app password |
| **`bandai-agen`** | Creates AU accounts end-to-end (email OTP → SMS OTP → `registerVerification` → login → shipping) into a vault |
| **`bandai` checkout path** | Login → `addToCart` → cart checkout → Global-e handoff (pay may be browser-assisted initially) |
| **Chance (stretch)** | Multi-account `applyDraw` from vault |
| **Monitor (nice)** | Poll search/PDP for `purchaseAvailable` / Chance status → notify |

Owner priority order for shipping: **OTP + agen → login/ATC → GE checkout → Chance → monitor**.

---

## 3. What the owner will provide (ask if missing)

| Item | Use |
|---|---|
| **OnlineSim API key** | AU SMS OTP (`country=61`) |
| **IMAP host + mailbox + app password** | Email OTP; mailbox email = Bandai `memberId` |
| **Sticky AU ISP/residential proxies** | Warm + signup + checkout (same IP stickiness as Kmart) |
| **≥1 existing Bandai AU test account** (email/password) | Login / ATC dry-run before agen is green |
| **Payment test path** (card / PayPal as they use on GE) | Phase 4 only |
| **HAR later** (optional but valuable) | Signup + ATC + GE once they can capture locally |

If OnlineSim “named service” slug for Bandai is unknown: implement **rent / other-service** config knobs (`onlinesimServiceSlug`, `onlinesimCountry=61`, prefer rent if single-activation misses Bandai SMS).

---

## 4. Stack cheat-sheet (do not rediscover)

| Layer | Detail |
|---|---|
| App | Vue 3 SPA, axios `baseURL: "/"` |
| Edge | CloudFront + **volt-adc** (`TS*` cookies) — not Hyper |
| Auth | `POST /login` form-urlencoded; email = `memberId` |
| Area | **`X-G1-Area-Code: au` required** or APIs 500 |
| CSRF | `GET /api/context/member` → `csrfToken`; also `x-csrf-token` on login |
| Pay | **Global-e merchant `1925`** |
| AU signup | **`multiAuth: true`** → email **and** SMS required |

### Required headers (most `/api/*`)

```
Accept: application/json, text/plain, */*
Content-Type: application/json          # JSON POSTs
Accept-Language: en
X-G1-Area-Code: au
X-CSRF-TOKEN: <from /api/context/member>
X-Requested-With: XMLHttpRequest
Origin: https://p-bandai.com
Referer: https://p-bandai.com/au/...
Cookie: SESSION=…; TS…=…
```

### Password login

```
POST /login
Content-Type: application/x-www-form-urlencoded

grantType=password
&memberId=<email>
&password=<password>
&saveLoginId=false
&autoLogin=false
```

Watch response header **`x-restricted-type`**:  
`SMSVerificationPending` / `SMSVerificationOutdated` → SMS gate; `TermsPending` → agreement; `TemporaryPassword` → reset.

---

## 5. Account gen flow (implement exactly)

UI routes:  
`/register` → mail auth → member form → `/sms/auth` → confirm → complete.

```
1. Warm           GET https://p-bandai.com/au/ + GET /api/context/member
2. Email send     POST /api/signUp/email/auth
                    { email, agreeAgeTerms: true }   # resend: { …, resend:true }
3. IMAP poll      wait for 6-digit (or Bandai) code
4. Email validate POST /api/signUp/email/validate
                    { authCode, authSn }
5. Profile        name, password (rules in BANDAI_AU_MODULE §4.2), DOB ≥18,
                  gender, AU homeAddress, phone1 { countryNo:"+61", phoneNo }
6. Phone unique   POST api/phoneNo  body=phone1 → { exists } must be false
7. Terms          GET /api/terms/termsofuse → termsAgreeList
                    [{ termsCode:"termsofuse", version, areaCode:"au", agree:true }]
8. SMS send       POST /api/phoneNo/auth { phoneNo: { countryNo, phoneNo } }
9. OnlineSim poll wait for SMS code
10. SMS validate  POST /api/phoneNo/validate { authCode, authSn }
                    → smsAuthInfo { authSn, authResultCode }
11. Register      POST /api/signUp/registerVerification  (full signUpData DTO)
                  # Do NOT use skip-SMS /api/signUp/register for AU
12. Auto-login    POST /login (password grant)
13. Clear gates   if x-restricted-type → finish SMS/terms
14. Shipping      POST /api/my/shippingAddresses
15. Vault         status: ready | needs_sms | banned
```

**Vault “ready”** = register OK + login with no blocking restriction + shipping present + SMS verified.

SignUp DTO shape: see `BANDAI_AU_MODULE.md` §3 / §4.1 (copy from there; don’t invent fields).

### Agen errors to handle

| Signal | Action |
|---|---|
| Email already registered | Burn email; next |
| `PHONE_NUMBER_DUPLICATED` / `exists:true` | New OnlineSim number |
| `MemberAuthCodeExpired` / mismatch | Resend or fail attempt |
| `SmsRateLimitExceeded` / `TOO_MANY_REQUEST` | Backoff; rotate |
| OnlineSim low balance / wrong key | Stop batch; surface to UI |
| OnlineSim timeout | Release number; retry |
| IMAP auth fail / no mail | Stop; surface Settings |

---

## 6. Checkout / Chance (after agen or with test account)

### ATC (login required — guest ATC returned 501 in DC)

```
POST /api/cart/addToCart
[{ "areaItemNo": "<SKU>", "qty": 1 }]
```

Then `GET /api/cart/detail`.  
Errors: `CouldNotAddToCartByMaxPurchaseQty`, `…OutOfStock`, `…EndOfSale`, etc.

### Checkout → Global-e

```
POST /api/cart/{cartSn}/checkout
{
  merchantCartToken: `${cartId}_Checkout_${globaleMerchantCartTokenSuffix}`,
  shippingAreaCode,
  items: [{ cartItemSn }]    // NOT areaItemNo
}
→ { checkoutSn }
```

Then GE client mid **1925** (`gem-bandai.global-e.com/includes/js/1925`).  
On success: `POST /api/checkout/{checkoutSn}/preComplete` with `globaleOrder` blob.

**Note:** `globaleMerchantCartTokenSuffix` is minted into cart-page PRELOAD — without HAR, load cart HTML/PRELOAD or find equivalent API field; if missing, ask owner for one cart-page capture.

GE has cart-token **captcha** (h-captcha / grecaptcha hybrid) + **FingerprintJS**. Phase 4 may need desktop browser for GE only; keep ATC HTTP.

### Chance

```
POST /api/my/campaign/apply/{campaignSn}/applyDraw
{ "applyGroupNo": null | number }
```

Login required. Scale = agen vault size.

---

## 7. Suggested file layout

```
executor/
  otp/
    imapInbox.js          # waitForCode({ host, port, user, appPassword, from?, subject?, regex, since, timeout })
    onlinesim.js          # acquireNumber / waitForSms / release  (apikey, country=61)
  adapters/
    bandai.js             # warm, login, getProduct, addToCart, checkout, applyChance
    bandai-agen.js        # createAccount orchestration → vault
  # wire into existing server/task router the same way kmart is registered

desktop/
  # Settings UI + persistence for:
  #   onlinesimApiKey, imapHost, imapPort, imapUser, imapAppPassword, imapMailbox?
  # Task types: bandai, bandai-agen
  # Reuse proxy + vault patterns from Kmart/Toymate if present
```

Mirror Kmart’s adapter registration / job-runner patterns; **copy structure, don’t copy Akamai**.

---

## 8. Build phases (execute in order)

### Phase A — Scaffold (1 PR)
- [x] Branch from `main`
- [x] `executor/otp/imapInbox.js` + unit/smoke (login IMAP, search recent mail)
- [x] `executor/otp/onlinesim.js` + smoke (`getBalance` / getNum with owner key)
- [x] Desktop Settings fields (persist locally, never log secrets)
- [x] Stub `adapters/bandai.js` `warm()` → CSRF + cookies on sticky proxy
- [x] Docs: link this handoff from PR body

**Exit:** OTP helpers proven with owner credentials; warm returns CSRF.  
_Code landed; live IMAP/OnlineSim proof still needs owner keys._

### Phase B — Account gen
- [x] Implement `bandai-agen` full flow (§5)
- [x] Password rule validator (§4.2 in research doc)
- [x] Vault schema: email, password, phone, proxyId, status, createdAt, lastLoginAt, shipping
- [x] Low concurrency (1–2); sticky proxy per attempt
- [ ] Dry-run with owner IMAP + OnlineSim until **one `ready` account**

**Exit:** ≥1 vault-ready account without manual OTP typing.

### Phase C — Login + ATC
- [x] Password login + restriction gate handling
- [x] `addToCart` + `cart/detail` with test or agen account
- [x] Stop before GE (`placeOrder:false` / no checkout POST) for first green ATC
- [ ] If ATC still 501 on ISP: pause and request HAR from owner (logged-in ATC)

**Exit:** Logged-in ATC returns JSON success (or clear next HAR ask).

### Phase D — Global-e checkout
- [x] Resolve `merchantCartToken` suffix _(best-effort from cart HTML PRELOAD)_
- [x] `POST …/checkout` → `checkoutSn` _(scaffold; stops before GE widget)_
- [ ] GE client path: prefer minimal browser/WebView for captcha+fp if HTTP fails
- [ ] `preComplete` → order number
- [ ] Document 3DS / PayPal outcomes

**Exit:** One successful test order (or intentional dry cancel) on owner account.

### Phase E — Chance + monitor (parallelizable)
- [x] `applyDraw` across vault _(single-account mode)_
- [x] Monitor poll `/api/search` + `/api/products/{code}` for availability / campaign flips
- [ ] Notify (desktop / webhook as existing product does)

---

## 9. Testing checklist

| Test | Expect |
|---|---|
| Guest `GET /api/context/member` + `X-G1-Area-Code: au` | 200 + csrfToken |
| Guest without area header | Often 500 — proves header requirement |
| IMAP waitForCode | Extracts Bandai signup code within timeout |
| OnlineSim AU number | Receives Bandai SMS (or document slug/rent fix) |
| Agen end-to-end | Vault `ready` |
| Login test account | 200; handle SMS restriction if thrown |
| ATC qty 1 | Success or typed business error (OOS / max qty) |
| Kmart smoke (regression) | Still works on same desktop build |

Use **sticky AU residential** for all Bandai tests. DC IPs may see F5 weirdness on HTML; APIs were callable from research DC with correct headers — still prefer ISP for signup/SMS trust.

---

## 10. Out of scope for v1

- Touching Kmart Akamai / SoftBlock / Playwright ladders  
- AusPost / Costco / Pokémon Centre adapters  
- BNID popup / SNS signup (email+SMS path only)  
- Solving F5 HTML challenges if API path works  
- Disney / other Global-e merchants  

---

## 11. When to ask the owner

| Situation | Ask for |
|---|---|
| ATC still 501/503 when logged in on ISP | Logged-in ATC HAR |
| `globaleMerchantCartTokenSuffix` unknown | Cart page HTML/PRELOAD snippet or HAR |
| OnlineSim never gets SMS | Try rent vs service slug; owner may need different SMS provider |
| IMAP no mail | Confirm From/Subject; spam folder; app password |
| GE captcha blocks HTTP | OK to add GE-only browser step |
| Need payment | Test card / PayPal on their GE account |

---

## 12. PR / commit hygiene

- Small PRs per phase (A → B → C → D) preferred  
- Descriptive commits; no secrets in logs or fixtures  
- Update `BANDAI_AU_MODULE.md` “open questions” as you close them  
- Reference this handoff + research doc in PR description  

---

## 13. One-paragraph prompt you can paste to the build agent

> Build Premium Bandai AU on a new branch off `main`. Do not change Kmart. Canonical site `https://p-bandai.com/au/`. Follow `executor/docs/BANDAI_BUILD_HANDOFF.md` and `executor/docs/BANDAI_AU_MODULE.md`. Phase A: shared `executor/otp/imapInbox.js` + `onlinesim.js` and Desktop Settings for OnlineSim API key + IMAP app password. Phase B: `bandai-agen` (email OTP via IMAP → SMS via OnlineSim country 61 → `registerVerification` → login → shipping vault). Phase C: login + `POST /api/cart/addToCart` with `X-G1-Area-Code: au` and CSRF. Phase D: Global-e mid 1925 checkout (browser OK for GE captcha only). Owner will provide OnlineSim key, IMAP credentials, AU sticky proxies, and a test account. No HAR yet — use JS-derived payloads; ask for HAR if ATC stays gated.

---

## 14. Quick API index (copy targets)

| Action | Method / path |
|---|---|
| CSRF | `GET /api/context/member` |
| Email OTP send/validate | `POST /api/signUp/email/auth` · `/validate` |
| Register (AU) | `POST /api/signUp/registerVerification` |
| Phone exists / SMS | `POST api/phoneNo` · `/api/phoneNo/auth` · `/validate` |
| Login | `POST /login` (form) |
| Product | `GET /api/products/{areaItemNo}` |
| Search | `GET /api/search?keyword=&offset=&limit=` |
| ATC | `POST /api/cart/addToCart` `[{areaItemNo,qty}]` |
| Cart | `GET /api/cart/detail` |
| Checkout | `POST /api/cart/{cartSn}/checkout` |
| Pre-complete | `POST /api/checkout/{checkoutSn}/preComplete` |
| Chance | `POST /api/my/campaign/apply/{sn}/applyDraw` |

Full bodies and error codes: **`BANDAI_AU_MODULE.md`**.
