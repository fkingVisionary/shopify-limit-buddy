# Premium Bandai AU — Module Research (Bandai-first)

_Date: 2026-07-18 (deep dig refresh)_  
_Status: adapter scaffolded (OTP + agen + login/ATC + GE stub) — harden with owner HAR / live OTP_  
_Why first: owner call — English bots already cover AusPost; **no known Bandai AU support** → greenfield edge on One Piece / exclusives._  
_Build: storefront `CONFIG_DATA.buildVersion=2.20260716` (2026-07-16)_

**Runtime contract (if checkout breaks):** [`BANDAI_CHECKOUT_BIBLE.md`](./BANDAI_CHECKOUT_BIBLE.md)

Canonical storefront: **`https://p-bandai.com/au/`**  
(Do not use `www.bandai.com.au` — cert mismatch.)

---

## 1. Executive summary

Premium Bandai AU is a **Vue 3 + Vite SPA** with a clean same-origin REST API, **Bandai Namco ID (BNID)** auth, and **Global-e** (merchant **1925**) for payment. Edge is **CloudFront + F5 Distributed Cloud (`volt-adc`, `TS*` cookies)** — not Hyper-native — but **catalog/cart JSON is callable** once session headers are correct.

Two buy modes:
1. **FCFS / PreOrder ATC** → cart → Global-e checkout  
2. **Chance to Buy** raffle (`POST /api/my/campaign/apply/{sn}/apply{campaignType}`) → Chance uses **`applyDraw`** → later purchase window for winners  

**Account generation is required** — `maxByPerUser` often 1 and Chance both scale on BNID/email accounts; AU forces **email + SMS** (`multiAuth: true`).

**This dig closed several prior open questions from JS alone** (login field names, signup DTO, AU address map, checkout `items` shape, GE captcha/fingerprint, full agen flow). Remaining blocker for build is still a **logged-in AU ISP HAR** (ATC + GE; ideally one signup too).

Competitive angle: APIs and payload shapes are largely reverse-engineered from public JS. A working module here is differentiation.

---

## 2. Stack map

| Layer | Tech | Notes |
|---|---|---|
| CDN / ADC | CloudFront + **volt-adc** (F5 XC / Volterra) | `TS01*` cookies; some `/item/*` HTML returns obfuscated bot script |
| App | Vue 3 + Vite, axios `baseURL: "/"` | Routes under `/:areaCode(au)/…` |
| Auth | **BNID** popup OAuth-ish + local `POST /login` | `clientId=AdJPb1GyRxvcncEObNvdcYUHeFX6SAIBeoTcRXmb` |
| Catalog / cart | REST `/api/*` | Header-gated by area code |
| Pay | **Global-e** mid **1925** | `gem-bandai.global-e.com`, `web-bandai.global-e.com`, `web.global-e.com`, `webservices.global-e.com` |
| Personalization | AWS Personalize | `perso.pbandai-glb.com`, `int.pbandai-glb.com` (non-checkout) |
| Consent | OneTrust | |
| Analytics | GTM `GTM-W8T227C` | |
| Limits | Per product `maxByPerOrder` / `maxByPerUser` | Often **1** on OP cards |
| AU area settings | `multiAuth: true`, `ageLimit: 18` | SNS: Facebook, Google, BNID |

### Required API headers (axios interceptor)

```
Accept: application/json, text/plain, */*
Content-Type: application/json          # for JSON POSTs
Accept-Language: en                     # locale helper
X-G1-Area-Code: au                      # pathname segment [1]
X-CSRF-TOKEN: <from GET /api/context/member>
X-Requested-With: XMLHttpRequest
Referer: https://p-bandai.com/au/...
Origin: https://p-bandai.com
Cookie: SESSION=…; TS…=…; GlobalE_Data=…
```

Without `X-G1-Area-Code`, most endpoints return **HTTP 500**.  
`GET /api/context/member` works guest and returns `{ csrfToken, loadTime }`.  
Homepage also injects `USER_DATA.csrfToken` + `ENV_DATA.globaleMid=1925`.

---

## 3. Auth — Bandai Namco ID (fields confirmed)

### Password login (UI → API)

From `LoginWidget` inside `pageBuilder-*.js` and `memberLoginService-*.js`:

```
POST /login
Content-Type: application/x-www-form-urlencoded

grantType=password
&memberId=<email>          # UI maps memberId: b.mail  (email IS the memberId)
&password=<password>
&saveLoginId=false
&autoLogin=false
```

`qs.stringify` via `index-*.js` — body is `grantType=${e}&${stringify(fields)}`.

**Response 200 headers:**
- `x-csrf-token` → update jar / axios token
- `x-restricted-type` → gate redirects (see below)

### SNS / BNID login

```
POST /login
grantType=sns&snsToken=…&snsType=BNID   # (+ other sns fields as returned)
```

**BNID popup**
```
https://account.bandainamcoid.com/login.html
  ?client_id=AdJPb1GyRxvcncEObNvdcYUHeFX6SAIBeoTcRXmb
  &redirect_uri={origin}/login-result?areaCode=au
  &backto={origin}/au/login
```
- Popup calls `window.bnidLoginResult(data)` → `snsToken`
- Optional: `GET /api/member/bnid/user?token={snsToken}` → `{ userID, mail1, birthday, gender }`

