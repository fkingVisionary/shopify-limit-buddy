# Handoff: Build Disney Store AU (ATC + Global-e)

_Date: 2026-07-26_  
_Audience: Cloud / coding agent starting implementation_  
_Owner goal: **checkout** on Disney Store AU (`disneystore.com.au`), reusing Bandai **Global-e** patterns where possible. OneID agen optional if guest is blocked._  
_HAR status: **not available yet** — build from this research; owner can supply proxies, test account, payment, and HAR._

---

## 0. Read these first (in order)

| Doc | Why |
|---|---|
| **This file** | Build scope, phases, constraints, pasteable prompt |
| [`DISNEY_STORE_MODULE.md`](./DISNEY_STORE_MODULE.md) | Full stack / API / antibot dig |
| [`BANDAI_AU_MODULE.md`](./BANDAI_AU_MODULE.md) + Bandai GE code (if present) | Global-e reuse — **mid 1696** here vs Bandai **1925** |
| [`COMPETITOR_BUTT_GAP.md`](./COMPETITOR_BUTT_GAP.md) | Disney is on BUTT list; Kmart/Target benched |
| [`AGENTS.md`](../../AGENTS.md) | Repo layout; do not break benched Kmart path casually |

Canonical: **`https://www.disneystore.com.au/`**  
SFCC site: **`Sites-DisneyStoreAUNZ-Site`** · locale **`en_AU`** · GE mid **`1696`**.

---

## 1. Non-negotiable constraints

1. **Branch off current `main`:** `cursor/disney-store-au-709b` (or required `cursor/…-709b` pattern).
2. **Do not modify `adapters/kmart.js`** unless fixing an accidental break. Kmart/Target are **owner-benched**.
3. Prefer **undici/HTTP + Hyper Akamai** for catalog/ATC (Kmart-class). Narrow browser only for OneID / reCAPTCHA / GE pay if required.
4. **Parameterize Global-e** by `merchantId` — do not fork a Disney-only copy of Bandai GE with hard-coded `1925`.
5. Secrets (proxies, OneID, cards, Hyper key) from owner / Desktop Settings — never commit.

---

## 2. End state (definition of done)

| Capability | Done when |
|---|---|
| **Monitor** | Detects new/restock SKUs (sitemap and/or suggest/PDP) → notify |
| **`disney` ATC** | Akamai warm → `Cart-AddProduct` → item in `/bag` on sticky AU ISP |
| **Global-e handoff** | `Globale-GetCartToken` (or equivalent) → GE checkout mid **1696** |
| **Pay** | Card/wallet completes or clean decline (browser-assisted OK v1) |
| **OneID agen** (stretch) | Creates/logs in Disney ID → `/ocapi/cc/login` bridge → vault |

Owner priority: **Akamai+ATC → GE checkout → monitor → OneID agen if needed**.

---

## 3. What the owner will provide

| Item | Use |
|---|---|
| Sticky **AU ISP/residential** proxies | Akamai warm + ATC + GE |
| **HAR** (ideal): PDP → ATC → bag → GE (+ login if any) | CSRF/ATC/GE bodies |
| Optional Disney OneID test account | Login path |
| Payment method on GE | Phase pay |
| Hyper API key with Akamai allowlist for `disneystore.com.au` | Sensor/SBSD/pixel |

---

## 4. Stack cheat-sheet

| Layer | Detail |
|---|---|
| Platform | SFCC `Sites-DisneyStoreAUNZ-Site` / `en_AU` / realm `BGSX` |
| Edge | Akamai BM (`_abck`, `bm_sz`) + Cloudflare |
| ATC | `POST …/Cart-AddProduct` (`pid`, `quantity`, CSRF) — **Akamai-hard from DC** |
| Bag | `GET /bag` · `Cart-MiniCartShow` |
| Auth | OneID `WDI-SHOPDISNEYAUNZ.WEB-PROD` → `POST/bridge /ocapi/cc/login` · clientID `0f4bc909-824c-445f-af00-7f4fb28cdb21` |
| CSRF | `…/CSRF-Generate` |
| Captcha | reCAPTCHA Enterprise `6LfTl6ApAAAAADNDby7y07sX55wM7B47VUFx7TFW` |
| Pay | Global-e **1696** · SDK `web.global-e.com/merchant/clientsdk/1696` · V2 checkout |

### Key URLs

```
https://www.disneystore.com.au/
https://www.disneystore.com.au/sitemap_0.xml
https://www.disneystore.com.au/on/demandware.store/Sites-DisneyStoreAUNZ-Site/en_AU/Cart-AddProduct
https://www.disneystore.com.au/on/demandware.store/Sites-DisneyStoreAUNZ-Site/en_AU/Cart-MiniCartShow
https://www.disneystore.com.au/on/demandware.store/Sites-DisneyStoreAUNZ-Site/en_AU/CSRF-Generate
https://www.disneystore.com.au/on/demandware.store/Sites-DisneyStoreAUNZ-Site/en_AU/Globale-GetCartToken
https://www.disneystore.com.au/ocapi/cc/login
https://cdn.registerdisney.go.com/v4/OneID.js
```

