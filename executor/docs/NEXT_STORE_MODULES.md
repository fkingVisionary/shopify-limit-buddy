# Next Store Modules — Research & Plan

_Date: 2026-07-18 (research day pass 4)_  
_Status: planning only (no adapters yet)_  
_Baseline: Kmart AU at hard-reset tip **`a1d9f9c` (“Electron Update”)** — Akamai BM v3 + Hyper + undici.  
_Ops plan:_ [`FUTURE_ROADMAP.md`](./FUTURE_ROADMAP.md) — **Phase 0 = prove Kmart green before any new adapter code.**

Findings combine live edge/API probes (Cursor cloud DC egress) with public platform signals. **Confirm on sticky AU ISP/residential + desktop before build** — several sites hard‑block or black‑hole DC IPs. Homepage ≠ PDP ≠ ATC protection.

### Yield / strategy note (owner input)
- **Premium Bandai AU — BUILD FIRST.** English bots already cover AusPost; **no known Bandai AU support** → greenfield on One Piece / exclusives. Deep dive: `BANDAI_AU_MODULE.md`.
- **Australia Post Shop** — still high yield (~2–3 coin drops/year, 200–300% ROI) but **parked** while Bandai is the differentiator; full dig: `AUSPOST_SHOP_MODULE.md`. Revisit after Bandai ATC/GE path exists (or forced by coin season).
- **Costco AU** — Hyper whitelist already has **Akamai + Kasada**; full dig: `COSTCO_AU_MODULE.md`. Strong antibot reuse, but **paid membership gate** + DC hard-block → backlog until member HAR + Bandai ships.
- **JB Hi-Fi** — high Pokémon/electronics yield at MSRP, but **Shopify + Cloudflare + reCAPTCHA** (not Akamai). Full dig: `JB_HIFI_MODULE.md`. Weak Hyper fit.
- Broader AU contenders scored below (Hyper fit × drop $).

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
| 3 | AusPost Shop | **Parked** (competitors exist) | DataDome | Intershop + Auth0 | M — see `AUSPOST_SHOP_MODULE.md` |
| 4 | **Costco AU** | Backlog (Hyper Akamai+Kasada ✅) | Akamai BM (+ Kasada claimed) + Queue-it | Spartacus + SAP `australia` | L — membership — see `COSTCO_AU_MODULE.md` |
| 5 | Harvey Norman | Contender (Incapsula ✅) | Imperva/Incapsula + Forter | Custom / WCS-family | M — Hyper Reese84 |
| 6 | Foot Locker AU | Contender (Kasada ✅) | Kasada | Custom React | M — sneakers |
| 7 | Platypus | Contender (DataDome ✅) | DataDome + Forter + reCAPTCHA | Magento-class | M — sneakers |
| 8 | Uniqlo AU | Contender (Akamai ✅) | Akamai BM | Uniqlo SPA | M — UT/collab drops |
| 9 | Big W | Backlog | Akamai BM | SAP + AEM | M |
| 10 | **JB Hi-Fi** | Backlog (yield high / Hyper ❌) | **CF + reCAPTCHA Enterprise** + Riskified | **Shopify Plus** custom | L — see `JB_HIFI_MODULE.md` |
| 11 | Toymate | Backlog | Cloudflare + EQL | BigCommerce | M–L |
| 12 | EB Games | Backlog | CF challenge | Custom .NET | L |
| 13 | Disney Store | After Bandai GE | Akamai+CF+reCAPTCHA | SFCC + Global‑e | L |
| 14 | Pop Mart AU | Watch (Labubu $) | Cloudflare | Custom / CF | L — Hyper ❌ |
| 15 | Good Guys | Low priority | CF + Shopify Oxygen | Hydrogen headless | M |

**Active track:** Bandai monitor ∥ **account gen** → login/ATC → Chance → Global‑e (`BANDAI_AU_MODULE.md`).  
**Later (Hyper-native):** Target Akamai · AusPost DD · Costco Kasada · HN Incapsula · FL Kasada · Platypus DD.  
**Avoid full ATC until CF productized:** JB · EB · Toymate · Pop Mart · Culture Kings.

---

## Deep dive — Australia Post Shop

**Canonical:** `https://auspost.com.au/shop/` · **Full dig:** [`AUSPOST_SHOP_MODULE.md`](./AUSPOST_SHOP_MODULE.md)

### Why it matters
- Limited coin / collectable releases sell out in minutes; site crashes under load.
- Cart: items **not reserved until checkout**; MyPost required to place order; multi‑account is the scale model.