**Logout:** BNID logout popup + `POST /login/logout-perform`

### Restricted post-login gates

| `x-restricted-type` | Redirect |
|---|---|
| `TemporaryPassword` | `/login/resetpassword/edit` |
| `SMSVerificationOutdated` / `SMSVerificationPending` | `/login/sms/auth` (fires `POST /api/phoneNo/multiAuth`) |
| `TermsPending` / `TermsOutdated` | `/agreement` |
| (none / `NoRestriction`) | continue |

AU has **`multiAuth: true`** → expect SMS verification on many accounts.

### Signup DTO (from Pinia/store in `FooterGlobal`)

Default `signUpData` shape posted via `POST /api/signUp/register` / `registerVerification`:

```js
{
  memberId: "",              // set = emailAddress
  memberPassword: "",
  emailAddress: "",
  name: { name1, name2, name3?, name4? },   // first / last
  phone1: { countryNo, phoneNo, countryNoName? },
  address: { countryCode, zipCode, address1, address2, address3, address4, address5 },
  homeAddress: { areaCode, homeAddressArea, homeAddressDetail? },
  gender: "",                // Male | Female | NotApplicable | NotSelected
  dobYear, dobMonth, dobDay,
  multiAuth: false,
  marketingConsent: {
    marketingPreference1, marketingPreference2, marketingPreference3
    // preference4 appears in UI for non-FR areas
  },
  termsAgreeList: [{ termsCode: "termsofuse", version, areaCode, agree: true }],
  // after SMS: smsAuthInfo: { authSn, authResultCode }
  // SNS path also: snsType, snsMemberId, snsToken
}
```

**Signup flow APIs**
| Method | Path | Notes |
|---|---|---|
| POST | `/api/signUp/email/auth` | Send email code; stores `{email, authCode}` |
| GET | `/api/signUp/email/auth` | Retrieve pending auth |
| POST | `/api/signUp/email/validate` | Validate code |
| POST | `/api/signUp/register` | Skip-verification path |
| POST | `/api/signUp/registerVerification` | Full verified register |
| POST | `api/signUp/sns/check` | SNS account exists? |

After register, UI auto-logs in:
`login({ memberId, password: memberPassword, saveLoginId:false, autoLogin:false })`.

---

## 4. Account generation module (required)

**Yes — build this.** Bandai scales on accounts, not on cart qty:

| Constraint | Implication |
|---|---|
| `maxByPerUser` / `maxByPerOrder` often **1** | One checkout unit per account per SKU |
| Chance to Buy | Entry pool = account pool |
| AU `multiAuth: true` | Every new AU account needs **email + SMS** |
| Phone uniqueness | `POST api/phoneNo` → `{ exists: true }` blocks reuse |

Treat gen as a **first-class task type** (`bandai-agen` / vault filler), not a one-off script. Monitor can ship without it; ATC / Chance / pay cannot scale without it.

### 4.1 End-to-end AU signup flow (from JS)

Routes: `/register` → `/register/mailaddress/auth` → `/register/memberregistration` → `/sms/auth` → `/register/confirm` → `/register/complete`

```
1. Warm          GET /au/ + GET /api/context/member  → SESSION, TS*, CSRF
2. Email code    POST /api/signUp/email/auth
                   { email, agreeAgeTerms: true }          # resend adds resend:true
                 ← { authSn, expireMinutes, … }  (stored client-side as authCode)
3. Verify email  POST /api/signUp/email/validate
                   { authCode: "<6digit>", authSn }
                 ← auth result; UI sets memberId = emailAddress = email
4. Profile form  Collect name, homeAddress, phone1, DOB (≥18), gender, password,
                 marketingConsent, termsAgreeList
5. Phone unique  POST api/phoneNo   body = phone1 { countryNo, phoneNo }
                 ← { exists: bool }  — if true → PHONE_NUMBER_DUPLICATED
6. Terms         GET /api/terms/termsofuse
                 ← { termsCode, termsVersion, areaCode, … }
                 UI: termsAgreeList=[{ termsCode:"termsofuse", version, areaCode, agree:true }]
                 Live AU: termsCode=termsofuse, termsVersion=1.7 (as of probe)
7. SMS (AU)      Because multiAuth=true:
                 POST /api/phoneNo/auth  { phoneNo: { countryNo, phoneNo } }
                 ← { authSn, expireMinutes, expiredDt, … }
                 User/SMS provider enters code
                 POST /api/phoneNo/validate  { authCode, authSn }
                 ← smsAuthResult → attached as smsAuthInfo { authSn, authResultCode }
8. Register      POST /api/signUp/registerVerification   body = full signUpData
                 (skip-SMS path exists: POST /api/signUp/register — NOT used for AU)
9. Auto-login    POST /login  grantType=password&memberId=email&password=…&saveLoginId=false&autoLogin=false
10. Optional     POST /api/my/shippingAddresses  (shipping profile for checkout)
                 PUT  /api/cookie/consent / POST /api/terms/consent as needed
```

