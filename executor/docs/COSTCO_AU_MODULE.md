# Costco AU — Module Research

_Date: 2026-07-18 (deep dig)_  
_Status: research only — no adapter code yet_  
_Priority: **backlog behind Bandai** — strong Hyper fit (Akamai already in executor + Kasada whitelist), but **paid membership gate** + dual antibot + DC hard-block make local HAR mandatory before build._  
_Owner signal: Hyper whitelist granted **Akamai + Kasada** access for Costco._

Canonical storefront: **`https://www.costco.com.au/`**  
PDP shape: `/c/{slug}/p/{productCode}` (e.g. `/c/…/p/259589`)  
Hot Buys: `/c/hot-buys` · `/c/hot-buys-category`

---

## 1. Executive summary

Costco AU is **SAP Commerce Cloud + Angular Spartacus** behind **Akamai Bot Manager** (sensor + pixel confirmed) with **Queue-it** waiting-room wiring (`costcointl`) and a claimed **Kasada** layer (Hyper whitelist; **not observed** on anonymous AU PDP browse — confirm on login/ATC/checkout HAR).

Critical path realities:
1. **Membership required** to shop online (`costcohelp` + T&Cs). Warehouse card → separate online registration (membership number + reCAPTCHA “I’m not a robot” + address validation). **Agen is not free-scale** — accounts need real paid memberships.
2. **DC egress is hard-blocked** — almost every path returns Akamai `403 Access Denied`. Soft anomaly: `GET /favicon.ico` returned the Spartacus HTML shell (`<base href="/spartacus/assets/">`, `istio-envoy`, `ak_bmsc`).
3. With a real AU browser session, catalog is **OCC-style REST** under base site **`australia`** (`/rest/v2/australia/…`, `/rest/v3/australia/…`) plus `GET /session` whoami.
4. Hyper reuse is the best of the backlog stores after Target: **Akamai sensor/SBSD/pixel already in `antibot.js`**; Kasada CT/CD is documented in Hyper SDK but **not wired** in executor yet.

Competitive angle: Hot Buys / limited electronics melt; membership friction keeps casual bots out — but ops cost (cards) is high vs Bandai agen.

---

## 2. Stack map

| Layer | Tech | Evidence |
|---|---|---|
| CDN / WAF | **Akamai** (`AKAMAI-AS`, `ak_bmsc`, `bm_sv`, `/akam/13/…`) | DC 403; urlscan AU PDP |
| Antibot (primary) | **Akamai Bot Manager** sensor + **pixel** | `/akam/13/11939384`, `/akam/13/pixel_11939384` |
| Antibot (claimed) | **Kasada** | Hyper Costco whitelist (Akamai+Kasada); **no `kpsdk`/`ips.js`/`/fp`/`/tl` in guest PDP scan** |
| Waiting room | **Queue-it** customer `costcointl` | `static.queue-it.net` + `assets.queue-it.net/costcointl/…/queueclientConfig.js` — integrations `[]` on 2026-04-28 scan (idle) |
| Edge origin | **istio-envoy** | Response `server: istio-envoy` |
| Storefront | **Angular Spartacus** | `<main app-root>`, `/spartacus/assets/main-*.js` |
| Commerce | **SAP Commerce Cloud** | `/medias/sys_master/…`, `/_ui/responsive/theme-costco/…`, OCC REST |
| CMS / assets | **Contentstack** | `azure-na-images.contentstack.com` |
| Reviews | Bazaarvoice client **`costco-au`** | `apps.bazaarvoice.com/deployments/costco-au/…` |
| Email | Emarsys | Hot Buy email deep links via `link.costco.com.au` |
| Help | Zendesk `costcohelp` | Membership / online account docs |
| Payments (T&Cs) | **Visa, Mastercard, Apple Pay** only on `www.costco.com.au` | Gateway vendor (CyberSource vs other) **unconfirmed** — need checkout HAR |

Legacy Hybris theme paths (`/_ui/responsive/…`) still ship fonts/icons alongside the Spartacus SPA.

