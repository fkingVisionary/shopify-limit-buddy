# Topps (multi-region) — Module Research & Plan

_Date: 2026-07-22_  
_Status: research only — no adapter code yet_  
_Owner ask: **US + JP first**, then remaining regions (UK / EU / IN / BR)._  
_Baseline: Fanatics Collectibles has replatformed Topps off Magento onto **Shopify** (separate shop per locale)._

---

## 1. Executive summary

Topps physical DTC is no longer one Magento Blue Acorn instance. Production is a **fleet of Shopify stores** behind **Cloudflare**, one shop per region, with Shopify **Customer Accounts** (new customer account API / OAuth) on `account*.topps.com`.

| Priority | Region | Primary shop host | `myshopify` | Shop ID | Currency |
|---|---|---|---|---|---|
| **P0** | **US** | `shop.topps.com` (`www.topps.com` also serves storefront HTML) | `213d22-a1.myshopify.com` | `66297495709` | USD |
| **P0** | **JP** | `shop-jp.topps.com` | `topps-jp.myshopify.com` | `72813576425` | JPY |
| P1 | UK | `shop-uk.topps.com` | `topps-uk.myshopify.com` | `73920151805` | GBP |
| P1 | DE | `shop-de.topps.com` | `topps-deu.myshopify.com` | `74937106672` | EUR |
| P1 | ES | `shop-es.topps.com` | `topps-esp.myshopify.com` | _(via UCP)_ | EUR |
| P1 | FR | `shop-fr.topps.com` | `topps-fra.myshopify.com` | _(via UCP)_ | EUR |
| P1 | IT | `shop-it.topps.com` | `topps-ita.myshopify.com` | _(via UCP)_ | EUR |
| P2 | IN | `shop-in.topps.com` | `topps-in.myshopify.com` | `91153105197` | INR |
| P2 | BR | `shop-br.topps.com` | `topps-bra.myshopify.com` | `56853266517` | BRL |
| Dev | Staging | `shopify-staging.topps.com` | `topps-dev.myshopify.com` | `87844520258` | USD |

**Yield:** Topps NOW / hobby drops / Japan Edition exclusives — high $ on timed releases; crowded (NSB already lists ToppsUS / ToppsJP / EU).

**Hyper fit: poor.** Edge is **Cloudflare** (hard `403 Attention Required` / managed challenge from DC on branded hosts). Captcha historically **Turnstile** on Magento forms; EU competitor guides cite **hCaptcha**. Neither is Hyper-native. Treat like JB / Toymate: **residential + desktop/browser clear**, not undici-first.

**Architecture win:** one parameterized **Shopify ATC/checkout** adapter + **region config table** (host, shop ID, currency, account host, ship-to). Do **not** build Magento paths — those are legacy.

**Out of scope for v1:** `play.toppsapps.com` (digital apps / Laravel), `ripped.topps.com` (Kinsta live breaks), Rakuten / Yahoo JP marketplace listings.

---

## 2. Stack map (confirmed 2026-07-22)

