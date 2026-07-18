# Next Store Modules — Research & Plan

_Date: 2026-07-18_  
_Status: planning only (no adapters yet)_  
_Baseline: Kmart AU (`adapters/kmart.js`) — Akamai Bot Manager v3 + Hyper sensor/SBSD/pixel + undici TLS_

This note ranks candidate AU retailers for the next checkout module(s). Findings combine live edge probes from this environment (datacenter egress, mid‑2026) with public platform signals. **Confirm on sticky AU ISP/residential + desktop before committing build effort** — several sites hard‑block or black‑hole DC IPs.

---

## Decision frame (how we score)

| Factor | Why it matters for us |
|---|---|
| **Antibot vendor** | Hyper today: **Akamai / DataDome / Incapsula / Kasada**. Not Cloudflare Turnstile, PerimeterX/HUMAN, or F5/Shape. |
| **Reuse of Kmart work** | TLS client, Hyper sensor loop, jar/proxy, progress UI, desktop sidecar. |
| **Checkout surface** | Custom GraphQL/API vs SAP Commerce vs Shopify/BigCommerce vs Global‑e handoff. |
| **Product fit** | Toys / TCG / collectibles / limited drops (EQL, Queue‑it, membership). |
| **Account friction** | Guest vs login vs paid membership vs third‑party ID. |

**Rough difficulty labels:** S = reuse Akamai path heavily · M = new platform, known antibot · L = unsupported antibot and/or Global‑e / membership maze.

---

## Scoreboard (recommended build order)

| Rank | Store | Antibot / edge | Platform | Difficulty | Verdict |
|---|---|---|---|---|---|
| 1 | **Target AU** | Akamai Bot Manager | SAP Commerce (Hybris) on AWS | S–M | **Best next Akamai sibling** |
| 2 | **Big W** | Akamai Bot Manager | SAP Commerce + AEM / Next façade | M | Strong product fit; stack in flux |
| 3 | **Toymate** | Cloudflare (WAF hard‑block from DC) | **BigCommerce** + **EQL** on drops | M–L | High TCG relevance; CF + raffle |
| 4 | **AusPost Shop** | CloudFront (weak from DC) | **Intershop** | M | Soft edge; odd catalog / low drop hype |
| 5 | **EB Games** | Cloudflare managed challenge | Custom **.NET** on AWS | L | Great catalog; CF + bespoke APIs |
| 6 | **Costco AU** | Akamai (+ Queue‑it historically) | SAP Commerce | L | Membership gate dominates |
| 7 | **Disney Store AU** | Akamai + CF + reCAPTCHA Enterprise | **SFCC** + **Global‑e** | L | Triple stack; Global‑e checkout |
| 8 | **Premium Bandai** | CloudFront + F5/Volterra (`TS*` cookies) | Custom + **Global‑e** + Bandai ID | L | Global‑e + ID; not Hyper‑native |

---

## Per‑store dossiers

### 1. Target Australia — `target.com.au`

**Observed**
- DNS: `shop.target.com.au.edgekey.net` (Akamai).
- Edge from DC: `403 Access Denied` via `AkamaiGHost` (same class of deny as Kmart without valid sensor/cookies).
- Headers/preload paths: `/_ui/_assets/...`, `AKA_A2`, geo cookies; preconnect to `druidapc.prod.druidprod.a-kmtkmg.net` (Kmart Group analytics fabric).
- Public stack: **SAP Commerce Cloud**, AWS/EKS, **Akamai Bot Manager** (also listed alongside CF Bot Management in aggregator sites — treat Akamai as primary from live headers).

**Protections**
- Akamai Bot Manager (sensor `_abck` / `bm_sz` expected once past edge; same Hyper path as Kmart).
- Possible SBSD / sec‑cpt — verify on warm residential session (same playbook as Kmart lab).

**Checkout shape**
- Classic Hybris/SAP Commerce storefront + OCC/API — **not** Kmart’s Next + `api.kmart.com.au` GraphQL + Paydock.
- Sibling brand (Kmart Group / Wesfarmers), but **do not assume shared cart/pay APIs**.

**Module plan**
1. Desktop HAR warm on AU ISP → confirm Akamai version, SBSD, pixel.
2. Map ATC + checkout (OCC endpoints vs form posts).
3. Reuse `antibot.js` Akamai solvers; new `adapters/target.js`.
4. Payment: discover tokenization (likely different from Paydock).

**Why first:** maximizes Hyper/Akamai leverage with large toy/kids assortment; closest “second Wesfarmers” module without pretending the Kmart adapter ports 1:1.

---

### 2. Big W — `bigw.com.au`

