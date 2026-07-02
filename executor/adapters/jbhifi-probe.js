// JB Hi-Fi per-SKU endpoint probe — Algolia-first.
//
// JB Hi-Fi's storefront search runs client-side against Algolia. Their
// app id, public search key, and index name are hard-coded in a theme
// bundle asset:
//   https://www.jbhifi.com.au/cdn/shop/t/506/assets/bundle.<hash>.js
// The exact fragment (as of 2026-07):
//   {app_id:"VTVKM5URPX",search_api_key:"a0c0108d737ad5ab54a0e2da900bf040",
//    index_prefix:"shopify_",index_products:"shopify_products_families", ...}
//
// The Algolia index exposes EVERY product family — including entries the
// storefront hides (`button:"DoNotDisplay"`, `product_published:true`,
// unreleased/embargoed SKUs). This is the single highest-leverage
// endpoint for JB Hi-Fi hidden-product recon.
//
// Strategy per run:
//   1. Load Algolia creds. Try hard-coded first; if a request fails or
//      the user forces `refreshKeys`, scrape the current theme bundles.
//   2. For each SKU, fire 3 Algolia queries in parallel:
//        a. plain query=<sku>            (fuzzy, handles typos)
//        b. filters=sku:"<sku>"          (exact match on sku attribute)
//        c. filters=variant_id=<sku>     (in case caller passed a variant id)
//   3. Also run a small set of Shopify-native probes (kept for
//      cross-checks / comparison), bounded by a shared time budget.
//   4. Hydrate every unique handle via /products/{handle}.json to confirm.

import { makeDispatcher, createJar, request } from "../http.js";

const HOST = "https://www.jbhifi.com.au";

// Hard-coded from theme bundle inspection (see file header).
const ALGOLIA_FALLBACK = {
  appId: "VTVKM5URPX",
  apiKey: "a0c0108d737ad5ab54a0e2da900bf040",
  indexName: "shopify_products_families",
  indexPrefix: "shopify_",
  productFamiliesKey: "1d989f0839a992bbece9099e1b091f07",
};

const TIME_BUDGET_MS = 22_000;

// ─── HTTP helpers ─────────────────────────────────────────────────────
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

async function algoliaQuery({ appId, apiKey, indexName }, params, ctx) {
  const url = `https://${appId.toLowerCase()}-dsn.algolia.net/1/indexes/${encodeURIComponent(indexName)}/query`;
  const t0 = Date.now();
  try {
    const res = await request(url, {
      method: "POST",
      headers: {
        "x-algolia-application-id": appId,
        "x-algolia-api-key": apiKey,
        "content-type": "application/json",
        accept: "application/json",
        origin: HOST,
        referer: HOST + "/",
      },
      body: JSON.stringify({ params }),
    }, ctx);
    const text = await res.text();
    let json = null; try { json = JSON.parse(text); } catch { /* ignore */ }
    return { url, status: res.status, ok: res.ok, elapsedMs: Date.now() - t0, bytes: text.length, body: text, json };
  } catch (e) {
    return { url, status: 0, ok: false, elapsedMs: Date.now() - t0, bytes: 0, body: "", json: null, error: e?.message ?? String(e) };
  }
}

