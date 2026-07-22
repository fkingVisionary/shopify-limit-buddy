# Australia Post Shop — Module Research

_Date: 2026-07-18 (deep dig)_  
_Status: research only — no adapter code yet_  
_Priority: **parked behind Bandai** (English bots already cover AusPost coin drops); build when coin season / after Bandai ATC+GE path exists._  
_Yield context: ~2–3 profitable coin drops/year historically, ~200–300% ROI; site melts under load._

Canonical storefront: **`https://auspost.com.au/shop/`**  
(`shop.auspost.com.au` → 301 here.)  
Marketing hub: `https://collectables.auspost.com.au/` (links into `/shop/collectables…`).

---

## 1. Executive summary

AusPost Shop is **Intershop 7** B2C with **DataDome** on hard surfaces and **Auth0 / MyPost** for checkout. Soft surfaces (homepage, suggest search, cart view, homepage express ATC form) are callable from DC without a challenge — **PDP, category, HTML search, and XHR express-ATC are 403 DataDome slider**.

Critical path insight from this dig:
1. **Guest ATC works** via `POST /shop/cart-dispatch` (homepage product forms) — item landed in cart, no DD.
2. **Guest checkout does not** — `checkout` submit bounced back to cart; login required (Auth0 relay often targets `ViewCheckoutAddresses`).
3. Hyper already documents DataDome **slider + interstitial**; executor `antibot.js` is Akamai-only today → **wiring DD is AusPost blocker #1**.

Competitive angle is weaker than Bandai (bots already play here), but feasibility is high once DD + Auth0 are done.

---

## 2. Stack map

| Layer | Tech | Notes |
|---|---|---|
| CDN | CloudFront | |
| App server | Apache / Intershop 7 | `Powered by INTERSHOP 7` |
| Commerce | **Intershop 7** | `ishconfig.appType=auspost.B2CWebShop`, `appVersion=6.3.6` |
| Auth | **Auth0** + MyPost | `welcome.auspost.com.au`; UI module on shop |
| Antibot | **DataDome** | Soft home / hard PDP+search+XHR ATC |
| Payments | **SecurePay** + **PayHive** + **PayPal** | Card, Apple Pay, AliPay, WeChat, SecurePay direct post; **3DS v2** iframe |
| Analytics | Adobe DTM / Omniture | |
| Fingerprint | FingerprintJS (via Auth0 module CDN) | `m1.openfpcdn.io/fingerprintjs` |

### `ishconfig` (homepage inline)

```js
ishconfig = {
  staticRoot: "https://auspost.com.au/shop/static/WFS/AusPost-Shop-Site/-/-/en_AU/",
  staticContentRoot: "https://auspost.com.au/shop/static/WFS/AusPost-Shop-Site/-/AusPost-Shop/en_AU",
  webRoot: "…/en_AU",
  appRoot: "https://auspost.com.au/shop/web/WFS/AusPost-Shop-Site/en_AU/-/AUD",  // Default-Start stripped
  appType: "auspost.B2CWebShop",
  appVersion: "6.3.6"
}
ishconfig.loggedin = false  // flips when Intershop session has customer
```

### Session cookies (guest warm)

| Cookie | Role |
|---|---|
| `sid` | Intershop session |
| `pgid-AusPost-Shop-Site` | Page group / site |
| `SecureSessionID-*` | Secure session |
| `datadome` | Set on DD challenges (`Domain=.auspost.com.au`) |

CSRF: **`SynchronizerToken`** hidden field (64 hex) on forms — refresh from any HTML page that embeds it (homepage / cart).

---

## 3. DataDome behaviour (DC probe, 2026-07-18)

