# Next Store Modules — Research & Plan

_Date: 2026-07-18 (research day pass 2)_  
_Status: planning only (no adapters yet)_  
_Baseline: Kmart AU (`adapters/kmart.js`) — Akamai Bot Manager v3 + Hyper sensor/SBSD/pixel + undici TLS_

Findings combine live edge/API probes (Cursor cloud DC egress) with public platform signals. **Confirm on sticky AU ISP/residential + desktop before build** — several sites hard‑block or black‑hole DC IPs. Homepage ≠ PDP ≠ ATC protection.

### Yield / strategy note (owner input)
- **Premium Bandai AU — BUILD FIRST.** English bots already cover AusPost; **no known Bandai AU support** → greenfield on One Piece / exclusives. Deep dive: `BANDAI_AU_MODULE.md`.
- **Australia Post Shop** — still high yield (~2–3 coin drops/year, 200–300% ROI) but **parked** while Bandai is the differentiator; revisit after Bandai ATC/GE path exists.
- Other stores remain on the backlog for Akamai reuse (Target) etc.

---

## Decision frame

| Factor | Weight |
|---|---|
| **Expected $ / drop** | Coin ROI + OP TCG scarcity |
| **Antibot fit vs Hyper** | Akamai / DataDome / Incapsula / Kasada ✅ · CF Turnstile / F5 Shape ❌ |
| **Drop mechanics** | Pure FCFS ATC (module wins) vs EQL/Chance raffle (entry product) vs membership |
| **Reuse of executor** | TLS, Hyper, jar, desktop sidecar |
| **Account friction** | MyPost / BNID / Costco membership |

---

## Scoreboard (Bandai-first)

| Rank | Store | Status | Antibot | Platform | Diff |
|---|---|---|---|---|---|
| **1** | **Premium Bandai** | **ACTIVE — build next** | Volterra/F5 edge; API path open | Vue SPA + BNID + Global‑e **1925** | L / high $ |
| 2 | Target AU | Backlog (Akamai reuse) | Akamai BM | SAP Commerce | S–M |
| 3 | AusPost Shop | **Parked** (competitors exist) | DataDome | Intershop + Auth0 | M |
| 4 | Big W | Backlog | Akamai BM | SAP + AEM | M |
| 5 | Toymate | Backlog | Cloudflare | BigCommerce + EQL | M–L |
| 6 | EB Games | Backlog | CF challenge | Custom .NET | L |
| 7 | Costco | Backlog | Akamai + membership | SAP | L |
| 8 | Disney Store | After Bandai GE | Akamai+CF+reCAPTCHA | SFCC + Global‑e | L |

**Active track:** Bandai monitor ∥ **account gen** → login/ATC → Chance → Global‑e (`BANDAI_AU_MODULE.md`).  
**Later:** Target Akamai twin; AusPost DataDome when we want coin season.

---

## Deep dive — Australia Post Shop

**Canonical:** `https://auspost.com.au/shop/` (`shop.auspost.com.au` → 301)

### Why it matters
- Limited coin / collectable releases (RAM partnerships, Bluey, etc.) sell out in minutes; site has publicly crashed under load.
- Cart copy on limited PDPs: **“Products in your cart are not reserved until you checkout”** — classic ATC→pay race.
- Terms: **MyPost account required** to place an order; order‑limit circumvention via multi‑order is explicitly rejected; coins support **pre‑order** (dispatch after release, up to ~6 weeks).

### Stack (confirmed live)
| Layer | Detail |
|---|---|
| CDN | CloudFront |
| Commerce | **Intershop 7** — `ishconfig.appType = auspost.B2CWebShop`, `appVersion = 6.3.6`, pipelines under `/shop/web/WFS/AusPost-Shop-Site/en_AU/-/AUD/…` |
| Auth | **Auth0** via `auth0-ui-integration-module`; `clientId=MaempCMHXE2AMFiGMAKDnb6eiNyoKRKk`; redirect `ViewUserAccountAuth0-ProcessLogin`; issuer family `welcome.auspost.com.au`; also FingerprintJS in auth module |
| Antibot | **DataDome** — not on soft homepage; **hard on PDP / category / ATC** |
| Payments | Icons strip + CSP/urlscan: **SecurePay** + **PayPal** (confirm in HAR) |

