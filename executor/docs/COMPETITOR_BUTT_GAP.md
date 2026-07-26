# Competitor gap: BUTT (Flux × BUTT) vs J1m's Bot

_Date: 2026-07-24_  
_Status: research only — no code_  
_Source: competitor Discord `#important` site list + feature sheet (Windows desktop AIO)_  
_Owner constraints: **functionality upgrades are must-haves**; **Kmart + Target benched** for now._

---

## 1. What they swept with (not the store list alone)

BUTT marketed as “Australia’s all in one auto-checkout” — **Windows-only native desktop**, high concurrency, and a **tight ops loop**: monitor → auto-start → checkout → 3DS/PayPal without leaving the app.

Their win this week is as much **product velocity + reliability UX** as site coverage. Site list is broad AU retail; the floor-sweep is the **watchdog + QuickTask + payment automation** combo under drop pressure.

---

## 2. Feature gap matrix

| BUTT feature | What it does | J1m today | Verdict |
|---|---|---|---|
| **Quick Task** | One-click task from drop link / preset when release goes live | Manual task forms (desktop Kmart form; web Shopify launcher) | **MUST** — drop UX, not nice-to-have |
| **In-bot monitors** | Stock/release pings inside the bot UI | Partial: web Shopify catalog/monitor patterns; no unified in-desktop monitor pane for retail adapters | **MUST** |
| **Watchdog** | Monitor hit → auto-start matching tasks | None (human clicks Run) | **MUST** — this is the competitive loop |
| **3DS solver** | Hands-off 3DS challenges | Kmart path has Paydock + 3DS stages; reliability uneven; no productized multi-store 3DS helper | **MUST** — harden + generalize |
| **PayPal multi-account + auto-relogin** | Managed PP sessions for checkout | Card-first; PayPal not a first-class account vault | **MUST** for sites that PP better than card |
| **Expressions** | Unlimited on-the-fly profile generation | Manual profile CRUD (desktop + localStorage web) | **MUST** for multi-account / raffle scale |
| **Web dashboard ↔ local bot** | Configure QuickTasks in browser; sync to desktop | We have web control plane + desktop sidecar, but **not** a shared QuickTask/monitor sync product | **MUST** — lean into our architecture advantage |
| **Import / Export** | One-click migrate profiles/proxies/tasks | No first-class bulk import/export | **MUST** (cheap win) |
| **Auto-updater** | Always on latest build | Desktop/manual pull; no silent updater story | **SHOULD → MUST** before paid users scale |
| **Hundreds–thousands concurrent tasks** | Tiny release windows | Desktop queue exists; not proven at that scale | **SHOULD** — measure after watchdog |
| **Windows-only native** | Their OS bet | Electron desktop (cross-platform capable) + web | **Don’t copy** — keep Electron/mac path; Win polish OK |

### Must-ship product track (owner: “alot of the functionality upgrades are a must”)

Ordered by competitive leverage:

1. **Monitor + Watchdog** (in desktop + optional web) — detect → auto-run  
2. **Quick Task** presets synced web ↔ desktop  
3. **3DS** reliability as a shared checkout helper  
4. **PayPal account manager** (session vault + relogin)  
5. **Profile Expressions** (template → N profiles)  
6. **Import/Export** JSON/CSV for profiles, proxies, tasks  
7. **Auto-updater** for desktop builds  

Do **not** wait on new stores to ship 1–2 and 6 — those raise win-rate on every adapter we already have or will add.

---

## 3. Their site list vs our plan

### Card auto-checkouts

| Site | BUTT | Our status | With Kmart/Target benched |
|---|---|---|---|
| **Kmart** | Listed | Adapter exists; owner: **trouble → BENCH** | **Park.** No more Kmart engineering until owner un-benches. |
| **Target** | Listed | Scoreboard backlog (Akamai) | **Park.** Same bench. |
| **Big W** | Listed | Backlog (Akamai / SAP+AEM) | **Next Hyper-reuse candidate** after Bandai/DD wiring — Akamai family |
| **EB Games** | Listed | Backlog (CF) | CF track — after CF tooling or browser lane |
| **Toymate** | Listed | Agen restore track (CF+EQL) | **Keep parallel** — agen + monitor; ATC when CF ready |
| **Costco** | Listed | Dig done (`COSTCO_AU_MODULE.md`) | Strong Hyper fit (Akamai+Kasada) — **Phase 2 after Bandai** |
| **Best & Less** | Listed | **Not on scoreboard** | Soft probe: Express + CloudFront; agency claims **SAP Commerce**. Fashion FCFS — **research dig next** if yield justifies |
| **Disney Store** | Listed | Dig + handoff done | SFCC + Akamai + GE **1696** + OneID — `DISNEY_STORE_MODULE.md` / `DISNEY_BUILD_HANDOFF.md` |
| **Pokémon Center** | Listed | Dig done (`POKEMON_CENTRE_MODULE.md`) | **High priority Phase 2** — Incapsula+DD (Hyper ✅) + hCaptcha gap |

