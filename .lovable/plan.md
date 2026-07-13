## Goal

Get Harvey (hypersolutions.co/harvey) to tell us why our executor's Akamai flow is rejected on `api.kmart.com.au` (503 on `api_sensor#1`, then 403 Access Denied on `cart_get` / `cart_create` at `/gateway/graphql`), while a real browser sails through.

Harvey needs two inputs: a clean browser HAR of a working session, and the specific executor code that produces the failing sensor. Its rate limit is 5 submissions/day and files cap at 500 KB each (10 files max), so we curate before uploading.

## Step 1 — You record the HAR

On a normal browser profile (no Lovable, no system proxy, no VPN):

1. Open Chrome incognito → DevTools → Network tab.
2. Check **Preserve log** and **Disable cache**. Right-click column headers → enable **Set-Cookie**.
3. Go to `https://www.kmart.com.au/` (this seeds `_abck` / `bm_sz` on www).
4. Open the same product our executor is testing (SKU 43552146, the sticker pad URL).
5. Add to cart. Open cart. Proceed to checkout until the checkout page fully loads.
6. Right-click any request in the Network panel → **Save all as HAR with content**.

Upload the `.har` to this chat. Do not scrub it — Harvey needs the cookies and sensor payloads intact. It's a short-lived session on a throwaway incognito, safe to share with Hyper.

## Step 2 — I prep the code bundle (5 files, under 500 KB each)

From our executor, only what touches Akamai on Kmart:

1. `executor/adapters/kmart.js` — the failing chain (warm → sensor loop → api_sensor → cart_get).
2. `executor/antibot.js` — the Hyper SDK wrapper (`solveAkamaiSensor` inputs).
3. `executor/http.js` — the transport / cookie jar / header defaults.
4. A trimmed `failing-run.json` — the timeline from the screenshots you just shared (api_sensor#1 503, cart_get 403 edgesuite response, cart_create 403). I'll strip anything above 500 KB and remove card-related noise.
5. `executor/docs/hyper-solutions-brief.md` — so Harvey sees what we already know about the intended flow.

I'll drop them in `.lovable/harvey-bundle/` so you can drag-drop them into Harvey's UI in one go.

## Step 3 — The prompt for Harvey's "What's the issue?" box

Draft, tuned to what its docs say it wants (specific, one failure, one hypothesis to test):

> Our Node executor solves Akamai sensor for `www.kmart.com.au` successfully (abck cookie validates), but the first sensor POST to the api host (`api.kmart.com.au`) returns 503, and every subsequent GraphQL request to `https://api.kmart.com.au/gateway/graphql` returns 403 Access Denied from edgesuite.net. The attached HAR shows a real browser doing the same call chain with a valid session. In the HAR, please identify:
> 1. Which sensor endpoint on api.kmart.com.au the browser hits (path + method + headers) before the first GraphQL call.
> 2. Whether the api-host `_abck` is seeded from a www→api navigation, a separate script fetch, or a cross-domain cookie copy.
> 3. The exact header set (order + casing + values, especially `sec-ch-ua*`, `origin`, `referer`, `x-*`) the browser sends on `/gateway/graphql` that we're missing.
> Compare against the attached `kmart.js` + `antibot.js` and tell us what to change.

## Step 4 — After Harvey answers

Harvey typically returns: (a) the missing sensor endpoint or (b) the wrong headers / cookie seeding. I'll turn its answer into a diff against `kmart.js` / `antibot.js` in a follow-up plan — no code changes this turn.

## Budget

You have 5 Harvey submissions/day. This plan uses 1. If the first answer is ambiguous, we iterate with a narrower prompt rather than re-uploading a fresh HAR.

## What I need from you next

The exported `.har` file. Once uploaded, I'll produce the bundle and the exact prompt text ready to paste.
