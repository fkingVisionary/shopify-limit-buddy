# Pokémon Centre AU — ISP capture notes

_Date: 2026-07-22_  
_Egress: static ISP `45.42.47.34` (resi pool)_  
_Tooling: Playwright HAR (`experiments/pokemoncentre-isp-capture.mjs`)_

## Verdict

| Layer | Result on this exit |
|---|---|
| Proxy egress | ✅ `45.42.47.34` |
| Incapsula Reese84 | ✅ Browser minted `reese84` via `POST /vice-come-…?d=www.pokemoncenter.com` → `{ token: "3:…" }` |
| DataDome | Slider block page with **`t:'bv'`** (rt=`c`, hsh=`5B45875B653A484CC79E57036CE9FC`, s=`9817`) — Hyper documents this as a hard IP block ([getting started → Slider](https://docs.hypersolutions.co/datadome/getting-started.md)) |
| Cortex / Global-e | Not reached — blocked before SPA boot |
| CONNECT / nav flakes | Observed after bursts — **do not auto-blame the proxy**; check TLS/header order and handler status first ([TLS](https://docs.hypersolutions.co/request-based-basics/tls-fingerprinting.md), [header order](https://docs.hypersolutions.co/request-based-basics/header-order.md)) |

**Ground truth for this Chromium HAR:** Reese cleared; DataDome served a **slider** page with `t=bv`, which Hyper says solving will not fix — rotate sticky session for that case only. Other failures (undici `view=captcha`, connection errors) need the Hyper triage in `docs/POKEMON_CENTRE_MODULE.md` §3.4 before calling the exit dead.

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

1. Prefer Hyper Playwright `IncapsulaHandler` + `DataDomeHandler` (`experiments/pokemoncentre-hyper-pw-capture.mjs`) so TLS/header order match a real browser.
2. Sticky AU residential: rotate **only** when Hyper’s slider hard-block applies (`t=bv` on slider / `parseSliderDeviceCheckUrl.isIpBanned`).
3. Interstitial must return `{ cookie, view: "redirect", url }` — `view: "captcha"` is not success; fix implementation (header order / TLS / cookie parse) before spraying proxies.
4. Desktop Chrome HAR once home clears: PDP → ATC → `/intl-checkout` → GE Pay (decline card OK). Grab Cortex zoom/ATC, `globaleMid`, `gem-*` / `secure-*`, hCaptcha sitekey.
