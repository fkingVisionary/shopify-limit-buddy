# Disney Store AU/NZ — Module Research

_Date: 2026-07-26 (scope dig + build scaffold)_  
_Status: **adapter scaffolded** (`adapters/disney*.js`) — ATC/GE need sticky AU ISP + Hyper + reCAPTCHA token; issuer encoded-merchant TBD_  
_Priority: **after Bandai Global-e reuse** — on BUTT card list; SFCC + Akamai (Hyper ✅) + reCAPTCHA Enterprise (Hyper ❌) + Global-e mid **1696**._  
_Handoff:_ [`DISNEY_BUILD_HANDOFF.md`](./DISNEY_BUILD_HANDOFF.md)

Canonical: **`https://www.disneystore.com.au/`**  
Aliases: `disneystore.com.au` → www; `shopdisney.com.au` → www.  
NZ: same host under **`/nz/...`** PDP paths (same SFCC site `DisneyStoreAUNZ`).  
**Not this module:** US `disneystore.com` / `shopdisney.com` (`Sites-shopDisney-Site` + Queue-it) — separate site/realm.

---

## 1. Executive summary

Official Disney / Pixar / Marvel / Star Wars merch for AU/NZ on **Salesforce Commerce Cloud (SFCC / Demandware)** with **Global-e** as merchant of record for checkout (GST/duties via GE — delivery FAQ + GE Terms).

Live stack (DC 2026-07-26):
1. **Akamai Bot Manager** — `_abck`, `bm_sz`; apex redirect via `AkamaiGHost`; **POST ATC = Access Denied** from cloud DC without sensor warm (edgesuite ref).
2. **Cloudflare** in front of origin (`server: cloudflare`, `cf-ray`) — home/PLP/PDP **soft 200** from DC once cookies set.
3. **SFCC** `Sites-DisneyStoreAUNZ-Site` / locale **`en_AU`** / realm **`BGSX`** / siteId **`DisneyStoreAUNZ`**.
4. **Disney OneID** auth (`cdn.registerdisney.go.com/v4/OneID.js`) → store bridge **`/ocapi/cc/login`**.
5. **Global-e** merchant **`1696`** (`clientJsUrl: web.global-e.com/merchant/clientsdk/1696`, `GlobalE_Data` cookie AU/AUD).
6. **reCAPTCHA Enterprise** sitekey `6LfTl6ApAAAAADNDby7y07sX55wM7B47VUFx7TFW` (also classic `api.js?render=explicit`).

**Yield:** Lorcana / exclusives / drop merch (sitemap heavy on Lorcana SKUs). Crowded vs Bandai greenfield; BUTT already lists it.

**Hyper fit: mixed.** Akamai sensor/SBSD/pixel = reuse Kmart path. Gaps: **reCAPTCHA Enterprise** (not Hyper), **Global-e** (Bandai-class custom — mid **1696** vs Bandai **1925**), **OneID** session machine.

**Vs Bandai:** Same GE checkout family → share GE helper once Bandai GE is proven. SFCC cart controllers are classic Demandware forms, not Bandai REST.

---

## 2. Stack map

| Layer | Tech | Evidence |
|---|---|---|
| Edge | **Akamai** + **Cloudflare** | `_abck`/`bm_sz`; `x-akamai-transformed`; `server: cloudflare`; ATC POST → edgesuite Access Denied |
| Commerce | **SFCC / Demandware** | `x-dw-request-base-id`; `dwsid` / `dwanonymous_*` / `dwac_*`; `/on/demandware.store/…` |
| Site | `Sites-DisneyStoreAUNZ-Site` | Static + controller paths; page title on error shells |
| Locale | `en_AU` | All controllers under `/…/en_AU/…` |
| Realm / CQ | `BGSX` / `bgsx-DisneyStoreAUNZ` | CQuotient config on homepage |
| Auth | **Disney OneID** | `didConfig.clientId=WDI-SHOPDISNEYAUNZ.WEB-PROD`; responder `OneID-Responder` |
| Login bridge | `/ocapi/cc/login` | `loginConfig.endpoint` + OCAPI `clientID=0f4bc909-824c-445f-af00-7f4fb28cdb21` |
| CSRF | `CSRF-Generate` | `csrfEndpoint` in footer |
| Cart | `Cart-AddProduct`, `Cart-MiniCartShow`, `/bag` | PDP `add-to-cart-url`; bag page soft 200 |
| Pay / MoR | **Global-e mid 1696** | Script loader + `MerchantIdHashed=mZ25`; `IsV2Checkout=true` |
| Captcha | **reCAPTCHA Enterprise** | Sitekey above on home |
| Analytics | Tealium `tags.disneyinternational.com` | `tealiumProfile=prod` |
| Catalog | HTML PLP/PDP + suggest | Soft from DC |

### SFCC identity cookies (guest)

