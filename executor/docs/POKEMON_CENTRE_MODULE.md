# Pokémon Centre (TPCI) — Module Research

_Date: 2026-07-21 (scope dig)_  
_Status: research only — no adapter code yet_  
_Priority: **high yield / high difficulty** — Hyper can cover **Incapsula + DataDome**, but **hCaptcha + Global-e + crowded bot scene** make this a Phase-2+ module, not Bandai-first._

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

**Hyper fit: mixed-strong.** Incapsula + DataDome are Hyper-native (same wiring AusPost/HN need). Gaps: hCaptcha, Global-e checkout (Bandai-class custom), ThreatMetrix / Quantum Metric fingerprinting, strict address/fraud limits, and a mature English-bot market (Valor etc.).

**Vs Bandai:** PC exclusives pay, but competition is fierce and antibot is heavier. Prefer Bandai greenfield first; treat PC as **Phase 2 after DD + Incapsula are wired**, with a dedicated AU ISP HAR.

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

### 3.2 Known layered checks (public + bot docs)
- Incapsula clear → browse
- DataDome interstitial/slider on protected XHR / PDP under suspicion
- hCaptcha when Imperva / drop protection escalates
- Queue when traffic spikes (session tied to IP)

**Module implication:** sticky residential/ISP per task; Hyper Reese84/UTMVC + DataDome slider/interstitial; **separate hCaptcha harvest** (browser/desktop) — Hyper does not solve hCaptcha.

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

## 5. Checkout + payments (AU)

| Topic | Detail |
|---|---|
| Fulfilment | **Global-e** for AU/NZ — GST inclusive; duties/taxes in total ([support](https://support.pokemoncenter.com/hc/en-us/articles/360000234573)) |
| AU pay methods | Visa, MC, PayPal, Amex, Diners, Google Pay, Apple Pay, Klarna, Amazon Pay, UnionPay |
| Card rail | CyberSource + Cardinal Commerce 3DS (CSP) |
| Limits | Community/bot docs: strict address / device / billing fingerprint — multi-ship same address often declined |

`/intl-checkout` in robots strongly suggests AU path leaves Cortex for Global-e mid-flow (same class of work as Bandai GE, different merchant).

---

## 6. Yield / competition

| Factor | Note |
|---|---|
| Yield | PC exclusives, PC ETBs, collab plush — high resale |
| Competition | Mature English bots (Valor documents Incapsula+DD+hCaptcha) |
| AU nuance | Same catalog family as US; shipping/GE friction; historically fewer local exclusives than JP |
| Differentiator | Weaker than Bandai AU (greenfield). Stronger than random Shopify if Hyper DD+Incapsula already built for AusPost/HN |

---

## 7. Module plan (when unparked)

| Phase | Work |
|---|---|
| **P0** | AU ISP HAR: Incapsula clear → browse → PDP → ATC → `/intl-checkout` → Global-e; capture DD + hCaptcha surfaces |
| **P1** | Wire **Incapsula** (Reese84/UTMVC) + **DataDome** in `antibot.js` if not already from AusPost/HN |
| **P2** | Monitor: soft catalog if any (or residential poll); notify on PC ETB / exclusive SKUs |
| **P3** | Cortex cart machine + account session |
| **P4** | Global-e AU checkout / pay (reuse Bandai GE patterns where possible) |
| **P5** | hCaptcha harvest path (desktop) for drop windows |

### Feasibility

| Factor | Score |
|---|---|
| Hyper antibot | **High** for Incapsula+DD; **gap** on hCaptcha |
| API clarity | Medium — Cortex paths known; bodies unknown |
| Account friction | Medium — accounts helpful; address/fraud hard limits |
| Competitive | Crowded |
| Executor reuse | GE experience from Bandai; DD from AusPost; Incapsula from HN |

**Verdict:** Scope and park behind Bandai + shared DD/Incapsula plumbing. Do **not** start PC before those Hyper vendors are live in executor.

---

## 8. Japan (out of scope note)

`www.pokemoncenter-online.com` = **Demandware/SFCC** (`dwsid`, `dwac_*`) + **`server: volt-adc`** (F5 XC) + Cloudflare ray headers. Entirely different module; Hyper weak on F5. Ignore for AU TPCI work.

---

## 9. Open questions (HAR day)

1. Guest ATC on `/en-au` or account required for exclusives?
2. Exact Cortex zoom for add-to-cart and cart GUID cookies
3. When does DataDome fire vs Incapsula-only browse?
4. hCaptcha sitekey / trigger (checkout only vs browse)?
5. Global-e merchant id for TPCI AU and captcha/fingerprint at GE
6. Queue vendor (custom vs Queue-it) and cookie names
7. One-order-per-address enforcement — soft or hard at payment?

---

## 10. Sources

- Live DC probes 2026-07-21 (`robots.txt`, Incapsula challenge on `/en-au`)
- urlscan CSP / cookies (`datadome`, Imperva, Global-e, CyberSource, DataDome hosts)
- Pokémon Center Support (regions, AU payments, Global-e tax FAQ)
- Valor Pokémon Center task notes (Incapsula + DataDome + hCaptcha)
- Elite Fourum / webcompat reports (layered antibot)
- Press: AU/NZ launch June 2024