| Surface | HTTP | DD? | Detail |
|---|---|---|---|
| `GET /shop/` homepage | 200 | ❌ soft | Full HTML + ATC forms + token |
| `GET /shop/cart` → viewdata | 200 | ❌ | Empty or filled cart HTML |
| `GET …/ViewSuggestSearch-Suggest` | 200 | ❌ | Autocomplete HTML list |
| `GET …/ViewSuggestSearch-SearchProduct` | 200 | ❌ | Product suggestion rows + SKUs |
| `POST /shop/cart-dispatch` (homepage ATC) | 302 → cart | ❌ | **Guest ATC succeeded** (SKU in cart) |
| `GET /shop/product/…` PDP | **403** | ✅ slider | `rt:'c'`, `t:'fe'`, `ct.captcha-delivery.com/c.js`, `hsh:'0F3EC7C51A7EB61002A574B7F514D7'` |
| `GET /shop/collectables` · `/view-all` | **403** | ✅ slider | Same |
| `GET /shop/search?SearchTerm=…` | **403** | ✅ | `x-dd-b: 3` |
| `POST …/ViewExpressShop-AddProduct` | **403** | ✅ | `t:'fe'`, `r:'b'` |

DD challenge body shape (slider):
```js
var dd = {
  rt: 'c',
  cid: 'AHrlq…',
  hsh: '0F3EC7C51A7EB61002A574B7F514D7',
  t: 'fe',           // slider family
  host: 'geo.captcha-delivery.com',
  cookie: '…'
}
// + script ct.captcha-delivery.com/c.js
```

Headers: `x-datadome: protected`, `x-datadome-cid`, `x-dd-b`.

**Module strategy:** monitor via Suggest/SearchProduct (no DD); ATC via **`cart-dispatch`** when possible; clear DD with Hyper `/slider` (and `/interstitial` if that variant appears) before PDP scrape or express-XHR ATC. Homepage soft ≠ drop-day soft — expect DD to tighten under load.

Hyper: `POST https://dd.hypersolutions.co/slider` · `/interstitial` · `/tags` (see `hyper-solutions-brief.md`). Allowlist `auspost.com.au`.

---

## 4. Catalog / monitor

### Soft APIs (guest, no DD in DC)

**Suggest**
```
GET /shop/web/WFS/AusPost-Shop-Site/en_AU/-/AUD/ViewSuggestSearch-Suggest
  ?SearchTerm=bluey%20coin
→ HTML <ul class="suggest-results-list"> … data-search-result="…" count
```

Live examples: `bluey 2026 $2 coin in card with privy mark – baby race|camping|…`, `uncirculated coin` (48).

**Product suggestions**
```
GET …/ViewSuggestSearch-SearchProduct
  ?SearchTerm=bluey%202026%20$2%20coin&SearchType=product
→ HTML product-rows with /shop/product/{slug}-{id} and image paths …
  /product/{SKU}-AusPost/…
```

Live Bluey coin SKUs seen:
| SKU | Title (abbrev) |
|---|---|
| `2336507INT-AusPost` | Rain |
| `2336508INT-AusPost` | Sleepy Time |
| `2336506INT-AusPost` | Granny Mobile |
| (+ Camping etc. via suggest) | |

Homepage also embeds many SKUs as `{id}-AusPost` (stamps, satchels, coins like `10011289-AusPost`, `2313117INT-AusPost`).

### Hard surfaces (need DD)
- PDP: `/shop/product/{slug}-{skuLower}`
- Category: `/shop/collectables`, `/shop/collectables/coins-and-banknotes`, …
- HTML search: `/shop/search?SearchTerm=`

### SKU / URL shape
- Intershop SKU: `{productId}-AusPost` (sometimes `…INT-AusPost`)
- PDP slug ends with lowercase id: `…-2336507int`
- Image CDN path under static product folder uses full SKU

### Drop intel
- Collectables hub + Stamp Bulletin for calendars
- Release times often **08:30 AEST/AEDT**
- No Queue-it on shop (unlike some RAM flows)
- Cart copy on limited PDPs (prior research): items **not reserved until checkout**

---

## 5. Cart & ATC

### Homepage / listing express form (preferred soft path)

