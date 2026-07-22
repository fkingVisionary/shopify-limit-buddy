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

## Hyper Playwright triage (2026-07-22)

`experiments/pokemoncentre-hyper-pw-capture.mjs` with `IncapsulaHandler` + `DataDomeHandler`:

| Signal | Classification |
|---|---|
| Reese path detected | `/vice-come-Soldenyson-it-non-Banquoh-Chare-Hart-C` (matches ISP HAR) |
| `InvalidApiResponseError: invalid scriptUrl` from IncapsulaHandler | **SDK wiring** — `hyper-sdk-playwright` beta.9 passes `Reese84Input` args in the wrong order vs `hyper-sdk-js` 2.12 (script body landed in `scriptUrl`). Patched in the experiment. **Not a proxy verdict.** |
| Home still slider `t=bv` (after/with broken Reese) | Hyper hard IP block when on slider — but if Reese never minted because of the SDK bug, fix that first before rotating |
| `net::ERR_CONNECTION_CLOSED` on ipify | Transient path flake — retry alternate IP endpoints; do not spray the pool |

Refs: [DataDome getting started](https://docs.hypersolutions.co/datadome/getting-started.md), [Reese84](https://docs.hypersolutions.co/incapsula/reese84.md), [TLS](https://docs.hypersolutions.co/request-based-basics/tls-fingerprinting.md).

## Checkout wire (HTTP + Hyper, 2026-07-22)

Proven on Noontide sticky after Reese + interstitial `view=redirect` (not a proxy spray):

| Step | Request | Result |
|---|---|---|
| Auth | `POST /tpci-ecommweb-api/auth/get-public-token` body `grant_type=password&role=CATALOG_BROWSER&scope=pokemon-au` + `X-Store-Locale` / `X-Store-Scope` | 200 + `access_token` + `Set-Cookie: auth={…}` |
| PDP | clear HTML `__NEXT_DATA__` → `product.addToCartForm` = `/carts/items/pokemon-au/{epItemId}/form` | e.g. AVAILABLE binder SKU |
| ATC | `POST /tpci-ecommweb-api/cart/add-product/{epItemId}` + `Authorization: bearer …` body `{clobber:false,quantity:1,dynamicAdd:false}` | **201** line-item JSON |
| Avoid | `configuration:{}` on ATC body; raw `/cortex/...` with bearer | DD captcha JSON / API Gateway IAM parse errors |
| Note | Undici→Chromium cookie handoff re-challenges DataDome (TLS bind) — keep ATC on HTTP BFF | not “dead proxy” |

## Next capture (owner)

1. After ATC: refresh Next cart for `cartGuid` → `POST /auth/get-globale-m2m-token` → `/en-au/intl-checkout` → GE mid/`gem-*` / Pay (decline OK).
2. Sticky AU residential: rotate **only** when Hyper’s slider hard-block applies (`t=bv` on slider).
3. Interstitial must return `{ cookie, view: "redirect", url }` before BFF calls.
4. Prefer Hyper Playwright handlers for browser GE Pay only — catalog/ATC stays HTTP-first.
