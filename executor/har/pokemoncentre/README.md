# Pokémon Centre AU — ISP capture notes

_Date: 2026-07-22_  
_Egress: static ISP `45.42.47.34` (resi pool)_  
_Tooling: Playwright HAR (`experiments/pokemoncentre-isp-capture.mjs`)_

## Verdict

| Layer | Result on this exit |
|---|---|
| Proxy egress | ✅ `45.42.47.34` |
| Incapsula Reese84 | ✅ Browser minted `reese84` via `POST /vice-come-…?d=www.pokemoncenter.com` → `{ token: "3:…" }` |
| DataDome | ❌ **`t:'bv'` IP ban** on `/en-au/` (rt=`c`, hsh=`5B45875B653A484CC79E57036CE9FC`, s=`9817`) |
| Cortex / Global-e | Not reached — blocked before SPA boot |
| Proxy stability | CONNECT to `pokemoncenter.com` often **403** after a short burst — space requests / reuse one browser context |

**Ground truth:** Reese clears on this ISP in Chromium, but DataDome has already banned the exit. Need a **fresh residential sticky** (or Hyper DD after IP rotate) before Cortex HAR is possible. Do not burn the same three Wealth-style exits hoping DD lifts.

## Confirmed wire

```
Reese script:  /vice-come-Soldenyson-it-non-Banquoh-Chare-Hart-C
Reese POST:    POST {script}?d=www.pokemoncenter.com
               Content-Type: text/plain; charset=utf-8
               Body: sensor (~24KB first post)
               → 200 {"token":"3:…","renewInSec":…,"cookieDomain":…}
Cookie:        reese84=<token>  (host-only www.pokemoncenter.com in capture)

Incapsula IDs: visid_incap_2682446 / incap_ses_*_2682446 / nlbi_2682446
DataDome:      cookie datadome; block page var dd={ rt:'c', t:'bv', hsh:'5B45875B653A484CC79E57036CE9FC', s:9817, host:'geo.captcha-delivery.com' }
               script https://ct.captcha-delivery.com/c.js
```

## Files

| File | Contents |
|---|---|
| `isp-capture-summary.json` | Hosts, cookie names, interesting URLs (redacted), notes |
| `isp-capture-steps.json` | Playwright step log |
| `isp-capture-cookies.json` | Cookie names + domains (value prefixes truncated) |

Full HAR kept local (`/tmp/pc-capture-isp/`) — not committed (large + tokens).

## Next capture (owner)

1. Fresh sticky AU residential **not** in the banned `45.42.47.*` set (or wait for DD ban TTL).
2. Desktop Chrome HAR: home → PDP → ATC → `/intl-checkout` → GE Pay (decline card).
3. Grab: Cortex zoom/ATC JSON, `globaleMid`, `gem-*` / `secure-*` hosts, hCaptcha sitekey if shown.
4. Optional: set `HYPER_API_KEY` in the cloud agent env so executor can clear DD slider/interstitial when `t≠bv`.
