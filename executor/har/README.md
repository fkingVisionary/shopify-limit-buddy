# HAR reference files

Drop a full browser HAR here (or link it) so we can diff executor traces
against a real checkout.

## Size limits

GitHub / chat uploads often reject multi‑MB HARs. Prefer one of:

1. **GitHub Release asset** — upload `kmart-checkout.har` on a release, paste the URL in an issue or chat.
2. **This folder via Git LFS** — `git lfs track "executor/har/*.har"` then commit.
3. **Private URL** — S3 / Drive link the agent can fetch.

## Diff against a run

```bash
# From repo root, with a HAR path and an executor run JSON (debugTrace:true):
node --max-old-space-size=4096 executor/scripts/har-diff.mjs path/to/checkout.har --json path/to/run.json
```

See `executor/scripts/README.md` for the golden checklist (get-token → cart → address → Paydock → 3DS → placeOrder).

## What we need from your HAR

Minimum useful extract if the full file won’t upload:

- Entries for: homepage, Akamai sensor POSTs, SBSD POSTs, `get-token`, GraphQL cart ops, checkout pages, Paydock tokenize/3DS, placeOrder
- Request URL, method, status, request headers (esp. cookie / sec-ch-ua / referer), and for GraphQL the operationName

You can export a filtered HAR from Chrome DevTools (only `kmart.com.au` + `paydock.com` + `api.kmart.com.au`).
