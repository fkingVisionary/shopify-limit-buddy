# Premium Bandai AU — Module Research (Bandai-first)

_Date: 2026-07-18_  
_Status: research only — no adapter code yet_  
_Why first: owner call — English bots already cover AusPost; **no known Bandai AU support** → greenfield edge on One Piece / exclusives._

Canonical storefront: **`https://p-bandai.com/au/`**  
(Do not use `www.bandai.com.au` — cert mismatch.)

---

## 1. Executive summary

Premium Bandai AU is a **Vue 3 + Vite SPA** with a clean same-origin REST API, **Bandai Namco ID (BNID)** auth, and **Global-e** (merchant **1925**) for payment. Edge is **CloudFront + F5 Distributed Cloud (`volt-adc`, `TS*` cookies)** — not Hyper-native — but **catalog/cart JSON is callable** once session headers are correct.

Two buy modes:
1. **FCFS / PreOrder ATC** → cart → Global-e checkout  
2. **Chance to Buy** raffle (`/api/my/campaign/apply/{sn}/applyDraw`) → later purchase window for winners  

Competitive angle: APIs and payload shapes are largely reverse-engineered from public JS. A working module here is differentiation.

---

## 2. Stack map

| Layer | Tech | Notes |
|---|---|---|
| CDN / ADC | CloudFront + **volt-adc** (F5 XC / Volterra) | `TS01*` cookies; some `/item/*` HTML returns obfuscated bot script |
| App | Vue 3 + Vite, axios `baseURL: "/"` | Routes under `/:areaCode(au)/…` |
| Auth | **BNID** popup OAuth-ish + local `POST /login` | `clientId=AdJPb1GyRxvcncEObNvdcYUHeFX6SAIBeoTcRXmb` |
| Catalog / cart | REST `/api/*` | Header-gated by area code |
| Pay | **Global-e** mid **1925** | `gem-bandai.global-e.com`, `web-bandai.global-e.com`, `webservices.global-e.com` |
| Consent | OneTrust | |
| Limits | Per product `maxByPerOrder` / `maxByPerUser` | Often **1** on OP cards |

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

---

## 3. API surface (confirmed)

### Session
| Method | Path | Notes |
|---|---|---|
| GET | `/api/context/member` | CSRF seed (guest OK) |
| GET | `/api/context/member/refresh` | After login |
| GET | `/api/cart/summary` | `{ totalItemCount }` |
| GET | `/api/customerAreas` | Area config (age limits, SNS) |

### Catalog / monitor
| Method | Path | Notes |
|---|---|---|
| GET | `/api/search?keyword=&offset=&limit=` | Live OP search works |
| GET | `/api/products/{productCode}` | Flags, inventory, limits, `campaignInfo` |
| GET | `/api/brand/{urlKeyword}` | e.g. `onepiececardgame` |
| GET | `/api/series/list` · `/api/shop/{urlKeyword}` | |
| GET | `/au/sitemap-product_1.xml` | ~486 product URLs |

**Product detail fields that matter for bots**
- `purchaseAvailable` (bool)
- `flags[]` — `PRE_ORDER`, `OUT_OF_STOCK`, …
- `areaItemNos[]` / `areaItemToItemCode` → **`areaItemNo`** for ATC
- `areaItemInventoryInfoMap`
- `productDescriptionSection.productLimitedQuantityInfo.maxByPerOrder|maxByPerUser`
- `infoSection.quantityInfo.minQuantity|maxQuantity`
- `infoSection.orderInfo` — sale window, `preOrderStatus` (`InProgress`, …)
- `infoSection.campaignInfo` — Chance linkage:
  - `applyForCampaignYn`
  - `campaignStatus`: `ApplyForCampaign` \| `PlaceOrdered` \| `PurchasePeriodEnds` \| `SoonAvailable`
  - `campaignUrl`, `winner`

### Cart (from `CartService-CjINCL-V.js`)
| Method | Path | Body / notes |
|---|---|---|
| POST | `/api/cart/addToCart` | **Array**: `[{ areaItemNo, qty, eventPickupSpecifiedPickupSn? }]` |
| GET | `/api/cart/detail` | Primary cart |
| PUT | `/api/cart/modifyCartItem` | `?cartItemSn=&qty=` |
| DELETE | `/api/cart/removeCartLineItems` | `?cartLineItemSns=` |
| POST | `/api/cart/{cartSn}/checkout` | `{ merchantCartToken, shippingAreaCode, defaultAreaCode, items }` |
| GET | `/api/cart/byCartSn/{sn}` | |
| POST | `/api/cart/byCartSn/{sn}/couponCodes` | |
| POST | `/api/cart/byCartSn/{sn}/estimateBenefits` | |

**ATC call site** (`Items-*.js`):
```js
await cartService.addToCart([
  {
    areaItemNo: "...",           // e.g. AAI0014074AU
    qty: chosenQuantity,
    eventPickupSpecifiedPickupSn: optional
  }
]);
```

