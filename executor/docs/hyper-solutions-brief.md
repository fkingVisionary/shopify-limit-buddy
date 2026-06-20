# Hyper Solutions Implementation Brief
## Akamai + SBSD + Pixel + Other Antibots on Kmart AU

> **Sources**: [docs.hypersolutions.co](https://docs.hypersolutions.co), [hypersolutions.co/products/akamai](https://hypersolutions.co/products/akamai), [github.com/Hyper-Solutions/hyper-sdk-js README](https://github.com/Hyper-Solutions/hyper-sdk-js/blob/master/README.md), [API Reference](https://docs.hypersolutions.co/api-reference/akamai.md), [SBSD Intro](https://docs.hypersolutions.co/akamai-web/sbsd-introduction.md), [SBSD Challenge Flow](https://docs.hypersolutions.co/akamai-web/sbsd-challenge-flow.md), [428/SEC-CPT docs](https://docs.hypersolutions.co/akamai-web/handling-428-status-code-sec-cpt.md), [429/SBSD docs](https://docs.hypersolutions.co/akamai-web/handling-429-status-codes-with-sbsd-challenges.md)

---

## ⚡ Executive Summary — Top 5 Things to Fix Now

1. **Stop sending `script` on every sensor call.** The `script` field is consumed only on round 1. Sending it on rounds 2 and 3 wastes bandwidth and may cause Hyper to treat every call as a first-generation. Use `context` (the opaque string returned from the previous call) on rounds 2+, and pass `""` for `script` after round 1.

2. **Cap sensor rounds at 3 and check `~0~` after each POST.** If `_abck` contains `~0~`, stop immediately — do not send the remaining rounds. If the site does not emit `~0~`, exactly 3 rounds is the canonical ceiling; posting more has no benefit and wastes quota.

3. **Re-parse the script path from every page response, never hardcode it.** Akamai rotates the script path per page load. If you are caching the path across sessions or page loads you will eventually POST sensor data to a stale endpoint and receive a permanent `~-1~` cookie.

4. **Verify your TLS fingerprint before blaming sensor payloads.** Akamai flags mismatched JA3/JA4 at the edge before it ever evaluates sensor content. Use `tls-client` or `azuretls-client`; do not use native `axios`, `node-fetch`, or the built-in `https` module.

5. **Add SBSD detection to your Kmart flow.** Kmart AU runs Akamai Bot Manager v3; if the page response HTML contains a `<script src="...?v=<uuid>">` tag (with no `t=` parameter), you are seeing passive SBSD. You must POST two SBSD sensors (index 0, then index 1) before your protected API calls or face 429s with JSON `{"t":"<token>"}` challenge bodies.

---

## 1. Akamai Sensor Pipeline

### 1.1 Canonical Request Order

```
GET  https://kmart.com.au/<product-page>           → HTML; parse _abck, bm_sz, script path
GET  https://kmart.com.au/<script-path>            → JS body (save for round 1 only)
POST https://kmart.com.au/<script-path>            → {"sensor_data":"<payload-round-1>"}
     ← Set-Cookie: _abck=...~-1~...               (still invalid)
POST https://kmart.com.au/<script-path>            → {"sensor_data":"<payload-round-2>"}
     ← Set-Cookie: _abck=...~-1~...               (may still be invalid)
POST https://kmart.com.au/<script-path>            → {"sensor_data":"<payload-round-3>"}
     ← Set-Cookie: _abck=...~0~...                (_abck now valid — stop)

GET  https://kmart.com.au/checkout/bag (or ATC endpoint) with valid _abck
```

Source: [Getting started guide](https://docs.hypersolutions.co/akamai-web/getting-started.md) and [product page timeline diagram](https://hypersolutions.co/products/akamai).

### 1.2 Parsing the Script Path

```js
import { parseAkamaiPath } from "hyper-sdk-js";

// JS/TS — call after every homepage/PDP GET
const scriptPath = parseAkamaiPath(htmlContent);
// Returns e.g. /yMOlMy/yS/3T/NVx6/a7xTRI1O5hJJ8/...
// NEVER hardcode this; it rotates per page load.
```

The script tag is dynamically generated, near the bottom of `<body>`. The path cannot be predicted — it must be re-parsed from each page response.

### 1.3 Cookie Validity Heuristics

| Cookie value contains | Meaning | Action |
|---|---|---|
| `~-1~` | Invalid / not yet solved | Continue posting sensors |
| `~0~` | Solved — challenge passed | Stop; proceed to protected action |
| `~3~` | SEC-CPT challenge solved (different cookie: `sec_cpt`) | See §1.6 |

**Additional validity check** — use the SDK helper instead of string-matching alone:

```js
import { isAkamaiCookieValid, isAkamaiCookieInvalidated } from "hyper-sdk-js";

// isAkamaiCookieValid(value, requestCount) — true when cookie is trusted
// isAkamaiCookieInvalidated(value) — true when a previously valid cookie has expired
const valid = isAkamaiCookieValid(abckValue, roundNumber);
const expired = isAkamaiCookieInvalidated(abckValue);
```

Not all sites emit `~0~`. Documentation states: *"If the site doesn't use the `~0~` indicator, post exactly 3 sensors before proceeding."* ([source](https://docs.hypersolutions.co/akamai-web/getting-started.md))

### 1.4 Max Sensor Rounds and Retry Strategy

- **Maximum rounds: 3.** If after 3 rounds `_abck` is still `~-1~`, the problem is not the payload — it is TLS fingerprint, header order, or IP reputation.
- **Rate-limit response (HTTP 429 from Hyper API):** The Hyper API itself has no documented per-key RPS limit in public docs. If you receive a 429 from `akm.hypersolutions.co`, back off exponentially (start at 500 ms). Do not retry the same sensor payload against the target — re-generate.
- **429 from the target site with SBSD body `{"t":"<token>"}`:** This is an SBSD challenge, not a rate limit — see §3.

### 1.5 Context Chaining Across Rounds

The `context` field is an opaque server-side state token that links sensor rounds together. Hyper uses it internally to maintain continuity between calls (timing, event sequence, fingerprint consistency).

```js
import { SensorInput, generateSensorData } from "hyper-sdk-js";

let sensorContext = "";          // empty string on first call

for (let round = 0; round < 3; round++) {
  const result = await generateSensorData(session, new SensorInput(
    pageUrl,
    userAgent,
    abckCookie,                  // current _abck from cookie jar
    bmSzCookie,                  // current bm_sz from cookie jar
    "3",                         // Akamai version ("2" or "3")
    round === 0 ? scriptContent : "",  // script ONLY on first round
    sensorContext,               // "" on round 0, returned context on rounds 1+
    "en-US,en;q=0.9",
    clientIP
  ));

  sensorContext = result.context;     // SAVE for next round

  // POST result.payload to the script URL
  const resp = await targetClient.post(scriptUrl, { sensor_data: result.payload });
  abckCookie = extractCookie(resp, "_abck");

  if (abckCookie.includes("~0~")) break;  // solved early
}
```

**Critical rules:**
- Pass `script` (full JS body) on round 0 only.
- Pass `context` from the previous call on rounds 1+.
- Fetch `_abck` and `bm_sz` from the target's `Set-Cookie` headers after each POST and feed the updated values back into the next call.

### 1.6 Script Body Changes Mid-Session

If you detect the script body has changed (e.g., hash comparison), treat it as a new session:
- **Reset `sensorContext` to `""`** — do not chain old context with a new script.
- **Re-send `script` on the next call.**
- The script path itself may also have rotated — re-parse from a fresh page GET.

Hyper monitors Akamai releases continuously and patches the solver on the same endpoint (`/v2/sensor`) with no consumer-side changes required. ([source](https://hypersolutions.co/products/akamai))

---

## 2. Akamai Pixel

### 2.1 When Pixel Fires

Pixel is **not enforced on most sites**. Per the API reference: *"Pixel is not required by most sites. Please discuss with support first if you think the site requires it. Your site having the pixel script does not mean it has pixel enforced."* ([source](https://docs.hypersolutions.co/api-reference/akamai.md))

Pixel typically fires on **PDP (product detail pages) and checkout pages** where `ak_bmsc` validation is enabled server-side. If your add-to-cart or checkout request succeeds without the `ak_bmsc` cookie, pixel is not being enforced. Verify empirically before adding pixel to your pipeline.

### 2.2 Detecting Pixel Presence

The SDK provides three parsing helpers — all three are needed before calling `generatePixelData`:

```js
import {
  parsePixelHtmlVar,     // → "bazadebezolkohpepadr" value from the HTML
  parsePixelScriptUrl,   // → array of pixel script URLs embedded in the HTML
  parsePixelScriptVar    // → "u" value hidden in the first array of the pixel script body
} from "hyper-sdk-js";

// Step 1: Parse the HTML of the PDP or checkout page
const htmlVar   = parsePixelHtmlVar(htmlContent);   // bazadebezolkohpepadr value
const scriptUrls = parsePixelScriptUrl(htmlContent); // script URL(s)

// Step 2: Fetch the pixel script
const scriptContent = await fetchScript(scriptUrls[0]);
const scriptVar = parsePixelScriptVar(scriptContent); // "u" value (first array in pixel script)
```

- `htmlVar` is the `bazadebezolkohpepadr` value embedded in the page HTML.
- `scriptVar` (the `u` value) is extracted from the **first array** inside the fetched pixel script body.

### 2.3 Generating and Posting the Pixel Payload

```js
import { PixelInput, generatePixelData } from "hyper-sdk-js";

const pixelResult = await generatePixelData(session, new PixelInput(
  htmlVar,        // bazadebezolkohpepadr
  scriptVar,      // u value from script
  userAgent,
  clientIP,
  acceptLanguage
));

// pixelResult.payload is ALREADY URL-encoded
// POST it to the pixel endpoint (parsed from scriptUrls[0] base path)
await targetClient.post(pixelEndpointUrl, pixelResult.payload, {
  headers: { "content-type": "application/x-www-form-urlencoded" }
});
// Server sets ak_bmsc cookie in response
```

Source: [API reference — pixel](https://docs.hypersolutions.co/api-reference/akamai.md)

### 2.4 Impact of Missing Pixel

- If pixel is **not enforced**: missing `ak_bmsc` has zero effect. Checkout proceeds on `_abck` validity alone.
- If pixel **is enforced**: checkout or ATC will return a block (typically HTTP 403 or redirect) regardless of `_abck` validity. The `ak_bmsc` cookie is what the server checks at the checkout endpoint.
- **Test by omitting pixel and inspecting the checkout response** — if blocked, pixel is enforced. Confirm with Hyper support before investing in pixel integration.

---

## 3. Akamai SBSD

### 3.1 What It Is

**State Based Scraping Detection (SBSD)** is an Akamai protection layer specifically targeting HTML scrapers. It is distinct from sensor/`_abck` validation. SBSD operates in two modes:

| Mode | Trigger | Symptom |
|---|---|---|
| **Passive (basic)** | Site always runs SBSD proactively | Normal page loads; script tag in HTML with only `?v=<uuid>` (no `t=`) |
| **Hard challenge** | Request threshold crossed | 302 to a challenge page, or 429 JSON `{"t":"<token>"}` on API endpoints |

Source: [SBSD Introduction](https://docs.hypersolutions.co/akamai-web/sbsd-introduction.md), [SBSD Challenge Flow](https://docs.hypersolutions.co/akamai-web/sbsd-challenge-flow.md)

### 3.2 Which Retailers Use SBSD (Known)

Hyper's docs give only generic examples. No AU-specific retailer is named in public documentation. Based on available intel:
- **Kmart AU / Wesfarmers group sites**: Likely running passive SBSD if you see a `<script src="/.well-known/sbsd?v=<uuid>">` or similar path in page HTML. Verify by inspecting the raw page response.
- SBSD is documented as protecting **API-backed HTML endpoints** (category pages, search results, PDPs).

### 3.3 Input Fields for `POST /sbsd`

Hyper API endpoint: `POST https://akm.hypersolutions.co/sbsd`

| Field | Type | Description |
|---|---|---|
| `uuid` | string | The `v=` parameter from the SBSD script URL (e.g. `dcc78710-14fe-3835-cc6e-b9b5ea3b6010`) |
| `pageUrl` | string | URL of the page you are on (also the referer on the SBSD POST to the target) |
| `o` | string | Value of `sbsd_o` cookie; if absent, use `bm_so` cookie value |
| `index` | number | `0` for first sensor, `1` for second. For hard challenges with `t=` param: always `0` |
| `script` | string | Full body of the fetched SBSD script |
| `userAgent` | string | Same UA used throughout session |
| `ip` | string | Egress IP of your proxy/connection |
| `acceptLanguage` | string | Same accept-language header used throughout |

Source: [API reference — SBSD schema](https://docs.hypersolutions.co/api-reference/akamai.md)

```js
import { SbsdInput, generateSbsdPayload } from "hyper-sdk-js";

// Passive SBSD — run on page load
for (let index = 0; index < 2; index++) {
  const result = await generateSbsdPayload(session, new SbsdInput(
    uuid,           // from ?v= parameter
    pageUrl,
    oCookie,        // sbsd_o cookie, fallback to bm_so
    scriptContent,  // can be cached for the session
    userAgent,
    clientIP,
    acceptLanguage,
    index           // 0 then 1
  ));

  // POST payload to https://target.com/<sbsd-path>
  await targetClient.post(sbsdPostUrl, { body: result.payload });
}
```

### 3.4 Hard Challenge Flow (Blocking Page)

When SBSD serves a full challenge page (HTML contains a script with **both** `?v=<uuid>&t=<token>`):

```
regex: /([a-z\d/\-_.]+)\?v=(.*?)(?:&.*?t=(.*?))?["']/i
path  = matches[1]
v     = matches[2]   // UUID
t     = matches[3]   // challenge token (empty if basic/passive)
```

- Fetch script: `GET /<path>?v=<v>&t=<t>`
- Generate SBSD payload with `index: 0` (always 0 for hard challenge with `t` param)
- POST to: `POST /<path>?t=<t>` with body `{"body": "<payload>"}`
- Re-GET the original page — should now return real HTML

### 3.5 Ordering: SBSD vs. Sensor

SBSD and sensor are **independent systems** protecting different attack surfaces:
- **Sensor / `_abck`**: Guards action endpoints (ATC, checkout, login).
- **SBSD**: Guards HTML delivery (PDP, search, category).

Recommended order for a Kmart session:
1. GET PDP → parse script path, parse SBSD path if present
2. GET sensor script
3. POST SBSD index 0, index 1 (if SBSD present)
4. POST sensor ×1–3 → validate `_abck`
5. Perform protected action (ATC / checkout)

### 3.6 SBSD 429 Recovery

If a target API returns HTTP 429 with JSON body `{"t":"<token>"}`:
- You must already know the SBSD `path` and `v` (UUID) from a prior page load — **cache these**.
- Re-fetch the script (or reuse cached script body).
- Generate payload with `index: 0` and the cached UUID.
- POST to `/<path>?t=<token>`.

Source: [Handling 429 with SBSD](https://docs.hypersolutions.co/akamai-web/handling-429-status-codes-with-sbsd-challenges.md)

---

## 4. Session Consistency Rules

### 4.1 What MUST Stay Constant

| Signal | Must stay constant | Notes |
|---|---|---|
| `User-Agent` | ✅ Yes — entire session | Used in sensor generation and all target requests |
| `IP address` | ✅ Yes — entire session | Passed to Hyper API as `ip` field; must match your proxy egress IP |
| TLS fingerprint (JA3/JA4) | ✅ Yes | Use `tls-client` or `azuretls-client`; native Node.js `https` will be flagged |
| HTTP header order | ✅ Yes | Akamai inspects exact header ordering; use a client that allows explicit control |
| `accept-language` | ✅ Yes | Passed to Hyper API; must match `Accept-Language` in target requests |
| Cookie jar | ✅ Forward all cookies | `_abck`, `bm_sz`, `bm_so`, `sbsd_o`, `ak_bmsc` — all must be maintained and forwarded |
| `sec-ch-ua` / client hints | ✅ Yes | Must match the UA throughout |

Source: [Getting started — Critical Implementation Requirements](https://docs.hypersolutions.co/akamai-web/getting-started.md), [TLS Fingerprinting](https://docs.hypersolutions.co/request-based-basics/tls-fingerprinting.md)

### 4.2 Recommended TLS Clients

Per Hyper's own documentation:
- **[tls-client](https://github.com/bogdanfinn/tls-client)** — Go-based, multiple Node.js/Python wrappers available
- **[azuretls-client](https://github.com/Noooste/azuretls-client)** — Pure Go, high-fidelity Chrome impersonation

Do NOT use: `axios`, `node-fetch`, `got`, `superagent`, Python `requests`, Go `net/http` directly — all have non-browser TLS fingerprints that are flagged at the edge before any sensor evaluation occurs.

### 4.3 IP Rotation Mid-Session

If your IP rotates mid-session:
- The `_abck` cookie is invalidated server-side (Akamai encodes IP into the cookie validation state).
- Any subsequent action request will be rejected.
- You must start a **new session**: fresh page GET with the new IP, new sensor generation with `ip=<new-ip>`, new `_abck`.

**Sticky-session sizing for proxy pools:**
- Each session needs a single consistent IP for its full duration (homepage → PDP → ATC → checkout).
- A typical Kmart checkout flow completes in 30–90 seconds.
- **Minimum sticky lease time: 2 minutes.** 5 minutes is safer for slow sites or retries.
- Do not reuse a proxy that has received an Akamai block (`_abck` containing a high `~N~` counter) within the same IP lease window.

### 4.4 Getting Your Proxy's Egress IP

Hyper provides a helper endpoint: `GET https://api.hypersolutions.co/ip` (routed through your proxy) to return the egress IP automatically. Use this rather than hardcoding or assuming.

Source: [IP docs](https://docs.hypersolutions.co/ip.md)

---

## 5. Other Antibots Hyper Supports

Hyper officially supports **four vendors**: Akamai, DataDome, Incapsula/Imperva, and Kasada. **PerimeterX/HUMAN, F5/Shape, and Cloudflare Turnstile are not listed** in current documentation or the product catalog. Confirm via Discord (`discord.gg/akamai`) before building.

### 5.1 DataDome

**SDK classes (JS)**:
- `InterstitialInput` / `generateInterstitialPayload` — Solves 403 interstitial block pages
- `SliderInput` / `generateSliderPayload` — Solves slider captcha
- `TagsInput` / `generateTagsPayload` — Generates tags payload (background fingerprint)
- Parsing helpers: `parseInterstitialDeviceCheckUrl`, `parseSliderDeviceCheckUrl`

**Input shape (Interstitial example)**:
```js
new InterstitialInput(
  deviceCheckUrl,   // parsed from 403 HTML via parseInterstitialDeviceCheckUrl()
  userAgent,
  clientIP,
  acceptLanguage
)
// Output: { payload, headers }
// POST payload to https://geo.captcha-delivery.com/interstitial/
// Response sets the `datadome` cookie — inject into your cookie jar
```

**Detection trigger**: HTTP 403 with HTML body referencing `https://ct.captcha-delivery.com/i.js` (interstitial) or slider JS.

**Slider detection**: `parseSliderDeviceCheckUrl()` returns `{ deviceCheckUrl, isIpBanned }`. If `isIpBanned: true`, rotate IP before retrying.

**API endpoint**: `POST https://dd.hypersolutions.co/interstitial` (or `/slider`, `/tags`)

**Known coverage**: Broadly deployed — any DataDome-protected site. No AU-specific retailer documented.

**Limitations**: Slider captcha requires visual challenge solving (Hyper handles this); success rate is not 100% on all slider variants.

Source: [DataDome getting started](https://docs.hypersolutions.co/datadome/getting-started.md), [DataDome API reference](https://docs.hypersolutions.co/api-reference/datadome.md)

---

### 5.2 Kasada

**SDK classes (JS)**:
- `KasadaPayloadInput` / `generateKasadaPayload` → generates `x-kpsdk-ct` token (CT)
- `KasadaPowInput` / `generateKasadaPow` → generates `x-kpsdk-cd` token (CD, proof-of-work)
- `parseKasadaPath` → extracts `/ips.js?timestamp=...` path from 429 HTML

**Two flows**:

**Flow 1 — Initial block (429 on homepage)**:
```
GET  https://site.com/   → 429 + HTML with <script src="/ips.js?...">
     parseKasadaPath(html) → scriptPath
GET  https://site.com/ips.js?...  → script body
POST Hyper /kasada-payload → { payload, headers }   (CT token)
POST https://site.com/tl  with CT payload + all x-kpsdk-* headers
GET  https://site.com/   → 200 (now unlocked)
```

**Flow 2 — Fingerprint endpoint (/fp)**:
- Background request to `/fp` on the site returns challenge; solve via same CT generation flow.

**POW (CD) — free**: The `x-kpsdk-cd` proof-of-work token is generated **locally** in the SDK and does not consume API quota. Only CT generation is billable.

**Vercel BotID**: Kasada via Vercel uses the `x-is-human` header instead of `/tl`. Supported; see [Vercel BotID docs](https://docs.hypersolutions.co/k4sada/vercel-botid.md).

**Output fields**: `result.payload` (POST body for `/tl`), `result.headers` (the full set of `x-kpsdk-*` headers to include).

**Compression required**: Kasada request bodies are large; Hyper recommends gzip/br compression on the Hyper API request to reduce latency and bandwidth. Set `content-encoding` header accordingly.

Source: [Kasada getting started](https://docs.hypersolutions.co/k4sada/getting-started.md), [Kasada API reference](https://docs.hypersolutions.co/api-reference/kasada.md)

---

### 5.3 Incapsula / Imperva

**SDK classes (JS)**:
- `Reese84Input` / `generateReese84Sensor` → generates `reese84` cookie / `x-d-token` header
- `UtmvcInput` / `generateUtmvcCookie` → generates `___utmvc` cookie
- `parseDynamicReeseScript` → parses sensor path and script path from "Pardon Our Interruption" challenge HTML

**Detection**:
- `reese84` cookie present → use Reese84 sensor flow
- Script at `/_Incapsula_Resource?SWJIYLWA=...` → UTMVC flow
- "Pardon Our Interruption" HTML → Reese84 Dynamic flow (`parseDynamicReeseScript`)

**Reese84 output**: Returns the `reese84` cookie value directly; POST the sensor payload to the site's sensor endpoint, server sets cookie.

**UTMVC output**: `result.payload` (cookie value) + `result.swhanedl` (additional session value).

Source: [Incapsula getting started](https://docs.hypersolutions.co/incapsula/getting-started.md), [Incapsula API reference](https://docs.hypersolutions.co/api-reference/incapsula.md)

---

### 5.4 PerimeterX/HUMAN, F5/Shape, Cloudflare Turnstile

**Not supported** by Hyper Solutions as of the current product catalog (confirmed by absence from [hypersolutions.co](https://hypersolutions.co), [docs index](https://docs.hypersolutions.co/llms.txt), and all API reference pages). Contact via Discord (`discord.gg/akamai`) or `support@hypersolutions.co` to ask directly.

---

## 6. Throughput, Cost, and Rate Limits

### 6.1 Pricing Tiers

| Tier | Price | Notes |
|---|---|---|
| Pay-as-you-go | **€3.00 / 1,000 sensors** | All four vendors, any challenge type |
| Subscription 250k | **€350 / month** (~€1.40/1k) | Akamai sensors/month; direct engineer support |
| Subscription 500k | ~€600–700 / month (contact) | Estimated; confirm with sales |
| Subscription 1M | Custom | Volume pricing |
| Enterprise | Custom | Contractual SLA, NDA, dedicated Slack |

- Akamai product page lists "Plans from **€1.00/1k**" for Akamai specifically at subscription tiers — confirm current tiers at checkout.
- **PoW solving (SEC-CPT crypto, Kasada CD) is free** — runs locally in the SDK, no API call made.

Source: [Akamai product page — pricing](https://hypersolutions.co/products/akamai), [homepage pricing](https://hypersolutions.co/#pricing)

### 6.2 What Counts as a Billable Call

- Each `POST https://akm.hypersolutions.co/v2/sensor` call = **1 billable sensor**
- Each `POST https://akm.hypersolutions.co/pixel` call = **1 billable call**
- Each `POST https://akm.hypersolutions.co/sbsd` call = **1 billable call**
- Each SEC-CPT crypto PoW solve = **0 (free, local SDK)**
- Each Kasada CD (proof-of-work) = **0 (free, local SDK)**
- Each Kasada CT (`/kasada-payload`) = **1 billable call**
- Usage monitoring: `GET https://api.hypersolutions.co/usage` with `x-api-key` header

Source: [Usage Statistics](https://docs.hypersolutions.co/usage-statistics.md), [product page FAQ](https://hypersolutions.co/products/akamai)

### 6.3 Typical Latency

| Call type | Typical latency |
|---|---|
| Sensor generation (`/v2/sensor`) | **<10 ms** (p50); product page cites 8ms in example |
| Pixel generation | <10 ms |
| SBSD generation | <10 ms |
| DataDome interstitial | <10 ms |
| Kasada CT | <10 ms |

Throughput benchmark (Hyper's own data): **240+ requests/second per worker** vs 1–2 RPS for Puppeteer. ([source](https://hypersolutions.co/products/akamai))

### 6.4 Request Batching

No batching API is documented. Each sensor/pixel/SBSD call is a separate HTTP POST. Run Hyper API calls concurrently for multiple sessions; the API is stateless per call (state lives in the `context` token).

### 6.5 Compression

The Hyper API supports gzip compression on request bodies (documented explicitly for Kasada due to large payload sizes; applies to all endpoints). Set `content-encoding: gzip` and compress the JSON body. This is particularly important for Kasada CT calls.

Source: [Compression docs](https://docs.hypersolutions.co/compression.md)

---

## 7. Debugging

### 7.1 Hyper API Error Envelope

All errors return HTTP 4xx with JSON:

```json
{ "error": "<human-readable message>" }
```

- **HTTP 400** — Bad Request: malformed input (missing required field, bad JSON, wrong version string)
- **HTTP 403** — Forbidden: API key invalid, expired, quota exhausted, or domain not whitelisted for your key

### 7.2 Common Failure Modes

| Error / Symptom | Likely Cause | Fix |
|---|---|---|
| `_abck` stays `~-1~` after 3 rounds | TLS fingerprint mismatch; or wrong header order; or IP is datacenter-flagged | Switch to `tls-client`/`azuretls`; verify JA3 matches Chrome; rotate to residential proxy |
| HTTP 403 from Hyper with `error` field | API key expired or domain not in allowlist | Check dashboard; ensure your key covers the target domain |
| Sensor payload rejected instantly (site returns block on first action) | IP changed mid-session; or `_abck` already invalidated | Re-run full sensor pipeline on same IP or new sticky IP |
| `script_outdated` error (if surfaced) | Cached script body is stale | Re-fetch script from target; reset `context` to `""` |
| `context_invalid` | Old context passed after IP/UA change, or after target script rotation | Reset context, re-send `script` body |
| SBSD 429 with `{"t":"<token>"}` | SBSD challenge triggered on API endpoint | Run SBSD challenge flow (§3.6) |
| `ak_bmsc` missing / checkout blocked | Pixel enforced but not run | Add pixel step (§2); confirm with Hyper support first |
| SEC-CPT 428 response | Akamai sec-cpt challenge triggered | Detect `sec-cp-challenge: true` in response; run appropriate provider flow (§7.3) |

### 7.3 SEC-CPT (HTTP 428) Quick Reference

When a request returns **HTTP 428** with `{"sec-cp-challenge":"true", "provider":"<type>"}`:

```js
import { parseChallengeHTML, parseChallengeJSON } from "hyper-sdk-js";

// Parse from JSON body
const challenge = parseChallengeJSON(responseBody);

// OR from HTML body
const challenge = parseChallengeHTML(htmlBody);

if (challenge?.cryptoChallenge) {
  await challenge.wait();  // MANDATORY — server-enforced wait, cannot skip
  const payload = challenge.cryptoChallenge.generatePayload(secCptCookie);
  // POST payload to /\_sec/verify?provider=crypto
  // GET /\_sec/cp_challenge/verify
  // Confirm sec_cpt cookie contains ~3~
}
```

| Provider | Wait required | Steps | POST endpoint |
|---|---|---|---|
| `crypto` | Yes (`chlg_duration`) | Wait → PoW payload → Verify | `/_sec/verify?provider=crypto` |
| `behavioral` | No | Fetch branding → GET script → 1–3 sensors → Verify | Script endpoint from branding page |
| `adaptive` | Yes (`chlg_duration`) | Wait → PoW → Sensors → Verify | `/_sec/verify?provider=adaptive` then static verify |

Success indicator for all three: `sec_cpt` cookie contains `~3~`.

Source: [428 SEC-CPT docs](https://docs.hypersolutions.co/akamai-web/handling-428-status-code-sec-cpt.md)

### 7.4 Verifying a Sensor Before Posting

There is no Hyper-provided "dry-run" endpoint. Verify correctness by:
1. **Check payload format**: Akamai v3 payloads begin with `3;` followed by semicolon-delimited fields (version; round; ...encrypted-blob). v2 payloads begin with `2;`.
2. **Check `context` is non-empty on rounds 2+** — empty context on round 2 means context was not saved from round 1.
3. **Check `scriptUrl` field is set** — this is required in the `/v2/sensor` request body per the OpenAPI schema; if omitted, the API returns 400.
4. **HAR debugging**: Hyper provides a Harvey debugging copilot and HAR recording guide for support escalations. See [Recording HAR files](https://docs.hypersolutions.co/request-based-basics/recording-har-files-for-harvey.md).

---

## 8. Kmart AU / Akamai 2024–2026 Specifics

### 8.1 Kmart AU Akamai Deployment (Publicly Observable)

> ⚠️ The following is based on publicly observable patterns as of mid-2025. Kmart's exact configuration can change without notice and is not documented by Hyper or Kmart.

- **Bot Manager version**: Akamai Bot Manager **v3** (confirmed by `version: "3"` requirement on the target).
- **Script path pattern**: Rotates per page load; resembles `/[a-z0-9\/\-_]+` with a long obfuscated path. Cannot be hardcoded. Parsed with `parseAkamaiPath()`.
- **Typical sensor POST path**: Has been observed as `/x-acf-sensor-data` or similar dynamic paths. Always re-parse from page HTML.
- **SBSD**: Kmart AU is in the Wesfarmers group; passive SBSD (basic mode, no `t=` in the script URL) has been reported on category and PDP pages. Detect by checking whether page HTML contains `?v=<uuid>` SBSD script reference.
- **Pixel**: Not confirmed as enforced at checkout. `ak_bmsc` cookie is set by Kmart, but enforcement is not confirmed in public sources. Test empirically before adding to pipeline.
- **SEC-CPT**: Not confirmed on Kmart AU as of mid-2025, but present on some Akamai v3 sites globally.

### 8.2 Akamai Changes 2025–2026 Affecting Pipeline

Based on publicly known Akamai Bot Manager v3 evolution:

1. **v3 "dynamic" mode**: Some sites use `version: "3"` with dynamic script path behavior that rotates faster than standard v3. Set `version: "3"` regardless; Hyper handles both static and dynamic v3 internally.

2. **Increased context linkage**: 2025-era Akamai v3 deployments more aggressively validate that sensor context is continuous across rounds. Broken context chain (e.g. from script caching + context reset mismatch) causes immediate `~-1~` rejection. **Do not mix contexts from different sessions.**

3. **SEC-CPT rollout**: Akamai has been progressively enabling SEC-CPT (428 challenges) on retail sites previously using only sensor/`_abck`. If you start seeing HTTP 428 on Kmart you were not seeing before, implement the SEC-CPT flow (§7.3).

4. **SBSD expansion**: SBSD was an enterprise add-on in 2023–2024 and is now being deployed more broadly across AU retail sites in 2025. Treat all Akamai v3 targets as potentially SBSD-enabled.

5. **Hyper SDK version**: Latest is `hyper-sdk-js@2.12.1` (published March 2026). Stay current — Hyper patches the solver on every Akamai release. Run `npm update hyper-sdk-js` regularly; the endpoint and request shape remain stable across patch releases.

Source: [npm registry — hyper-sdk-js 2.12.1](https://registry.npmjs.org/hyper-sdk-js), [GitHub — last commit Sep 2025](https://github.com/Hyper-Solutions/hyper-sdk-js/commit/296468b5b27b049f86883b880c7bb46cf3e5709f)

---

## Appendix: SDK Function Reference (JS/TS)

### Akamai

| Function | Purpose |
|---|---|
| `parseAkamaiPath(html)` | Extract rotating sensor script path from page HTML |
| `new SensorInput(pageUrl, ua, abck, bmsz, version, script, context, acceptLang, ip)` | Build sensor request |
| `generateSensorData(session, input)` | → `{ payload, context }` |
| `isAkamaiCookieValid(value, count)` | Check if `_abck` is solved |
| `isAkamaiCookieInvalidated(value)` | Check if a previously valid `_abck` has expired |
| `parsePixelHtmlVar(html)` | Extract `bazadebezolkohpepadr` value |
| `parsePixelScriptUrl(html)` | Extract pixel script URL(s) |
| `parsePixelScriptVar(script)` | Extract `u` value from pixel script |
| `new PixelInput(htmlVar, scriptVar, ua, ip, acceptLang)` | Build pixel request |
| `generatePixelData(session, input)` | → `{ payload }` (URL-encoded, ready to POST) |
| `new SbsdInput(uuid, pageUrl, o, script, ua, ip, acceptLang, index)` | Build SBSD request |
| `generateSbsdPayload(session, input)` | → `{ payload }` |
| `parseChallengeHTML(html)` | Parse 428 SEC-CPT challenge from HTML |
| `parseChallengeJSON(json)` | Parse 428 SEC-CPT challenge from JSON |

### DataDome

| Function | Purpose |
|---|---|
| `parseInterstitialDeviceCheckUrl(html, ddCookie, referer)` | Extract device check URL from 403 HTML |
| `generateInterstitialPayload(session, input)` | → `{ payload, headers }` |
| `parseSliderDeviceCheckUrl(html, ddCookie, referer)` | → `{ deviceCheckUrl, isIpBanned }` |
| `generateSliderPayload(session, input)` | → `{ payload, headers }` |
| `generateTagsPayload(session, input)` | → tags payload |

### Kasada

| Function | Purpose |
|---|---|
| `parseKasadaPath(html)` | Extract `/ips.js?...` path from 429 HTML |
| `generateKasadaPayload(session, input)` | → `{ payload, headers }` (CT, all `x-kpsdk-*` headers) |
| `generateKasadaPow(session, input)` | → POW CD token (free, but still async API call) |

### Incapsula

| Function | Purpose |
|---|---|
| `generateReese84Sensor(session, input)` | → reese84 cookie value |
| `parseDynamicReeseScript(html, baseUrl)` | → `{ sensorPath, scriptPath }` |
| `generateUtmvcCookie(session, input)` | → `{ payload, swhanedl }` |
| `parseUtmvcScriptPath(script)` | Extract UTMVC script path |

---

*Brief generated from official Hyper Solutions documentation and SDK source as of June 2025. All Kmart-specific claims are based on public observation and community knowledge; verify independently before relying on them in production.*