PDP example:  
`/disney-lorcana-trading-card-game-by-ravensburger-gateway-050368983992.html` · pid `050368983992`

---

## 5. Phases

### Phase A — Session + Akamai warm
- Cookie jar on `www.disneystore.com.au`
- Hyper Akamai sensor (+ pixel if required) until `_abck` healthy
- Prove `GET` PDP + `Cart-MiniCartShow` on same jar

### Phase B — ATC dry-run
- `CSRF-Generate` → token shape from HAR/residential
- `POST Cart-AddProduct` with `pid` + `quantity`
- Confirm minibag / `/bag` line item (`placeOrder` false)

### Phase C — Global-e
- Reuse Bandai GE client parameterized for mid **1696**
- `Globale-GetCartToken` / checkout container handoff
- Stop before live pay until owner OK

### Phase D — Pay + monitor
- GE card/wallet
- Sitemap/suggest/PDP monitor → optional QuickTask/watchdog hooks if product musts exist

### Phase E — OneID (only if guest blocked)
- OneID login → `/ocapi/cc/login` → refresh via `Login-Refresh`
- Agen + IMAP if email verify required

---

## 6. Acceptance checklist

- [x] Feature branch only; no Kmart regression — `adapters/disney*.js` + registry  
- [x] GE merchantId not hard-coded to Bandai 1925 — mid **1696** / builders parameterized  
- [x] Monitor can see a known Lorcana/test SKU — `disneyMode=monitor` + sitemap/PDP parse  
- [x] Secrets out of git  
- [x] Hyper sensor warm works (201 success + valid `_abck`; plateau rebind)  
- [x] ATC on sticky AU via **TLS chrome_131** (undici alone AkamaiGHost-403s even with `~0~`) — CapSolver optional; SFCC verify still `result:false`  
- [x] Minibag confirms line after ATC (`pids=050368983992`)  
- [x] SFCC GE token: **POST** `Globale-GetCartToken` → `cartToken` UUID (GET=500)  
- [ ] GEM `GetCartToken` mid 1696 → Checkout/v2 URL — discover issuer encoded merchant  



- [ ] GE mid 1696 session starts from bag (SFCC `Globale-GetCartToken` shape via HAR)  
- [ ] Pay / issuer encoded-merchant confirmed  
- [x] Own HAR captured (headed ISP): CSRF + sensor + ATC attempt — see `har/disney/`

### Scaffold entrypoints

| File | Role |
|---|---|
| `adapters/disney.js` | Modes: `warm` / `monitor` / `atc`/`checkout` / `ge` |
| `adapters/disney-session.js` | SFCC URLs, PDP/pid parse, headers |
| `adapters/disney-akamai.js` | Hyper sensor warm |
| `adapters/disney-cart.js` | CSRF + ATC + minibag |
| `adapters/disney-ge.js` | GE 1696 handoff (stop before pay) |

---

## 7. Out of scope v1

- US `disneystore.com` / Queue-it  
- Full OneID agen if guest GE works  
- Product musts (watchdog/QuickTask) unless already shared infra  
- Costco / other stores on this branch  

---

## 8. Pasteable kickoff prompt

```
You are implementing Disney Store AU checkout for J1m's Bot.

Read first:
- executor/docs/DISNEY_BUILD_HANDOFF.md (source of truth for phases)
- executor/docs/DISNEY_STORE_MODULE.md
- AGENTS.md
- Any existing Bandai Global-e helper (parameterize merchantId — Disney is 1696, Bandai is 1925)

Constraints:
- Branch off main as cursor/disney-store-au-709b
- Do NOT touch adapters/kmart.js (Kmart benched)
- Prefer undici + Hyper Akamai; browser only for OneID/reCAPTCHA/GE pay if required
- Never commit secrets

Canonical: https://www.disneystore.com.au/
SFCC: Sites-DisneyStoreAUNZ-Site / en_AU
ATC: POST .../Cart-AddProduct (Akamai-hard without warm)
GE: merchant 1696
Auth: Disney OneID → /ocapi/cc/login (optional if guest works)

Build order: Akamai warm → CSRF → ATC dry-run → bag → GE handoff → pay → monitor.
Ask owner for sticky AU proxies + HAR if blocked. Commit/push on the feature branch; open/update PR.
```

---

## 9. Related

- Bandai GE mid 1925 — reuse patterns  
- Pokémon Centre — also GE but Incapsula/DD/hCaptcha (different edge)  
- BUTT lists Disney — parity target, not greenfield  