**ATC error codes** (map to UI strings):
- `CouldNotAddToCartByMaxPurchaseQty`
- `CouldNotAddToCartByOutOfStock`
- `CouldNotAddToCartByPreallocation`
- `CouldNotAddToCartByEndOfSale`
- `CouldNotAddToCartByMinPurchaseQty`
- `CouldNotAddToCartBySuspendedItem`

**DC probe note:** guest `POST /api/cart/addToCart` returned **501 HTML “PAGE NOT AVAILABLE”** for all body shapes tried. Likely **login-required and/or edge policy on POST from DC**. `/api/my/*` as guest returned **503 “NETWORK CONGESTION”** HTML (auth wall disguised). **Must confirm ATC with logged-in AU ISP session in HAR.**

### Chance to Buy / campaigns
| Method | Path | Notes |
|---|---|---|
| GET | `/api/campaign/list` | Active (empty at probe time) |
| GET | `/api/campaign/past` | Past promo campaigns |
| GET | `/api/campaign/detail/{campaignUrl}` | |
| GET | `/api/campaign/detail/{id}/items` | |
| POST | `/api/my/campaign/apply/{campaignSn}/apply{Type}` | Body `{ applyGroupNo: number\|null }` · **login required** |
| GET | `/api/my/campaign/applied/products` | History |
| PUT | `/api/my/campaign/apply/{sn}/applyDraw/cancel` | Cancel draw entry |

`apply{Type}` is concatenated — Chance uses **`Draw`** →  
`POST /api/my/campaign/apply/{sn}/applyDraw`.  
Coupon-style campaigns use other suffixes (via same helper).  
UI redirects winners to `/mypage/chancetobuy`; apply UX under `/hotdeals/{campaignUrl}`.

Trading-halt members (`memberStatus == TradingHalts`) are blocked from apply.

### Checkout → Global-e
From cart UI + `Checkout-*.js`:
1. `merchantCartToken` ≈ `` `${cartId}_Checkout_${globaleMerchantCartTokenSuffix}` `` (suffix from `PRELOAD_DATA`)
2. `POST /api/cart/{cartSn}/checkout` → `{ checkoutSn, … }`
3. Navigate to checkout view; DOM carries `merchantcarttoken=…`
4. Global-e client (`GEClient` / mid 1925) runs hosted checkout (`web-bandai.global-e.com` / webservices)
5. On GE success callback → `POST /api/checkout/{checkoutSn}/preComplete` with GE order payload (`globaleOrder`)
6. Redirect order complete / error

Global-e client exposes CartToken / Checkout / ApplePay / PayPal express helpers; fraud scripts (often Forter-class) typically load inside GE — **confirm in browser HAR**.

---

## 4. Auth — Bandai Namco ID

From `memberLoginService-*.js`:

**BNID popup**
```
{loginUri}?client_id={clientId}
  &redirect_uri={origin}/login-result?areaCode=au
  &backto={origin}/au/login
```
- `loginUri` = `https://account.bandainamcoid.com/login.html`
- `clientId` = `AdJPb1GyRxvcncEObNvdcYUHeFX6SAIBeoTcRXmb`
- Popup sets `window.bnidLoginResult(data)` → `snsToken`
- Optional: `GET /api/member/bnid/user?token={snsToken}` for profile fields

**Local session grant**
```
POST /login
Content-Type: application/x-www-form-urlencoded
grantType=password&…fields…
  OR grantType=sns&…snsToken…
```
- Response **200** may set header `x-csrf-token` (update jar) and `x-restricted-type`
- Restricted types: `TemporaryPassword`, `SMSVerification*`, `TermsPending` → forced flows

**Logout**
- BNID popup logout + `POST /login/logout-perform`

**Module implication:** account pool = BNID accounts (email/pass and/or SNS). SMS / terms gates must be handled or pre-cleared on accounts.

---

## 5. Protections & what Hyper helps with

| Control | Present? | Hyper? | Strategy |
|---|---|---|---|
| F5 / Volterra ADC | Yes (`volt-adc`, `TS*`) | ❌ | Good TLS + cookies from `/au/` warm; browser if HTML challenges |
| Item HTML obfuscation | Sometimes | ❌ | Prefer **API** over scraping `/item/{code}` HTML |
| CSRF | Yes | N/A | `/api/context/member` every session |
| Login wall on cart/my | Yes (501/503 pages) | N/A | BNID session first |
| Per-user qty | Yes | N/A | Multi-account |
| Global-e fraud | Likely | Partial/none | Browser GE or dedicated fraud solve TBD |
| Chance raffle | Product feature | N/A | Separate “entry” task type |

Akamai/DataDome **not** observed as primary on Bandai AU.

---

## 6. One Piece / drop modes

