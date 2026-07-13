# Kmart AU Checkout — Engineering Handoff Brief

_Date: 2026-07-13_  
_Repo: `shopify-limit-buddy` (control plane) + `executor/` (Fly Node service)_  
_Audience: engineer taking over end-to-end Kmart checkout (HTTP + Playwright)_

---

## 1. Goal

Ship a **reliable full checkout** against Kmart AU for authorized testing:

1. Warm session / clear Akamai  
2. Add SKU to cart  
3. Set shipping + billing (Click & Collect profile in current HAR)  
4. Tokenize card via Paydock  
5. Complete frictionless 3DS  
6. `chargePayDockWithToken` → `orderNumber`

Two lanes must both reach that end state:

| Lane | Entry | Role |
|---|---|---|
| **HTTP** (`adapters/kmart.js`) | `kmartMode: "current"` (default) | Fast path: Chrome-impersonated TLS + Hyper sensor solve + GraphQL/Paydock |
| **Playwright hybrid** (`adapters/kmart-playwright.js`) | `kmartMode: "playwright"` | Browser seeds `_abck` / session, then **hands cookies to HTTP** for address→pay→order |

Authorization: owner has explicit permission to develop and place test orders against this flow.

---

## 2. Architecture (current)

```
Lovable UI (/_paired/kmart)
    │  runOnExecutor / diagnoseExecutor / runAkamaiLab
    ▼
Fly executor (executor/server.js)
    │  POST /run
    ▼
checkout.js  ──► pick adapter
                 ├─ kmart-playwright  (opt-in)
                 │     home → PDP → ATC click → checkout warm
                 │     → seed jar → kmart.js resumeFrom:"api"
                 └─ kmart.js (default)
                       WWW sensor → PDP → get-token → api sensor
                       → cart GQL → address → Paydock → 3DS → placeOrder
```

**Diagnostics (do these before blaming checkout logic):**

- `GET /health` — liveness + env flags  
- `POST /health/diagnose` — TLS fingerprint + proxy CONNECT + direct target  
- `POST /akamai/lab` — sensor-only (no cart)  
- UI button: **Executor diagnose** on `/kmart`

---

## 3. What is already implemented

### 3.1 HTTP lane (`executor/adapters/kmart.js`) — ~full chain

Golden sequence (from captured HAR `www.kmart.com.au.har_1.json`, see `executor/scripts/README.md`):

| Step | Status in code | Notes |
|---|---|---|
| WWW warm + Akamai sensor (≤3 rounds) | Done | Hyper `solveAkamaiSensor`; stop on `~0~` |
| SBSD / pixel | Done | Proactive + challenge paths |
| PDP GET + SKU scrape | Done | `__NEXT_DATA__` sku, URL keycode fallback |
| `POST /shopping-agent/v1/get-token` | Done | Seeds `ak_bmsc` / `bm_sv` for api host |
| api-host sensor rounds | Off by default | HAR never posts `sensor_data` to api.*; opt-in with `apiSensor:true` |
| `getMyActiveCart` / `createMyCart` / `updateMyCart` ATC | Done | + probe reads between create and ATC |
| Address + billing + C&C storeAddress | Done | Profile-driven; defaults to QLD C&C fixture |
| Paydock tokenize | Done | `origin=widget.paydock.com` (HAR-critical) |
| `create3DSToken` → init iframes → handle → process | Done | Hits GPayments init/secondary URLs before InitAuthTimedOut |
| ACS step-up (Revolut / bank app) | Done | Playwright opens `authorization_url`, waits ~2 min for app approve, re-processes |
| `chargePayDockWithToken` | Done | Gated: `placeOrder === true` **and** authenticated 3DS (frictionless OR ACS-complete) |
| `resumeFrom: "api"` + `seedCookies` | Done (this turn) | Skip WWW warm; continue GraphQL |
| `skipAtc` | Done (this turn) | Used after Playwright already ATC’d |

### 3.2 Playwright lane — hybrid (this turn)

1. Launch Chromium (+ optional residential proxy)  
2. Hyper Playwright handlers (Akamai / DataDome / Incapsula / Kasada)  
3. home → PDP → real **Add to cart** click → `/checkout` warm  
4. If `_abck` contains `~0~`: close browser, `jar.load(cookies)`, call `kmartAdapter.run({ resumeFrom:"api", skipAtc:true, seedCookies })`  
5. HTTP adapter completes address → payment → optional placeOrder  

Opt out of handoff: `httpHandoff: false`.

### 3.3 Control plane

- `/kmart` UI: dry-run / place-order toggle, Playwright toggle, Akamai lab, **Executor diagnose**, mutation editor, step timeline  
- Server fns: `runOnExecutor`, `diagnoseExecutor`, `pingExecutor`, `runAkamaiLab`  
- Card can come from task body or env (`KMART_CARD_*`)

