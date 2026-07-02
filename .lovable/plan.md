# JB Hi-Fi Shopify Recon

Pivot away from Kmart/Akamai work. Build a JB Hi-Fi–specific recon tool that discovers products (including unpublished/hidden ones surfaced by public Shopify endpoints) and lets you search or list them from a UI. Primary use case: catch Pokémon 30th Celebrations SKUs early, but not hardcoded to Pokémon.

## Approach

Shopify leaks unpublished / not-yet-linked products through several public JSON and XML endpoints even when they are hidden from the storefront navigation. The recon script probes every known leak surface for `jbhifi.com.au`, dedupes, and stores a normalised product list. The UI is a search box + table over that list.

Endpoints the recon will probe (order matters — cheapest first):

```text
/sitemap.xml                         → indexes all sitemap_products_N.xml
/sitemap_products_1.xml (…_N)        → every product handle Shopify knows about,
                                       including hidden-but-published ones
/sitemap_collections_1.xml           → collection handles (may include hidden ones)
/products.json?limit=250&page=N      → paginated public product feed (200-page cap)
/collections.json?limit=250&page=N   → collections feed
/collections/{handle}/products.json  → per-collection feed (finds items missing
                                       from /products.json when they're only in
                                       a hidden collection)
/products/{handle}.json              → full product incl. variants + inventory
/variants/{id}.js                    → live variant price/availability
/search/suggest.json?q=…&resources[type]=product
                                       → catches items indexed but not linked
/recommendations/products.json?product_id=…
```

The parallel exploration agent is still fetching live evidence (Shopify signals on jbhifi.com.au, anti-bot layer, myshopify.com backend host, community monitor intel). Its findings only refine endpoint ordering and the transport choice — they don't change the plan shape.

## Deliverables

1. **`executor/adapters/jbhifi-recon.js`** — new module. Functions:
   - `discoverHandles()` — pulls every `sitemap_products_*.xml`, extracts `<loc>` → handle set.
   - `walkProductsJson()` — paginates `/products.json` until empty.
   - `walkCollections()` — pulls `/collections.json`, then `/collections/{h}/products.json` for each, merges handles.
   - `hydrate(handle)` — GETs `/products/{handle}.json`, returns `{ id, handle, title, vendor, productType, tags, publishedAt, updatedAt, images[0], variants: [{id, sku, title, price, available, inventoryQty?}], sourceEndpoints: [...] }`.
   - `runRecon({ query?, limit?, since? })` — orchestrates the above, dedupes by product id, optionally filters by title/tag/vendor/sku substring, returns `{ products, stats: { sitemapCount, productsJsonCount, hiddenOnly, elapsedMs, endpointHits } }`. `hiddenOnly = true` when a handle appears in sitemap but not in `/products.json` — those are the interesting ones.
   - Concurrency: p-limit style, max 8 in-flight, small jitter. Goes through the executor's existing residential `dispatcher` when `PROXY_URL_RESI` is set; direct otherwise.

2. **`executor/server.js`** — add `POST /jbhifi/recon` (bearer-auth, same pattern as `/recon`). Body: `{ query?, limit?, hiddenOnly?, refresh? }`. Returns the recon JSON. Caches the full sitemap sweep in memory for 5 min so `?query=…` calls are fast; `refresh:true` forces a re-sweep.

3. **`src/lib/jbhifi-recon.functions.ts`** — `createServerFn` wrapping the executor call (mirrors `runOnExecutor` shape, uses `EXECUTOR_URL` + `EXECUTOR_TOKEN`). Zod-validated input.

4. **`src/routes/jbhifi.tsx`** — new route. UI:
   - Search input (debounced, 300ms) → calls the server fn with `query`.
   - "Hidden only" toggle, "Force refresh" button, "Vendor / product type" filters.
   - Results table: image thumb, title, handle → link to `jbhifi.com.au/products/{handle}`, vendor, product type, price range, total inventory (sum of variant `inventory_quantity` when present), variant count, publishedAt, a "HIDDEN" badge when `hiddenOnly`.
   - Copy-as-JSON button per row for later feeding into checkout.
   - Head metadata: title "JB Hi-Fi Recon", description, `robots: noindex`.

5. **No changes** to Kmart adapter, TLS fingerprint code, HAR diff tooling, or checkout chain. Deferred until you want to come back to it.

## Out of scope

- No polling / monitor loop / Discord webhook yet — script is on-demand only. Easy follow-up once we confirm the endpoint set actually surfaces hidden Pokémon SKUs.
- No JB Hi-Fi checkout automation. Recon only.
- No database persistence; results are in-memory + returned to the browser. If you want history/diffing later, add a Supabase table then.

## Technical notes

- `products.json` caps at 250 per page and 20 000 total; `sitemap_products_*.xml` has no such cap — it's the primary discovery source.
- JB Hi-Fi may front Shopify with a CDN / bot layer (Cloudflare or Akamai). The residential-proxy dispatcher in `executor/http.js` already handles TLS; if we get 403s on `sitemap.xml`, the recon reports that per-endpoint so we can pivot (e.g. Browserless fallback) without guessing.
- `hiddenOnly` heuristic: handle in sitemap ∧ not in `/products.json` ∧ `product.published_at != null` when hydrated. That's the classic Shopify "published to Online Store sales channel but not linked in nav/collections" leak — the exact pattern monitors exploit.
- Auth: the new route is public read-only (no writes, no PII). We can gate it behind `_authenticated/` later if you want it private.

## Order of operations after approval

1. Build `jbhifi-recon.js` + wire `/jbhifi/recon` endpoint.
2. Deploy executor (existing GitHub Actions workflow).
3. Add server fn + UI route.
4. Run against `pokemon` / `pokémon` / `pokemon 30th` / `celebrations` queries, share the hidden-only slice.