| Mode | When | Bot job |
|---|---|---|
| **PreOrder FCFS** | `productType=PreOrder`, `purchaseAvailable`, sale window open | Monitor → ATC → checkout → GE pay |
| **In-stock FCFS** | Rare on PB exclusives | Same |
| **Chance to Buy** | `campaignInfo.applyForCampaignYn` + status `ApplyForCampaign` | Login → `applyDraw` across accounts → alert winners → purchase in window |
| **Ended** | `saleStatus=End` | Ignore / archive |

Live sample (probe day): many OP SKUs `saleStatus=End`; e.g. `N2903432003` `On` but `OUT_OF_STOCK`, `maxQuantity=1`, window into Jul 31 2026 — good dry-run candidate once restocked / with test SKU.

Public context: Jan 2026 FCFS anniversary drop caused chaos → March 2026 Chance program for several English reprints. **Module must support both modes.**

---

## 7. Proposed module phases (build when ready)

### Phase 0 — Local HAR day (blocker)
On **desktop + AU residential/ISP**:
1. BNID login (one real account)
2. Find any `purchaseAvailable:true` SKU (or wait for restock)
3. Capture: `POST /api/cart/addToCart` (confirm array body + cookies)
4. Capture: cart detail → checkout POST → Global-e network (Forter/reCAPTCHA?)
5. If any Chance open: capture `applyDraw`
6. Save HAR → slim like Kmart pipeline

### Phase 1 — Monitor (ship first, low risk)
- `adapters/bandai-monitor` or executor experiment:
  - search + product poll
  - detect `purchaseAvailable` / stock / campaign status flips
  - webhook / desktop notify
- No pay; proves headers + TLS + proxy

### Phase 2 — ATC dry-run
- Login session machine (password grant first; BNID popup later)
- `addToCart` + `cart/detail` assert
- `placeOrder:false` stop before GE

### Phase 3 — Chance entry pool
- Multi-account `applyDraw`
- Deduped history via `applied/products`
- Winner watch → human or auto purchase handoff

### Phase 4 — Global-e checkout
- Hardest: hosted GE + possible fraud/3DS
- Reuse patterns from Disney later if both greenlit
- May need Playwright handoff for GE only (HTTP through ATC)

### Out of scope initially
- AusPost (parked — competitors exist)
- Disney Global-e until Bandai GE works
- Solving F5 HTML challenges unless API path fails on ISP

---

## 8. Executor integration sketch

```
antibot.js          # no Bandai vendor yet — TLS/jar only
adapters/bandai.js  # matches p-bandai.com
  warm()            # GET /au/ → SESSION + TS* + CSRF
  login()           # POST /login grantType=password|sns
  getProduct(code)
  addToCart([{areaItemNo, qty}])
  checkout(cartSn, merchantCartToken, …)
  applyChance(campaignSn, applyGroupNo?)
  # pay via GE — phase 4
```

Desktop: task type `bandai` alongside `kmart`; proxy sticky AU; account vault for BNID.

Hyper allowlist: `p-bandai.com`, `account.bandainamcoid.com`, `*.global-e.com` (if any Hyper use later).

---

## 9. Open questions (HAR day checklist)

- [ ] Does guest ATC ever work, or is login mandatory?
- [ ] Exact `POST /login` field names for password grant
- [ ] `addToCart` response JSON shape (`items[].addedNewCart`, `totalCartCount`)
- [ ] How `merchantCartToken` / `globaleMerchantCartTokenSuffix` are minted
- [ ] Global-e: Forter / reCAPTCHA / 3DS on mid 1925 AU
- [ ] Chance `applyGroupNo` semantics when `applyGroupUse=true`
- [ ] Whether Volterra challenges appear on ISP for API POSTs
- [ ] Rate limits / 503 under real drop load

---

## 10. Probe log (DC, 2026-07-18)

| Call | Result |
|---|---|
| GET `/au/` | 200 SPA + CONFIG (`globaleMid=1925`, bnidConfig) |
| GET `/api/context/member` + area header | 200 CSRF |
| GET `/api/search?keyword=ONE PIECE` | 200 products |
| GET `/api/products/A2388840008` | 200 inventory/limits |
| GET `/api/cart/summary` | 200 `{totalItemCount:0}` |
| POST `/api/cart/addToCart` (guest, DC) | **501** PAGE NOT AVAILABLE |
| GET `/api/my/*` (guest) | **503** NETWORK CONGESTION HTML |
| GET `/api/campaign/list` | 200 `[]` |
| GET `/api/campaign/past` | 200 promo campaigns (not live Chance) |
| JS assets | CartService, ChanceToBuy, Checkout, memberLoginService mapped |

---

## 11. Recommendation

**Proceed Bandai-first.** Next concrete step when local files are available: one logged-in HAR covering ATC + checkout (and Chance if any window is open). Until then, continue research on Global-e client behaviour and BNID password-grant field names from more JS chunks if needed — but **HAR is the critical path**.