| Cookie | Role |
|---|---|
| `dwsid` | Session |
| `dwanonymous_40364d569417e6f7eb63f51dd6014c13` | Anonymous shopper |
| `dwac_f05a0f99defdc47fdddcda1647` | Site/context (`Australia/Melbourne`) |
| `sid` | Session id companion |
| `GlobalE_Data` | `countryISO=AU`, `currencyCode=AUD`, `cultureCode=en-GB`, `apiVersion=2.1.4` |
| `_abck`, `bm_sz` | Akamai BM |

---

## 3. Auth — Disney OneID + OCAPI bridge

### Config (homepage)

```js
var didConfig = {
  clientId: "WDI-SHOPDISNEYAUNZ.WEB-PROD",
  cssOverride: "https://cdn.registerdisney.go.com/v4/asset/css/branded.css",
  langPref: "en-IE",
  responderPage: "https://www.disneystore.com.au/on/demandware.store/Sites-DisneyStoreAUNZ-Site/en_AU/OneID-Responder",
  sessionId: "<per-page>",
  debug: false
};

var loginConfig = {
  endpoint: "https://www.disneystore.com.au/ocapi/cc/login",
  refreshEndpoint: "https://www.disneystore.com.au/on/demandware.store/Sites-DisneyStoreAUNZ-Site/en_AU/Login-Refresh",
  clientID: "0f4bc909-824c-445f-af00-7f4fb28cdb21",
  oidClientID: "WDI-SHOPDISNEYAUNZ.WEB-PROD",
  status: false,
  reviewLogin: false,
  identityFlow: false,
  sourceClientID: "WDI-POPUPSHOPDISNEYAUNZ.WEB"
};
```

Scripts: `OneID.js` + `responder.js` on `OneID-Responder` (soft 200 HTML shell).

**Agen implication:** account creation is **Disney OneID**, not a simple SFCC register form. Expect email verification via Disney ID; SMS unknown — confirm in HAR. Reuse IMAP for email OTP; OnlineSim only if OneID forces SMS.

**Guest checkout:** Global-e often allows guest — confirm whether bag → GE requires OneID. Prefer **guest ATC → GE** first if allowed (faster than agen).

---

## 4. Catalog / monitor

| Surface | Status (DC) | Use |
|---|---|---|
| `GET /` | 200 | Cookie warm |
| `GET /new`, `/toys`, categories | 200 | PLP monitor |
| `GET /{slug}-{sku}.html` | 200 | PDP stock |
| `SearchServices-GetSuggestions?q=` | 200 HTML | Soft typeahead (e.g. `stitch`) |
| `GET /sitemap_index.xml` → `sitemap_0.xml` | 200 | ~2.3k locs; AU + `/nz/` pairs |
| `Cart-MiniCartShow` | 200 | Empty bag probe |

**PDP shape:**  
`https://www.disneystore.com.au/{seo-slug}-{sku}.html`  
Example SKU / `data-pid`: `050368983992` (Lorcana Gateway).

**NZ:** same SKU under `/nz/{slug}-{sku}.html`.

Monitor strategy: sitemap + suggest + PDP `data-pid` / OOS markers — no DD/Incapsula on browse from DC.

---

## 5. Cart / ATC

| Endpoint | Method | DC result |
|---|---|---|
| `…/Cart-AddProduct` | POST | **403 Access Denied** (Akamai) without warm |
| `…/Cart-MiniCartShow` | GET | 200 empty minibag |
| `/bag` | GET | 200 bag page |

PDP embeds:

```html
<input class="add-to-cart-url"
  value="/on/demandware.store/Sites-DisneyStoreAUNZ-Site/en_AU/Cart-AddProduct" />
```

### ATC wire (AU ISP + `main.js` + headed HAR, 2026-07-26)

| Step | Detail |
|---|---|
| CSRF | `POST CSRF-Generate` → `{ csrf: { tokenName: "csrf_token", token } }` ✅ HAR |
| Primary ATC body | Live browser: `pid` + `quantity` + `csrf_token` (optional `pidsObj` / bundles) |
| reCAPTCHA | **Enterprise on ATC** — `execute(sitekey, { action: "AddToCart" })` → `POST Google-reCaptchaEnterprise` `{ token }`. CapSolver ProxyLess mints OK; SFCC currently returns `result:false` for CapSolver **and** native browser tokens (open). |
| Sitekeys | ATC button `6LfTl6Ap…`; widget `#g-recaptch` also `6LeKIIIp…` + classic `Google-reCaptcha` |
| Akamai | **Hyper allowlisted (2026-07-26)** — sensor POST **201 `{success:true}`**, `~0~` ✅ (plateau → script rebind). Home HTML: **no SBSD / no bazade pixel** (sensor script only). |
| ATC | **Root cause = TLS/JA3, not missing SBSD.** Undici + valid `_abck` + CSRF 200 → `Cart-AddProduct` **AkamaiGHost 403**. Same jar on **node-tls-client `chrome_131`** → **ATC 200** `Product added to cart` + minibag line (Lorcana `050368983992`, 2026-07-26). Checkout defaults Disney to TLS (`DISNEY_TLS=0` / `transport=undici` to override). Exit-IP sensitive — some sticky lines still 403 after solve. |
| GE token | **`POST` `Globale-GetCartToken`** (empty body) → `{ cartToken, success:true }` after ATC. **GET** returns SFCC 500 even with bag lines. |
| HAR | `experiments/disney-isp-capture.mjs` + hyper labs → `har/disney/` (full HAR in `/tmp/disney-*`) |