---

## 3. Antibot behaviour

### 3.1 Akamai (confirmed)

| Signal | Detail |
|---|---|
| Soft cookies | `ak_bmsc` (HttpOnly, `.costco.com.au`), `bm_sv` |
| Sensor script | `GET /akam/13/11939384` |
| Pixel | `POST /akam/13/pixel_11939384` |
| DC probe | Home, PDP, `/session`, `/rest/v2/australia/…`, `/spartacus/assets/*` → **403 Access Denied** (edgesuite reference) |
| Soft leak | `GET /favicon.ico` → **200** Spartacus HTML shell (~57 KB) + `ak_bmsc` set |

Expect full BM cookie set (`_abck`, `bm_sz`, etc.) once sensor posts succeed on ISP — same class as Kmart. Pixel path is live → treat Hyper pixel as **likely required** (unlike “most sites” default); confirm with support if Costco is allowlisted for pixel.

### 3.2 Kasada (Hyper whitelist; live surface TBD)

Hyper documents two flows (`hyper-solutions-brief.md` §5.2):
1. **Initial 429 + `/ips.js` → POST `/tl`**
2. **Background `/fp` → CT (`x-kpsdk-ct`) + optional POW CD (`x-kpsdk-cd`)**

**This dig:** anonymous AU urlscan of a Hot Buy PDP showed **zero** Kasada markers. Possibilities:
- Kasada only on login / cart / checkout / account APIs
- Triggered by bad TLS / automation / after Akamai clears
- Whitelist covers Costco **family** (e.g. other locales) — still treat AU as in-scope per owner

**Module assumption until HAR:** warm Akamai first (Kmart pattern), then watch for `429` + `ips.js` or `/fp` on mutating/auth calls; wire `generateKasadaPayload` + `generateKasadaPow` in `antibot.js` when seen.

### 3.3 Queue-it

```js
window.queueit_clientside_config = {
  customerId: "costcointl",
  integrations: []   // empty on 2026-04-28 idle scan
};
```

Client scripts load from Spartacus chunk (`queueconfigloader` / `queueclient`). On Hot Buy / hype days expect non-empty integrations + `QueueITAccepted*` cookies and `x-queueit-ajaxpageurl` on XHRs (already present as header on anonymous REST calls).

---

## 4. Session + membership

### 4.1 Whoami

SPA boots with:

```js
window.sessionPromise = fetch('/session');
```

Anonymous REST XHRs send custom header:

```http
Membership-Data: {"membership_expiry":null,"member_type":"ANONYMOUS","is_international_member":null,"membership_upgrade_available":null,"membership_upgrade_pending":null}
```

Logged-in members will flip `member_type` / expiry — capture exact shape from HAR.

Also present on XHR: `x-queueit-ajaxpageurl: <urlencoded page URL>`.

### 4.2 Membership gate (ops, not code)

| Fact | Source |
|---|---|
| Membership required for warehouse **and** `costco.com.au` | Zendesk “Do I need a membership to shop?” |
| Online account ≠ warehouse signup — must **Register Now** with card number | Zendesk online-account article |
| Registration includes **reCAPTCHA** + address find/validate + SMS/email confirm | Same |
| Non-members can only buy Costco via **DoorDash** (different stack; not this module) | News / DoorDash partnership |

**Agen implication:** no OnlineSim-scale Costco membership factory. Module model = **vault of real memberships** (owner-supplied cards) → online login sessions. Shared IMAP may still help for online-account OTP/confirm email, but SMS + physical card remain blockers.

Gold Star ~$65 / Executive ~$130 AUD (public figures) — multi-account scale is expensive vs Bandai.

---

## 5. API map (from AU browser urlscan + Spartacus norms)

**Base site ID:** `australia`  
**Locale / currency query:** `lang=en_AU&curr=AUD`

### Confirmed live (anonymous, AU egress)