### DataDome behaviour (DC probe)
| Surface | Result |
|---|---|
| `GET /shop/` homepage | **200**, full HTML, no DD challenge |
| `GET /shop/product/…` coin PDP | **403** `x-datadome: protected`, body `rt:'c'` + `ct.captcha-delivery.com/c.js`, `t:'fe'` → **slider captcha** (Hyper `/slider`) |
| `POST …/ViewExpressShop-AddProduct` (XHR) | **403** JSON with `geo.captcha-delivery.com/interstitial/…`, `t:'it'` → **interstitial** (Hyper `/interstitial`) |
| `GET …/ViewSuggestSearch-Suggest?SearchTerm=bluey%20coin` | **200** suggestions (incl. live Bluey coin titles) |
| `GET /shop/cart` | **200** empty cart (session cookies `sid`, `pgid-AusPost-Shop-Site`, `SecureSessionID-*`) |

Homepage soft / PDP+ATC hard is important: monitor via suggest/search; clear DD before PDP/ATC.

### Intershop pipelines of interest
- `ViewExpressShop-AddProduct` — ATC
- `ViewExpressShop-ViewProduct` / `ViewProduct-Start`
- `ViewCart-View` (via `/shop/cart` → `/shop/viewdata/{id}?JumpTarget=ViewCart-View`)
- `ViewSuggestSearch-Suggest` / `ViewSuggestSearch-SearchProduct`
- `ViewSavedCarts-SimpleCartSearch`
- `ViewUserAccountAuth0-ProcessLogin` / `LogoutUser`
- Homepage express forms post to `/shop/cart-dispatch` with `SynchronizerToken` + `SKU` + `addToCartBehavior=expresscart`

SKU shape observed: `{id}-AusPost` (e.g. `45303-AusPost`, product images `2336509INT-AusPost`).

### Drop / ops realities
- Release times often **08:30 AEST/AEDT**.
- No Queue‑it observed on AusPost Shop (unlike RAM’s own site). Protection = capacity meltdown + DataDome + account/limits.
- Multi‑account MyPost + per‑SKU qty caps are first‑class product requirements.

### Module plan — AusPost
1. **Hyper DataDome** — extend `antibot.js` with interstitial + slider solvers (not only Akamai). Allowlist `auspost.com.au` on Hyper key.
2. Session warm: homepage → DD clear → PDP → CSRF `SynchronizerToken` → ATC → checkout.
3. Auth0/MyPost login machine (token refresh via `welcome.auspost.com.au` / digitalapi).
4. Payment HAR: SecurePay tokenize + place order; 3DS path unknown.
5. Monitor: Stamp Bulletin / collectables pages + SuggestSearch for SKU discovery pre‑drop.
6. Load strategy: expect 5xx/“temporarily unavailable”; retry/backoff + multi‑proxy.

**Feasibility:** Strong — DataDome is Hyper‑native; Intershop form ATC is old‑school and HAR‑friendly once DD is cleared. Highest yield/feasibility ratio in this set.

---

## Deep dive — Premium Bandai AU

**Canonical:** `https://p-bandai.com/au/` (not `www.bandai.com.au` — SSL mismatch)

### Why it matters
- Official channel for AU One Piece TCG exclusives / premium sets at MSRP.
- Jan 2026 FCFS anniversary drop: site instability + bots → March 2026 **Chance to Buy** raffle program for many English OP reprints.
- Still plenty of normal `PreOrder` / FCFS SKUs; raffle is an additional mode, not a full replacement.

### Stack (confirmed live)
| Layer | Detail |
|---|---|
| Edge | CloudFront + **volt-adc** (F5 Distributed Cloud / Volterra); `TS*` cookies |
| App | Vue 3 + Vite SPA (`#app`), axios `baseURL: "/"` |
| Auth | **Bandai Namco ID** (`account.bandainamcoid.com`) — Cognito/social; WebAuthn scripts present |
| Checkout | **Global‑e** merchant **1925** (`gem-bandai.global-e.com`, `web.global-e.com/merchant/clientsdk/1925`) |
| Catalog | Same‑origin REST under `/api/…` |

### Required API headers (from axios interceptor)
```
Accept-Language: en          // from locale helper
X-G1-Area-Code: au           // first path segment of URL
X-CSRF-TOKEN: <from /api/context/member>
X-Requested-With: XMLHttpRequest
Content-Type: application/json
```
Without `X-G1-Area-Code`, most endpoints return **500**. With it: full JSON.

### API map (extracted from JS + live 200s)

**Session / member**
- `GET /api/context/member` → `{ csrfToken }`
- `GET /api/context/member/refresh`
- `GET /api/cart/summary` → `{ totalItemCount }`