### Stack (confirmed live)
| Layer | Detail |
|---|---|
| CDN | CloudFront |
| Commerce | **Intershop 7** — `auspost.B2CWebShop` / `6.3.6` |
| Auth | **Auth0** `clientId=MaempCMHXE2AMFiGMAKDnb6eiNyoKRKk` → `welcome.auspost.com.au` → `ViewUserAccountAuth0-Dispatch` |
| Antibot | **DataDome** — soft home/suggest/cart-dispatch ATC; **hard** PDP/category/HTML search/express-XHR ATC (`t:fe` slider) |
| Payments | **SecurePay** + **PayHive** (card/ApplePay/AliPay/WeChat) + **PayPal**; **3DS v2** |

### Highest-signal findings (this dig)
- **Guest ATC works** via `POST /shop/cart-dispatch` (`SKU` + `SynchronizerToken` + `addToCartBehavior=expresscart`) — no DD in DC.
- **Guest checkout blocked** (checkout submit returns to cart) → Auth0 login; relay often `ViewCheckoutAddresses`.
- **Monitor without DD:** `ViewSuggestSearch-Suggest` + `SearchProduct` (live Bluey coin SKUs e.g. `2336507INT-AusPost`).
- Express XHR `ViewExpressShop-AddProduct` is DD-hard — prefer cart-dispatch until cookie warm.

### Module plan — AusPost (when un-parked)
1. Hyper DataDome in `antibot.js` (slider + interstitial); allowlist `auspost.com.au`.
2. Monitor (suggest/search) → soft ATC → Auth0 → SecurePay/3DS HAR.
3. `auspost-agen` via Auth0/MyPost + shared IMAP/OnlineSim OTP Settings.
4. Expect 5xx under drop load; multi-proxy + retry.

**Feasibility:** Strong once DD wired — Intershop forms are HAR-friendly. Parked only for competitive/priority reasons, not technical dead-end.

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

### JB Hi-Fi — `jbhifi.com.au` — **full dig:** [`JB_HIFI_MODULE.md`](./JB_HIFI_MODULE.md)
- **Shopify Plus** custom + **Cloudflare Workers** (robots.txt explicit). **Not Akamai.**
- reCAPTCHA Enterprise `6LewUkQo…` + **Riskified**; DC **429/503** on home/products/collections.
- Highest Pokémon MSRP channel vs EB (~2× markup on 30th Celebration). Yield ✅ · Hyper ❌.
- Monitor-only possible; full ATC needs CF + captcha outside Hyper.

### Harvey Norman — `harveynorman.com.au` (+ Domayne / Joyce Mayne)
- **Imperva/Incapsula** “Pardon Our Interruption” from DC (`visid_incap_*`); Hyper Reese84/UTMVC ✅.
- Forter + CyberSource + reCAPTCHA in CSP; electronics / some TCG listings.
- Strong **Hyper-native** contender after AusPost DD wiring (same Incapsula family).

### Foot Locker AU — `footlocker.com.au`
- **Kasada** confirmed (`kpsdk-load` / `KPSDK.configure` in HTML). Homepage 200 from DC.
- Sneaker / collab drops — pairs with Costco Kasada work in `antibot.js`.

### Platypus — `platypusshoes.com.au`
- **DataDome** (`js.datadome.co`) + Forter + reCAPTCHA; Magento-class Accent Group stack.
- Sneaker drops; Hyper DD reuse with AusPost.

### Uniqlo AU — `uniqlo.com/au`
- **Akamai BM** (`_abck`, `bm_sz`, `bm_s`) live; UT / collab drops.
- Pure Akamai twin after Target / Kmart patterns.

### Big W — `bigw.com.au`
- Akamai edgekey; DC **timeouts** (silent drop).
- Akamai BM + SAP + AEM; Woolworths decoupling risk.
- Prove on ISP before committing.

### Target AU — `target.com.au`
- Akamai (`shop.target.com.au.edgekey.net`); DC 403 `AkamaiGHost`.
- SAP Commerce on AWS; Kmart Group sibling but **not** Kmart GraphQL/Paydock.
- Best pure Akamai reuse after/alongside AusPost DataDome work.

### The Good Guys — `thegoodguys.com.au`
- **Shopify Hydrogen/Oxygen** + Cloudflare (`powered-by: Shopify, Oxygen, Hydrogen`).
- Soft homepage from DC; same CF class risk as JB on drop days. Lower TCG urgency.

### Officeworks — `officeworks.com.au`
- IBM **WebSphere Commerce** paths in robots (`/webapp/wcs/stores/servlet/…`); CloudFront.
- Soft from DC; Auth0 cookie present. Stationery / print exclusives — lower $ than TCG.

### Myer — `myer.com.au`
- **Next.js** on CloudFront/API Gateway; soft from DC. Department-store toys/beauty.
- Antibot lighter at edge than HN/Costco — dig ATC before ranking up.