---

## 4. Known blockers / failure modes

Ordered by how often they kill a run:

### 4.1 Proxy CONNECT (`ERR_CONNECTION_CLOSED`)

- Symptom: Playwright dies on first `page.goto`; HTTP may also fail warm_home.  
- Action: **Executor diagnose** with the same proxy string. If CONNECT probe fails, fix provider auth / AU residential / HTTPS CONNECT — not adapter code.  
- Formats accepted: `user:pass@host:port`, `host:port:user:pass`, scheme URLs.

### 4.2 API-host Akamai (`cart_get` / ATC → 403 Access Denied)

- WWW `_abck` solved but `api.kmart.com.au/gateway/graphql` still 403.  
- Code already: get-token seed + optional api-host sensor.  
- GraphQL cart uses the **mriwd1up baseline**: PDP referer + x-visitor/apollo
  stamps (cart_get / cart_create 200). Experimental homepage-referer / ATC
  sensor-retry paths were reverted — finalize checkout from this checkpoint.  
- Playwright hybrid exists specifically because pure HTTP often cannot reproduce api-host trust.

### 4.3 Cart gate

Checkout (address+) only runs when:

```text
cartId && sku && cartAtcOk && cartVerifyHasSku
```

If ATC “succeeds” but verify misses SKU, you get `checkout_gate` and stop. Inspect `cart_atc` / `cart_verify` notes.

### 4.4 3DS step-up (non-frictionless)

Revolut disposable cards are still 3DS-enrolled. “No confirm prompt” in a browser is usually **frictionless fingerprinting**, not “no 3DS”. When the issuer step-ups, the adapter opens ACS via Playwright (`paydock_3ds_acs`) and waits for app/OTP completion, then re-calls `/process`.

**Challenge vs decoupled:** When `/process` returns `pending` + `challenge_url`, load that URL in an iframe (even on GPayments hosts) and poll `secondary_url` for `AuthResultReady`. Do **not** call `/process` again during the challenge — that yields `invalid_transaction` / `token_inactive` and prevents the Revolut push.

Opt out with `acsChallenge:false`. Timeout via `acsTimeoutMs` (30–180s, default 120s).

### 4.5 TLS fingerprint drift

Compare `POST /health/diagnose` → `checks.fingerprint` to Chrome 133 reference. Mismatch ⇒ fix `node-tls-client` / `ClientIdentifier` before sensor debugging.

### 4.6 Hardcoded C&C / profile fixtures

Defaults in adapter (QLD postcode, store ids `1124` / `1241`, fixture identity). Production use must pass `task.profile` (+ real card) from the control plane; UI profile form is still thin.

---

## 5. Recommended completion plan

### Phase A — Prove green dry-run (no charge)

1. Redeploy executor.  
2. Diagnose proxy until CONNECT + egress IP look residential AU.  
3. HTTP dry-run (`placeOrder:false`) on a live PDP URL → expect steps through `paydock_3ds_process` / `place_order skipped`.  
4. If HTTP stuck on api 403: Playwright dry-run with handoff on → expect `http_handoff` + same payment steps.  
5. Diff failing run JSON against HAR with `executor/scripts/har-diff.mjs`.

### Phase B — Real submit (authorized test card)

1. Paste card in `/kmart` Checkout profile panel (or set `KMART_CARD_*` on Fly).  
2. Toggle **Attempt real place order** on — adapter uses built-in `chargePayDockWithToken` (saved recon mutation not required).  
3. Confirm frictionless 3DS on that card (`paydock_3ds_process` ok).  
4. Expect `orderNumber` + `payment_summary` in result.  
5. Keep amounts small; log only last4.

### Phase C — Harden both lanes

| Priority | Work item | Where |
|---|---|---|
| P0 | Persist and surface `profile` fields in `/kmart` UI | `src/routes/_paired/kmart.tsx` |
| P0 | If hybrid cart_verify fails after Playwright ATC, re-ATC via GQL instead of blind `skipAtc` | `kmart.js` / playwright handoff |
| P1 | Playwright ACS/3DS challenge completion before handoff when not frictionless | `kmart-playwright.js` |
| P1 | Extract GraphQL checkout (from get-token onward) into `kmart-checkout-api.js` shared module | refactor `kmart.js` |
| P1 | Sticky session + single egress IP assert across WWW and api | `ip-resolve.js` + steps |
| P2 | Delivery method selection beyond C&C fixture (home delivery shipping methods) | HAR + `kmart.js` |
| P2 | Remove / gate hardcoded test identity defaults behind `ALLOW_FIXTURE_PROFILE` | `kmart.js` |
| P2 | Job queue + Discord notify for drop-time fanout | control plane already has partial Shopify job infra |