| Layer | Tech | Evidence |
|---|---|---|
| Edge | **Cloudflare** | `server: cloudflare`, `__cf_bm`, DC `403` on almost all branded HTML/JSON |
| Commerce | **Shopify** (per-region shops) | `powered-by: Shopify`, `_shopify_*` cookies, `meta.json`, UCP |
| Canonical shop hosts | `shop.topps.com`, `shop-{region}.topps.com` | `meta.json` `domain` / `url` fields |
| Locale vanity hosts | `www` / `uk` / `jp` / `de` / … | Same CF edge; often UCP `404` HTML shell that still embeds `myshopify` |
| Accounts | Shopify **Customer Accounts** OAuth | `accounts-jp.topps.com` → `/authentication/oauth/authorize?…&scope=openid+email+customer-account-api%3Afull` |
| Agent / UCP | Shopify Universal Commerce Protocol | Soft `GET /.well-known/ucp` on `shop-*` + staging (`version: 2026-04-08`) |
| Fraud | **Riskified** (US HTML) | Present in `www.topps.com` storefront shell |
| Pay | Shopify Checkout + Shop Pay (US) | US meta: Shop Pay card brands + installments; JP: Visa/MC/Amex/**JCB**, no installments |
| Legacy | Magento 2 / Blue Acorn | Historical agency case studies; **do not target** for new build |
| Digital (separate) | Laravel on AWS | `play.toppsapps.com` — not physical checkout |

### Soft surfaces that work from DC (use for research / light monitor)

| Surface | Status | Notes |
|---|---|---|
| `https://{region}.myshopify.com/meta.json` | **200** | Shop id, currency, ship-to, product counts |
| `https://shop-*.topps.com/.well-known/ucp` | **200** | Confirms shop + UCP capabilities |
| `https://shopify-staging.topps.com/{cart.js,meta.json,agents.md}` | **200** (rate-limits on some) | Dev sandbox; `agents.md` documents UCP flow |
| Branded `/cart.js`, `/products.json`, HTML | **403** CF | Needs residential / cleared session |
| Direct `*.myshopify.com/products.json` | Often **429** `local_rate_limited` | Soft but throttled |

---

## 3. Region dossier

### 3.1 United States — P0

| Field | Value |
|---|---|
| Primary | `https://shop.topps.com/` |
| Also | `https://www.topps.com/` (large Shopify HTML; UCP path returns 404 page that still loads shop assets) |
| `myshopify` | `213d22-a1.myshopify.com` |
| Shop ID | `66297495709` |
| Accounts | `https://account.topps.com/` → OAuth `client_id=fb81dcd7-4a02-4a54-9f13-f48699169b6e`, CSP allows `213d22-a1.myshopify.com` |
| Currency | USD |
| Ship-to | Broad international list in meta (near-global) |
| Catalog size (meta snapshot) | ~18 published products / 62 collections (NOW-heavy catalog churns; treat as snapshot) |
| Pay signals | Shop Pay enabled; Visa / MC / Amex / Discover |
| Fraud | Riskified on storefront shell |

**Drop product:** Topps NOW MLB / NBA / WWE / hobby boxes. Competitor bots run **guest** checkout on US.

### 3.2 Japan — P0

| Field | Value |
|---|---|
| Primary | `https://shop-jp.topps.com/` |
| Vanity | `https://jp.topps.com/` (CF-hard from DC; `/collections/…` paths = Shopify) |
| `myshopify` | `topps-jp.myshopify.com` |
| Shop ID | `72813576425` |
| Accounts | `https://accounts-jp.topps.com/` · locale `ja-JP` · OAuth `client_id=a7529fea-ad58-419e-8f4a-1aae9540d9c9` |
| Currency | JPY (`¥{{amount_no_decimals}}`) |
| Ship-to | **Asia-Pacific only** (JP, AU, CN, HK, ID, KR, MO, MY, NZ, PH, SG, TH, TW, VN) — no US ship from JP shop |
| Catalog size (meta snapshot) | ~6 products / 54 collections |
| Pay | Visa / MC / Amex / **JCB**; Shop Pay installments off |
| Marketplace (not module) | Official Rakuten + Yahoo stores — separate platforms |

**JP-specific yield:** Japan Edition baseball, NPB, J.League, WBC Team Japan NOW — often JP-shop exclusive or earlier.

**Agen note:** JP Customer Accounts flow is email-centric OAuth; confirm OTP / email verify on sticky JP residential before designing `topps-jp-agen`. SMS less central than Bandai BNID, but IMAP still required.

### 3.3 Remaining Shopify regions (P1–P2)

| Host | `myshopify` | Accounts host | Notes |
|---|---|---|---|
| `shop-uk.topps.com` | `topps-uk.myshopify.com` | `accounts-uk.topps.com` | GBP; ships GB + selected intl |
| `shop-de.topps.com` | `topps-deu.myshopify.com` | `accounts-de.topps.com` | EUR; EU-heavy ship list |
| `shop-es.topps.com` | `topps-esp.myshopify.com` | `accounts-es.topps.com` | UCP confirmed |
| `shop-fr.topps.com` | `topps-fra.myshopify.com` | `accounts-fr.topps.com` | UCP confirmed |
| `shop-it.topps.com` | `topps-ita.myshopify.com` | `accounts-it.topps.com` | UCP confirmed |
| `shop-in.topps.com` | `topps-in.myshopify.com` | `accounts-in.topps.com` | INR |
| `shop-br.topps.com` | `topps-bra.myshopify.com` | `accounts-br.topps.com` | BRL |

NSB publicly lists: **ToppsUS, ToppsUK, ToppsDE, ToppsES, ToppsFR, ToppsIT, ToppsJP** — guest mode, CF browser mandatory, EU hCaptcha callout.

---

## 4. Antibot / access reality

| Observation | Implication |
|---|---|
| DC egress → branded hosts **403** CF challenge | Proves need sticky **US / JP residential or ISP** + browser TLS fingerprint |
| `shop-*` UCP soft; cart/products hard | Discovery ≠ ATC. Clear CF cookie jar before `/cart/add.js` |
| Staging softer than prod | Use `shopify-staging` only to learn UCP shapes — **never** for drop inventory |
| Historical Turnstile on Magento forms | Expect Turnstile and/or Shopify bot protection + EU hCaptcha on prod — **confirm in HAR** |
| Riskified (US) | Post-ATC fraud risk; clean accounts / billing congruence matter |
| Competitor guidance: guest checkout, no login/2FA | v1 can be **guest-first**; agen is for limit-bypass / loyalty later |

**Hyper:** not applicable for CF. Do not block Topps on Hyper allowlisting. Reuse any future **CF / Turnstile / hCaptcha** productization shared with JB / Toymate / EB.

---

## 5. Module plan

### 5.1 Design principles

1. **One adapter, many regions** — `adapters/topps.js` (or `shopify-topps.js`) driven by `TOPPS_REGIONS` config.
2. **Guest checkout first** (matches competitor playbook); account login / agen as Phase B.
3. **CF session prerequisite** — desktop Electron or cleared jar from residential before undici cart calls.
4. **Do not touch Kmart.** Feature branch off current `main`.
5. **No Magento** endpoints (`/customer/account/login`, `/checkout/cart` Magento forms, Blue Acorn static).

### 5.2 Suggested region config shape

```js
// illustrative — not shipped code
TOPPS_REGIONS = {
  us: {
    shopHost: 'https://shop.topps.com',
    myshopify: '213d22-a1.myshopify.com',
    shopId: 66297495709,
    accountHost: 'https://account.topps.com',
    currency: 'USD',
    locale: 'en-US',
  },
  jp: {
    shopHost: 'https://shop-jp.topps.com',
    myshopify: 'topps-jp.myshopify.com',
    shopId: 72813576425,
    accountHost: 'https://accounts-jp.topps.com',
    currency: 'JPY',
    locale: 'ja-JP',
  },
  // uk, de, es, fr, it, in, br …
}
```

### 5.3 Phased build

| Phase | Scope | Acceptance |
|---|---|---|
| **T0 — Prove access** | Sticky US + JP residential; clear CF on `shop.topps.com` + `shop-jp.topps.com`; capture HAR: home → PDP → ATC → checkout | HAR in hand; note captcha vendor + guest vs forced login |
| **T1 — Monitor** | Poll soft `meta.json` / collection JSON / sitemap where CF allows; webhook on new NOW SKUs / stock | Alert on US + JP handles without full ATC |
| **T2 — Guest ATC (US)** | `POST /cart/add.js` → cart → checkout start on cleared session | Line item reserved; fail only on sold-out / limit |
| **T3 — Guest checkout (US)** | Payment path (card / Shop Pay as available); Riskified-safe profiles | Paid order or clean decline |
| **T4 — JP parity** | Same adapter, `jp` config; respect JP ship-to; JCB if needed | JP NOW / Japan Edition checkout |
| **T5 — EU pack** | UK/DE/ES/FR/IT configs; hCaptcha path | One EU region green then clone |
| **T6 — Agen (optional)** | Shopify Customer Accounts register + IMAP OTP; multi-account for per-customer limits | Vaulted accounts per region |

### 5.4 Shared dependencies (cross-store)

| Need | Shared with | Status |
|---|---|---|
| Cloudflare clear / Turnstile | JB, Toymate, EB, Pop Mart | Not productized |
| hCaptcha (EU) | Pokémon Centre (diff vendor), EU Topps | Not productized |
| IMAP OTP Settings | Bandai agen | Planned / Bandai track |
| OnlineSim | Bandai (SMS) | Likely unused for Topps v1 |
| Shopify cart primitives | JB (different theme/API wrappers) | Partial pattern only |

### 5.5 What owner should supply

1. Sticky **US residential** + **JP residential** proxies (separate pools).
2. HAR: US guest ATC→checkout; JP guest ATC→checkout (captcha frames included).
3. Optional: test Customer Account emails for agen (IMAP).
4. Cards / Shop Pay test profiles congruent with ship country (JP shop cannot ship to US).

---

## 6. Competitive & risk notes

- **Crowded:** NSB and others already multi-region; differentiation is local reliability + JP exclusives, not greenfield APIs.
- **Platform churn:** Magento→Shopify recent; vanity hosts / redirects may still move. Always resolve via `meta.json` + UCP, not hard-coded Magento URLs.
- **Per-customer limits:** Expect Shopify Functions / apps on NOW drops — guest multi-profile or agen may be required for scale.
- **Separate JP marketplaces:** Rakuten / Yahoo are not this module; ignore unless owner expands scope.
- **Digital apps:** Out of scope; different auth and economics.

---

## 7. Verdict

| Question | Answer |
|---|---|
| Build Topps? | **Yes as Phase 3-class** (high yield / weak Hyper) — after or parallel to Bandai, **not** before CF tooling exists or owner accepts browser/desktop ATC |
| US + JP same codebase? | **Yes** — region config over one Shopify adapter |
| Start with Magento research? | **No** — fleet is Shopify now |
| First milestone | T0 HARs on residential US + JP |
| Hyper? | Skip |

---

## 8. Open questions (close with HAR / residential)

1. Exact captcha on US vs JP vs EU at ATC vs checkout (Turnstile vs hCaptcha vs Shopify challenge).
2. Whether `www.topps.com` and `shop.topps.com` share cart cookies / checkout domain.
3. Guest checkout allowed on all regions or account-gated on some drops.
4. Per-SKU / per-customer limit enforcement mechanism (theme vs Checkout UI extension vs Function).
5. Queue-it or other waiting room on mega drops (not seen in soft probes).

---

## 9. Related docs

- Scoreboard: [`NEXT_STORE_MODULES.md`](./NEXT_STORE_MODULES.md)
- Roadmap: [`FUTURE_ROADMAP.md`](./FUTURE_ROADMAP.md)
- Similar CF+Shopify pain: [`JB_HIFI_MODULE.md`](./JB_HIFI_MODULE.md)
- CF+EQL parallel: Toymate (scoreboard)