| Method | Path | Role |
|---|---|---|
| `GET` | `/session` | Whoami / session bootstrap |
| `GET` | `/rest/v2/australia/products/{code}/?fields=FULL&lang=en_AU&curr=AUD` | PDP product JSON |
| `GET` | `/rest/v2/australia/metadata/productDetails?code={code}&lang=en_AU&curr=AUD` | Extra PDP metadata |
| `GET` | `/rest/v2/australia/i18n/chunk/en_AU?basename=&lang=en_AU&curr=AUD` | i18n bundle |
| `GET` | `/rest/v3/australia/cms/pages?pageType=ProductPage&code={code}&lang=en_AU&curr=AUD` | CMS page for PDP |
| `GET` | `/rest/v3/australia/cms/csheader?lang=en_AU&curr=AUD` | Header CMS |
| `GET` | `/rest/v3/australia/cms/navigationMenu?lang=en_AU&curr=AUD` | Nav CMS |

DC cannot call these (403). Monitor strategy once Akamai warm: poll `products/{code}` + `metadata/productDetails` for stock/price flags.

### Expected Spartacus / OCC shapes (HAR to confirm)

Standard Commerce Webservices patterns Costco likely follows (names may be customized):

```
# OAuth (typical)
POST /authorizationserver/oauth/token
  grant_type=password&client_id=…&client_secret=…&username=…&password=…

# Cart (authenticated member — anonymous may be blocked by membership)
POST /rest/v2/australia/users/current/carts?fields=FULL&lang=en_AU&curr=AUD
POST /rest/v2/australia/users/current/carts/{cartId}/entries
  { "product": { "code": "259589" }, "quantity": 1 }

GET  /rest/v2/australia/users/current/carts/{cartId}?fields=FULL&…
POST …/carts/{cartId}/addresses/delivery
POST …/carts/{cartId}/paymentdetails   # or payment provider silent post
POST …/users/current/orders
```

Do **not** treat anonymous ATC as viable — membership gate implies `users/current` path after login.

Search (unconfirmed live):  
`GET /rest/v2/australia/products/search?query=…&pageSize=…&lang=en_AU&curr=AUD`

---

## 6. Catalog / drop surfaces

| Surface | URL / signal |
|---|---|
| PDP | `/c/{seo-slug}/p/{productCode}` |
| Hot Buys | `/c/hot-buys`, `/c/hot-buys-category` — “Member Only Item” badges |
| Email drops | Emarsys → `link.costco.com.au/u/nrd.php?…` → PDP with `utm_campaign=…Hotbuy` |
| Product id | Numeric OCC code (e.g. `259589`) — use for REST, not only slug |

Stock / purchasability fields live in `products/{code}?fields=FULL` + `metadata/productDetails` — extract exact flag names from first successful ISP JSON.

---

## 7. Checkout + payments

T&Cs: **Visa, Mastercard, Apple Pay** only on `www.costco.com.au`.  
Payment gateway vendor **not proven** in this dig (CyberSource is common on Spartacus but not listed in public tech stacks for AU). Need HAR of payment iframe / silent post / Apple Pay session.

Expect:
1. Membership login session
2. Cart entries
3. Delivery address (member profile may prefill)
4. Payment authorize → order create
5. Possible 3DS / bank challenge on card

Apple Pay may be desktop/Safari-constrained — card path is the automation default.

---

## 8. Soft SPA shell (DC leak)

`GET https://www.costco.com.au/favicon.ico` (mis-routed) returned:

```html
<title>Costco</title>
<base href="/spartacus/assets/">
<main app-root></main>
<script>window.sessionPromise = fetch('/session');</script>
<script src="polyfills-….js" type="module"></script>
<script src="scripts-….js" defer></script>
<script src="main-….js" type="module"></script>
```

Headers: `server: istio-envoy`, `set-cookie: ak_bmsc=…`, CSP `frame-ancestors 'self' https://*.costco.com.au`.  
Asset hashes rotate (urlscan had `main-CPAFIK5L.js`; soft shell had `main-S4LWVB3Y.js`). Always resolve from live HTML — do not hardcode chunk names.