### David Jones / Smyths Toys
- Both **Incapsula**-fronted (DJ “Pardon Our Interruption”; Smyths soft-block). Hyper Incapsula reuse.
- DJ fashion/beauty; Smyths toys (UK chain AU) — secondary to HN.

### Rebel Sport — `rebelsport.com.au`
- **SFCC** (`dwac_*`, `dwsid`) behind Cloudflare. Soft page, CF risk under load. Sneakers/apparel.

### Pop Mart AU — `popmart.com/au`
- Labubu / blind-box **high $**; Cloudflare edge (`__cf_bm`). Hyper ❌ same as JB/EB.
- Watch for AU drop calendar; browser module only.

### Toymate — `toymate.com.au`
- Cloudflare **Request Blocked** from DC; **BigCommerce** (`cdn11.bigcommerce.com/s-cf7jv97qb3`).
- **EQL** for Pokémon‑class drops — raffle product, not ATC module.
- Hyper weak on CF — browser clear.

### EB Games — `ebgames.com.au`
- CF managed challenge; custom .NET on AWS.
- World Plus membership + premium pricing vs JB. Browser‑heavy.

### Costco AU — `costco.com.au` — **full dig:** [`COSTCO_AU_MODULE.md`](./COSTCO_AU_MODULE.md)
- **SAP Commerce + Angular Spartacus**; OCC base site **`australia`** (`/rest/v2|v3/australia/…`).
- **Akamai BM** sensor+pixel (`/akam/13/11939384`) confirmed; DC **hard 403** (soft `/favicon.ico` SPA leak only).
- **Kasada:** Hyper whitelist (owner) for Costco; **not seen** on anonymous AU PDP urlscan — confirm on login/ATC HAR.
- **Queue-it** `costcointl` (idle integrations on quiet scan); Hot Buys / hype days.
- **Membership required** online (card → register + reCAPTCHA). No free agen — membership vault.
- Pay: Visa / Mastercard / Apple Pay. Best Hyper reuse after Target once Kasada wired.

### Disney Store AU — `disneystore.com.au`
- SFCC `Sites-DisneyStoreAUNZ` + `_abck`/`bm_sz` + CF + reCAPTCHA Enterprise + Global‑e.
- Same Global‑e class as Bandai; lower OP‑style urgency.

### Niche TCG (Drop Store / Grailborne / GengStore)
- Mostly **Shopify + CF**; membership gates common. Crowded small-bot space — low priority vs Bandai/JB MSRP.

---

## AU high-value matrix (Hyper × yield)

| Store | Drop $ | Hyper antibot | Account friction | Verdict |
|---|---|---|---|---|
| Bandai AU | OP / exclusives ★★★★★ | F5 (API soft) | BNID + SMS agen | **Build first** |
| AusPost Shop | Coins ★★★★ | DataDome ✅ | MyPost Auth0 | Parked |
| Costco | Hot Buys ★★★★ | Akamai+Kasada ✅ | Paid membership | Backlog |
| Target / Big W / Uniqlo | Electronics / UT ★★★ | Akamai ✅ | Low | Akamai reuse |
| Harvey Norman | Electronics / TCG ★★★ | Incapsula ✅ | Low–med | Strong next Hyper |
| Foot Locker / Platypus | Sneakers ★★★★ | Kasada / DD ✅ | Low–med | After Kasada/DD wired |
| JB Hi-Fi | Pokémon MSRP ★★★★★ | CF + reCAPTCHA ❌ | Low | Monitor / later browser |
| EB / Toymate / Pop Mart | TCG / Labubu ★★★★ | CF ❌ | Membership / EQL | Browser-only |
| Good Guys | Electronics ★★ | CF + Shopify ❌ | Low | Skip |
| Officeworks / Myer | Low–med exclusives ★★ | Soft / unclear | Auth0 / account | Low priority |

**Rule of thumb:** prefer stores where Hyper already sells a solver (Akamai / DD / Incapsula / Kasada). CF + Google captcha stores are **monitor or desktop-browser**, not undici+Hyper twins of Kmart.

---

## Hyper capability gaps

| Need | Status |
|---|---|
| Akamai sensor/SBSD/pixel | ✅ in `antibot.js` (Kmart) → Target / Costco / Uniqlo / Big W |
| Kasada CT + CD | ✅ Hyper API · ❌ not wired → **Costco + Foot Locker** |
| DataDome interstitial + slider | ✅ Hyper API · ❌ not wired → **AusPost + Platypus** |
| Incapsula Reese84 / UTMVC | ✅ Hyper API · ❌ not wired → **Harvey Norman / DJ / Smyths** |
| Cloudflare Turnstile / managed challenge | ❌ → JB / EB / Toymate / Pop Mart / Good Guys / Rebel |
| Google reCAPTCHA Enterprise | ❌ (not Hyper) → JB / Disney / many checkouts |
| F5 / Volterra / Shape | ❌ → Bandai HTML edge; APIs may bypass |
| Global‑e checkout | N/A vendor · custom work → Bandai / Disney |
| Auth0 MyPost / BNID / Costco membership | Custom session machines |

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
| *later* | Target Akamai · AusPost DD · Costco Kasada · HN Incapsula · FL Kasada · Platypus DD |
| *browser/CF track* | JB monitor · EB · Pop Mart (only if CF path exists) |