**Catalog**
- `GET /api/products/{productCode}` — flags (`PRE_ORDER`, `OUT_OF_STOCK`), `purchaseAvailable`, inventory, **`maxByPerOrder` / `maxByPerUser`**
- `GET /api/search?keyword=&offset=&limit=`
- `GET /api/brand/{urlKeyword}` · `/api/series/list` · `/api/shop/{urlKeyword}`
- Sitemap: `https://p-bandai.com/au/sitemap-product_1.xml` (~486 items)

**Auth (JS-confirmed)**
- `POST /login` form: `grantType=password&memberId=<email>&password=…&saveLoginId=false&autoLogin=false`
- BNID popup → `grantType=sns`; AU `multiAuth:true` (SMS gates common)
- Full signup/shipping DTOs + AU address map in `BANDAI_AU_MODULE.md`

**Cart** (`CartService`)
- `POST /api/cart/addToCart` body **array** `[{ areaItemNo, qty, eventPickupSpecifiedPickupSn? }]` — guest DC → 501; login HAR still required
- Errors: `CouldNotAddToCartByMaxPurchaseQty`, `…OutOfStock`, `…Preallocation`, `…EndOfSale`, …
- `GET /api/cart/detail` · `PUT …/modifyCartItem` · `DELETE …/removeCartLineItems`
- `POST /api/cart/{cartSn}/checkout` `{ merchantCartToken, shippingAreaCode, defaultAreaCode, items:[{ cartItemSn }] }`
- Token formula: `` `${cartId}_Checkout_${globaleMerchantCartTokenSuffix}` ``

**Chance to Buy / campaigns**
- `GET /api/campaign/list` · `/past` · `/detail/{url}` · `…/items`
- `POST /api/my/campaign/apply/{sn}/apply{campaignType}` body `{ applyGroupNo }` — Chance → **`applyDraw`**
- `GET /api/my/campaign/applied/products` · cancel `PUT …/applyDraw/cancel`
- Requires login; trading‑halt members redirected

**Checkout → Global‑e**
- After GE confirmation: `POST /api/checkout/{checkoutSn}/preComplete` with `{ globaleOrder }`
- Client dig: cart-token **captcha** (`IsCaptcha` + `.h-captcha`/grecaptcha) + **FingerprintJS** (`fpId`); **no Forter string** in gem/clientsdk (still confirm live HAR)

### Protections nuance
- Homepage HTML **200** without challenge.
- Some `/item/{code}` responses return a large obfuscated inline script (bot defence) instead of SPA shell — treat as **edge bot score** on product navigation; APIs may still work with good cookies/headers from `/au/` warm.
- Hyper does **not** list F5/Shape — browser warm may be needed for some HTML routes; JSON API path is the better HTTP target.

### One Piece sample (live search)
- Many `saleStatus: End` preorders; at least one `On` with `OUT_OF_STOCK`, `maxByPerUser: 1`.
- Example titles: 3rd Anniversary Set (~AUD 200), Heroines Special Set (~340), Premium Card Collections (~18–43).

### Module plan — Bandai
1. Desktop HAR: **signup (agen)** + login → addToCart → checkout → Global‑e (and Chance applyDraw).
2. Adapter phases: **monitor** ∥ **account gen** → **ATC dry‑run** → **Chance entry** → **Global‑e pay**.
3. Account pool: agen vault via **OnlineSim + IMAP app password** (user Settings); `maxByPerUser: 1` scales accounts.
4. Desktop task types: `bandai`, **`bandai-agen`**; shared `executor/otp/*` for future stores.
5. Share Global‑e learnings with Disney later.

**Feasibility:** Medium‑hard technically, but APIs are unusually well exposed once headers are right — rare for a “high value / low support” target.

---

## Other dossiers (condensed)

### Target AU — `target.com.au`
- Akamai (`shop.target.com.au.edgekey.net`); DC 403 `AkamaiGHost`.
- SAP Commerce on AWS; Kmart Group sibling but **not** Kmart GraphQL/Paydock.
- Best pure Akamai reuse after/alongside AusPost DataDome work.

### Big W — `bigw.com.au`
- Akamai edgekey; DC **timeouts** (silent drop).
- Akamai BM + SAP + AEM; Woolworths decoupling risk.
- Prove on ISP before committing.

