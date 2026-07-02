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

async function fetchJson(url, ctx) {
  const t0 = Date.now();
  try {
    const res = await request(url, { method: "GET", headers: { referer: HOST + "/", accept: "application/json,*/*" } }, ctx);
    const body = await res.text();
    let json = null;
    try { json = JSON.parse(body); } catch { /* not json */ }
    return { url, status: res.status, ok: res.ok, elapsedMs: Date.now() - t0, bytes: body.length, body, json };
  } catch (e) {
    return { url, status: 0, ok: false, elapsedMs: Date.now() - t0, bytes: 0, body: "", json: null, error: e?.message ?? String(e) };
  }
}

async function fetchText(url, ctx) {
  const t0 = Date.now();
  try {
    const res = await request(url, { method: "GET", headers: { referer: HOST + "/", accept: "text/html,*/*" } }, ctx);
    const body = await res.text();
    return { url, status: res.status, ok: res.ok, elapsedMs: Date.now() - t0, bytes: body.length, body };
  } catch (e) {
    return { url, status: 0, ok: false, elapsedMs: Date.now() - t0, bytes: 0, body: "", error: e?.message ?? String(e) };
  }
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
      url: `${HOST}/search/suggest.json?q=${q}&resources[type]=product,collection,page,article&resources[limit]=10&resources[options][unavailable_products]=last&resources[options][fields]=title,product_type,variants.sku,vendor,tag,handle`,
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
      url: `${HOST}/search?q=${q}&section_id=predictive-search`,
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
    const bySku = [];
    const allHandles = new Set();

    for (const sku of list) {
      const eps = endpointsFor(sku);
      const results = await Promise.all(
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
      );
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