**Module assumption:** **TLS chrome_131 + Hyper Akamai warm → sticky AU ISP → CSRF → Cart-AddProduct → bag → POST Globale-GetCartToken → GEM GetCartToken mid 1696 → Checkout/v2 (stop before pay)**. CapSolver optional (SFCC verify still `result:false`).

---

## 6. Global-e (mid **1696**)

| Field | Value |
|---|---|
| Merchant ID | **1696** |
| Hashed | `mZ25` |
| Client SDK | `https://web.global-e.com/merchant/clientsdk/1696` |
| API version | `2.1.4` |
| Checkout | V2 (`IsV2Checkout=true`); container suffix `Global-e_International_Checkout` |
| Cookie domain | `www.disneystore.com.au` |
| Controllers | `Globale-GetCartToken`, `Globale-ConvertPrice`, `Globale-GetSiteRedirectUrl` |
| MoR | Global-e AU entity (GE Terms of Sale Disney Store Aug 2024) |

**Reuse:** Bandai GE mid **1925** helper should parameterize `merchantId` / cookie domain / handoff URLs — do not hard-code Bandai-only mid.

Ship costs (public FAQ): AU standard **A$9.95** / express **A$14.95**; NZ similar in NZ$.

---

## 7. Antibot / captcha

| Layer | Fit | Notes |
|---|---|---|
| Akamai BM | Hyper ✅ | Warm before ATC; pixel may be required — confirm allowlist |
| Cloudflare | Soft on GET | Watch drop-day challenges |
| reCAPTCHA Enterprise | Hyper ❌ | Likely login / checkout / bot triggers — browser or external solver |
| Queue-it | US site yes; **AU not seen** this dig | Re-check on hype |

US `disneystore.com` showed `x-queueit-connector: akamai` — do not assume AU has the same waiting room.

---

## 8. Module plan (phased)

| Phase | Work | Acceptance |
|---|---|---|
| **D0** | AU ISP HAR: guest browse → PDP → ATC → bag → GE checkout (+ OneID login if forced) | Captcha + CSRF + GE bodies captured |
| **D1** | Monitor (sitemap / suggest / PDP OOS) | Lorcana/exclusive alerts |
| **D2** | Akamai warm + `Cart-AddProduct` dry-run | Line in bag on sticky AU |
| **D3** | Global-e handoff mid **1696** (share Bandai GE codepath) | Checkout iframe/session started |
| **D4** | Pay (card / wallets on GE) | Order or clean decline |
| **D5** | OneID agen (optional) | Vault accounts if guest blocked / limits |

---

## 9. Owner supplies

1. Sticky **AU residential/ISP** proxies  
2. HAR: ATC + GE (+ OneID if used)  
3. Optional: Disney OneID test account  
4. Payment method for GE  
5. Confirm Hyper **Akamai allowlist** includes `disneystore.com.au`

---

## 10. Open questions

1. Guest vs OneID-required before GE  
2. ~~Where reCAPTCHA Enterprise fires~~ → **ATC** (action `AddToCart`) + gift-card balance; login path still TBD  
3. ~~Exact CSRF + ATC fields~~ → closed from `main.js` (see §5); live CSRF still 500 until `_abck` solved  
4. Variant / size products (costume SKUs) vs simple `standard` pid  
5. NZ shipping profile vs AU bag on same session  
6. Per-customer / drop limits  
7. **GE issuer encoded merchant** (Bandai `8urc` / PC `8u22` analogue) + secure host for mid **1696**  
8. CapSolver / external solver for reCAPTCHA Enterprise `AddToCart`

---

## 11. Verdict

| Question | Answer |
|---|---|
| Full dig done? | **Yes** (this file) — HAR still needed for ATC/GE bodies |
| Build next after Bandai+PC? | Strong **GE-reuse** candidate; vs Costco: Costco = Hyper-native membership Hot Buys; Disney = GE + OneID + reCAPTCHA friction |
| Hyper? | Akamai yes; captcha/GE no |
| BUTT overlap? | Yes — parity store |

Related: Bandai GE (`BANDAI_AU_MODULE.md`), competitor gap (`COMPETITOR_BUTT_GAP.md`), handoff (`DISNEY_BUILD_HANDOFF.md`).
