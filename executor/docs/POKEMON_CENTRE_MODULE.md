# Pokémon Centre (TPCI) — Module Research

_Date: 2026-07-22 (adapter scaffold)_  
_Status: **adapter scaffolded** — Incapsula/DD in `antibot.js` + `adapters/pokemoncentre*.js` + desktop store; Cortex ATC / GE mid still need AU ISP HAR_  
_Priority: **high yield / high difficulty** — Hyper covers **Incapsula + DataDome**; **hCaptcha** via CapSolver; **Global-e** reuses Bandai playbook (merchant mid TBD)._  
_GE update: Bandai AU (mid 1925) reached issuer wire proof 2026-07-22 — fold those patterns into P4 below._

### Canonical AU storefront
**`https://www.pokemoncenter.com/en-au`**  
Also: `en-nz`, `en-ca`, `en-gb`, US `/`, DE locale.  
Support confirms country switcher → regional paths ([Pokémon Center Support](https://support.pokemoncenter.com/hc/en-us/articles/360051729272)).

**Not this module:** Japan **`https://www.pokemoncenter-online.com/`** — separate stack (**SFCC + F5 volt-adc**). Do not confuse with TPCI `.com`.

No physical Pokémon Centre in AU — online only (opened ~June 2024 for AU/NZ).

---

## 1. Executive summary

TPCI Pokémon Center is the official exclusive merch / PC ETB channel. AU is the same React commerce app as US/UK, locale-scoped, with **Global-e** fulfilment for AU/NZ (GST-inclusive, duties handled — support docs).

Antibot is a **stacked** setup:
1. **Imperva / Incapsula** at the edge (DC gets iframe challenge / Distil-era script remnant)
2. **DataDome** in-app (`js.datadome.co`, first-party `dd.pokemoncenter.com`, `ct.captcha-delivery.com` / `geo.captcha-delivery.com`)
3. **hCaptcha** on Imperva / drop challenges (Valor + community; **not** a Hyper vendor)
4. Load **queue** under hype (IP-sticky; residential IP changes = requeue)

Commerce API surface (from `robots.txt`) is classic **Elastic Path Cortex**:
`/cortex`, `/carts`, `/extcarts`, `/items`, `/itemdefinitions`, `/availabilities`, `/orders`, `/paymentinstruments`, …

**Hyper fit: mixed-strong.** Incapsula + DataDome are Hyper-native (same wiring AusPost/HN need). Gaps: hCaptcha, Global-e checkout (now **partially demystified by Bandai**), ThreatMetrix / Quantum Metric fingerprinting, strict address/fraud limits, and a mature English-bot market (Valor etc.).

**Vs Bandai:** PC exclusives pay, but competition is fierce and antibot is heavier. Prefer Bandai greenfield first (done / shipping); treat PC as **Phase 2 after DD + Incapsula are wired**. Global-e P4 should **reuse Bandai GE playbook**, not rediscover iframes from scratch.

---

## 2. Stack map

| Layer | Tech | Evidence |
|---|---|---|
| Edge | **Imperva Incapsula** | `visid_incap_*`, `incap_ses_*`, `/_Incapsula_Resource`, `X-CDN: Imperva`; DC challenge HTML |
| Distil remnant | Imperva-era | `sessionStorage distil_referrer` in challenge shell |
| App antibot | **DataDome** | CSP: `js.datadome.co`, `dd.pokemoncenter.com`, `ct.captcha-delivery.com`; cookie `datadome`; headers `x-datadome` |
| Captcha | **hCaptcha** (+ reCAPTCHA script also in CSP) | Imperva iframe / bot guides; `sentry.hcaptcha.com` |
| CDN | CloudFront behind Imperva | urlscan `Via: CloudFront` |
| Commerce | **Elastic Path Cortex** | robots Disallow list of Cortex resource paths |
| CMS | Bloomreach | CSP `*.tpci1.bloomreach.cloud`, `*.cms.pokemoncenter.com` |
| Intl checkout | **Global-e** | CSP `*.global-e.com`; robots `/intl-checkout`; AU tax FAQ → Global-e partner |
| Payments | CyberSource + Cardinal 3DS; PayPal; Amazon Pay; Apple Pay; Klarna (AU) | CSP + support payment matrix |
| Fingerprint / fraud | ThreatMetrix (`online-metrix.net`), Quantum Metric | CSP |
| Experimentation | SiteSpect | `AllowSiteSpect`, `admin1.sitespect.com` |
| UI | React (NULogic case studies) | Public eng writeups |

### Locales (same host)
| Region | Path |
|---|---|
| US | `https://www.pokemoncenter.com/` |
| AU | `/en-au` |
| NZ | `/en-nz` |
| CA | `/en-ca` |
| UK | `/en-gb` |

**Region note (from Bandai expansion):** locale path parameterization is cheap once one region is green. For PC, AU/NZ are the Global-e locales — US/UK may stay domestic Cortex checkout (confirm in HAR). Do **not** assume every locale hits GE.

---

## 3. Antibot behaviour

### 3.1 DC probe (2026-07-21)

| Surface | Result |
|---|---|
| `GET /en-au/`, `/en-us/`, `/`, `/cortex`, `/carts` | ~1 KB Incapsula iframe challenge (HTTP 200 body = block) |
| `GET /robots.txt` | **200** — full Cortex Disallow list (soft) |
| `GET /product/…` (bad slug) | **403** Incapsula short HTML |
| PDP urlscan samples | Often **403** from scanners |

Challenge shape:
```html
<script src="/vice-come-Soldenyson-it-non-Banquoh-Chare-Hart-C" async></script>
<iframe id="main-iframe" src="/_Incapsula_Resource?SWUDNSAI=31&…"></iframe>
```

### 3.2 ISP capture (2026-07-22) — static `45.42.47.34`

Playwright HAR via sticky ISP (see `executor/har/pokemoncentre/`).

| Signal | Observation |
|---|---|
| Egress | ✅ `45.42.47.34` |
| Reese script | `/vice-come-Soldenyson-it-non-Banquoh-Chare-Hart-C` (confirmed) |
| Reese POST | `POST …?d=www.pokemoncenter.com` `text/plain` → `{"token":"3:…"}` → cookie `reese84` **minted in browser** |
| Incapsula site id | **2682446** (`visid_incap_2682446`, `incap_ses_*_2682446`) |
| DataDome | Slider block with **`t:'bv'`** after Reese — `rt:'c'`, `hsh:'5B45875B653A484CC79E57036CE9FC'`, `s:9817`, `ct.captcha-delivery.com/c.js` ([Hyper: hard IP block on slider `t=bv`](https://docs.hypersolutions.co/datadome/getting-started.md)) |
| Cortex / GE | Not reached on this exit |
| CONNECT flakes | Seen after bursts — classify with §3.4; do not spray proxies or assume “burnt exit” from a single connection error |

**Implication:** On that Chromium HAR, Reese worked and DataDome returned a Hyper-documented **slider hard block** (`t=bv`) — rotate sticky for *that* signal only. Reese alone is never enough. Prefer Hyper handlers / correct TLS+header order before churning exits. Artifacts: `har/pokemoncentre/README.md`.

### 3.3 Known layered checks (public + bot docs)
- Incapsula clear → browse
- DataDome interstitial/slider on protected XHR / PDP under suspicion
- hCaptcha when Imperva / drop protection escalates
- Queue when traffic spikes (session tied to IP)

**Module implication:** sticky residential/ISP per task; Hyper Reese84/UTMVC + DataDome slider/interstitial; **separate hCaptcha harvest** (browser/desktop) — Hyper does not solve hCaptcha.

### 3.4 Failure triage (Hyper Solutions — do not over-blame proxies)

Connection errors, 403s, and challenge loops are **easy to mislabel as proxy issues**. Classify against Hyper docs first:

| Signal | Meaning (Hyper) | Action |
|---|---|---|
| Interstitial POST → `{ cookie, view: "redirect", url }` | **Solved** ([getting started](https://docs.hypersolutions.co/datadome/getting-started.md)) | Parse `datadome=VALUE` only; retry protected URL |
| Interstitial → `view: "captcha"` (not `redirect`) | **Not solved** — usually TLS / header-order / cookie-jar mismatch, not automatic “dead proxy” | Fix client per [header order](https://docs.hypersolutions.co/request-based-basics/header-order.md) + [TLS fingerprinting](https://docs.hypersolutions.co/request-based-basics/tls-fingerprinting.md); prefer Hyper Playwright `DataDomeHandler` |
| Slider block page with `t: "bv"` / SDK `isIpBanned` | **Hard IP block** — “solving the challenge will not have any effect” ([slider warning](https://docs.hypersolutions.co/datadome/getting-started.md)) | Rotate sticky session |
| Escalated captcha URL containing `t=bv` | Treat as Hyper hard-block hint **after** confirming it is a slider/captcha path, not an interstitial parse bug | Rotate only if implementation already matches Hyper success shape |
| Tags `ch` then `le` | Trust telemetry — not a block page ([tags](https://docs.hypersolutions.co/datadome/tags.md)) | POST `/js`, update `datadome` from JSON cookie |
| CONNECT timeout / `net::ERR_*` / undici socket errors | Often handshake / TLS / proxy *path* flake | Retry once on same sticky; check TLS client profile — **do not** condemn the whole pool from one error |
| Cookie field `datadome=VALUE; Max-Age=…` stored whole | Implementation bug (we hit this) | Strip to VALUE only (`parseDatadomeSetCookie`) |
| Hyper Playwright `InvalidApiResponseError: invalid scriptUrl` on Reese POST | **SDK arg-order bug** in `hyper-sdk-playwright@1.0.0-beta.9` vs `hyper-sdk-js@2.12` (`Reese84Input` script/scriptUrl/pow swapped) | Patch handler call order (see `pokemoncentre-hyper-pw-capture.mjs`) — not a proxy issue |
| Interstitial `view=captcha` after undici Reese success | Client TLS/header fingerprint vs browser | Prefer Hyper PW handlers (with Reese patch) / tls-client header order before rotating exits |

**Rule of thumb:** bank-style proof for antibot is Hyper’s documented success shapes (`view: "redirect"`, slider check cookie). Proxy rotation is a last resort for documented `t=bv` hard blocks — not the default explanation for every failure.

**Transport lesson (Bandai):** keep **catalog/cart HTTP-first** once edge cookies are solved. Do **not** default a full Playwright checkout ladder for Cortex ATC. Browser is for (a) edge solve assist if Hyper stalls, (b) hCaptcha, (c) Global-e pay UI.

---

## 4. API / cart sketch (from robots + Cortex norms)

Confirmed Disallow paths (live `robots.txt`):

```
/availabilities  /carts  /cortex  /coupons  /dependentoptions
/digitalflag  /discounts  /extcarts  /extpaymentinstruments
/itemdefinitions  /items  /minicarts  /offers  /orders
/paymentinstructions  /paymentinstruments  /paymentmethods
/prices  /promotions  /recommendations  /subtotal  /totals
/wishlists  /account  /checkout  /intl-checkout
/site/*/resourceapi/  /page/*  /en-zz/*
```

Expect authenticated Cortex zoom URIs after Incapsula+DD warm, e.g.:
- Item lookup / availability → `/items` · `/availabilities` · `/itemdefinitions`
- Cart → `/carts` · `/extcarts` · `/minicarts`
- Checkout → `/checkout` (domestic) · `/intl-checkout` (**AU → Global-e**)

Exact zoom URLs, CSRF, and cart line bodies need **AU ISP HAR** (guest vs account).

PDP URL pattern (urlscan):  
`/product/{sku}/{seo-slug}` e.g. `…/product/10-10186-109/pokemon-tcg-…-elite-trainer-box`

---

## 5. Checkout + payments (AU) — Global-e

| Topic | Detail |
|---|---|
| Fulfilment | **Global-e** for AU/NZ — GST inclusive; duties/taxes in total ([support](https://support.pokemoncenter.com/hc/en-us/articles/360000234573)) |
| AU pay methods | Visa, MC, PayPal, Amex, Diners, Google Pay, Apple Pay, Klarna, Amazon Pay, UnionPay |
| Card rail | CyberSource + Cardinal Commerce 3DS (CSP) — **plus** GE-hosted card iframe (see Bandai) |
| Limits | Community/bot docs: strict address / device / billing fingerprint — multi-ship same address often declined |

`/intl-checkout` in robots strongly suggests AU leaves Cortex for Global-e mid-flow (same **class** as Bandai GE, **different merchant / mid / GEM CDN host**).

### 5.1 Bandai Global-e lessons (2026-07-22) — apply to PC P4

Bandai AU (merchant mid **1925**, `gem-bandai.global-e.com`) reached **issuer wire proof**: Revolut declined **A$317** to **“Globale /bandai Spirit”** (low balance) after automated Pay. Use this as the GE checklist for Pokémon Centre — do not relearn from zero.

| Lesson | What happened on Bandai | PC plan implication |
|---|---|---|
| **HTTP through handoff, browser for Pay** | undici + F5 sensor bridge → `checkoutSn`; GE card/Pay stayed in Playwright | Cortex ATC + `/intl-checkout` handoff = HTTP once Incapsula/DD clear. **GE Pay UI = browser** (or later shared `ge-checkout` helper). |
| **SPA boot > raw checkout id** | API `checkoutSn` alone often left orderdetails **without** payment iframe; UI **PROCEED TO CHECKOUT** booted GEM | Drive PC through the real **`/intl-checkout`** (or equivalent CTA), not only a Cortex order id. |
| **Wait for Checkout/v2, not prefetcher** | Prefetcher iframe ≠ ready; need `webservices.global-e.com/Checkout/v2/…` and/or `CreditCardForm` | Gate Pay on Checkout/v2 + secure card form frame; fail closed if only prefetcher. |
| **Cookie / CMP banners** | OneTrust overlay stalled GEM boot / empty page | Dismiss CMP (OneTrust / similar) before GE interactions. |
| **Nested secure card iframe** | `#secureWindow` → `secure-bandai.global-e.com/payments/CreditCardForm/…` | Expect `secure-*.global-e.com` (merchant-specific subdomain). Fill **inside** that frame. |
| **Field shape** | `cardNum` (tel), **SELECT** `cardExpiryMonth` / `cardExpiryYear`, `cvdNumber` (CVV); often **no** holder name | Use selects for expiry; don’t assume a single `MM/YY` input. |
| **Mandatory T&Cs checkbox** | “I confirm no returns…” unchecked → Pay click does nothing useful | Explicitly tick GE purchase-agreement / terms before Pay. |
| **Hidden fraud / captcha fields** | `PaymentData.recapchaToken` + `recapchaTime` (empty until solved); `CheckoutData.ForterToken` often empty at boot | Wait for token population / invisible captcha execute; Bandai JS also had cart-token captcha + FingerprintJS. PC CSP already lists hCaptcha + ThreatMetrix — expect **more** friction than Bandai. |
| **“Pay clicked” ≠ bank hit** | Narrow network filters reported `payNet=0` while Revolut still got the auth | Treat **issuer / bank notification as ground truth**. Broaden GE traffic capture after Pay; scrape GE body for decline copy. |
| **3DS is optional** | Low-balance soft-decline fired **without** ACS/3DS | Keep 3DS waiter as fallback; success/decline can be frictionless. Do not require `reached3ds` for “pay path green”. |
| **Score order** | Bank ping → GE/Bandai order number / `preComplete` → not client `ok` alone | Same for PC: Revolut/bank → GE confirmation → Cortex/TPCI order id. Persist milestones so client timeouts don’t hide wins. |
| **Lab cards** | Decline PAN for dry labs; disposable funded card for wire proof | Same. Never commit PANs. Stop before Pay on expensive SKUs unless owner opts in. |
| **Merchant-specific GEM** | `gem-bandai` / `web-bandai` / mid **1925** | HAR must capture PC’s `gem-*` host + **merchant id** — do not hardcode Bandai mid. |
| **Shared helper (future)** | Bandai logic lives in `bandai-browser-checkout.js` | When PC is built, extract a thin **`ge-pay.js`** (dismiss CMP → wait Checkout/v2 → fill CreditCardForm → tick T&Cs → Pay → wait 3DS/decline/order) parameterized by mid/hosts. |

### 5.2 Expected GE host pattern (confirm in PC HAR)

| Role | Bandai example | PC (TBD in HAR) |
|---|---|---|
| GEM script CDN | `gem-bandai.global-e.com/includes/js/{mid}` | `gem-*.global-e.com` or shared `web.global-e.com/merchant/…` |
| Checkout UI | `webservices.global-e.com/Checkout/v2/…` | same family |
| Card form | `secure-bandai.global-e.com/payments/CreditCardForm/…` | `secure-*.global-e.com` |
| Cart token | `gepi.global-e.com/Checkout/GetCartToken?…` | same family |
| Merchant mid | **1925** | **unknown — capture** |

---

## 6. Yield / competition

| Factor | Note |
|---|---|
| Yield | PC exclusives, PC ETBs, collab plush — high resale |
| Competition | Mature English bots (Valor documents Incapsula+DD+hCaptcha) |
| AU nuance | Same catalog family as US; shipping/GE friction; historically fewer local exclusives than JP |
| Differentiator | Weaker than Bandai AU (greenfield). Stronger than random Shopify if Hyper DD+Incapsula already built for AusPost/HN. GE path is no longer a pure unknown. |

---

## 7. Module plan (when unparked)

| Phase | Work | Status / Bandai-informed notes |
|---|---|---|
| **P0** | AU ISP HAR: Incapsula clear → browse → PDP → ATC → **`/intl-checkout`** → Global-e through Pay (decline card OK) | **Owner desk** — capture incap/DD cookies, Cortex zoom, GEM mid + hosts, CreditCardForm, T&Cs, captcha/Forter/TMX, post-Pay |
| **P1** | Wire **Incapsula** (Reese84/UTMVC) + **DataDome** in `antibot.js` | **Done (scaffold)** — `solveIncapsulaReese84` / `solveDataDome*` + `pokemoncentre-edge.js` warm |
| **P2** | Monitor: residential poll / PDP availability parse | **Done (scaffold)** — desktop `pcMode=monitor` / `edge` |
| **P3** | Cortex cart machine + account session (**HTTP-first**) | **Stub** — `pokemoncentre-cortex.js` + `har_probe`; override via `task.cortex*` after HAR |
| **P4** | Global-e AU checkout / pay | **Stub** — `pokemoncentre-ge.js` (Bandai checklist; mid from `task.globaleMid` / `PC_GLOBALE_MID`) |
| **P5** | hCaptcha harvest path (desktop) for drop windows | **Done (scaffold)** — CapSolver `HCaptchaTask` in `pokemoncentre-hcaptcha.js` |

### Adapter surface (2026-07-22)

| File | Role |
|---|---|
| `adapters/pokemoncentre.js` | Main adapter (`pcMode`: monitor / checkout / edge / har_probe) |
| `adapters/pokemoncentre-session.js` | Locale (`en-au`…) + headers |
| `adapters/pokemoncentre-edge.js` | Reese84 + DataDome clear on sticky proxy |
| `adapters/pokemoncentre-cortex.js` | Cortex path probe + guest ATC placeholder |
| `adapters/pokemoncentre-ge.js` | GE Checkout/v2 + CreditCardForm (browser Pay) |
| `adapters/pokemoncentre-hcaptcha.js` | CapSolver hCaptcha |
| `antibot.js` | Shared Incapsula + DataDome Hyper wrappers (Akamai untouched) |

Desktop: store **Pokémon Centre AU** → modes above. Sticky AU ISP + Hyper key + CapSolver (hCaptcha) in Settings.

### Feasibility

| Factor | Score |
|---|---|
| Hyper antibot | **High** for Incapsula+DD; **gap** on hCaptcha |
| API clarity | Medium — Cortex paths known; bodies unknown |
| Global-e | **Improved** — Bandai proved issuer path; PC still needs mid/HAR |
| Account friction | Medium — accounts helpful; address/fraud hard limits |
| Competitive | Crowded |
| Executor reuse | GE patterns from Bandai; DD from AusPost; Incapsula from HN |

**Verdict:** Scaffold shipped on a feature branch (Kmart untouched). Next critical path is **AU ISP HAR** for Cortex ATC bodies + GE merchant mid — then harden P3/P4 against wire proof (bank → confirmation).

---

## 8. Japan (out of scope note)

`www.pokemoncenter-online.com` = **Demandware/SFCC** (`dwsid`, `dwac_*`) + **`server: volt-adc`** (F5 XC) + Cloudflare ray headers. Entirely different module; Hyper weak on F5. Ignore for AU TPCI work. (Bandai’s F5 `p8komysnbc-*` sensor bridge is **not** portable here without a JP-specific dig.)

---

## 9. Open questions (HAR day)

1. Guest ATC on `/en-au` or account required for exclusives?
2. Exact Cortex zoom for add-to-cart and cart GUID cookies
3. When does DataDome fire vs Incapsula-only browse?
4. hCaptcha sitekey / trigger (browse vs checkout vs Imperva only)?
5. **Global-e merchant id** for TPCI AU + GEM CDN host (`gem-…`) + whether GE cart-token captcha / FingerprintJS / Forter load
6. Queue vendor (custom vs Queue-it) and cookie names
7. One-order-per-address enforcement — soft or hard at payment?
8. Does `/intl-checkout` always embed Checkout/v2, or sometimes redirect off-site?
9. Domestic US/UK checkout vs GE — confirm AU/NZ-only GE assumption
10. After Pay: does TPCI call a Cortex/order complete endpoint analogous to Bandai `preComplete`?

---

## 10. Sources

- Live DC probes 2026-07-21 (`robots.txt`, Incapsula challenge on `/en-au`)
- urlscan CSP / cookies (`datadome`, Imperva, Global-e, CyberSource, DataDome hosts)
- Pokémon Center Support (regions, AU payments, Global-e tax FAQ)
- Valor Pokémon Center task notes (Incapsula + DataDome + hCaptcha)
- Elite Fourum / webcompat reports (layered antibot)
- Press: AU/NZ launch June 2024
- **Bandai AU executor labs 2026-07-22** — HTTP `checkoutSn`, GE Checkout/v2 + CreditCardForm, Revolut issuer decline (A$317 Globale/Bandai Spirit); see `BANDAI_AU_MODULE.md` §7 + `adapters/bandai-browser-checkout.js` / `bandai-f5.js`
- **Hyper Solutions** — [DataDome getting started](https://docs.hypersolutions.co/datadome/getting-started.md) (`view: "redirect"`, slider `t=bv`), [tags](https://docs.hypersolutions.co/datadome/tags.md), [header order](https://docs.hypersolutions.co/request-based-basics/header-order.md), [TLS fingerprinting](https://docs.hypersolutions.co/request-based-basics/tls-fingerprinting.md), [Incapsula Reese84](https://docs.hypersolutions.co/incapsula/reese84.md)
