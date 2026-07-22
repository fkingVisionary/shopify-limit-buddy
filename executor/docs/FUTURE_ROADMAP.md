# Future roadmap — after Kmart hard rollback

_Date: 2026-07-18_  
_Status: operating plan (docs + process; no new adapters until Phase 0 green)_

---

## Phase 0 — Stabilize Kmart on known-good tip (**NOW**)

**Action taken:** `main` was **force-reset** to **`a1d9f9c` (“Electron Update”)** — the last tip with confirmed successful transactions. Soft restores of `kmart.js` alone were insufficient because desktop sidecar / post-tip commits still drifted.

| Check | Detail |
|---|---|
| Tip | `git rev-parse origin/main` → `a1d9f9c957965fb96b4f271aef4792dfa756248e` |
| Do **not** | Merge PR #32-era undici rollbacks, Playwright recovery ladders, or “restore” PRs that re-land those commits |
| Prove on | **Desktop + sticky AU ISP/residential proxy** (not cloud DC) |
| After pull | `cd desktop && npm run setup && npm start` → **Start engine** |

### Local verify checklist
1. Fresh clone / hard reset: `git fetch && git reset --hard origin/main` (must be `a1d9f9c`)
2. `cd executor && npm install && npm run dev` (or desktop sidecar only)
3. Desktop: Start engine → one Kmart job with sticky ISP proxy
4. Confirm: Akamai warm → PDP → ATC → checkout path completes (or fails for non-antibot reasons only)
5. Only after a green transaction: allow new commits on `main`

**If still broken on this tip:** the regression is env (proxy sticky/IP, Hyper key/allowlist, desktop install), not git history. Debug that before any code change.

---

## Phase 1 — Bandai AU (first new module)

Docs: `BANDAI_AU_MODULE.md` · scoreboard: `NEXT_STORE_MODULES.md`

| Step | Work |
|---|---|
| B0 | Logged-in **AU ISP HAR** (signup optional): login → ATC → Chance → Global-e |
| B1 | Monitor (search/product poll + notify) |
| B1b | **Account gen** — Desktop Settings: OnlineSim API key + IMAP app password → vault |
| B2 | Login + ATC dry-run |
| B3 | Chance `applyDraw` pool |
| B4 | Global-e checkout |

Keep Bandai on a **feature branch**; do not pile experimental Akamai changes into Kmart while Bandai is WIP.

---

## Phase 2 — Hyper-native expansions (after Bandai ships)

Wire missing solvers in `antibot.js` once, then store adapters:

| Order | Store | Antibot | Doc |
|---|---|---|---|
| 2a | AusPost Shop (un-park for coin season) | DataDome | `AUSPOST_SHOP_MODULE.md` |
| 2b | Harvey Norman | Incapsula | scoreboard |
| 2c | **Pokémon Centre AU** | Incapsula + DataDome (+ hCaptcha gap) | `POKEMON_CENTRE_MODULE.md` |
| 2d | Costco AU | Akamai (reuse) + Kasada (wire) | `COSTCO_AU_MODULE.md` |
| 2e | Target / Uniqlo / Big W | Akamai reuse | `NEXT_STORE_MODULES.md` |
| 2f | Foot Locker / Platypus | Kasada / DataDome | scoreboard |

---

## Phase 3 — High yield / weak Hyper (browser or monitor-only)

| Store | Notes | Doc |
|---|---|---|
| JB Hi-Fi | Shopify + **CF** + reCAPTCHA Enterprise — not Akamai | `JB_HIFI_MODULE.md` |
| **Topps (US+JP first)** | Per-region Shopify + **CF**; guest-first; EU hCaptcha likely | `TOPPS_MODULE.md` |
| EB / Toymate / Pop Mart | CF / EQL / membership | scoreboard |

Monitor feeds OK; full undici ATC only if a CF/captcha path is productized outside Hyper.  
Topps: one adapter × region table (`shop.topps.com` / `shop-jp.topps.com` / EU `shop-*`); Magento paths are dead.

---

## Branching rules (protect Kmart)

1. **`main` = known-good Kmart** until Phase 0 is green on your machine.
2. New store work → `cursor/<store>-…-709b` off current `main`.
3. Never “fix” Kmart by rolling to PR #32 (`600b40f`) — that undoes Electron Update.
4. Research-only docs can land ahead of adapters (this PR); **no executor behavior change** without Phase 0 green + explicit go.

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
| `FUTURE_ROADMAP.md` | This plan |