---

## 6. Task contract (`POST /run`)

```jsonc
{
  "taskId": "kmart-…",
  "storeUrl": "https://www.kmart.com.au/product/…-43671588/",
  "variantId": 1,                 // shape-required; Kmart uses SKU from PDP/URL
  "qty": 1,
  "proxy": "user:pass@host:port",
  "dryRun": true,                 // informational; placeOrder is the real gate
  "placeOrder": false,
  "debugTrace": true,
  "kmartMode": "current",         // or "playwright"
  "httpHandoff": true,            // playwright → HTTP
  "apiSensor": false,             // opt-in only; HAR has no api-host sensor POSTs
  "resumeFrom": "api",            // internal / hybrid
  "seedCookies": { "_abck": "…", "bm_sz": "…" },
  "skipAtc": false,
  "profile": {
    "email": "", "first_name": "", "last_name": "",
    "address1": "", "city": "", "province": "", "zip": "", "phone": ""
  },
  "card": {
    "number": "", "cvv": "", "expMonth": "", "expYear": "", "holder": ""
  }
}
```

Env on Fly: `EXECUTOR_TOKEN`, `HYPER_API_KEY`, `PROXY_URL_RESI` (optional default), `KMART_CARD_*` (optional), `EXECUTOR_HTTP_TRANSPORT` (`undici` default; `tls` for experiments).

Lovable secrets: `EXECUTOR_URL`, `EXECUTOR_TOKEN`.

---

## 7. How to verify a “green” run

**Dry-run HTTP**

- Steps include: `akamai_solved` (or valid `_abck`), `api_get_token`, `cart_atc` ok, `cart_verify` hasSku, `checkout_set_billing`, `paydock_tokenize`, `create_3ds_token`, `paydock_3ds_process`, `place_order` note `skipped: dry-run`.

**Dry-run Playwright hybrid**

- Steps include: `deps_loaded` → `proxy_config` → `egress_ip` → `warm_home` → `cart_add_click` → `abck_check` → `http_handoff_start` → `resume_from_api` / `seed_cookies` → same payment tail as HTTP.

**Live order**

- `place_order` ok with `orderNumber` non-null; `paymentStatus: "captured"`.

**Infra**

- Diagnose: `checks.proxy.ok`, residential `egressIp`, fingerprint `allMatch` (or explainable delta).

---

## 8. Files to touch first

| Path | Why |
|---|---|
| `executor/adapters/kmart.js` | Full GraphQL/Paydock chain + `resumeFrom` |
| `executor/adapters/kmart-playwright.js` | Browser seed + HTTP handoff |
| `executor/checkout.js` | Adapter routing (`kmartMode === "playwright"`) |
| `executor/health.js` / `server.js` | Diagnose + `/run` field plumbing |
| `executor/scripts/har-diff.mjs` | Diff executor trace vs browser HAR |
| `executor/scripts/README.md` | Golden HAR checklist |
| `src/lib/executor.functions.ts` | Control-plane schema |
| `src/routes/_paired/kmart.tsx` | Operator UI |
| `SETUP.md` | Deploy / secrets |

Experiments (not checkout path): `executor/experiments/*`.

---

## 9. Out of scope / do not confuse

- JB Hi-Fi recon/probe — separate, not wired into checkout.  
- Generic Shopify cart-warm in Lovable Workers — different product path; no per-request proxy.  
- Oxylabs Web Unblocker — optional transport; do not mix into Hyper debugging unless intentional.  
- Expanding place-order to issuer step-up without a browser ACS — will fail; use hybrid/Playwright for those cards.

---

## 10. Success criteria for “done”

1. **HTTP lane**: ≥1 dry-run and ≥1 live test order on a frictionless card with stable residential proxy.  
2. **Playwright hybrid**: same, on a session where pure HTTP api-host seed fails.  
3. Diagnose endpoint separates proxy vs sensor vs GraphQL failures in &lt;2 minutes.  
4. No secrets (PAN/CVV/full cookies) in logs or unredacted traces.  
5. Profile + card supplied by caller (fixtures only behind an explicit flag).

---

## 11. Context for the next engineer

Previous agents under-scoped Playwright to “recon only” over caution. That constraint is lifted. Prefer **hybrid** (browser trust + HTTP checkout) over re-implementing Paydock/3DS as pure UI automation.

If stuck: capture a fresh HAR of a successful manual checkout, run `har-diff.mjs` against an executor `debugTrace` JSON, and fix the first divergent step in the golden checklist — do not rewrite the chain from scratch.
