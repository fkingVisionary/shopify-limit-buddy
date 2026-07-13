# Harvey submission

**Paste this into "What's the issue?":**

Our Node executor (node-tls-client, Chrome fingerprint, residential AU proxy, Hyper SDK for sensor) successfully solves Akamai on `www.kmart.com.au` — the www `_abck` cookie validates. But the first sensor POST to the api host (`api.kmart.com.au`) returns **HTTP 503**, and every subsequent GraphQL request to `https://api.kmart.com.au/gateway/graphql` returns **403 Access Denied** from `errors.edgesuite.net` (Akamai edge, not origin). See `failing-run.json` for the exact step timeline.

Please use the attached HAR (real browser, working session on the same product page → add to cart → checkout) to identify:

1. **Sensor endpoint on api.kmart.com.au** — which path + method the browser hits to seed the api-host `_abck`, and at what point in the flow (before cart, after cart, on the first GraphQL call?). Include full request headers (order, casing) and the request body shape.
2. **Cookie seeding strategy** — does the browser get api-host `_abck` from a dedicated api-host sensor POST, from a cross-domain www→api navigation, from an Akamai script served by api.kmart.com.au, or is `_abck` shared cross-subdomain via `Domain=.kmart.com.au`?
3. **GraphQL request headers** — the exact header set (order + casing + values, especially `sec-ch-ua*`, `origin`, `referer`, `x-api-key` or any custom `x-*`, `content-type`) the browser sends on `POST /gateway/graphql` that our executor is missing or sending differently.

Then compare against the attached `kmart.js` (chain), `antibot.js` (Hyper sensor wrapper), and `http.js` (transport / cookie jar / default headers) and give a concrete diff.

## Files to attach (in this folder)

1. `<your recording>.har` — the browser HAR
2. `kmart.js`
3. `antibot.js`
4. `http.js`
5. `failing-run.json`
6. `hyper-solutions-brief.md`

Total: 6 files (Harvey max 10). Each under 500 KB.

## Budget

5 submissions/day. Use one now with the prompt above. Save the rest for follow-up narrowing if the answer is ambiguous.