### Success criteria
- **Bandai agen:** vault of SMS-cleared accounts with shipping addresses.
- **Bandai FCFS:** logged-in ATC + GE complete on a live/restock SKU.
- **Bandai Chance:** multi-account `applyDraw` + winner→purchase path.
- Hyper-native backlog (AusPost/Target/Costco/HN/FL): deferred until Bandai ships.

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
| costco.com.au | Akamai 403 almost everywhere; `/favicon.ico` → Spartacus shell; REST baseSite `australia` from urlscan |
| jbhifi.com.au | CF 429/503; robots = Shopify + CF Workers; reCAPTCHA Enterprise + Riskified (urlscan) |
| harveynorman.com.au | Incapsula “Pardon Our Interruption” |
| footlocker.com.au | 200 + Kasada `KPSDK.configure` |
| platypusshoes.com.au | 200 + DataDome + Forter |
| uniqlo.com/au | 200 + Akamai `_abck`/`bm_sz` |
| thegoodguys.com.au | Shopify Oxygen/Hydrogen + CF |
| popmart.com/au | CF `__cf_bm` |
| disneystore.com.au | 200 SFCC + Akamai cookies + Global‑e + reCAPTCHA |

---

## Deep dive — Costco AU

**Canonical:** `https://www.costco.com.au/` · **Full dig:** [`COSTCO_AU_MODULE.md`](./COSTCO_AU_MODULE.md)

### Why it matters
- Hot Buys / limited electronics sell out; Queue-it + dual antibot raise the bar.
- Hyper already allowlisted **Akamai + Kasada** for Costco → best antibot reuse after Kmart/Target.

### Stack (confirmed / claimed)
| Layer | Detail |
|---|---|
| Storefront | Angular **Spartacus** + SAP Commerce; Envoy |
| OCC | baseSite **`australia`** — `/rest/v2/australia/products/{code}`, `/rest/v3/australia/cms/…`, `/session` |
| Antibot | **Akamai** sensor+pixel confirmed; **Kasada** per Hyper whitelist (not on guest PDP scan) |
| Waiting room | Queue-it **`costcointl`** |
| Auth / buy | **Membership required**; `Membership-Data` header on XHR |
| Pay | Visa / Mastercard / Apple Pay |

### Module plan — Costco (when un-parked)
1. Member AU ISP HAR (login → ATC → checkout) — Kasada surface + OAuth + cart bodies.
2. Kasada in `antibot.js`; reuse Akamai warm.
3. Monitor via OCC product JSON; membership vault (not free agen).

**Feasibility:** High once HAR + Kasada wired; **ops-bound** by real membership cards.

---

## Open questions (for local HAR day)
1. AusPost: ISP — does soft `cart-dispatch` ATC hold under residential + drop load?
2. AusPost: checkout after Auth0 (`ViewCheckoutAddresses` → SecurePay/PayHive + 3DS bodies).
3. AusPost agen: MyPost Auth0 signup OTP channels (email/SMS) vs shared IMAP/OnlineSim.
4. Bandai: logged-in ATC response + whether Volterra challenges fire on ISP POSTs (schema known from JS).
5. Bandai: live GE captcha sitekey + whether Forter loads at payment; `globaleMerchantCartTokenSuffix` mint.
6. Bandai: Chance `applyGroupNo` when `applyGroupUse=true`; other `campaignType` suffixes in the wild.
7. Bandai agen: OnlineSim rent vs slug for Bandai SMS; IMAP From/Subject patterns; +tag email OK?
8. Target: OCC vs form checkout; Paydock or other.
9. Costco: Kasada on which surfaces? OAuth client + ATC entry body? Pixel enforced? Queue-it under Hot Buy load?
10. JB: `/cart/add.js` vs themeapis ATC? Captcha always-on vs Shopify bot-protection windows?
11. HN: Reese84 vs UTMVC after Incapsula clear; CyberSource checkout body?

### Shared agen OTP infra (all future signup modules)
User provides once in Desktop Settings:
- **OnlineSim API key** — SMS numbers / OTP poll (`country` per store; Bandai AU = `61`)
- **IMAP host + mailbox + app password** — email OTP poll

Executor helpers `otp/imapInbox.js` + `otp/onlinesim.js` are store-agnostic; each `*-agen` adapter only implements that site’s signup API.
