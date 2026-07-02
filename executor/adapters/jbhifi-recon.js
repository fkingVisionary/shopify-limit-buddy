// JB Hi-Fi (jbhifi.com.au) Shopify recon.
//
// Discovers products via the union of public Shopify surfaces:
//   /sitemap.xml → /sitemap_products_*.xml   (primary source, no 20k cap)
//   /products.json?limit=250&page=N          (paginated public feed)
//   /collections.json + /collections/{h}/products.json
//   /products/{handle}.json                  (hydration)
//
// `hiddenOnly` = handle present in sitemap but NOT returned by /products.json.
// That's the classic "published to Online Store sales channel but not linked"
// leak monitors exploit.
//
// Uses the executor's node-tls-client dispatcher (Chrome-133 JA3/JA4) so we
// look like a browser to whatever CDN JB Hi-Fi fronts Shopify with.

import { makeDispatcher, createJar, request } from "../http.js";

const HOST = "https://www.jbhifi.com.au";

// In-memory sweep cache (per executor process).
const cache = {
  sweptAt: 0,
  sitemapHandles: new Set(),
  productsJsonHandles: new Set(),
  hydrated: new Map(), // handle -> normalised product
  endpointHits: {},
};
const CACHE_TTL_MS = 5 * 60 * 1000;

function log(step, ok, note) {
  cache.endpointHits[step] = { ok, note, at: Date.now() };
}

async function getText(url, ctx) {
  const res = await request(url, { method: "GET", headers: { referer: HOST + "/" } }, ctx);
  const body = await res.text();
  return { status: res.status, body, ok: res.ok };
}

async function getJson(url, ctx) {
  const { status, body, ok } = await getText(url, ctx);
  let json = null;
  try { json = JSON.parse(body); } catch { /* ignore */ }
  return { status, body, ok, json };
}

// Extract Shopify product handles from a sitemap XML string.
function handlesFromSitemap(xml) {
  const out = new Set();
  const re = /<loc>\s*([^<\s]+)\s*<\/loc>/gi;
  let m;
  while ((m = re.exec(xml))) {
    const url = m[1];
    const pm = url.match(/\/products\/([a-z0-9][a-z0-9-]*)/i);
    if (pm) out.add(pm[1].toLowerCase());
  }
  return out;
}

function subSitemapsFromIndex(xml) {
  const out = [];
  const re = /<loc>\s*([^<\s]+)\s*<\/loc>/gi;
  let m;
  while ((m = re.exec(xml))) {
    const url = m[1];
    if (/sitemap_products_/i.test(url)) out.push(url);
  }
  return out;
}

async function sweepSitemap(ctx) {
  const handles = new Set();
  const idx = await getText(HOST + "/sitemap.xml", ctx);
  log("sitemap.xml", idx.ok, `status=${idx.status} bytes=${idx.body.length}`);
  if (!idx.ok) return handles;
  const subs = subSitemapsFromIndex(idx.body);
  // Fallback: if sitemap.xml is itself the product sitemap.
  if (subs.length === 0) {
    for (const h of handlesFromSitemap(idx.body)) handles.add(h);
  }
  for (const sub of subs) {
    const r = await getText(sub, ctx);
    log(sub.replace(HOST, ""), r.ok, `status=${r.status} bytes=${r.body.length}`);
    if (!r.ok) continue;
    for (const h of handlesFromSitemap(r.body)) handles.add(h);
  }
  return handles;
}

async function sweepProductsJson(ctx, maxPages = 250) {
  const handles = new Set();
  const products = [];
  for (let page = 1; page <= maxPages; page++) {
    const url = `${HOST}/products.json?limit=250&page=${page}`;
    const r = await getJson(url, ctx);
    if (page === 1) log("/products.json", r.ok, `status=${r.status}`);
    if (!r.ok || !r.json?.products?.length) break;
    for (const p of r.json.products) {
      if (p?.handle) {
        handles.add(String(p.handle).toLowerCase());
        products.push(p);
      }
    }
    if (r.json.products.length < 250) break;
  }
  log("/products.json (total)", true, `pages walked, products=${products.length}`);
  return { handles, products };
}

