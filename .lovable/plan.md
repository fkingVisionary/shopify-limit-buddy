## Goal

Stop fighting Oxylabs' render browser. Use Hyper Solutions (already wired in) to solve Akamai/SBSD/pixel ourselves and use Oxylabs Web Unblocker purely as a sticky AU residential-IP transport. Every hop becomes a raw fetch with our own cookies, our own UA, our own fingerprint — through the same AU IP the whole flow.

## Why this fixes it

- **Current broken flow:** `OXYLABS_ENABLED` gates out every `runSensor` / `runSbsd` / `runPixel` call in `kmart.js`, and we ask Oxylabs to render HTML hops. Oxylabs spins up a fresh headless browser per render call; its cookies are bound to that browser's fingerprint. When we try to reuse those cookies on the next hop (rendered or raw), the fingerprint mismatch trips Akamai → 400 on `pdp_get`, session marked `failed`.
- **Fixed flow:** Hyper generates a real `_abck` cookie bound to our UA. Web Unblocker in raw mode (no `x-oxylabs-render`) just forwards our exact request through an AU residential IP pinned by session-id + session-time. Same UA + same IP + valid Hyper-solved cookies = Akamai accepts every hop, including raw JSON/GraphQL calls to cart/checkout later.

## Changes

### 1. `executor/http.js` — Web Unblocker in raw mode only
- Remove the `x-oxylabs-render: html` header entirely. Never render.
- Always send `x-oxylabs-force-headers: 1` (raw fetch, our headers).
- Keep `x-oxylabs-geo-location: Australia`, `x-oxylabs-session-id` (32 alnum chars), `x-oxylabs-session-time: 10`.
- Remove the `oxyRender` opt from `request()` — no callers need it anymore.

### 2. `executor/adapters/kmart.js` — re-enable Hyper solves
Remove the `!OXYLABS_ENABLED` short-circuits so Hyper runs regardless of transport:
- `warm_home` → run sensor if the response carries an Akamai script (parse `bmsz`/script path from HTML).
- `category_browse` → SBSD solve if present.
- `pdp_get` → SBSD solve if present, pixel solve if present, then retry (`pdp_get#2`).
- API warm / sensor round on the `api.kmart.com.au` origin — re-enable.
- Keep the `unblocker` step note so we still see "oxylabs session=xxxx" in the timeline, but drop the "skipping Akamai/SBSD/pixel solves" wording — those solves are back on.
- Fail early with a clear message if `HYPER_API_KEY` is missing (already the pattern for non-Oxylabs mode).

### 3. `verify_ip` — keep but reinterpret
Web Unblocker with a sticky session pins the IP for the target domain (kmart.com.au). The IP-check host is a *different* target, so `verify_ip` can legitimately show a different IP even when Kmart is stable. Two options in the plan (defer until we see the next run):
- Option A: leave `verify_ip` as-is; treat "different" as a soft warning, not a failure.
- Option B: replace with a check that hits `https://www.kmart.com.au/robots.txt` and reads a response header Oxylabs exposes (e.g. `x-oxylabs-node`) to confirm session stickiness.

Recommend A for now — one less thing to change per turn.

### 4. Kmart headers — one small correctness fix
The screenshots show `sec-fetch-site: none` on `warm_home` but that's what a real cold-open sends. Good. On `category_browse` we send `same-origin` with `referer: origin + "/"` — also correct. No change needed here; documenting so we don't touch it by accident.

### 5. Docs
Update `executor/README.md` "Env vars" section to say: `EXECUTOR_HTTP_TRANSPORT=oxylabs` uses Web Unblocker as an **IP transport only** — Hyper still handles antibot. Remove the sentence that says Kmart skips its own solves when Oxylabs is on.

## Out of scope for this turn

- No HAR-replay path yet. If cart/checkout still fails after this, that's the next step.
- No switch to Oxylabs Residential Proxies — you said Web Unblocker + Hyper first; residential is our fallback if this doesn't stick.
- No frontend changes. UI/timeline display stays the same.

## Validation after redeploy

1. Trigger the "Deploy executor" workflow.
2. Run a Kmart dry test on the sparkle salamander PDP.
3. Expected timeline: `unblocker` ✓ → `resolve_ip` ✓ → `warm_home` 200 → `sensor_home` ✓ (new step from Hyper) → `category_browse` 200 → `sbsd_category` ✓ (only if challenge present) → `pdp_get` 200 → `pdp_body_full` ✓ → `sku_extract` ✓.
4. No more "session is failed" note from Oxylabs.
5. If `verify_ip` still shows different IPs, ignore — the real signal is whether `pdp_get` returns 200 with real product HTML.

## Fallback if this still fails

If Hyper + Web Unblocker raw still hits 400 on `pdp_get`, the next move is your sticky residential proxies (send me the format when needed). We'd flip `EXECUTOR_HTTP_TRANSPORT` back to `undici`, drop the Oxylabs headers, and pipe the proxy URL through the existing `parseProxy` path. Hyper stays exactly the same.