// ─── Algolia key discovery (fallback for when hard-coded creds rotate)
async function discoverAlgoliaFromBundles(ctx, budgetMs = 15_000) {
  const deadline = Date.now() + budgetMs;
  const home = await fetchText(HOST + "/", ctx);
  if (!home.ok) return { discovered: false, reason: `home ${home.status}`, sourceUrls: [] };
  const srcs = [...home.body.matchAll(/<script[^>]+src=["']([^"']+bundle\.[^"']+\.js[^"']*)["']/g)].map((m) => m[1]);
  const absolute = srcs
    .map((s) => (s.startsWith("http") ? s : s.startsWith("//") ? "https:" + s : HOST + s))
    .slice(0, 20);
  const sourceUrls = [];

  // Config-shaped regex: {app_id:"XXX",search_api_key:"HEX",...}
  const CONFIG_RE = /app_id\s*:\s*"([A-Z0-9]{6,20})"\s*,\s*search_api_key\s*:\s*"([a-f0-9]{20,64})"[^}]{0,600}?(?:index_products\s*:\s*"([a-z0-9_\-]+)")?/i;

  const found = { appId: null, apiKey: null, indexName: null };
  // Scan up to 6 bundles in parallel with per-file cap
  const chunk = absolute.slice(0, 6);
  const results = await Promise.all(chunk.map(async (url) => {
    if (Date.now() > deadline) return null;
    const r = await fetchText(url, ctx);
    sourceUrls.push({ url: url.slice(0, 140), status: r.status, bytes: r.bytes });
    if (!r.ok) return null;
    const m = r.body.match(CONFIG_RE);
    if (m) return { appId: m[1], apiKey: m[2], indexName: m[3] ?? null };
    return null;
  }));
  for (const r of results) {
    if (r) {
      found.appId ??= r.appId;
      found.apiKey ??= r.apiKey;
      found.indexName ??= r.indexName;
    }
  }
  return { discovered: !!(found.appId && found.apiKey), ...found, sourceUrls };
}

// ─── Shopify-native probes (cross-check only) ─────────────────────────
function handlesFromHtml(html) {
  const out = new Set();
  const re = /\/products\/([a-z0-9][a-z0-9-]{2,120})/gi;
  let m;
  while ((m = re.exec(html))) out.add(m[1].toLowerCase());
  return [...out];
}
function handlesFromSuggest(json) {
  const products = json?.resources?.results?.products ?? [];
  return products.map((p) => (p?.handle ? String(p.handle).toLowerCase() : null)).filter(Boolean);
}

function shopifyEndpointsFor(sku) {
  const q = encodeURIComponent(sku);
  return [
    { key: "suggest.product", url: `${HOST}/search/suggest.json?q=${q}&resources[type]=product&resources[limit]=10&resources[options][unavailable_products]=last`, kind: "json", extract: (r) => handlesFromSuggest(r.json) },
    { key: "search.view=json", url: `${HOST}/search?q=${q}&type=product&view=json`, kind: "text", extract: (r) => handlesFromHtml(r.body) },
    { key: "handle.json", url: `${HOST}/products/${encodeURIComponent(sku.toLowerCase())}.json`, kind: "json", extract: (r) => (r.json?.product?.handle ? [String(r.json.product.handle).toLowerCase()] : []) },
  ];
}

// Extract a compact summary of an Algolia hit (JB Hi-Fi schema).
function summarizeHit(h) {
  if (!h) return null;
  return {
    objectID: h.objectID ?? null,
    sku: h.sku ?? null,
    variantId: h.variant_id ?? null,
    productId: h.product_id ?? null,
    title: h.title ?? h.primary_title ?? null,
    handle: h.handle ?? null,
    vendor: h.vendor ?? null,
    productType: h.product_type ?? null,
    price: h.price ?? h.pricing?.displayPriceInc ?? null,
    published: h.product_published ?? null,
    button: h.button ?? null,                 // "DoNotDisplay" == HIDDEN
    tags: typeof h.tags === "string" ? h.tags.split(",").map((s) => s.trim()) : (h.tags ?? null),
    releaseDate: h.release_date ? new Date(h.release_date * 1000).toISOString() : null,
    image: h.product_image ?? null,
    inventoryManagement: h.inventory_management ?? null,
    availabilityRank: h.availabilityRank ?? null,
    limitPerOrder: h.product?.limitPerOrder ?? null,
    availability: h.availability?.overallStatus ?? null,
    isHidden: h.button === "DoNotDisplay" || h.button === "SoldOut" || h.button === "ComingSoon",
  };
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
    handle, hydrated: true, id: p.id ?? null, title: p.title,
    vendor: p.vendor ?? null, productType: p.product_type ?? null,
    tags: Array.isArray(p.tags) ? p.tags : typeof p.tags === "string" ? p.tags.split(",").map((s) => s.trim()) : [],
    publishedAt: p.published_at ?? null, updatedAt: p.updated_at ?? null, createdAt: p.created_at ?? null,
    image: p.image?.src ?? p.images?.[0]?.src ?? null,
    variantCount: variants.length,
    inventoryTotal: variants.reduce((s, v) => s + (Number(v.inventoryQty) || 0), 0),
    variants, url: `${HOST}/products/${handle}`,
  };
}

// ─── Main entry ───────────────────────────────────────────────────────
export async function runJbhifiProbe(opts = {}) {
  const { skus = [], queries = [], proxy = null, concurrency = 6, refreshKeys = false, skipShopify = false, skipHydrate: skipHydrateOpt, hitsPerQuery = 20 } = opts;
  // Algolia-only mode: skip the slow jbhifi.com.au hydrate step unless explicitly opted in.
  const skipHydrate = skipHydrateOpt ?? skipShopify;
  const t0 = Date.now();
  const jar = createJar();
  const dispatcher = makeDispatcher(proxy);
  const ctx = { dispatcher, jar };
  const deadline = t0 + TIME_BUDGET_MS;

  const list = (Array.isArray(skus) ? skus : [])
    .map((s) => String(s).trim())
    .filter(Boolean)
    .slice(0, 50);
  const queryList = (Array.isArray(queries) ? queries : [])
    .map((s) => String(s).trim())
    .filter(Boolean)
    .slice(0, 20);


  try {
    // 1. Resolve Algolia creds. Hard-coded first; only scrape on demand.
    let algolia = { ...ALGOLIA_FALLBACK, source: "hardcoded", sourceUrls: [] };
    if (refreshKeys) {
      const disc = await discoverAlgoliaFromBundles(ctx, 15_000);
      if (disc.discovered) {
        algolia = { appId: disc.appId, apiKey: disc.apiKey, indexName: disc.indexName ?? ALGOLIA_FALLBACK.indexName, source: "discovered", sourceUrls: disc.sourceUrls };
      } else {
        algolia.sourceUrls = disc.sourceUrls;
        algolia.discoveryError = disc.reason ?? "no config regex match";
      }
    }

    // 2. Per-SKU Algolia queries + optional Shopify probes.
    const bySku = [];
    const allHandles = new Set();

    for (const sku of list) {
      if (Date.now() > deadline) {
        bySku.push({ sku, endpoints: [{ key: "budget", url: "-", status: 0, ok: false, elapsedMs: 0, bytes: 0, handles: [], snippet: "time budget exceeded", error: null }], handlesFound: [], algoliaSummary: null });
        continue;
      }

      // Three Algolia strategies in parallel.
      const [byQuery, bySkuFacet, byVariant] = await Promise.all([
        algoliaQuery(algolia, `query=${encodeURIComponent(sku)}&hitsPerPage=5`, ctx),
        algoliaQuery(algolia, `query=&filters=sku:"${sku}"&hitsPerPage=5`, ctx),
        /^\d{8,20}$/.test(sku)
          ? algoliaQuery(algolia, `query=&filters=variant_id=${sku}&hitsPerPage=5`, ctx)
          : Promise.resolve({ status: 0, ok: false, elapsedMs: 0, bytes: 0, body: "", json: null, skipped: true }),
      ]);

      const rows = [];
      const pushAlgolia = (label, r) => {
        if (r.skipped) return;
        const hits = r.json?.hits ?? [];
        const handles = hits.map((h) => h.handle).filter(Boolean).map((h) => String(h).toLowerCase());
        for (const h of handles) allHandles.add(h);
        rows.push({
          key: `algolia:${label}`,
          url: `algolia.net/1/indexes/${algolia.indexName}/query`,
          status: r.status, ok: r.ok, elapsedMs: r.elapsedMs, bytes: r.bytes,
          handles: [...new Set(handles)],
          snippet: r.json ? `nbHits=${r.json.nbHits ?? "?"} ${hits[0] ? "first=" + JSON.stringify(summarizeHit(hits[0])) : ""}`.slice(0, 400) : (r.body || "").slice(0, 240),
          error: r.error ?? null,
        });
      };
      pushAlgolia("query", byQuery);
      pushAlgolia("sku-filter", bySkuFacet);
      pushAlgolia("variant-filter", byVariant);

      // Rich per-SKU Algolia summary (first exact match by sku, then any hit).
      const allHits = [
        ...(bySkuFacet.json?.hits ?? []),
        ...(byQuery.json?.hits ?? []),
        ...(byVariant.json?.hits ?? []),
      ];
      const exact = allHits.find((h) => String(h?.sku ?? "").toLowerCase() === sku.toLowerCase());
      const algoliaSummary = summarizeHit(exact ?? allHits[0] ?? null);

      // 3. Optional Shopify cross-checks.
      if (!skipShopify && Date.now() < deadline) {
        const eps = shopifyEndpointsFor(sku);
        const shopifyResults = await Promise.all(
          eps.map(async (ep) => {
            const r = ep.kind === "json" ? await fetchJson(ep.url, ctx) : await fetchText(ep.url, ctx);
            let handles = [];
            try { handles = ep.extract(r) ?? []; } catch { /* ignore */ }
            for (const h of handles) allHandles.add(h);
            return {
              key: ep.key, url: ep.url.replace(HOST, ""),
              status: r.status, ok: r.ok, elapsedMs: r.elapsedMs, bytes: r.bytes,
              handles, snippet: r.body ? String(r.body).slice(0, 240) : null, error: r.error ?? null,
            };
          }),
        );
        rows.push(...shopifyResults);
      }

      bySku.push({ sku, endpoints: rows, handlesFound: [...new Set(rows.flatMap((r) => r.handles))], algoliaSummary });
    }

    // 2b. Keyword queries — free-text Algolia searches for discovery.
    const byQuery = [];
    for (const q of queryList) {
      if (Date.now() > deadline) {
        byQuery.push({ query: q, nbHits: 0, elapsedMs: 0, status: 0, ok: false, hits: [], error: "time budget exceeded" });
        continue;
      }
      const r = await algoliaQuery(algolia, `query=${encodeURIComponent(q)}&hitsPerPage=${hitsPerQuery}`, ctx);
      const rawHits = r.json?.hits ?? [];
      const hits = rawHits.map(summarizeHit).filter(Boolean);
      byQuery.push({
        query: q,
        nbHits: r.json?.nbHits ?? hits.length,
        elapsedMs: r.elapsedMs,
        status: r.status,
        ok: r.ok,
        error: r.error ?? null,
        hits,
      });
    }


    // 4. Hydrate every unique handle in parallel (bounded), respecting deadline.
    const uniqueHandles = [...allHandles];
    const hydrated = new Map();
    if (!skipHydrate && Date.now() < deadline) {
      let i = 0;
      const remaining = () => deadline - Date.now();
      await Promise.all(
        Array.from({ length: Math.min(concurrency, uniqueHandles.length) }, async () => {
          while (i < uniqueHandles.length && remaining() > 500) {
            const idx = i++;
            const h = uniqueHandles[idx];
            const norm = await hydrateHandle(h, ctx);
            hydrated.set(h, norm);
          }
        }),
      );
    }

    // Match each SKU to its confirmed hydrated product.
    const matches = [];
    for (const row of bySku) {
      const confirmed = [];
      for (const h of row.handlesFound) {
        const p = hydrated.get(h);
        if (!p?.hydrated) continue;
        const hit = (p.variants ?? []).find((v) => v.sku && String(v.sku).toLowerCase() === row.sku.toLowerCase());
        if (hit) confirmed.push({ ...p, matchedVariant: hit });
      }
      matches.push({ sku: row.sku, algolia: row.algoliaSummary, product: confirmed[0] ?? null, alternates: confirmed.slice(1) });
    }

    return {
      ok: true,
      elapsedMs: Date.now() - t0,
      budgetExceeded: Date.now() > deadline,
      stats: {
        skus: list.length,
        queries: queryList.length,
        uniqueHandlesFound: uniqueHandles.length,
        confirmed: matches.filter((m) => m.product).length,
        algoliaHits: matches.filter((m) => m.algolia).length,
        hiddenFound: matches.filter((m) => m.algolia?.isHidden).length,
        queryHits: byQuery.reduce((s, q) => s + q.hits.length, 0),
        queryHiddenHits: byQuery.reduce((s, q) => s + q.hits.filter((h) => h?.isHidden).length, 0),
      },
      algolia: {
        appId: algolia.appId,
        apiKey: algolia.apiKey ? `${algolia.apiKey.slice(0, 6)}…${algolia.apiKey.slice(-4)}` : null,
        indexName: algolia.indexName,
        source: algolia.source,
        discovered: !!algolia.appId,
        sources: algolia.sourceUrls,
        discoveryError: algolia.discoveryError ?? null,
      },
      matches,
      bySku,
      byQuery,
      hydrated: [...hydrated.values()],
    };

  } finally {
    try { await dispatcher?.close?.(); } catch { /* ignore */ }
  }
}