// Normalise either a /products.json entry or a /products/{handle}.json entry.
function normaliseProduct(p, handle, source) {
  const variants = (p.variants ?? []).map((v) => ({
    id: v.id,
    sku: v.sku ?? null,
    title: v.title,
    price: v.price ?? null,
    available: v.available ?? null,
    inventoryQty: v.inventory_quantity ?? null,
  }));
  const prices = variants.map((v) => Number(v.price)).filter((n) => Number.isFinite(n));
  return {
    id: p.id ?? null,
    handle: handle ?? p.handle,
    title: p.title,
    vendor: p.vendor ?? null,
    productType: p.product_type ?? null,
    tags: Array.isArray(p.tags) ? p.tags : typeof p.tags === "string" ? p.tags.split(",").map((s) => s.trim()) : [],
    publishedAt: p.published_at ?? null,
    updatedAt: p.updated_at ?? p.updatedAt ?? null,
    createdAt: p.created_at ?? null,
    image: p.image?.src ?? p.images?.[0]?.src ?? null,
    priceMin: prices.length ? Math.min(...prices) : null,
    priceMax: prices.length ? Math.max(...prices) : null,
    variantCount: variants.length,
    inventoryTotal: variants.reduce((s, v) => s + (Number(v.inventoryQty) || 0), 0),
    variants,
    url: `${HOST}/products/${handle ?? p.handle}`,
    source,
  };
}

async function hydrate(handle, ctx) {
  if (cache.hydrated.has(handle)) return cache.hydrated.get(handle);
  const url = `${HOST}/products/${handle}.json`;
  const r = await getJson(url, ctx);
  if (!r.ok || !r.json?.product) {
    const stub = { handle, title: handle, url: `${HOST}/products/${handle}`, hydrated: false, status: r.status };
    cache.hydrated.set(handle, stub);
    return stub;
  }
  const norm = normaliseProduct(r.json.product, handle, "products/{handle}.json");
  norm.hydrated = true;
  cache.hydrated.set(handle, norm);
  return norm;
}

async function withLimit(items, limit, worker) {
  const out = [];
  let i = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      try { out[idx] = await worker(items[idx]); }
      catch (e) { out[idx] = { error: e?.message ?? String(e) }; }
    }
  });
  await Promise.all(runners);
  return out;
}

function matchesQuery(p, q) {
  if (!q) return true;
  const needle = q.toLowerCase();
  const hay = [
    p.title, p.handle, p.vendor, p.productType,
    ...(p.tags ?? []),
    ...((p.variants ?? []).flatMap((v) => [v.sku, v.title])),
  ].filter(Boolean).map((s) => String(s).toLowerCase()).join(" \u241f ");
  return hay.includes(needle);
}

// Resolve a SKU (or free-text) to candidate product handles via the public
// Shopify predictive search endpoint. Works for unlisted/hidden products
// that don't appear in /products.json as long as the item is published to
// the Online Store sales channel.
async function searchSuggest(term, ctx) {
  const url = `${HOST}/search/suggest.json?q=${encodeURIComponent(term)}&resources[type]=product&resources[limit]=10&resources[options][unavailable_products]=last&resources[options][fields]=title,product_type,variants.sku,vendor,tag`;
  const r = await getJson(url, ctx);
  log(`search/suggest?q=${term}`, r.ok, `status=${r.status}`);
  const products = r.json?.resources?.results?.products ?? [];
  return products
    .map((p) => (p?.handle ? String(p.handle).toLowerCase() : null))
    .filter(Boolean);
}

