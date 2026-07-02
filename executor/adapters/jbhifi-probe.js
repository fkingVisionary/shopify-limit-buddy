// JB Hi-Fi per-SKU endpoint probe.
//
// Given one or more SKUs, fan out across every public Shopify surface that
// might leak a handle/variant/inventory for that SKU, in parallel. Each
// endpoint's outcome is recorded in a matrix so we can see WHICH surfaces
// leak data the public PDP hides.
//
// Endpoints probed per SKU:
//   1. /search/suggest.json                (predictive - product only)
//   2. /search/suggest.json                (broad: product+collection+page+article, unavailable_products=last)
//   3. /search?q={sku}&type=product&view=json    (theme JSON view template)
//   4. /search?q={sku}&section_id=predictive-search  (section rendering API)
//   5. /search?q={sku}&type=product        (HTML - grep for /products/{handle})
//   6. /products/{sku}.json                (handle == sku guess)
//   7. /products/{sku}.js                  (alt serializer)
//   8. /recommendations/products.json?product_id=…&intent=complementary  (only if we have an id)
//   9. /collections/all/products.json?limit=250 filter (skipped here - too heavy for probe)
//  10. Search-Console-style probe via HTML grep of any /products/... URLs on
//      the site search HTML page.
//
// Then: for every UNIQUE handle any probe surfaced, hydrate via
// /products/{handle}.json and confirm the SKU appears in one of its variants.

import { makeDispatcher, createJar, request } from "../http.js";

const HOST = "https://www.jbhifi.com.au";

async function fetchJson(url, ctx, extraHeaders = {}) {
  const t0 = Date.now();
  try {
    const res = await request(url, { method: "GET", headers: { referer: HOST + "/", accept: "application/json,*/*", ...extraHeaders } }, ctx);
    const body = await res.text();
    let json = null;
    try { json = JSON.parse(body); } catch { /* not json */ }
    return { url, status: res.status, ok: res.ok, elapsedMs: Date.now() - t0, bytes: body.length, body, json };
  } catch (e) {
    return { url, status: 0, ok: false, elapsedMs: Date.now() - t0, bytes: 0, body: "", json: null, error: e?.message ?? String(e) };
  }
}

async function fetchText(url, ctx, extraHeaders = {}) {
  const t0 = Date.now();
  try {
    const res = await request(url, { method: "GET", headers: { referer: HOST + "/", accept: "text/html,*/*", ...extraHeaders } }, ctx);
    const body = await res.text();
    return { url, status: res.status, ok: res.ok, elapsedMs: Date.now() - t0, bytes: body.length, body };
  } catch (e) {
    return { url, status: 0, ok: false, elapsedMs: Date.now() - t0, bytes: 0, body: "", error: e?.message ?? String(e) };
  }
}

async function postJson(url, ctx, headers, body) {
  const t0 = Date.now();
  try {
    const res = await request(url, { method: "POST", headers: { referer: HOST + "/", accept: "application/json,*/*", "content-type": "application/x-www-form-urlencoded", ...headers }, body }, ctx);
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* not json */ }
    return { url, status: res.status, ok: res.ok, elapsedMs: Date.now() - t0, bytes: text.length, body: text, json };
  } catch (e) {
    return { url, status: 0, ok: false, elapsedMs: Date.now() - t0, bytes: 0, body: "", json: null, error: e?.message ?? String(e) };
  }
}