```
POST https://auspost.com.au/shop/cart-dispatch
Content-Type: application/x-www-form-urlencoded

SynchronizerToken=<64hex>
SKU=45303-AusPost
addToCartBehavior=expresscart
addProduct=…                 # submit button name
```

Optional: `Quantity=1` (homepage form often omits qty → defaults 1).

**DC result:** 302 → `/shop/viewdata/{id}?JumpTarget=ViewCart-View` → cart HTML containing the SKU. Guest OK.

Button also carries:
```
data-expresscart-action="…/ViewExpressShop-AddProduct"
```
— the **XHR express path is DD-hard**; prefer `cart-dispatch` until DD cookie is warm.

### Cart page pipelines
| Pipeline | Role |
|---|---|
| `ViewCart-View` (via `/shop/cart` → viewdata) | Render cart |
| `ViewCart-UpdateCartQuantity` | Qty update |
| `ViewCart-RemoveProduct?removeProduct={pliId}` | Remove line |
| `ViewCart-ApplyPromotion` / `DeletePromotion` | Promo codes |
| `UpdateShippingMethod` form | `DOMESTIC` / `EXPRESS` radios |

Cart line fields (example):
- `data-product-sku="45303"`
- `name="Quantity_{pliId}"` min/max (e.g. **max=8** on sample bag SKU)
- `data-pli-product-min-order-qty`, `data-pli-product-max-order-qty`
- Shipping method UUIDs per bucket

### Checkout CTA (cart form → same `cart-dispatch`)

```
POST /shop/cart-dispatch
SynchronizerToken=…
checkout=Continue+to+checkout     # primary
# OR fastCheckout_{paymentId}=…   # PayPal express button
```

**Guest DC:** 302 back to `ViewCart-View` (no progress) → **login required before checkout**.

PayPal button present: “Pay now or Pay in 4 with PayPal”.

---

## 6. Auth — Auth0 / MyPost

### UI integration (every shop page)

```
data-auth0-script-url="https://auspost.com.au/auth0-ui-integration-module/module.js"
data-auth0-config-client-id="MaempCMHXE2AMFiGMAKDnb6eiNyoKRKk"
data-auth0-config-env="prod"
data-auth0-config-redirect-url="…/ViewUserAccountAuth0-ProcessLogin"
data-auth0-config-caller="ONLINE_SHOP_AP"
data-auth0-config-channel="WEB"
data-auth0-config-product="ONLINE_SHOP"
data-auth0-config-audience="https://digitalapi.auspost.com.au/medium"
data-auth0-config-scope="https://scopes.auspost.com.au/auth/noaccess"
data-auth0-config-session-required="true"
data-auth0-config-force-login="true"
data-auth0-config-csso-session-config-skip-check|exchange|refresh="true"
data-auth0-logout-url="…/ViewUserAccountAuth0-LogoutUser"
```

### Auth0 hosts
| Env | Host |
|---|---|
| PROD | `welcome.auspost.com.au` |
| SANDBOX | `welcome.sandbox.auspost.com.au` |
| … | vtest/stest/ptest/dev variants |

Digital API: `https://digitalapi.auspost.com.au` (audience `/medium`).

### Login completion (Intershop bridge)

`ViewUserAccountAuth0-ProcessLogin` loads module → `getAccessTokenSilently` → posts:
```
POST …/ViewUserAccountAuth0-Dispatch
SynchronizerToken
AccessToken=<jwt>
Auth0UserInfo=<JSON user>
RelayState=…                 # often prior URL / checkout
TargetPipeline=…             # optional
FetchAddress=true            # if RelayState contains ViewCheckoutAddresses
LinkOldOrders=…              # optional
```

RelayState can encode checkout return: **`ViewCheckoutAddresses`**.

SPA helpers: `services/user/login.js` → `Models.Auth0` → `login(relayState)` / `signup(relayState)` / `logout`.  
Checkout header component syncs Intershop `loggedin` vs Auth0 session (logout if desynced).

### Account generation implications

