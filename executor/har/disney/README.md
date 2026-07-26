# Disney Store AU — ISP HAR capture notes

_Date: 2026-07-26_  
_Egress: static AU ISP (`resi.proxies`) via Playwright **headed Chrome + xvfb**_  
_Tooling: `experiments/disney-isp-capture.mjs`_  
_Hyper: allowlist for `disneystore.com.au` **pending** — browser sensors only_

## Verdict

| Step | Result |
|---|---|
| Home / PDP GET | ✅ 200 (headed Chrome; **headless → Akamai 403**) |
| Akamai sensor POST | ✅ 201 ×N to BM script path |
| `_abck` → `~0~` | ✅ after ~30 dwell loops (~80s mouse/scroll) |
| `CSRF-Generate` | ✅ 200 `{ csrf: { tokenName: "csrf_token", token } }` |
| `Cart-AddProduct` | ❌ **403 Access Denied** (edgesuite) even with `~0~` |
| reCAPTCHA Enterprise verify | ⚠ scripts often aborted in capture (`status -1`); ATC fired without `Google-reCaptchaEnterprise` |
| `Globale-GetCartToken` | 500 empty-bag error shell (expected without line items) |
| GE clientsdk **1696** | ✅ `web.global-e.com/merchant/clientsdk/1696` |
| GE issuer / encoded merchant | ❌ not reached |

**Ground truth:** guest browse + CSRF wire are locked from our HAR. **POST ATC is still Akamai-hard** on Playwright even after cookie `~0~` — treat Hyper allowlist + Hyper sensor mint as required for HTTP/Playwright ATC, same class as Kmart.

### CapSolver (2026-07-26)

| Check | Result |
|---|---|
| Balance / key | ✅ works (`CAPSOLVER_API_KEY` in gitignored `.env.local`) |
| Mint token | ✅ `ReCaptchaV3EnterpriseTaskProxyLess` ~6–7s, action `AddToCart`, sitekey `6LfTl6Ap…` |
| CapSolver + ISP proxy task | ❌ `ERROR_PROXY_CONNECT_REFUSED` (provider cannot CONNECT our ISP) |
| SFCC `Google-reCaptchaEnterprise` | ⚠ returns `{ result: false }` for **both** CapSolver tokens **and** native `grecaptcha.enterprise.execute` in headed Chrome |
| ATC | still AkamaiGHost **403** (Hyper pending) — captcha not the current hard gate |

So CapSolver is ready for when Hyper clears BM; SFCC verify `result:false` needs a successful browser ATC HAR (or server-side assessment dig) to interpret.

## Hyper allowlist (2026-07-26 — approved)

| Check | Result |
|---|---|
| `HYPER_API_KEY` + Disney domain | ✅ sensor POST → **201** `{"success": true}` |
| `_abck` validity | ✅ `abckValid=true` / `~0~` after 3–5 rounds on sticky AU ISP |
| CSRF | ✅ `csrf_token` |
| CapSolver mint | ✅ ProxyLess Enterprise V3 |
| `Cart-AddProduct` (undici) | ❌ **AkamaiGHost 403** even with valid `_abck` + CSRF 200 |
| `Cart-AddProduct` (TLS chrome_131) | ✅ **200** `Product added to cart` + minibag line (Lorcana `050368983992`) |
| Home HTML SBSD / pixel | ❌ none (sensor script only; `bm_sv` not required for ATC win) |
| `Globale-GetCartToken` GET | ❌ SFCC 500 (even with bag) |
| `Globale-GetCartToken` POST | ✅ `{ cartToken, success: true }` |
| Proxy flake | tls-client CONNECT 403 after ipify preflight / spray — use proxy-host IP, rotate sticky exit |

Labs:
- `experiments/disney-hyper-atc-once.mjs` — TLS (default) Hyper → CapSolver → ATC
- `experiments/disney-hyper-browser-atc.mjs` — Hyper cookie inject → headed Chrome ATC

**Lock:** Disney ATC needs **JA3 parity** (`node-tls-client` chrome_131 / checkout Disney TLS default). Not SBSD/pixel. GE SFCC token is **POST**.

## Confirmed wire

```
CSRF:  POST …/CSRF-Generate
       → { "csrf": { "tokenName": "csrf_token", "token": "…" } }

ATC:   POST …/Cart-AddProduct
       Content-Type: application/x-www-form-urlencoded; charset=UTF-8
       X-Requested-With: XMLHttpRequest
       Body: pid=<sku>&quantity=1&csrf_token=<token>
       (browser path; pidsObj/childProducts/personalization omitted when empty)

Sensor: POST https://www.disneystore.com.au/<rotating-bm-path>
        Body: {"sensor_data":"3;0;1;0;…"} → 201

GE:    clientJsUrl https://web.global-e.com/merchant/clientsdk/1696
       mid 1696 · hashed mZ25 · welcome/prefetcher on webservices.global-e.com
```

## Files

| File | Contents |
|---|---|
| `isp-capture-summary.json` | Hosts, cookies names, milestones, redacted interesting entries |
| `isp-capture-steps.json` | Playwright step log |
| `isp-capture-cookies.json` | Cookie names + domains (value prefixes only) |

Full HAR kept local under `/tmp/disney-capture-*` — **not committed** (large + tokens).

## Reproduce

```bash
cd executor
PROXY='host:port:user:pass' HEADED=1 PW_CHANNEL=chrome \
  CAPSOLVER_API_KEY=… \
  xvfb-run -a node experiments/disney-isp-capture.mjs
```

## Next (when Hyper allowlists Disney)

1. HTTP path: Hyper `solveAkamaiSensor` on seeded ISP jar → CSRF → CapSolver Enterprise `AddToCart` → `Cart-AddProduct`.
2. Re-capture HAR through bag → `Globale-GetCartToken` → Checkout/v2 to learn issuer host + encoded merchant (Bandai `8urc` / PC `8u22` analogue).
3. Prefer undici+Hyper for catalog/ATC; browser only if GE pay requires it.