### Toymate — `toymate.com.au`
- Cloudflare **Request Blocked** from DC; **BigCommerce** (`cdn11.bigcommerce.com/s-cf7jv97qb3`).
- **EQL** for Pokémon‑class drops — raffle product, not ATC module.
- Hyper weak on CF — browser clear.

### EB Games — `ebgames.com.au`
- CF managed challenge; custom .NET on AWS.
- Browser‑heavy.

### Costco AU — `costco.com.au`
- Akamai; **membership required** online. Park unless membership ops ready.

### Disney Store AU — `disneystore.com.au`
- SFCC `Sites-DisneyStoreAUNZ` + `_abck`/`bm_sz` + CF + reCAPTCHA Enterprise + Global‑e.
- Same Global‑e class as Bandai; lower OP‑style urgency.

---

## Hyper capability gaps

| Need | Status |
|---|---|
| Akamai sensor/SBSD/pixel | ✅ in `antibot.js` (Kmart) |
| DataDome interstitial + slider | ✅ Hyper API · ❌ not wired in executor yet → **AusPost blocker #1** |
| Cloudflare Turnstile / managed challenge | ❌ → Toymate / EB |
| F5 / Volterra / Shape | ❌ → Bandai HTML edge; APIs may bypass |
| Global‑e checkout | N/A vendor · custom work → Bandai / Disney |
| Auth0 MyPost / BNID | Custom session machines |

---

## Recommended program (Bandai-first)

### When back at desk (critical path)
1. **Bandai HAR (logged-in, AU ISP):** ideally **one signup** + login → `addToCart` → cart checkout → Global‑e (and Chance `applyDraw` if open). See `BANDAI_AU_MODULE.md`.
2. Confirm guest vs login ATC (DC got 501 on POST).
3. Optional: Target Akamai lab only if spare time.

### Build order
| Phase | Work |
|---|---|
| **B0** | HAR + slim notes (blocker; include signup if possible) |
| **B1** | Bandai monitor (search/product poll + notify) |
| **B1b** | **Account gen** (`bandai-agen`: user OnlineSim key + IMAP app password → vault) |
| **B2** | Login + ATC dry-run (`placeOrder:false`) |
| **B3** | Chance entry pool (`applyDraw` from agen vault) |
| **B4** | Global‑e checkout / pay |
| *later* | Target Akamai · AusPost DataDome |

### Success criteria
- **Bandai agen:** vault of SMS-cleared accounts with shipping addresses.
- **Bandai FCFS:** logged-in ATC + GE complete on a live/restock SKU.
- **Bandai Chance:** multi-account `applyDraw` + winner→purchase path.
- AusPost/Target: deferred until Bandai ships.

---

## Probe log (2026‑07‑18 DC)

| Host | Signal |
|---|---|
| auspost.com.au/shop | 200 Intershop; DD on PDP/ATC; Auth0 login page |
| p-bandai.com/au | 200 SPA; APIs OK with `X-G1-Area-Code: au`; Cart/Chance/Checkout routes in JS |
| target.com.au | Akamai 403 |
| bigw.com.au | Timeout |
| toymate.com.au | CF Request Blocked |
| ebgames.com.au | CF Just a moment |
| costco.com.au | Akamai 403 |
| disneystore.com.au | 200 SFCC + Akamai cookies + Global‑e + reCAPTCHA |

---

## Open questions (for local HAR day)
1. AusPost: exact SecurePay / card fields + whether DD tags.js runs on every page after first clear.
2. AusPost: guest vs forced login timing (terms say MyPost to place order — is ATC allowed logged‑out?).
3. Bandai: logged-in ATC response + whether Volterra challenges fire on ISP POSTs (schema known from JS).
4. Bandai: live GE captcha sitekey + whether Forter loads at payment; `globaleMerchantCartTokenSuffix` mint.
5. Bandai: Chance `applyGroupNo` when `applyGroupUse=true`; other `campaignType` suffixes in the wild.
6. Bandai agen: OnlineSim rent vs slug for Bandai SMS; IMAP From/Subject patterns; +tag email OK?
7. Target: OCC vs form checkout; Paydock or other.

### Shared agen OTP infra (all future signup modules)
User provides once in Desktop Settings:
- **OnlineSim API key** — SMS numbers / OTP poll (`country` per store; Bandai AU = `61`)
- **IMAP host + mailbox + app password** — email OTP poll

Executor helpers `otp/imapInbox.js` + `otp/onlinesim.js` are store-agnostic; each `*-agen` adapter only implements that site’s signup API.