### Coins

| Site | BUTT | Our status | Action |
|---|---|---|---|
| **Aus Post** | Listed | Dig done; **parked** (competitors exist) | **Un-park when coin season hits** — DD is Hyper-native; their presence validates demand |
| **Coin Collect** | Listed | Not researched | `coincollect.com.au` CF-hard from DC; independent numismatic shop that flips AusPost product — **lower priority than AusPost Shop** unless owner wants secondary coin lane |

### Raffles

| Site | BUTT | Stack signal | Action |
|---|---|---|---|
| **Supply Store** | Listed | Shopify (`supply-au.myshopify.com`) + CF rate-limit | Sneaker raffle — **shared Shopify raffle entry module** candidate |
| **UP THERE** | Listed | `uptherestore.com` Shopify “Launches” raffle (card auth on win) | Same raffle module family |
| **Above The Clouds** | Listed | Shopify (`abovethecloudsstore.myshopify.com`); raffle T&Cs = card hold → charge on win | Same family |
| **Casio** | Listed | `casio.com` **Akamai BM** cookies from DC | Watch/raffle — Akamai reuse later |
| **MoonSwatch** | Listed | Swatch AU (not soft-probed this pass) | Often EQL/raffle-adjacent — dig when raffle module exists |

**Raffle takeaway:** three of five are **Shopify launch/raffle** stores. One shared **AU Shopify raffle-entry** adapter (agen + card-on-file + enter) covers Supply / UP THERE / ATC cheaper than three bespoke bots. Casio/MoonSwatch are separate antibot paths.

---

## 4. What we should *not* copy blindly

| Temptation | Why not |
|---|---|
| Chase Kmart/Target to “match list” | Owner benched; they already win there — fighting on their strongest board is low ROI while broken |
| Windows-only rewrite | We already have Electron + web; sync dashboard is our edge |
| Mirror entire site list before product loop | Without watchdog/QuickTask/3DS/PP, more adapters still lose drops |
| Build Coin Collect before AusPost | AusPost is the primary official coin channel; Coin Collect is secondary inventory |

---

## 5. Our differentiation (keep)

| Our edge | Why it matters vs BUTT |
|---|---|
| **Premium Bandai AU** | **Not on their list** — greenfield OP/exclusives + Chance + GE |
| **Topps multi-region** | Global NOW / Japan Edition — outside their AU AIO pitch |
| **JB Hi-Fi** | Pokémon MSRP — also not on their card list |
| **Web + desktop architecture** | They bolt a web QuickTask config on; we can make sync native |
| **Hyper-native path** | Costco / AusPost DD / Pokémon Incapsula+DD / Big W Akamai — once product loop exists |

Strategy: **match their ops features**, **don’t mirror their Kmart/Target dependency**, **hit Bandai + Hyper-native AU + shared raffle module**.

---

## 6. Revised priority (research recommendation)

### A — Product musts (parallel to any store work)

```
Import/Export → In-bot Monitor → Watchdog → QuickTask (web↔desktop)
→ 3DS helper harden → PayPal vault → Profile Expressions → Auto-updater
```

### B — Stores while Kmart/Target benched

| Order | Work | Why |
|---|---|---|
| 1 | **Bandai** (agen → ATC → Chance → GE) | Not on BUTT list; owner greenfield |
| 2 | **Pokémon Centre** (after DD/Incapsula wire; hCaptcha honest gap) | On their list; Hyper-strong antibot |
| 3 | **Costco** | On their list; Hyper Akamai+Kasada |
| 4 | **AusPost** un-park for coin season | On their list; DD |
| 5 | **Big W** | On their list; Akamai reuse |
| 6 | **Shopify raffle pack** (Supply / UP THERE / Above The Clouds) | Their raffle wedge; one module |
| 7 | Toymate agen / EB / Disney / Best & Less dig | Fill remaining list gaps |
| — | **Kmart / Target** | Benched — reopen only on owner call |

### C — Explicit non-goals short-term

- Matching BUTT’s Kmart/Target success rate  
- Coin Collect before AusPost  
- MoonSwatch/Casio deep ATC before Shopify raffle pack  

---

## 7. Open research digs (docs only, when scheduled)

| Dig | Trigger |
|---|---|
| Best & Less module dig (SAP/Express) | After Bandai ships or owner yield call |
| Coin Collect soft dig on residential | If AusPost season + secondary channel wanted |
| Shopify raffle entry patterns (Supply / UP THERE / ATC HAR) | When raffle pack scheduled |
| Casio / MoonSwatch raffle mechanics | After Shopify raffle pack |

---

## 8. One-line brief for the next agent

> Ship **monitor + watchdog + QuickTask sync + import/export** as product musts; keep **Kmart/Target benched**; continue **Bandai** as differentiation; next retail adapters **Pokémon Centre → Costco → AusPost/Big W**; treat Supply/UP THERE/Above The Clouds as one **Shopify raffle** module — do not chase their full list store-by-store.