MyPost/Auth0 signup is **not** the Bandai email+SMS Intershop form — it’s Auth0 Universal Login / AusPost identity.

| Need | Approach |
|---|---|
| Email OTP (if Auth0 sends mail) | Same shared **IMAP app password** waiter (`executor/otp/imapInbox.js`) |
| SMS OTP (if phone verify) | Same **OnlineSim** helper (`executor/otp/onlinesim.js`, country 61) |
| Store-specific | Auth0 authorize URL, clientId, callback → Dispatch form — **HAR required** |

Multi-account remains first-class (order limits / anti-circumvention in terms). Vault = MyPost identities ready for shop SSO.

---

## 7. Checkout & payment (from JS; HAR still required)

Pipelines referenced in auth relay / prior research:
- `ViewCheckoutAddresses` (post-login address step)
- Cart → checkout after Auth0

**Payment method IDs** (in `auspost_shop.min.js`):
| ID | Meaning |
|---|---|
| `SECUREPAY_DIRECT_POST` / `PAY_DIRECT_POST` | SecurePay direct post card UI |
| `PAYHIVE_CARD_PAYMENT` | PayHive card |
| `PAYHIVE_STORE_CARD` | Stored card |
| `PAYHIVE_APPLEPAY_PAYMENT` | Apple Pay |
| `PAYHIVE_ALIPAY_PAYMENT` | AliPay |
| `PAYHIVE_WECHAT_PAYMENT` | WeChat |

UI markers: `#securepay-ui-container`, `form[name=CardNameForm]`, `#3ds-v2-challenge-iframe`, `#SecurePayErrorMessageDiv`, billing address panel.

**3DS v2** is first-class in client JS — expect challenge iframe on many cards.

PayPal: cart `fastCheckout_*` button + “Pay in 4” copy.

**HAR day must capture:** logged-in checkout addresses → payment select → SecurePay/PayHive tokenize → 3DS → place order (and PayPal path if used).

---

## 8. Protections & Hyper

| Control | Present? | Hyper? | Strategy |
|---|---|---|---|
| DataDome slider (PDP/cat/search) | ✅ | ✅ `/slider` | Clear before PDP; optional for monitor |
| DataDome on express ATC XHR | ✅ | ✅ | Prefer `cart-dispatch` soft path |
| DataDome interstitial | Seen historically on ATC | ✅ `/interstitial` | Handle if `i.js` / `t:'it'` |
| CSRF SynchronizerToken | ✅ | N/A | Parse from HTML |
| Auth0 / MyPost login | ✅ | N/A | Browser or ROPC-if-any (unlikely) — HAR |
| FingerprintJS (auth module) | ✅ | N/A | Comes with Auth0 UI |
| Per-line qty caps | ✅ | N/A | Multi-account |
| Capacity / 5xx on drops | ✅ | N/A | Retry + multi-proxy |
| Queue-it | ❌ on shop | — | |

Akamai **not** primary on shop.

---

## 9. Proposed module phases

### Phase 0 — HAR (blocker for pay; useful for auth)
On **desktop + AU residential/ISP**:
1. Soft ATC via `cart-dispatch` (confirm still works on ISP)
2. Auth0 login / signup (one MyPost) → Dispatch → `ViewCheckoutAddresses`
3. Full SecurePay or PayHive + 3DS (+ PayPal optional)
4. PDP with DD: capture slider challenge for Hyper calibration
5. Optionally express `ViewExpressShop-AddProduct` after DD cookie

### Phase 1 — Monitor (can start without DD)
- Poll Suggest + SearchProduct for coin keywords (Bluey, uncirculated, RAM, etc.)
- Detect new SKUs / title flips
- Notify desktop / webhook
- Collectables hub / bulletin as secondary signals

### Phase 1b — Account gen (MyPost)
- Auth0 signup automation + shared IMAP / OnlineSim OTP providers
- Vault MyPost accounts linked for shop SSO
- Same Settings keys as Bandai agen (`onlinesimApiKey`, IMAP app password)