export async function runJbhifiRecon(opts = {}) {
  const {
    query = null,
    skus = null,
    limit = 200,
    hiddenOnly = false,
    refresh = false,
    proxy = null,
    hydrateAll = false,
  } = opts;

  const t0 = Date.now();
  const jar = createJar();
  const dispatcher = makeDispatcher(proxy);
  const ctx = { dispatcher, jar };
  const TIME_BUDGET_MS = 45_000;
  const outOfBudget = () => Date.now() - t0 > TIME_BUDGET_MS;

  try {
    // ---- SKU-targeted fast path: skip full sweep. ------------------------
    if (Array.isArray(skus) && skus.length > 0) {
      cache.endpointHits = {};
      const results = [];
      const seenHandles = new Set();
      for (const raw of skus) {
        const sku = String(raw).trim();
        if (!sku) continue;
        const handles = await searchSuggest(sku, ctx);
        // Also try direct /products/{sku}.json in case handle == sku.
        const guess = sku.toLowerCase();
        if (!handles.includes(guess)) handles.push(guess);
        for (const h of handles) {
          if (seenHandles.has(h)) continue;
          seenHandles.add(h);
          const norm = await hydrate(h, ctx);
          if (!norm?.hydrated) continue;
          const hit = (norm.variants ?? []).some(
            (v) => v.sku && String(v.sku).toLowerCase() === sku.toLowerCase(),
          );
          if (hit) {
            norm.matchedSku = sku;
            results.push(norm);
            break; // one handle per SKU
          }
        }
        if (outOfBudget()) break;
      }
      return {
        ok: true,
        elapsedMs: Date.now() - t0,
        cached: false,
        mode: "sku",
        stats: {
          sitemapCount: 0,
          productsJsonCount: 0,
          hiddenCount: results.length,
          candidatesConsidered: skus.length,
          hydratedThisCall: seenHandles.size,
          returned: results.length,
          endpointHits: cache.endpointHits,
          sweptAt: Date.now(),
        },
        products: results,
      };
    }

    // ---- Standard sweep path --------------------------------------------
    const fresh = refresh || Date.now() - cache.sweptAt > CACHE_TTL_MS;
    if (fresh) {
      cache.endpointHits = {};
      cache.hydrated.clear();
      // Cap products.json sweep at 60 pages (~15k products) to stay in budget.
      const [sitemap, pj] = await Promise.all([
        sweepSitemap(ctx),
        sweepProductsJson(ctx, 60),
      ]);
      cache.sitemapHandles = sitemap;
      cache.productsJsonHandles = pj.handles;
      for (const p of pj.products) {
        const h = String(p.handle).toLowerCase();
        cache.hydrated.set(h, { ...normaliseProduct(p, h, "products.json"), hydrated: true });
      }
      cache.sweptAt = Date.now();
    }

    const allHandles = new Set([...cache.sitemapHandles, ...cache.productsJsonHandles]);
    const hiddenHandles = new Set([...cache.sitemapHandles].filter((h) => !cache.productsJsonHandles.has(h)));

    let candidates = [...(hiddenOnly ? hiddenHandles : allHandles)];

    const preFiltered = [];
    const needsHydration = [];
    for (const h of candidates) {
      const known = cache.hydrated.get(h);
      if (known && known.hydrated) {
        if (matchesQuery(known, query)) preFiltered.push(known);
      } else {
        needsHydration.push(h);
      }
    }

    let toHydrate;
    if (hydrateAll || (query && hiddenOnly)) toHydrate = needsHydration;
    else if (query) toHydrate = needsHydration;
    else toHydrate = needsHydration.slice(0, Math.max(0, limit - preFiltered.length));
    // Hard cap so we never blow the request budget.
    toHydrate = toHydrate.slice(0, 400);

    const hydratedResults = await withLimit(toHydrate, 8, (h) => hydrate(h, ctx));
    const hydratedMatches = hydratedResults
      .filter((p) => p && p.hydrated)
      .filter((p) => matchesQuery(p, query));

    let products = [...preFiltered, ...hydratedMatches];
    for (const p of products) p.hidden = hiddenHandles.has(String(p.handle).toLowerCase());
    products.sort((a, b) => {
      if (a.hidden !== b.hidden) return a.hidden ? -1 : 1;
      const ta = a.publishedAt ? Date.parse(a.publishedAt) : 0;
      const tb = b.publishedAt ? Date.parse(b.publishedAt) : 0;
      return tb - ta;
    });
    if (products.length > limit) products = products.slice(0, limit);

    return {
      ok: true,
      elapsedMs: Date.now() - t0,
      cached: !fresh,
      mode: "sweep",
      stats: {
        sitemapCount: cache.sitemapHandles.size,
        productsJsonCount: cache.productsJsonHandles.size,
        hiddenCount: hiddenHandles.size,
        candidatesConsidered: candidates.length,
        hydratedThisCall: toHydrate.length,
        returned: products.length,
        endpointHits: cache.endpointHits,
        sweptAt: cache.sweptAt,
      },
      products,
    };
  } finally {
    try { await dispatcher?.close?.(); } catch { /* ignore */ }
  }
}