---

## 9. Module plan (when unparked)

### Phases

| Phase | Work |
|---|---|
| **C0** | **AU ISP HAR (member login):** home → Akamai warm → login → PDP → ATC → checkout → pay attempt. Capture Kasada if any, OAuth token URL, cart entry body, payment posts, Queue-it cookies under load. |
| **C1** | Wire **Kasada** in `antibot.js` (CT + CD) if HAR shows it; allowlist `costco.com.au`. Reuse Akamai sensor/SBSD/pixel. |
| **C2** | Monitor: poll `/rest/v2/australia/products/{code}` + metadata for Hot Buy SKUs; Discord/desktop notify. |
| **C3** | Session machine: login + `Membership-Data` header + jar; cart ATC. |
| **C4** | Checkout + card/Apple Pay; Queue-it pass-through when `integrations` non-empty. |
| **Cagen** | Not traditional agen — **membership vault** UI (card #, online creds, IMAP for confirm mail). Optional OnlineSim only if Costco SMS OTP appears on login (unconfirmed). |

### Executor touchpoints

```
antibot.js          # Akamai ✅ · Kasada ❌ wire · Queue-it cookie passthrough
adapters/costco.js  # new — after C0 HAR
desktop Settings    # membership vault + shared IMAP (reuse Bandai OTP settings)
```

### Feasibility

| Factor | Score |
|---|---|
| Hyper antibot fit | **High** — Akamai live in product; Kasada whitelisted |
| API clarity | **Medium** — baseSite + PDP REST known; cart/auth sketched |
| Account friction | **Very high** — paid membership + reCAPTCHA register |
| DC probeability | **None** — ISP/desktop only |
| Yield | High on Hot Buys / electronics; ops-limited by card count |

---

## 10. Probe log (2026-07-18)

| Probe | Result |
|---|---|
| `GET /` · `/c/…/p/259589` · `/session` · `/rest/v2/australia/…` · `/spartacus/assets/…` | **403** Akamai Access Denied (DC) |
| `GET /favicon.ico` | **200** Spartacus HTML shell + `ak_bmsc` |
| Queue-it config CDN | **200** `customerId=costcointl`, `integrations=[]` |
| Contentstack logo CDN | **200** |
| urlscan AU PDP (2026-04-28) | Akamai sensor+pixel; REST v2/v3 `australia`; `/session`; Queue-it scripts; Membership-Data ANONYMOUS; **no Kasada** |
| Public stack lists | SAP Commerce, Angular, Envoy, Queue-it, Contentstack — Kasada not listed |

---

## 11. Open questions (local HAR day)

1. Does Kasada appear on login, ATC, or checkout (path, flow 1 vs 2)?
2. OAuth: `authorizationserver` URL, `client_id`, username = email vs membership number?
3. Exact ATC: `users/current/carts/.../entries` body + required headers (`Membership-Data`, CSRF)?
4. Guest browse stock vs purchase — can anonymous see FULL product stock?
5. Is Akamai pixel enforced for Costco (Hyper support)?
6. Payment: CyberSource silent post vs other; Apple Pay session API?
7. Queue-it: which Hot Buy events enable integrations; cookie TTL?
8. Login MFA: SMS/email OTP frequency?
9. International membership checkbox path — usable for multi-region cards?
10. `_abck` / SBSD / sec-cpt behaviour under drop load vs Kmart.

---

## 12. Sources

- Live DC probes (Cursor cloud) 2026-07-18  
- urlscan.io AU scan of Hot Buy PDP (uuid `019dd683-5f2b-7029-98d6-2a3ae919ab47`, 2026-04-28)  
- Queue-it public config `assets.queue-it.net/costcointl/…`  
- Zendesk Costco AU membership / online account articles  
- Costco AU Terms (payment methods)  
- Hyper Kasada docs + owner whitelist note (Akamai + Kasada for Costco)  
- `executor/docs/hyper-solutions-brief.md` §5.2