**Observed**
- DNS: `bigw.com.au.edgekey.net` (Akamai).
- From this DC: TCP/HTTP **timeouts** (no response) — aggressive geo/ASN blackhole or bot score silent drop.
- Aggregators: **Akamai Bot Manager**, reCAPTCHA, **SAP Commerce**, Adobe Experience Manager, Next/React façade.
- Woolworths is **decoupling Big W** from shared group tech (2025–26) → APIs may move underfoot.

**Protections**
- Akamai Bot Manager primary; reCAPTCHA may appear on account/checkout.
- Expect ISP/residential requirement similar to or stricter than Kmart.

**Module plan**
1. Prove homepage + PDP + ATC from desktop + sticky AU proxy (non‑negotiable).
2. HAR checkout; identify SAP OCC vs custom BFF.
3. Adapter after Target if Akamai patterns match; else parallel recon only.

**Risk:** platform split from Woolworths may invalidate early HAR work mid‑build.

---

### 3. Toymate — `toymate.com.au`

**Observed**
- Cloudflare (`cf-ray`, `__cf_bm`); DC gets **"Request Blocked"** (WAF deny, not “Just a moment…” challenge).
- Storefront: **BigCommerce** (`cdn11.bigcommerce.com/s-cf7jv97qb3/...`, `/login.php`, stencil theme).
- Hot drops: **EQL** raffle/queue (Pokémon case study) — bots often lose to entry systems, not ATC races.

**Protections**
- Cloudflare Bot Fight / WAF (and possibly Turnstile on sensitive actions).
- BigCommerce native rate limits + checkout bot signals.
- **EQL** for hyped TCG/collectible drops (fair‑draw, not pure cart).

**Hyper fit:** weak — CF Turnstile **not** in Hyper catalog. Path = browser clear CF → HTTP BigCommerce cart/checkout, or full browser lane.

**Module plan**
1. Recon on residential: confirm CF mode (JS challenge vs managed vs Turnstile).
2. Map BigCommerce cart (`/cart.php`, Storefront API / GraphQL) and payment (Afterpay known historically).
3. Treat EQL drops as a **separate product** (monitor + notify), not as checkout adapter success criteria.

**Why high on list despite CF:** best pure specialty‑toy/TCG fit; BigCommerce is a known shape once past CF.

---

### 4. Australia Post Shop — `auspost.com.au/shop` (canonical; `shop.auspost.com.au` → redirect)

**Observed**
- **CloudFront** + Apache origin; **200 OK** from DC with full HTML.
- Platform: **Intershop** (`WFS/AusPost-Shop-Site`, `intershop.utils`, `ViewExpressShop-AddProduct`, `pgid-AusPost-Shop-Site` cookies).
- No Akamai/CF challenge on homepage probe.

**Protections**
- Light edge from DC; expect app‑layer session + possibly captcha/fraud later in checkout (not confirmed on home).
- Government‑adjacent brand → compliance/fraud review likely on payment.

**Module plan**
1. Easy recon win: map Intershop cart pipeline from already‑open HTML.
2. Build only if catalog SKUs matter (merch/collectables vs stationery).

**Fit:** lowest antibot friction in this set; weakest “drop” business case.

---

### 5. EB Games — `ebgames.com.au`

**Observed**
- Cloudflare **managed challenge** (`cf-mitigated: challenge`, “Just a moment…”).
- Platform: custom **.NET** e‑commerce on **AWS** (GameStop AU — public engineering writeups); not Shopify/Magento.
- High relevance for games, consoles, pop culture, some TCG.

**Protections**
- Cloudflare Bot Management / challenge (Hyper unsupported for Turnstile/challenge clear).
- Custom APIs behind CF → full reverse engineer after browser warm.

**Module plan**
1. Browser/Playwright CF clear → cookie handoff (pattern similar to optional Kmart playwright lane).
2. HAR authenticated browsing for ATC/checkout JSON.
3. Defer until we either (a) have a CF solver strategy or (b) accept browser‑heavy module cost.

---

### 6. Costco Australia — `costco.com.au`

**Observed**
- Akamai edge (`AkamaiGHost` 403 from DC).
- Stack signals: **SAP Commerce**, Akamai Bot Manager; Queue‑it cited on some tech inventories.
- **Membership required** for online purchase; separate online account registration after warehouse card.

**Protections**
- Akamai (+ possible Queue‑it on events).
- Hard product gate: valid membership + login before cart value.

**Module plan**
1. Only if owners have test memberships and want warehouse exclusives.
2. Akamai warm reusable; add SSO/LogonForm session machine + Queue‑it if present.

**Fit:** high friction / niche — park behind Target/Big W unless membership ops are ready.

---

### 7. Disney Store AU — `disneystore.com.au` (`shopdisney.com.au` → same)

