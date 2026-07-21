# JB Hi-Fi AU — Module Research

_Date: 2026-07-18 (deep dig)_  
_Status: research only — no adapter code yet_  
_Priority: **high yield, weak Hyper fit** — Pokémon MSRP king vs EB, but edge is **Cloudflare + reCAPTCHA**, not Akamai._  
_Correction vs prior assumption: **not Akamai**. Live edge is **Cloudflare** in front of **Shopify Plus** (custom theme / Workers)._

Canonical: **`https://www.jbhifi.com.au/`**  
Shopify store: `prod-jbhifi.myshopify.com` (public signals) · Shop ID path in robots: `/2498035810/checkouts`

---

## 1. Executive summary

JB Hi-Fi is Australia’s primary **MSRP Pokémon / console / electronics** online channel. July 2026 30th Celebration preorders: JB at ~MSRP while EB World Plus charged ~2× — so JB wins on **unit economics** when you can clear the queue.

Stack reality (DC + urlscan + Shopify case study):
1. **Shopify Plus** custom build (API-first, multi-tenant AU/NZ) — confirmed by Shopify case study + `cdn.shopify.com` / `robots.txt` (“we use Shopify… served using Cloudflare Workers”).
2. **Cloudflare** edge — homepage/products often **429** from DC; collections can **503**; robots/CDN assets softer.
3. **reCAPTCHA Enterprise** sitekey `6LewUkQoAAAAACjjhhlNDb4WOpaWFVs9ZJhnqogl` on storefront (urlscan).
4. **Riskified** fraud beacon (chargeback / bot-adjacent).
5. **No Akamai BM cookies / sensor** in 2026 AU/FI scans — older Akamai IP noise in ancient scans is not current edge.

**Hyper fit: poor.** Cloudflare managed rate-limit / challenge + Google reCAPTCHA Enterprise are outside Hyper’s four vendors (Akamai / DD / Incapsula / Kasada). Module would need browser/desktop clear or a CF solver outside Hyper — same class of pain as Toymate / EB.

Still worth a **monitor-only** product (stock alerts) without full ATC, if desired.

---

## 2. Stack map

| Layer | Tech | Notes |
|---|---|---|
| Edge | **Cloudflare** (+ Workers) | `server: cloudflare`, `cf-ray`; robots: “served using Cloudflare Workers” |
| Commerce | **Shopify Plus** | Custom theme bundles under `/cdn/shop/t/{theme}/assets/bundle.*` |
| Custom APIs | `themeapis.jbhifi.com.au`, `server-side.jbhifi.com.au` | Theme/SSR helpers; GTM server-side |
| Captcha | **reCAPTCHA Enterprise** | Sitekey above; Shopify Plus bot-protection events can schedule reCAPTCHA/hCaptcha |
| Fraud | **Riskified** | `beacon.riskified.com` |
| Search / CMS | Algolia (public lists), Contentful/CTF assets | |
| Loyalty | JB Hi-Fi Perks (Cart API discounts per Shopify case study) | |
| Pay | Shopify checkout + Afterpay / wallets (accelerated checkout CSS present) | |

Standard Shopify surfaces still present: `/cart.js`, `/products/{handle}`, `/collections/…`, `/checkouts/internal/preloads.js`.

---

## 3. Antibot / rate behaviour (DC 2026-07-18)

| Surface | HTTP | Detail |
|---|---|---|
| `GET /` | **429** | `retry-after: 60`, plain body |
| `GET /products.json` | **429** | Same |
| `GET /collections/pokemon` | **503** | CF HTML, `retry-after` ~3 min |
| `GET /robots.txt` | **200** | Explicit Shopify + CF Workers note |
| Theme CSS under `/cdn/shop/t/511/assets/…` | **200** | Soft CDN |
| `GET /sitemap.xml` | **200** | Shopify sitemap index |

Expect drop days to tighten CF + Shopify bot protection (scheduled captcha windows up to 60 min per Shopify docs).

**Not observed:** `_abck` / `bm_*` / Kasada `kpsdk` / DataDome.

---

## 4. Catalog / ATC sketch

| Surface | Path |
|---|---|
| PDP | `/products/{handle}` |
| Collections | `/collections/{handle}` (e.g. Pokémon) |
| Ajax cart | `/cart.js`, `/cart/add.js` (Shopify norms — confirm custom overrides) |
| Checkout | Shopify checkout (`/2498035810/checkouts/…` in robots Disallow) |

Custom theme may wrap ATC through `themeapis` / Storefront API rather than vanilla `/cart/add.js` — **ISP HAR required** before adapter work.

Perks / account may be required for some promos; guest ATC likely possible on open SKUs (unconfirmed).

---

## 5. Yield note

- Pokémon TCG / Switch exclusives / console launches sell out.
- JB pricing often **beats EB** (World Plus markup) on the same wave.
- Competitive bot landscape is crowded (Shopify bots + CF solvers) — differentiation is weaker than Bandai greenfield.

---

## 6. Module plan (if ever)

| Phase | Work |
|---|---|
| **J0** | AU ISP HAR: home → PDP → ATC → checkout with CF clear + reCAPTCHA solve path |
| **J1** | Monitor-only (sitemap / collection poll via residential) — no Hyper dependency |
| **J2** | ATC only if CF+captcha path is productized outside Hyper (browser sidecar or third-party CF) |
| **Skip** until Bandai/AusPost/Costco Hyper stack pays off — **antibot mismatch** |

---

## 7. Open questions

1. Vanilla `/cart/add.js` vs custom GraphQL/Storefront ATC?
2. Is reCAPTCHA always-on or only Shopify “bot protection” windows?
3. Riskified — deny at checkout only or earlier?
4. Perks login required for TCG allocations?
5. Queue / waiting room on mega drops (CF or custom)?

---

## 8. Sources

- Live DC probes 2026-07-18  
- urlscan `019d33ba-77f6-7195-87de-2dee77577edd` (2026-03-28)  
- `robots.txt` Shopify + Cloudflare Workers statement  
- Shopify case study: JB Hi-Fi AU/NZ on Shopify Plus  
- StoreInspect / ecomm.design: Riskified + Klaviyo  
- Press coverage: JB vs EB Pokémon 30th pricing (2026-07)