### Phase 2 — ATC dry-run
- Warm home → token → `cart-dispatch` ATC → assert cart line
- Wire Hyper DD if soft path breaks under ISP/load
- Stop before payment (`placeOrder:false`)

### Phase 3 — Checkout + pay
- Auth0 session + address
- SecurePay/PayHive + 3DS handling (likely browser assist)
- Multi-account / qty respect

### Out of scope initially
- Building AusPost **before** Bandai (owner call — competitors exist)
- Collectables marketing CMS as primary checkout surface

---

## 10. Executor integration sketch

```
antibot.js
  + DataDome slider / interstitial / tags   # Hyper dd.hypersolutions.co
adapters/auspost.js
  warm()                 # GET /shop/ → sid + SynchronizerToken
  suggest(term) / searchProducts(term)
  addToCart({ sku, qty })  # POST cart-dispatch
  getCart()
  loginMyPost()            # Auth0 → ProcessLogin → Dispatch
  checkout…                # HAR-driven
executor/otp/*             # shared agen OTP (IMAP + OnlineSim)
```

Desktop: task types `auspost`, `auspost-agen`; sticky AU proxy; Hyper key allowlist `auspost.com.au`, `welcome.auspost.com.au`, `digitalapi.auspost.com.au`, `*.captcha-delivery.com`.

---

## 11. Open questions (HAR / live)

### Closed this dig
- [x] Soft vs hard DD matrix (home/suggest/cart soft; PDP/search/express-XHR hard)
- [x] Guest ATC via `cart-dispatch` works (DC)
- [x] Guest checkout blocked (bounces to cart)
- [x] Auth0 clientId, audience, scope, ProcessLogin → Dispatch field names
- [x] Payment method IDs (SecurePay / PayHive / ApplePay / …) + 3DS v2 markers
- [x] Monitor path without DD (Suggest + SearchProduct)
- [x] Live Bluey coin SKU samples

### Still need HAR / account
- [ ] ISP: does `cart-dispatch` ATC stay soft under residential + drop load?
- [ ] Exact checkout pipeline sequence after login (`ViewCheckoutAddresses` → payment)
- [ ] SecurePay / PayHive request bodies + 3DS callback
- [ ] Whether DD interstitial still appears on some ATC variants
- [ ] MyPost Auth0 signup OTP channels (email vs SMS) for agen
- [ ] Per-SKU order limits / pre-order flags on coin PDPs (need DD clear)
- [ ] PayPal fast-checkout vs card success rates

---

## 12. Probe log (DC, 2026-07-18)

| Call | Result |
|---|---|
| GET `/shop/` | 200 Intershop; token; many ATC forms |
| GET PDP coin/stamp | **403** DD slider (`t:fe`, hsh `0F3EC7C5…`) |
| GET `/shop/collectables` | **403** DD |
| GET `/shop/search?…` | **403** DD |
| GET Suggest `bluey coin` | 200 suggestions |
| GET SearchProduct Bluey $2 | 200 SKUs `2336506–08INT-AusPost` |
| POST `cart-dispatch` ATC `45303-AusPost` | 302 → cart **with line** (guest) |
| POST `ViewExpressShop-AddProduct` | **403** DD |
| POST `cart-dispatch` `checkout=` (guest) | 302 → cart (no advance) |
| Auth0 ProcessLogin HTML | 200; config + Dispatch form |
| `welcome.auspost.com.au` | Auth0 (CF); 302 to auspost.com.au |
| min.js payment IDs | SecurePay + PayHive* + 3DS v2 |

---

## 13. Recommendation

Keep AusPost **documented and ready**, but **do not jump the Bandai-first queue** unless coin season forces it. When building: ship monitor (soft APIs) → Hyper DD → soft ATC → Auth0 → pay HAR. Reuse shared OTP Settings for MyPost agen. Highest Hyper reuse value in the backlog (DataDome native).