**Observed**
- Akamai CDN + **`_abck` / `bm_sz` set on 200**; also `server: cloudflare` on responses.
- Platform: **Salesforce Commerce Cloud** (`Sites-DisneyStoreAUNZ-Site`, Demandware static).
- Checkout localization: **Global‑e** (cart token / convert price controllers).
- **reCAPTCHA Enterprise** on storefront scripts; Disney **OneID**.

**Protections**
- Akamai Bot Manager + Cloudflare + reCAPTCHA Enterprise + Global‑e fraud (often Forter‑class via Global‑e).
- Account/OneID may be required for some flows.

**Module plan**
1. Not a “second Kmart” — even with Akamai cookies, pay path is Global‑e hosted.
2. If pursued: SFCC session + Global‑e checkout adapter as its own subsystem (shared later with Bandai).

---

### 8. Premium Bandai AU — `p-bandai.com/au/`

**Observed**
- `www.bandai.com.au` SSL mismatch — **canonical shop is Premium Bandai**.
- CloudFront / `volt-adc` (F5 Distributed Cloud / Volterra); **`TS*` cookies** (F5 ASM/Shape‑adjacent).
- Storefront: custom SPA; login via **Bandai Namco ID**.
- Checkout: **Global‑e** merchant id `1925` (`gem-bandai.global-e.com`).

**Protections**
- Edge ADC + F5 cookies; Global‑e fraud on pay; account wall.
- Hyper does **not** list F5/Shape.

**Module plan**
1. Share Global‑e research with Disney if either is greenlit.
2. Otherwise low priority vs AU specialty retail.

---

## Capability gap vs Hyper / executor today

| Vendor | On candidates | Hyper | Implication |
|---|---|---|---|
| Akamai BM | Target, Big W, Costco, Disney, (Kmart) | ✅ | Prefer these for HTTP modules |
| Cloudflare | Toymate, EB Games, (Disney layer) | ❌ Turnstile | Browser warm or new solver |
| Kasada | Not confirmed on this list | ✅ | Watch Woolworths/Big W over time |
| F5 / Volterra | Bandai | ❌ | Avoid or browser‑only |
| Queue‑it / EQL | Costco?, Toymate drops | N/A | Product feature, not checkout |
| Global‑e | Disney, Bandai | N/A | Separate checkout engine |

Also: Hyper domain allowlisting — new hosts must be added to the Hyper key before lab work.

---

## Recommended program (phased)

### Phase 0 — Prove egress (all candidates)
- Desktop + sticky AU ISP against each homepage / PDP / ATC.
- Record: status, `_abck` validity, CF challenge type, membership walls.
- Extend `PROXY_PROBE_STORES` with these eight IDs once probes are useful.

### Phase 1 — Next HTTP module: **Target**
- HAR → Akamai lab endpoint reuse → `adapters/target.js` skeleton (ATC dry‑run).
- Success criteria: sensor clear + cart create + address; payment as stretch.

### Phase 2 — Parallel recon (no full adapter yet)
- **Big W:** Akamai twin check; abort if OCC unstable during Woolworths split.
- **Toymate:** CF clear strategy + BigCommerce cart map; EQL = notify‑only.
- **AusPost:** Intershop spike only if SKU demand exists.

### Phase 3 — Browser‑heavy / special
- EB Games (CF + custom .NET).
- Costco (membership ops).
- Disney / Bandai (Global‑e shared spike) — only with explicit demand.

### Explicit non‑goals for now
- Rolling Kmart back or sharing Paydock assumptions onto Target/Big W.
- Building Cloudflare Turnstile solvers in‑tree without a chosen vendor.
- Treating EQL/Queue‑it wins as “checkout module done.”

---

## Suggested first tickets (when build starts)

1. `recon/target`: desktop HAR + cookie timeline + OCC discovery notes.
2. `lab/target-akamai`: wire Target host into `/akamai/lab` allowlist.
3. `adapter/target-atc-dryrun`: cart only, `placeOrder:false`.
4. `recon/toymate-cf`: classify CF challenge on residential; document BigCommerce endpoints.
5. `recon/bigw-edge`: confirm Akamai from ISP (DC is dead); one PDP ATC attempt.

---

## Sources / method notes

- Live `curl`/`fetch` probes from Cursor cloud egress (US DC) — 2026‑07‑18.
- DNS CNAME inspection (`edgekey.net`, Cloudflare, CloudFront).
- Public: Target AWS/SAP posts; EB Games .NET/AWS; Costco membership help centre; Toymate BigCommerce CDN + EQL case study; Big W tech inventories; Disney/Bandai HTML (`Sites-DisneyStoreAUNZ`, Global‑e mid 1925).
- Internal: `executor/docs/hyper-solutions-brief.md`, `antibot.js`, `adapters/kmart.js`.

**Confidence:** edge vendor high (Akamai/CF/CloudFront from headers/DNS). Checkout payment processors medium until HAR. Big W application stack medium (aggregator + Akamai DNS; body unreachable from DC).