**BNID/SNS alternate:** popup → `GET /api/member/bnid/user?token=` → `POST api/signUp/sns/check` → prefill → same SMS/confirm path → `snsLogin`. Lower priority for agen (harder to automate BNID than email+SMS).

### 4.2 Password rules (signup `input-password`)

| Rule | Detail |
|---|---|
| Length | **> 7** and `maxlength=20` |
| No triple repeat | ban `(.)\1{2,}` (e.g. `aaa`) |
| No sequential runs | 3+ ascending/descending letters or digits |
| Not email local-part | password must not contain `email.split("@")[0]` |
| Char classes (AU/non-TW) | upper + lower + number + symbol (half-width) |
| Encoding | half-width only |

### 4.3 OTP providers (user-supplied — shared across modules)

Agen does **not** ship with SMS/email credentials. The user pastes providers in Desktop **Settings** (same pattern as license `apiKey`); secrets stay local and are passed into agen tasks. This stack is **store-agnostic** — Bandai first, then AusPost / Target / others reuse the same helpers.

| Setting (planned) | Purpose |
|---|---|
| `smspoolApiKey` | [SMSPool](https://www.smspool.net/) API key (preferred) — Bandai service `1733`; AU signup accepts **US/UK** numbers |
| `smspoolCountry` | `GB` (default, cheaper) or `US` |
| `onlinesimApiKey` | [OnlineSim](https://onlinesim.io) API key — optional AU fallback |
| `imapHost` / `imapPort` | Mailbox for signup email OTP (e.g. `imap.gmail.com:993`) |
| `imapUser` | Full email address used as Bandai `memberId` |
| `imapAppPassword` | Provider **app password** (not the normal login password) |
| `imapMailbox` | Optional folder (default `INBOX`) |

#### Email OTP — IMAP app password

```
agen requests Bandai email code
  → POST /api/signUp/email/auth { email: imapUser, agreeAgeTerms: true }
  → poll IMAP (IDLE or short poll) for message from Premium Bandai / p-bandai
  → extract 6-digit (or documented) auth code + match authSn window
  → POST /api/signUp/email/validate { authCode, authSn }
```

Notes:
- Prefer **dedicated mailboxes** (or a pool) over public catch-alls; app passwords are the supported automation path (Gmail/Outlook/etc.).
- One mailbox can often create one Bandai account (`memberId` = email). For pools, either many IMAP accounts or a catch-all domain with unique local-parts **if** Bandai accepts them (confirm in HAR — open question).
- Shared helper: `otp/imapInbox.js` → `waitForCode({ from?, subject?, regex, since, timeout })`.

#### SMS OTP — SMSPool (preferred) + OnlineSim fallback

**Preferred:** [SMSPool](https://www.smspool.net/article/how-to-use-the-smspool-api-0dd6eadf4c) — users paste their own API key in Desktop Settings.

- Named service **Bandai = `1733`**
- AU Bandai accepts **US (`country=1`)** and **UK (`country=2`)** numbers (owner-validated). Default country **GB** (cheaper pools).
- Purchase `POST /purchase/sms` → poll `/request/active` (or `/sms/check`) → cancel unused via `/sms/cancel`
- Helper: `otp/smspool.js` → `acquireNumber` / `waitForSms` / `release`

**Fallback:** OnlineSim AU rent/activation (`otp/onlinesim.js`, country `61`) when no SMSPool key is set.

**Risks to budget for:** virtual-number blocks, pool stock gaps, `SmsRateLimitExceeded`, phone uniqueness forever on Bandai (`exists: true`). Do not blast signups — one careful test at a time.

#### Reuse for future store modules

```
executor/otp/
  imapInbox.js      # app-password IMAP OTP waiter
  smspool.js        # SMSPool purchase + SMS poll + cancel (preferred)
  onlinesim.js      # OnlineSim AU fallback
adapters/<store>-agen.js   # store-specific signup; calls otp/*
desktop Settings    # smspoolApiKey + IMAP fields (one place for all agen)
```

Any future agen (AusPost MyPost, Target, etc.) plugs the same Settings + `otp/*` and only swaps the store’s request/validate endpoints / code regex.

### 4.4 External dependencies (agen stack)

| Dependency | Why | Notes |
|---|---|---|
| **SMSPool API key** (user) | SMS OTP (US/UK) | See §4.3; service `1733` |
| **OnlineSim API key** (user, optional) | AU SMS fallback | country `61` |
| **IMAP + app password** (user) | Email OTP | Same mailbox becomes `memberId` unless pool strategy differs |
| **Sticky AU ISP/residential proxy** | Edge + geo consistency | Same class as checkout tasks |
| **Identity data** | Name, DOB ≥18, AU home address | Synthesize; keep consistent with shipping |
| **Account vault** | Store email/pass/phone/member status/SMS-cleared | Shared with checkout + Chance |

### 4.5 Error codes agen must handle

| Code / signal | Stage | Action |
|---|---|---|
| Email `detail` / already registered | email auth | Mark email burned; next |
| `TooManyRequest` / mail resend limit | email | Backoff |
| `MemberAuthCodeExpired` / mismatch | email/SMS validate | Resend or fail attempt |
| `MemberAuthLimitExceeded` | validate | Kill attempt → cool account/IP |
| `PHONE_NUMBER_DUPLICATED` / `exists:true` | phone check | Next phone / new OnlineSim number |
| `SmsRateLimitExceeded` / `TOO_MANY_REQUEST` | SMS send | Backoff; rotate number/IP |
| `SMS_AUTH_FAIL` | SMS send | Retry / fail |
| OnlineSim `WARNING_LOW_BALANCE` / `ERROR_WRONG_KEY` | SMS provider | Surface to user; stop batch |
| OnlineSim timeout (no SMS in window) | SMS poll | `setOperationOk`/cancel; retry new number |
| IMAP auth failure / no mail | email poll | Surface bad app password / host; stop |
| Post-login `x-restricted-type` | login | Complete SMS/terms/temp-password gates before vaulting as “ready” |

### 4.6 Module shape (executor / desktop)

```
executor/otp/imapInbox.js      # shared — waitForCode via IMAP app password
executor/otp/onlinesim.js      # shared — acquire AU number, waitForSms, release

adapters/bandai-agen.js
  warm()
  requestEmailCode(email)       # Bandai API
  verifyEmail(authSn, code)     # code ← otp/imapInbox
  buildProfile({ name, phone, address, dob, password })
  ensurePhoneUnique(phone1)
  loadTerms("termsofuse")
  requestSmsCode(phone1)        # Bandai API; phone ← otp/onlinesim
  verifySms(authSn, code)       # code ← otp/onlinesim
  registerVerification(signUpData)
  loginPassword(email, password)
  ensureShippingAddress(addr)
  vault.save({ status: "ready"|"needs_sms"|"banned", … })
```

Desktop: Settings holds `onlinesimApiKey` + IMAP fields; task type **`bandai-agen`** reads them, batch N, low concurrency.

### 4.7 Readiness definition (“vault ready”)

An account is **checkout/Chance ready** only when:
1. `registerVerification` succeeded  
2. Password login returns 200 with **no** blocking `x-restricted-type` (or gates cleared)  
3. Shipping address present (for GE ship)  
4. Phone/SMS verified (AU multiAuth)

### 4.8 Ordering vs other Bandai phases

| Phase | Depends on agen? |
|---|---|
| Monitor | No |
| **Account gen** | — (parallel with monitor) |
| ATC dry-run | Yes (at least 1 ready account) |
| Chance pool | Yes (many ready accounts) |
| GE pay | Yes + payment instruments |

HAR day should also capture **one full signup** (email+SMS+registerVerification) if possible — validates payloads better than JS alone.

---

## 5. Shipping address (AU field map)

**CRUD (login required)**
| Method | Path |
|---|---|
| GET | `/api/my/shippingAddresses` |
| GET | `/api/my/shippingAddresses/{sn}` |
| POST | `/api/my/shippingAddresses` | body = address object |
| PUT | `/api/my/shippingAddresses/{shippingAddressSn}` |
| DELETE | `/api/my/shippingAddresses/{sns joined by comma}` |

**Object posted** (from `ShippingAddressInfo`):
```js
{
  shippingAddressSn?,          // edit only
  name: { name1, name2, … },
  phone1: { countryNo, phoneNo },
  address: {
    countryCode,               // "AU"
    zipCode,                   // 4 digits for AU
    address1,                  // line 1 (required)
    address2,                  // line 2 (optional)
    address3,                  // city/suburb (Text for AU)
    address4,                  // NotUse for AU → ""
    address5                   // state/province Select for AU
  },
  areaCode                     // derived from country → "AU"
}
```

**AU `addressSetting` (live):**
```json
{
  "address5": "Select",   // state/province dropdown (NSW, VIC, …)
  "address4": "NotUse",
  "address3": "Text",     // city/suburb free text
  "zipCode": true         // required, length 4
}
```

Zip autocomplete: `GET /api/address/global?langCode=en&countryCode=AU&zipCode=2000`  
→ `{ country, zipCode, state, city, formattedAddress }` — UI fills `address3=city`, `address5=state`.

**Public address helpers (guest OK)**
| Method | Path | Notes |
|---|---|---|
| GET | `/api/address/homeAddress` | ISO country list for home |
| GET | `/api/address/address` | Shipping countries + states + settings |
| GET | `/api/address/countryNumber` | Dial codes (`+61`, …) |
| GET | `/api/address/global` | Zip → city/state |
| GET/POST | `/api/platformSettings/blockShippingAreas/checkPattern/{country}` | Undeliverable patterns |

---

## 6. API surface

### Session / context
| Method | Path | Guest? | Notes |
|---|---|---|---|
| GET | `/api/context/member` | ✅ | CSRF seed |
| GET | `/api/context/member/refresh` | login | After login |
| GET | `/api/context/staff` | | Staff |
| POST | `/api/context/locale?_lc=` | | Locale |
| GET | `/api/cart/summary` | ✅ | `{ totalItemCount }` |
| GET | `/api/customerAreas` | ✅ | Per-area age/SNS/multiAuth |
| GET | `/api/member/infoForPage` | login | |
| GET | `api/member/token/refresh` | login | |

### Catalog / monitor (guest OK — Phase 1)
| Method | Path | Notes |
|---|---|---|
| GET | `/api/search?keyword=&offset=&limit=` | Primary monitor. Nested: `productResults.products[]` |
| GET | `/api/search/suggestions?keyword=` | Autocomplete strings |
| GET | `/api/search/topSearched` | Live trends (OP often #1) |
| GET | `/api/search/bulk` | Bulk |
| GET | `/api/products/{productCode}` | Full PDP JSON |
| GET | `/api/products/content/{code}/{…}` | Extra content |
| GET | `/api/brand?offset=&limit=` | Brand list (**offset required**) |
| GET | `/api/brand/{urlKeyword}` | e.g. `onepiececardgame` |
| GET | `/api/brand/{kw}/relatedSeries` | |
| GET | `/api/series/list` · `/popular` · `/alphabet` · `/top/{kw}` | |
| GET | `/api/category` | AU categories |
| GET | `/api/shop?offset=&limit=` · `/api/shop/{kw}` | Tamashii etc. |
| GET | `/api/display/feature` · `/{id}` · `/{id}/items` | Feature merchandising |
| GET | `/api/news` · `/emergency` · `/filters` · `/content/{sn}` | Site notices |
| GET | `/au/sitemap-product_1.xml` | ~486 product URLs |

**Wrong paths (404):** `/api/products/search`, `/api/campaigns`, `/api/address/country`, bare `/api/cart`, `/api/wishlist`, `/api/series` (use `/series/list`).

### Product detail fields that matter for bots

Top-level on `GET /api/products/{productCode}`:
- `purchaseAvailable` (bool) — **gate for ATC button**
- `flags[]` — short codes: `PRE_ORDER`, `PRE_ORDER_CLOSED`, `OUT_OF_STOCK`, …
- `areaItemNos[]` → **`areaItemNo` for ATC** (e.g. `NAI0871504AU`)
- `areaItemToItemCode`, `areaItemInventoryInfoMap` (per-item stock map)
- `productDescriptionSection.productLimitedQuantityInfo.maxByPerOrder|maxByPerUser`
- `infoSection.quantityInfo.minQuantity|maxQuantity`
- `infoSection.generalProdInfo.availabilityStatus` — `On` \| `End` \| …
- `infoSection.orderInfo` — `orderStartDate`, `orderEndDate`, `preOrderStatus` (`InProgress`, `End`, …)
- `infoSection.campaignInfo`:
  - `applyForCampaignYn`
  - `campaignStatus`: `ApplyForCampaign` \| `PlaceOrdered` \| `PurchasePeriodEnds` \| `SoonAvailable`
  - `campaignUrl`, `winner`, `purchaseAvailable`, `announcementDt`, purchase window dates
- `infoSection.productFlags[]` — `{ labelCode, labelName }` (UI badges)

Search list cards also expose `saleStatus`, `productType` (`PreOrder`), `fixedListPrice`, windows — useful for cheap polling before hitting PDP.

**Live sample (probe day):**
| SKU | Status | Flags | Notes |
|---|---|---|---|
| `N2903432003` | availability `On` | `OUT_OF_STOCK` | Window into 2026-07-31; qty max 1; good dry-run when restocked |
| Many OP | `End` | `PRE_ORDER_CLOSED` | Ignore |

### Cart
| Method | Path | Body / notes |
|---|---|---|
| POST | `/api/cart/addToCart` | **Array**: `[{ areaItemNo, qty, eventPickupSpecifiedPickupSn? }]` |
| GET | `/api/cart/detail` | Primary cart |
| PUT | `/api/cart/modifyCartItem` | `?cartItemSn=&qty=` |
| DELETE | `/api/cart/removeCartLineItems` | `?cartLineItemSns=` |
| POST | `/api/cart/{cartSn}/checkout` | see Checkout |
| GET | `/api/cart/byCartSn/{sn}` | |
| POST | `/api/cart/byCartSn/{sn}/couponCodes` | `?couponCode=` + body |
| POST | `/api/cart/byCartSn/{sn}/estimateBenefits` | `{ coupons[], items:[{cartItemSn}] }` |

**ATC call site** (`Items-*.js`):
```js
await cartService.addToCart([{
  areaItemNo: "...",           // e.g. NAI0871504AU
  qty: chosenQuantity,
  eventPickupSpecifiedPickupSn: optional
}]);
// response used as: R.items[].addedNewCart, R.totalCartCount
```

**ATC error codes** (map to UI strings):
- `CouldNotAddToCartByMaxPurchaseQty`
- `CouldNotAddToCartByOutOfStock`
- `CouldNotAddToCartByPreallocation`
- `CouldNotAddToCartByEndOfSale`
- `CouldNotAddToCartByMinPurchaseQty`
- `CouldNotAddToCartBySuspendedItem`

**DC probe note:** guest `POST /api/cart/addToCart` → **501 HTML “PAGE NOT AVAILABLE”**. `/api/my/*` as guest → **503 “NETWORK CONGESTION” HTML**. **Must confirm ATC with logged-in AU ISP session in HAR.**

### Chance to Buy / campaigns
| Method | Path | Notes |
|---|---|---|
| GET | `/api/campaign/list?offset=&limit=` | Active (empty at probe) |
| GET | `/api/campaign/past?offset=&limit=` | Past promos |
| GET | `/api/campaign/detail/{campaignUrl}` | Full campaign; `applyGroupUse`, dates |
| GET | `/api/campaign/detail/{id}/items` | `?offset&limit&applyGroupNo` |
| POST | `/api/my/campaign/apply/{campaignSn}/apply{Type}` | Body `{ applyGroupNo: number\|null }` · **login required** |
| GET | `/api/my/campaign/applied/products` | History `?filter&offset&limit` |
| PUT | `/api/my/campaign/apply/{sn}/applyDraw/cancel` | Body `{ applyGroupNo }` |

`apply{Type}` is **`campaignType` concatenated** — Chance uses **`Draw`** →  
`POST /api/my/campaign/apply/{sn}/applyDraw`.  
Coupon-style campaigns return `couponMgmtCode` and redirect to coupon acquisition.

UI: `applyForCampaignAndRedirect(sn, url, campaignType, applyGroup?)`  
Login required; `TradingHalts` members blocked (`STOPPED_TRANSACTION_MEMBER`).  
Winners UX: `/mypage/chancetobuy`; apply under `/hotdeals/{campaignUrl}`; `?autoApply=true` supported.

### Checkout → Global-e
From `Cart-*.js` + `Checkout-*.js`:

1. Must be logged in; then `GEM_Components.ExternalMethodsComponent.IsOperatedByGlobalE(cb)`
2. Build token:  
   `merchantCartToken = `${cartId}_Checkout_${PRELOAD_DATA.globaleMerchantCartTokenSuffix}``  
   (suffix minted into cart-page PRELOAD — **confirm in HAR**)
3. Checkout POST:
```js
POST /api/cart/{cartSn}/checkout
{
  merchantCartToken,
  shippingAreaCode,          // from shipping-area checkbox UI
  defaultAreaCode,           // optional if "use as default" checked
  items: [{ cartItemSn }]    // one per selected line — NOT areaItemNo
}
→ { checkoutSn, … }
```
4. `sessionStorage.bsp_checkout_sn = checkoutSn`; navigate `/orderdetails`
5. DOM attribute `merchantcarttoken=…`; wait for `window.glegem` / GE client (mid 1925)
6. On GE step `CONFIRMATION` + `IsSuccess`:
```js
POST /api/checkout/{checkoutSn}/preComplete
{
  globaleOrder: {
    success, orderId, merchantOrderId, authCode, stepId,
    details: { /* GE order details blob */ }
  }
}
→ { orderNo } → /ordercomplete/{orderNo}
```

### Orders / account (login)
| Method | Path |
|---|---|
| GET | `/api/my/order/list` |
| GET | `/api/my/order/{id}` · `/{id}/basic` |
| PUT | `/api/my/order/{id}/changeShipping` |
| POST | `/api/my/cancellation/draft/{id}` |
| POST | `/api/my/order/{id}/eventPickup/token` |
| PUT | `/api/my/mine` | Profile update |
| GET/POST/DELETE | `/api/my/product/wish` · `/wish/{productCode}` |
| GET | `/api/my/wishList/products|brands|series|shops` |
| GET/POST | `/api/my/coupon/…` | Click-coupon issue |

### SMS / phone
| Method | Path |
|---|---|
| POST | `api/phoneNo` | Exists check |
| POST | `/api/phoneNo/auth` · `/authUpdate` | Send code |
| POST | `/api/phoneNo/validate` | |
| POST | `/api/phoneNo/multiAuth` | Login SMS gate |
| GET | `api/phoneNo/last2Digits` | |

### Password reset
| Method | Path |
|---|---|
| POST | `/api/member/passwordReset/email/auth` · `/validate` |
| PUT | `/api/member/passwordReset/reset` · `/temporary/reset` |
| GET | `/api/member/passwordReset/currentMemberId` |

### CMS
| Method | Path | Notes |
|---|---|---|
| GET | `/api/cms/pageModel/GlobalPage/Login` | Login CMS tree (LoginWidget) |
| GET | `/api/cms/page/{pageCode}` | Generic CMS |

---

## 7. Global-e (mid 1925) — client dig

**Bootstrap**
```html
<script src="//gem-bandai.global-e.com/includes/js/1925"></script>
```
CONFIG also exposes:
```json
"globaleConfig": {
  "jsCdnUrl": "//gem-bandai.global-e.com/includes/js/",
  "cssCdnUrl": "//gem-bandai.global-e.com/includes/css/"
}
```
`ENV_DATA.globaleMid = 1925`

**Hosts seen in gem + clientsdk**
- `gem-bandai.global-e.com` — GEM bundle (~305KB for mid 1925)
- `web.global-e.com/merchant/clientsdk/1925` — `GEClient`
- `web-bandai.global-e.com`
- `webservices.global-e.com`
- `services.global-e.com`, `utils.global-e.com`
- Analytics: `globale-analytics-sdk.global-e.com`

**Fraud / bot signals in client (no HAR yet)**

| Signal | Present in JS? | Notes |
|---|---|---|
| **Cart-token captcha** | ✅ | `IsCaptcha` on cart-token response; injects HTML with `.h-captcha` + renders via `window.grecaptcha` (GE hybrid). Sitekey comes from injected HTML `data-sitekey` — not hardcoded. `CaptchaSdkUrl` loaded dynamically. |
| **FingerprintJS** | ✅ | `GEClient.InitFingerprint` → `Scripts/Fingerprint/fingerprint.js`; visitorId as `fpId` query on checkout. Gated by MPH flag `FT_CheckoutFingerprintMechanismEnabled`. |
| **Forter** | ❌ not in gem/clientsdk strings | Still confirm in live checkout HAR (often loaded late / differently named) |
| **ThreatMetrix / Sift / PX / DataDome** | ❌ | Not in these bundles |

**Queueing:** GE cart-token can return `Queued` + poll hash — expect drop-day queue behaviour.

**Module implication:** Phase 4 likely needs browser (or at least captcha + fingerprint) for GE; HTTP-only through ATC/Chance may still be viable.

---

## 8. Protections & what Hyper helps with

| Control | Present? | Hyper? | Strategy |
|---|---|---|---|
| F5 / Volterra ADC | Yes (`volt-adc`, `TS*`) | ❌ | Good TLS + cookies from `/au/` warm; browser if HTML challenges |
| Item HTML obfuscation | Sometimes | ❌ | Prefer **API** over scraping `/item/{code}` HTML |
| CSRF | Yes | N/A | `/api/context/member` every session |
| Login wall on cart/my | Yes (501/503 pages) | N/A | BNID session first |
| Per-user qty | Yes | N/A | Multi-account |
| AU SMS multiAuth | Yes | N/A | Pre-verify accounts |
| Global-e captcha + fp | Yes | ❌ (not CF/Akamai) | Browser GE or dedicated solve TBD |
| Chance raffle | Product feature | N/A | Separate “entry” task type |

Akamai/DataDome **not** observed as primary on Bandai AU.

---

## 9. One Piece / drop modes

| Mode | When | Bot job |
|---|---|---|
| **PreOrder FCFS** | `purchaseAvailable`, sale window open, not OOS | Monitor → ATC → checkout → GE pay |
| **In-stock FCFS** | Rare on PB exclusives | Same |
| **Chance to Buy** | `campaignInfo.applyForCampaignYn` + status `ApplyForCampaign` | Login → `applyDraw` across accounts → alert winners → purchase in window |
| **Ended** | `availabilityStatus=End` / `PRE_ORDER_CLOSED` | Ignore / archive |

Public context: Jan 2026 FCFS anniversary drop caused chaos → March 2026 Chance program for several English reprints. **Module must support both modes.**

Live `topSearched` (probe): `one piece`, `30th celebration`, `black bolt`, `pitch black`, …

---

## 10. Proposed module phases (build when ready)

### Phase 0 — Local HAR day (blocker)
On **desktop + AU residential/ISP**:
1. BNID/password login (one real account) — capture `POST /login` form body + Set-Cookie
2. Ideally: **one full signup** (email code → SMS → `registerVerification`) for agen payloads
3. Find any `purchaseAvailable:true` SKU (or wait for restock of `N2903432003`)
4. Capture: `POST /api/cart/addToCart` (confirm array body + cookies + response JSON)
5. Capture: cart detail → checkout POST → Global-e network (captcha sitekey, Forter?, fingerprint)
6. If any Chance open: capture `applyDraw`
7. Note `globaleMerchantCartTokenSuffix` from cart PRELOAD
8. Save HAR → slim like Kmart pipeline

### Phase 1 — Monitor (ship first, low risk)
- Poll `/api/search` + `/api/products/{code}`
- Detect `purchaseAvailable` / `flags` / campaign status flips
- Webhook / desktop notify
- No pay; proves headers + TLS + proxy

### Phase 1b — Account generation (parallel with monitor)
- Task type `bandai-agen`: **IMAP app password** (email OTP) + **OnlineSim API key** (AU SMS) → `registerVerification` → vault
- Shared `executor/otp/{imapInbox,onlinesim}.js` (reuse for future store agen)
- Desktop Settings: user pastes OnlineSim key + IMAP host/user/app password
- Enforce password rules, unique phones, terms version, post-login gate clearance
- Seed shipping addresses on ready accounts
- See §4 — **required before ATC/Chance scale**

### Phase 2 — ATC dry-run
- Login: `grantType=password` with `memberId=email`
- `addToCart` + `cart/detail` assert
- `placeOrder:false` stop before GE

### Phase 3 — Chance entry pool
- Multi-account `applyDraw` from agen vault
- Deduped history via `applied/products`
- Winner watch → human or auto purchase handoff

### Phase 4 — Global-e checkout
- Hardest: hosted GE + captcha + fingerprint (+ possible 3DS)
- May need Playwright handoff for GE only (HTTP through ATC)

### Out of scope initially
- AusPost (parked — competitors exist)
- Disney Global-e until Bandai GE works
- Solving F5 HTML challenges unless API path fails on ISP
- BNID popup signup automation (email+SMS path first)

---

## 11. Executor integration sketch

```
antibot.js               # no Bandai vendor yet — TLS/jar only
executor/otp/
  imapInbox.js           # SHARED agen — IMAP app-password OTP waiter
  onlinesim.js           # SHARED agen — OnlineSim AU number + SMS poll
adapters/bandai.js       # matches p-bandai.com
  warm()                 # GET /au/ → SESSION + TS* + CSRF
  login()                # POST /login grantType=password|sns
  createAccount()        # agen: IMAP email OTP → OnlineSim SMS → register → shipping
  getProduct(code)
  addToCart([{areaItemNo, qty}])
  checkout(cartSn, merchantCartToken, shippingAreaCode, items:[{cartItemSn}])
  applyChance(campaignSn, applyType='Draw', applyGroupNo?)
  # pay via GE — phase 4
```

Desktop Settings (planned): `onlinesimApiKey`, `imapHost`, `imapPort`, `imapUser`, `imapAppPassword` — shared by all future `*-agen` tasks.  
Task types: `bandai`, **`bandai-agen`**, alongside `kmart`. Proxy sticky AU; shared account vault.

Hyper allowlist (if any later): `p-bandai.com`, `account.bandainamcoid.com`, `*.global-e.com`, `onlinesim.io`.

---

## 12. Open questions (updated)

### Closed this dig (JS + guest API)
- [x] Exact `POST /login` field names → `memberId` (=email), `password`, `saveLoginId`, `autoLogin`
- [x] Signup / shipping address DTO shapes + **full agen step sequence**
- [x] Password rules, phone uniqueness check, AU terms `termsofuse` v1.7
- [x] Checkout `items: [{ cartItemSn }]` (not areaItemNo)
- [x] `merchantCartToken` formula (`${cartId}_Checkout_${suffix}`)
- [x] ATC success fields used by UI (`items[].addedNewCart`, `totalCartCount`)
- [x] GE: captcha on cart-token path + FingerprintJS; **no Forter string** in gem/clientsdk
- [x] Public monitor endpoint matrix (search, suggestions, topSearched, products, brand, series, …)
- [x] AU address field mapping (zip4, address3=city text, address5=state select)
- [x] AU `multiAuth: true`

### Still need HAR / live account
- [ ] Full signup HAR (email + SMS + `registerVerification` response)
- [ ] IMAP: which From/Subject patterns Bandai uses; +tag / catch-all acceptance
- [ ] OnlineSim: rent vs named slug for Bandai SMS; whether AU virtual numbers are accepted
- [ ] OnlineSim stock / price for country `61` under a live key
- [ ] Does guest ATC ever work, or is login mandatory? (DC says login/edge)
- [ ] Full `addToCart` response JSON
- [ ] How / when `globaleMerchantCartTokenSuffix` is minted into PRELOAD
- [ ] Live captcha sitekey + whether Forter loads at payment step
- [ ] Chance `applyGroupNo` semantics when `applyGroupUse=true`
- [ ] Whether Volterra challenges appear on ISP for API POSTs
- [ ] Rate limits / 503 under real drop load
- [ ] 3DS / ApplePay / PayPal express behaviour on mid 1925 AU

---

## 13. Probe log (DC, 2026-07-18)

| Call | Result |
|---|---|
| GET `/au/` | 200 SPA + CONFIG (`globaleMid=1925`, bnidConfig, build `2.20260716`) |
| GET `/api/context/member` + area header | 200 CSRF |
| GET `/api/search?keyword=ONE PIECE` | 200 `productResults.products` |
| GET `/api/search/suggestions?keyword=one` | 200 string list |
| GET `/api/search/topSearched` | 200 (OP #1) |
| GET `/api/products/N2903432003` | 200 On + OUT_OF_STOCK, maxQty 1 |
| GET `/api/cart/summary` | 200 `{totalItemCount:0}` |
| POST `/api/cart/addToCart` (guest, DC) | **501** PAGE NOT AVAILABLE |
| GET `/api/my/*` (guest) | **503** NETWORK CONGESTION HTML |
| GET `/api/campaign/list` | 200 `[]` |
| GET `/api/campaign/past` | 200 past Campaign-type promos |
| GET `/api/brand?offset=0&limit=5` | 200 |
| GET `/api/brand/onepiececardgame` | 200 |
| GET `/api/series/list` · `/popular` | 200 (OP in popular) |
| GET `/api/address/address` · `/global?…zip=2000` | 200 AU settings + autocomplete |
| GET `/api/customerAreas` | 200 AU `multiAuth:true` |
| GET `/api/cms/pageModel/GlobalPage/Login` | 200 LoginWidget CMS |
| gem `…/includes/js/1925` | 200 ~305KB; IsCaptcha + MerchantCartToken |
| clientsdk `/merchant/clientsdk/1925` | 200; FingerprintJS loader |
| JS assets | CartService, ChanceToBuy, Checkout, memberLogin, signUp, shippingAddress, LoginWidget mapped |

---

## 14. Recommendation

**Proceed Bandai-first.** Research density is now high enough to scaffold Phase 1 monitor + **Phase 1b account gen** + Phase 2 login/ATC against a HAR. Next concrete step when local: one logged-in AU ISP HAR covering **signup (ideal) + ATC + checkout** (and Chance if any window is open). Until then, keep watching for `purchaseAvailable:true` / open Chance via public search APIs — no adapter code until HAR validates the gated POSTs.