// ─── Algolia key discovery ──────────────────────────────────────────
// JB Hi-Fi's search runs client-side against Algolia. The app id + public
// search-only key are embedded in the storefront JS (window.__STORE__ or a
// script that calls algoliasearch(...)). Scan the homepage + search page +
// any script it references to extract them.
const ALGOLIA_APP_RE = /["']?(?:appId|app_id|application_id|algolia_app_id|algoliaAppId)["']?\s*[:=]\s*["']([A-Z0-9]{6,20})["']/i;
const ALGOLIA_KEY_RE = /["']?(?:apiKey|api_key|search_api_key|algolia_api_key|algoliaApiKey|searchApiKey)["']?\s*[:=]\s*["']([a-f0-9]{20,40})["']/i;
const ALGOLIA_INDEX_RE = /["']([a-z0-9_\-]*(?:shopify_products|products)[a-z0-9_\-]*)["']/i;
const ALGOLIA_INLINE_APP_RE = /algoliasearch\(\s*["']([A-Z0-9]{6,20})["']\s*,\s*["']([a-f0-9]{20,40})["']/i;

async function discoverAlgolia(ctx) {
  const hits = { appId: null, apiKey: null, indexName: null, sourceUrls: [] };

  async function scan(url) {
    const r = await fetchText(url, ctx);
    if (!r.ok || !r.body) return;
    hits.sourceUrls.push({ url: url.replace(HOST, ""), status: r.status, bytes: r.bytes });
    // Inline algoliasearch("APPID", "KEY", ...) → both at once
    const inline = r.body.match(ALGOLIA_INLINE_APP_RE);
    if (inline) { hits.appId ??= inline[1]; hits.apiKey ??= inline[2]; }
    const a = r.body.match(ALGOLIA_APP_RE); if (a) hits.appId ??= a[1];
    const k = r.body.match(ALGOLIA_KEY_RE); if (k) hits.apiKey ??= k[1];
    const i = r.body.match(ALGOLIA_INDEX_RE); if (i) hits.indexName ??= i[1];
    // Follow up to 5 script srcs that look interesting.
    if (!hits.appId || !hits.apiKey) {
      const scripts = [...r.body.matchAll(/<script[^>]+src=["']([^"']+)["']/g)].map((m) => m[1]);
      const interesting = scripts.filter((s) => /algolia|search|instantsearch|theme|app\.|main\./i.test(s)).slice(0, 5);
      for (const s of interesting) {
        if (hits.appId && hits.apiKey && hits.indexName) break;
        const abs = s.startsWith("http") ? s : s.startsWith("//") ? "https:" + s : HOST + s;
        const rr = await fetchText(abs, ctx);
        hits.sourceUrls.push({ url: abs.slice(0, 120), status: rr.status, bytes: rr.bytes });
        if (!rr.body) continue;
        const inline2 = rr.body.match(ALGOLIA_INLINE_APP_RE);
        if (inline2) { hits.appId ??= inline2[1]; hits.apiKey ??= inline2[2]; }
        const a2 = rr.body.match(ALGOLIA_APP_RE); if (a2) hits.appId ??= a2[1];
        const k2 = rr.body.match(ALGOLIA_KEY_RE); if (k2) hits.apiKey ??= k2[1];
        const i2 = rr.body.match(ALGOLIA_INDEX_RE); if (i2) hits.indexName ??= i2[1];
      }
    }
  }

  await scan(HOST + "/");
  if (!hits.appId || !hits.apiKey || !hits.indexName) await scan(HOST + "/search?q=test");
  return hits;
}

async function queryAlgolia(algolia, sku, ctx) {
  if (!algolia?.appId || !algolia?.apiKey) {
    return { skipped: true, reason: "no algolia keys discovered" };
  }
  // Try common JB Hi-Fi index name patterns if discovery didn't find one.
  const indexes = algolia.indexName
    ? [algolia.indexName]
    : ["shopify_products", "shopify_products_price_asc", "jbhifi_products", "products"];

  const attempts = [];
  for (const indexName of indexes) {
    const url = `https://${algolia.appId.toLowerCase()}-dsn.algolia.net/1/indexes/${encodeURIComponent(indexName)}/query`;
    const body = JSON.stringify({ params: `query=${encodeURIComponent(sku)}&hitsPerPage=10` });
    const r = await postJson(url, ctx, {
      "x-algolia-application-id": algolia.appId,
      "x-algolia-api-key": algolia.apiKey,
      "content-type": "application/json",
    }, body);
    const hits = r.json?.hits ?? [];
    const handles = hits
      .map((h) => h.handle || h.product_handle || h.slug || (h.url ? String(h.url).match(/\/products\/([a-z0-9-]+)/)?.[1] : null))
      .filter(Boolean)
      .map((h) => String(h).toLowerCase());
    attempts.push({
      indexName,
      status: r.status,
      ok: r.ok,
      elapsedMs: r.elapsedMs,
      nbHits: r.json?.nbHits ?? null,
      handles: [...new Set(handles)],
      firstHit: hits[0] ? { objectID: hits[0].objectID, title: hits[0].title ?? hits[0].name, sku: hits[0].sku ?? hits[0].variant_sku } : null,
      snippet: r.body ? r.body.slice(0, 240) : null,
      error: r.error ?? null,
    });
    if (r.ok && handles.length > 0) break; // stop at first productive index
  }
  return { skipped: false, attempts };
}


function handlesFromHtml(html) {
  const out = new Set();
  const re = /\/products\/([a-z0-9][a-z0-9-]{2,120})/gi;
  let m;
  while ((m = re.exec(html))) out.add(m[1].toLowerCase());
  return [...out];
}

function handlesFromSuggest(json) {
  const products = json?.resources?.results?.products ?? [];
  return products
    .map((p) => (p?.handle ? String(p.handle).toLowerCase() : null))
    .filter(Boolean);
}

// Build the probe endpoints for one SKU.
function endpointsFor(sku) {
  const q = encodeURIComponent(sku);
  return [
    {
      key: "suggest.product",
      url: `${HOST}/search/suggest.json?q=${q}&resources[type]=product&resources[limit]=10&resources[options][unavailable_products]=last`,
      kind: "json",
      extract: (r) => handlesFromSuggest(r.json),
    },
    {
      key: "suggest.broad",
      url: `${HOST}/search/suggest.json?q=${q}&resources[type]=product,collection,page,article&resources[limit]=10&resources[options][unavailable_products]=last`,
      kind: "json",
      extract: (r) => handlesFromSuggest(r.json),
    },
    {
      key: "search.view=json",
      url: `${HOST}/search?q=${q}&type=product&view=json`,
      kind: "text",
      extract: (r) => handlesFromHtml(r.body),
    },
    {
      key: "search.section",
      url: `${HOST}/search?q=${q}&type=product&section_id=predictive-search`,
      kind: "text",
      extract: (r) => handlesFromHtml(r.body),
    },
    {
      key: "search.html",
      url: `${HOST}/search?q=${q}&type=product`,
      kind: "text",
      extract: (r) => handlesFromHtml(r.body),
    },
    {
      key: "handle.json",
      url: `${HOST}/products/${encodeURIComponent(sku.toLowerCase())}.json`,
      kind: "json",
      extract: (r) => (r.json?.product?.handle ? [String(r.json.product.handle).toLowerCase()] : []),
    },
    {
      key: "handle.js",
      url: `${HOST}/products/${encodeURIComponent(sku.toLowerCase())}.js`,
      kind: "json",
      extract: (r) => (r.json?.handle ? [String(r.json.handle).toLowerCase()] : []),
    },
    {
      key: "handle.oembed",
      url: `${HOST}/products/${encodeURIComponent(sku.toLowerCase())}.oembed`,
      kind: "json",
      extract: (r) => {
        const u = r.json?.provider_url || r.json?.author_url || "";
        return handlesFromHtml(String(u));
      },
    },
  ];
}

async function hydrateHandle(handle, ctx) {
  const r = await fetchJson(`${HOST}/products/${handle}.json`, ctx);
  if (!r.ok || !r.json?.product) return { handle, hydrated: false, status: r.status };
  const p = r.json.product;
  const variants = (p.variants ?? []).map((v) => ({
    id: v.id, sku: v.sku ?? null, title: v.title, price: v.price ?? null,
    available: v.available ?? null, inventoryQty: v.inventory_quantity ?? null,
  }));
  return {
    handle,
    hydrated: true,
    id: p.id ?? null,
    title: p.title,
    vendor: p.vendor ?? null,
    productType: p.product_type ?? null,
    tags: Array.isArray(p.tags) ? p.tags : typeof p.tags === "string" ? p.tags.split(",").map((s) => s.trim()) : [],
    publishedAt: p.published_at ?? null,
    updatedAt: p.updated_at ?? null,
    createdAt: p.created_at ?? null,
    image: p.image?.src ?? p.images?.[0]?.src ?? null,
    variantCount: variants.length,
    inventoryTotal: variants.reduce((s, v) => s + (Number(v.inventoryQty) || 0), 0),
    variants,
    url: `${HOST}/products/${handle}`,
  };
}

export async function runJbhifiProbe(opts = {}) {
  const { skus = [], proxy = null, concurrency = 6 } = opts;
  const t0 = Date.now();
  const jar = createJar();
  const dispatcher = makeDispatcher(proxy);
  const ctx = { dispatcher, jar };

  const list = (Array.isArray(skus) ? skus : [])
    .map((s) => String(s).trim())
    .filter(Boolean)
    .slice(0, 50);

  try {
    // Discover Algolia credentials ONCE per run (shared across all SKUs).
    const algolia = await discoverAlgolia(ctx);

    const bySku = [];
    const allHandles = new Set();

    for (const sku of list) {
      const eps = endpointsFor(sku);
      const [shopifyResults, algoliaResult] = await Promise.all([
        Promise.all(
          eps.map(async (ep) => {
            const r = ep.kind === "json" ? await fetchJson(ep.url, ctx) : await fetchText(ep.url, ctx);
            let handles = [];
            try { handles = ep.extract(r) ?? []; } catch { /* ignore */ }
            for (const h of handles) allHandles.add(h);
            return {
              key: ep.key,
              url: ep.url.replace(HOST, ""),
              status: r.status,
              ok: r.ok,
              elapsedMs: r.elapsedMs,
              bytes: r.bytes,
              handles,
              snippet: r.body ? String(r.body).slice(0, 240) : null,
              error: r.error ?? null,
            };
          }),
        ),
        queryAlgolia(algolia, sku, ctx),
      ]);

      // Fold Algolia attempts into the same endpoint matrix so the UI shows them.
      const algoliaRows = (algoliaResult.attempts ?? []).map((a) => {
        for (const h of a.handles) allHandles.add(h);
        return {
          key: `algolia:${a.indexName}`,
          url: `algolia.net/1/indexes/${a.indexName}/query`,
          status: a.status,
          ok: a.ok,
          elapsedMs: a.elapsedMs,
          bytes: (a.snippet ?? "").length,
          handles: a.handles,
          snippet: a.firstHit ? `nbHits=${a.nbHits} first=${JSON.stringify(a.firstHit)}` : a.snippet,
          error: a.error ?? null,
        };
      });
      if (algoliaResult.skipped) {
        algoliaRows.push({
          key: "algolia:skipped",
          url: "-",
          status: 0,
          ok: false,
          elapsedMs: 0,
          bytes: 0,
          handles: [],
          snippet: algoliaResult.reason,
          error: null,
        });
      }

      const results = [...shopifyResults, ...algoliaRows];
      bySku.push({ sku, endpoints: results, handlesFound: [...new Set(results.flatMap((r) => r.handles))] });
    }

    // Hydrate every unique handle in parallel (bounded).
    const uniqueHandles = [...allHandles];
    const hydrated = new Map();
    let i = 0;
    await Promise.all(
      Array.from({ length: Math.min(concurrency, uniqueHandles.length) }, async () => {
        while (i < uniqueHandles.length) {
          const idx = i++;
          const h = uniqueHandles[idx];
          const norm = await hydrateHandle(h, ctx);
          hydrated.set(h, norm);
        }
      }),
    );

    // Match each SKU back to its confirmed product (SKU appears in a variant).
    const matches = [];
    for (const row of bySku) {
      const confirmed = [];
      for (const h of row.handlesFound) {
        const p = hydrated.get(h);
        if (!p?.hydrated) continue;
        const hit = (p.variants ?? []).find((v) => v.sku && String(v.sku).toLowerCase() === row.sku.toLowerCase());
        if (hit) confirmed.push({ ...p, matchedVariant: hit });
      }
      matches.push({ sku: row.sku, product: confirmed[0] ?? null, alternates: confirmed.slice(1) });
    }

    return {
      ok: true,
      elapsedMs: Date.now() - t0,
      stats: {
        skus: list.length,
        endpointsPerSku: list[0] ? endpointsFor(list[0]).length : 0,
        uniqueHandlesFound: uniqueHandles.length,
        confirmed: matches.filter((m) => m.product).length,
      },
      matches,
      bySku, // full endpoint matrix — the actual recon output
      hydrated: [...hydrated.values()],
    };
  } finally {
    try { await dispatcher?.close?.(); } catch { /* ignore */ }
  }
}
