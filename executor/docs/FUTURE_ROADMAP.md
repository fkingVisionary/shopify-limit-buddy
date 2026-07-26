# Future roadmap — after Kmart hard rollback

_Date: 2026-07-24 (BUTT competitor pass)_  
_Status: operating plan (docs + process)_  
_Competitor gap:_ [`COMPETITOR_BUTT_GAP.md`](./COMPETITOR_BUTT_GAP.md)

---

## Phase 0 — Product musts + Kmart/Target bench (**NOW**)

**Owner update (2026-07-24):** **Kmart and Target are benched** after ongoing trouble. Do **not** prioritize Kmart/Target engineering until explicitly un-benched.

**Competitor lesson (BUTT):** their sweep is driven by **ops features** (Quick Task, in-bot monitors, watchdog, 3DS, PayPal vault, profile expressions, import/export, auto-updater) as much as site count. Those upgrades are **must-haves** — see gap doc.

| Must (product) | Notes |
|---|---|
| Import / Export | Profiles, proxies, tasks |
| In-bot monitors | Stock/release inside desktop (+ web) |
| Watchdog | Monitor hit → auto-start tasks |
| Quick Task | One-click drop setup; **web ↔ desktop sync** |
| 3DS helper | Hands-off, multi-store |
| PayPal account manager | Multi-account + auto-relogin |
| Profile Expressions | Generate N profiles from templates |
| Auto-updater | Desktop builds |

Historical Kmart tip note (only if un-benched later): known-good was `a1d9f9c` (“Electron Update”); prove on desktop + sticky AU ISP — do not roll to PR #32.

---

## Phase 1 — Bandai AU (first new module; differentiation)

Docs: `BANDAI_AU_MODULE.md` · bible: `BANDAI_CHECKOUT_BIBLE.md` · scoreboard: `NEXT_STORE_MODULES.md`

**Drop win-con (2026-07-23):** cart holds ~**30 minutes**. Race is **ATC speed**
(F5 → login → addToCart). Global-e pay is phase-2 inside that window — keep it
fast, but never sacrifice ATC for pay experiments.

| Step | Work |
|---|---|
| B0 | Logged-in **AU ISP HAR** (signup optional): login → ATC → Chance → Global-e |
| B1 | Monitor (search/product poll + notify) |
| B1b | **Account gen** — Desktop Settings: OnlineSim API key + IMAP app password → vault |
| B2 | Login + ATC dry-run — **optimize wall→ATC** (`bandaiFastAtc`, settle knobs) |
| B3 | Chance `applyDraw` pool |
| B4 | Global-e checkout (HTTP GE / no-page) **after** cart hold |

Keep Bandai on a **feature branch**; do not pile experimental Akamai changes into Kmart while Bandai is WIP.

---

## Phase 2 — Sites on competitor list we can win (Kmart/Target skipped)

Wire missing solvers in `antibot.js` once, then adapters. Prefer Hyper-native + digs we already have:

| Order | Store | Antibot | Doc / note |
|---|---|---|---|
| 2a | **Pokémon Centre AU** | Incapsula + DataDome (+ CapSolver hCaptcha); GE reuse Bandai — **adapter scaffolded on main** | `POKEMON_CENTRE_MODULE.md` — on BUTT list |
| 2b | **Costco AU** | Akamai + Kasada | `COSTCO_AU_MODULE.md` — on BUTT list |
| 2c | AusPost Shop (coin season) | DataDome | `AUSPOST_SHOP_MODULE.md` — on BUTT list |
| 2d | Big W / Uniqlo | Akamai | scoreboard — on BUTT list (Big W) |
| 2e | Shopify raffle pack | CF + Shopify | Supply / UP THERE / Above The Clouds — see gap doc |
| 2f | Harvey Norman / FL / Platypus | Incapsula / Kasada / DD | scoreboard |
| — | **Kmart / Target** | — | **BENCHED** |
| later | Best & Less dig | SAP/Express suspected | Not yet researched |
| later | **Disney Store AU** | SFCC + Akamai + GE **1696** + OneID | `DISNEY_STORE_MODULE.md` · handoff `DISNEY_BUILD_HANDOFF.md` |

---

## Phase 3 — High yield / weak Hyper (browser or monitor-only)

| Store | Notes | Doc |
|---|---|---|
| JB Hi-Fi | Shopify + **CF** + reCAPTCHA Enterprise — not Akamai | `JB_HIFI_MODULE.md` |
| **Topps (US+JP first)** | Per-region Shopify + **CF**; guest-first; EU hCaptcha likely | `TOPPS_MODULE.md` |
| EB / Toymate / Pop Mart | CF / EQL / membership — on BUTT list | scoreboard |

Monitor feeds OK; full undici ATC only if a CF/captcha path is productized outside Hyper.  
Topps: one adapter × region table (`shop.topps.com` / `shop-jp.topps.com` / EU `shop-*`); Magento paths are dead.

---

## Branching rules

1. **Kmart/Target benched** — no adapter churn there unless owner un-benches.
2. New store / product work → `cursor/<name>-…-709b` off current `main`.
3. If Kmart is ever un-benched: do **not** “fix” by rolling to PR #32 (`600b40f`).
4. Research-only docs can land ahead of adapters; product musts (monitor/watchdog/QuickTask) may ship without new stores.

---

## Doc index

| File | Role |
|---|---|
| `NEXT_STORE_MODULES.md` | Scoreboard + AU matrix |
| `BANDAI_AU_MODULE.md` | Bandai deep dig + agen |
| `AUSPOST_SHOP_MODULE.md` | AusPost dig (parked) |
| `COSTCO_AU_MODULE.md` | Costco dig |
| `JB_HIFI_MODULE.md` | JB dig (CF correction) |
| `hyper-solutions-brief.md` | Hyper vendor API notes |
| `POKEMON_CENTRE_MODULE.md` | Pokémon Centre AU dig (Incapsula+DD+GE) |
| `TOPPS_MODULE.md` | Topps multi-region (US/JP + EU/IN/BR Shopify fleet) |
| `DISNEY_STORE_MODULE.md` | Disney Store AU dig (SFCC + GE 1696 + OneID) |
| `DISNEY_BUILD_HANDOFF.md` | Disney build handoff + pasteable agent prompt |
| `COMPETITOR_BUTT_GAP.md` | BUTT feature + site gap vs us (Kmart/Target benched) |
| `FUTURE_ROADMAP.md` | This plan |
