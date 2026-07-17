// Read-only Kmart PDP stock probe — HTML / __NEXT_DATA__ parse only.
// No ATC / GraphQL cart. Used by private desktop monitor and monitor/ service.

const { extractKeycodeFromUrl, normalizeKmartPdpUrl } = require("./keyword-parse.cjs");

/**
 * @typedef {{
 *   ok: boolean;
 *   inStock: boolean | null;
 *   title: string | null;
 *   sku: string | null;
 *   url: string;
 *   price: number | null;
 *   imageUrl?: string | null;
 *   sizes?: string[];
 *   blocked?: boolean;
 *   error?: string;
 *   status?: number;
 * }} StockProbeResult
 */

/**
 * Walk __NEXT_DATA__ / JSON blobs for product-ish fields.
 * @param {unknown} node
 * @param {{ title?: string; sku?: string; price?: number; inStock?: boolean; imageUrl?: string; sizes?: string[] }} acc
 * @param {number} depth
 */
function walkProductFields(node, acc, depth = 0) {
  if (!node || depth > 12) return;
  if (Array.isArray(node)) {
    for (const item of node) walkProductFields(item, acc, depth + 1);
    return;
  }
  if (typeof node !== "object") return;

  const o = /** @type {Record<string, unknown>} */ (node);

  const productish =
    (typeof o.sku === "string" && /^\d{6,9}$/.test(o.sku)) ||
    (typeof o.keyCode === "string" && /^\d{6,9}$/.test(o.keyCode)) ||
    (typeof o.keycode === "string" && /^\d{6,9}$/.test(o.keycode)) ||
    (typeof o.productName === "string" && o.productName.length > 4) ||
    (typeof o.__typename === "string" && /product/i.test(o.__typename));
  const chromeTitle = (t) =>
    !t ||
    t.length < 5 ||
    /^(footer|header|menu|nav|home|search|cart|login|account|kmart|shop|categories)$/i.test(t.trim());

  // Only take titles from product-shaped nodes — first `name:"footer"` poisoned the feed.
  if (productish) {
    if (!acc.title && typeof o.productName === "string" && !chromeTitle(o.productName)) acc.title = o.productName;
    if (!acc.title && typeof o.name === "string" && !chromeTitle(o.name)) acc.title = o.name;
    if (!acc.title && typeof o.title === "string" && !chromeTitle(o.title)) acc.title = o.title;
  }

  if (!acc.sku && typeof o.sku === "string" && /^\d{6,9}$/.test(o.sku)) acc.sku = o.sku;
  if (!acc.sku && typeof o.keyCode === "string" && /^\d{6,9}$/.test(o.keyCode)) acc.sku = o.keyCode;
  if (!acc.sku && typeof o.keycode === "string" && /^\d{6,9}$/.test(o.keycode)) acc.sku = o.keycode;

  if (!acc.imageUrl) {
    if (typeof o.imageUrl === "string" && /^https?:\/\//i.test(o.imageUrl)) acc.imageUrl = o.imageUrl;
    else if (typeof o.thumbnail === "string" && /^https?:\/\//i.test(o.thumbnail)) acc.imageUrl = o.thumbnail;
    else if (typeof o.url === "string" && /\.(jpg|jpeg|png|webp)/i.test(o.url) && /^https?:\/\//i.test(o.url)) {
      acc.imageUrl = o.url;
    } else if (o.image && typeof o.image === "object") {
      const img = /** @type {Record<string, unknown>} */ (o.image);
      if (typeof img.url === "string") acc.imageUrl = img.url;
    }
  }

  if (!acc.sizes) acc.sizes = [];
  if (Array.isArray(o.sizes)) {
    for (const s of o.sizes) {
      if (typeof s === "string" && s.trim()) acc.sizes.push(s.trim());
      else if (s && typeof s === "object" && typeof /** @type {any} */ (s).name === "string") {
        acc.sizes.push(String(/** @type {any} */ (s).name));
      }
    }
  }
  if (Array.isArray(o.attributes)) {
    for (const a of o.attributes) {
      if (!a || typeof a !== "object") continue;
      const attr = /** @type {Record<string, unknown>} */ (a);
      const n = String(attr.name || "").toLowerCase();
      if (/size|colour|color|variant/i.test(n) && typeof attr.value === "string") {
        acc.sizes.push(String(attr.value));
      }
    }
  }

  if (acc.price == null) {
    if (typeof o.price === "number") acc.price = o.price;
    else if (typeof o.centAmount === "number") acc.price = o.centAmount / 100;
    else if (o.price && typeof o.price === "object") {
      const p = /** @type {Record<string, unknown>} */ (o.price);
      if (typeof p.centAmount === "number") acc.price = p.centAmount / 100;
      if (typeof p.value === "number") acc.price = p.value;
    }
  }

  if (acc.inStock == null) {
    if (typeof o.inStock === "boolean") acc.inStock = o.inStock;
    if (typeof o.available === "boolean") acc.inStock = o.available;
    if (typeof o.isAvailable === "boolean") acc.inStock = o.isAvailable;
    if (typeof o.purchasable === "boolean") acc.inStock = o.purchasable;
    if (typeof o.availability === "string") {
      const a = o.availability.toLowerCase();
      if (/in.?stock|available|instock/.test(a)) acc.inStock = true;
      if (/out.?of.?stock|sold.?out|unavailable|oos/.test(a)) acc.inStock = false;
    }
    if (typeof o.stockStatus === "string") {
      const a = o.stockStatus.toLowerCase();
      if (/in.?stock|available/.test(a)) acc.inStock = true;
      if (/out|sold|unavailable/.test(a)) acc.inStock = false;
    }
  }

  for (const v of Object.values(o)) {
    if (v && typeof v === "object") walkProductFields(v, acc, depth + 1);
  }
}

/**
 * Infer stock from HTML heuristics when JSON fields are thin.
 * @param {string} html
 * @returns {boolean | null}
 */
function inferStockFromHtml(html) {
  const lower = html.toLowerCase();
  const oos =
    /out of stock|sold out|currently unavailable|not available online|this product is unavailable/.test(
      lower,
    );
  const ats =
    /add to (cart|bag|trolley)|buy now|add to trolley|data-testid=["'][^"']*add.?to.?cart/i.test(
      html,
    );
  if (oos && !ats) return false;
  if (ats && !oos) return true;
  if (oos && ats) return false;
  return null;
}

/**
 * @param {string} html
 * @param {string} url
 * @returns {StockProbeResult}
 */
function parseKmartPdpHtml(html, url) {
  const cleanUrl = normalizeKmartPdpUrl(url) || String(url || "").trim();
  const acc = /** @type {{ title?: string; sku?: string; price?: number; inStock?: boolean; imageUrl?: string; sizes?: string[] }} */ ({
    sizes: [],
  });
  const chromeTitle = (t) =>
    !t ||
    String(t).trim().length < 5 ||
    /^(footer|header|menu|nav|home|search|cart|login|account|kmart|shop|categories)$/i.test(String(t).trim());

  // Prefer document meta first — JSON walk used to grab name:"footer".
  const og = html.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i)
    || html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:title["']/i);
  if (og?.[1]) {
    const t = og[1].replace(/\s*[|\-–]\s*Kmart.*$/i, "").trim();
    if (!chromeTitle(t)) acc.title = t;
  }
  if (!acc.title) {
    const t = html.match(/<title[^>]*>([^<]+)<\/title>/i);
    if (t?.[1]) {
      const cleaned = t[1].replace(/\s*[|\-–]\s*Kmart.*$/i, "").trim();
      if (!chromeTitle(cleaned)) acc.title = cleaned;
    }
  }

  const nextBlock = html.match(
    /<script[^>]+id=["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/i,
  );
  if (nextBlock?.[1]) {
    try {
      walkProductFields(JSON.parse(nextBlock[1]), acc);
    } catch {
      /* ignore */
    }
  }

  // Fallback SKU from HTML / URL
  if (!acc.sku) {
    const m1 = /"sku"\s*:\s*"(\d{6,9})"/.exec(html);
    if (m1) acc.sku = m1[1];
  }
  if (!acc.sku) {
    acc.sku = extractKeycodeFromUrl(cleanUrl) || undefined;
  }
  if (acc.title && chromeTitle(acc.title)) acc.title = undefined;

  if (!acc.imageUrl) {
    const ogImg =
      html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i) ||
      html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i);
    if (ogImg?.[1]) acc.imageUrl = ogImg[1];
  }

  let inStock = acc.inStock ?? null;
  if (inStock == null) inStock = inferStockFromHtml(html);

  const blocked =
    /access denied|pardon our interruption|akamai|bot manager/i.test(html) ||
    (/access denied/i.test(String(acc.title || "")) && !/"sku"\s*:\s*"\d{6,9}"/.test(html));

  const sizes = [...new Set((acc.sizes || []).map((s) => String(s).trim()).filter(Boolean))].slice(0, 24);

  // Never treat Akamai interstitial as a successful product parse (URL keycode fallback alone is not enough).
  const hasRealProduct =
    Boolean(acc.title) &&
    !/access denied/i.test(acc.title) &&
    (Boolean(acc.sku) || /"sku"\s*:\s*"\d{6,9}"/.test(html) || /__NEXT_DATA__/i.test(html));

  return {
    ok: !blocked && hasRealProduct,
    inStock,
    title: blocked ? null : acc.title || null,
    sku: acc.sku || null,
    url: cleanUrl,
    price: acc.price ?? null,
    imageUrl: blocked ? null : acc.imageUrl || null,
    sizes: blocked ? [] : sizes,
    blocked: blocked || undefined,
    error: blocked ? "Akamai / Access Denied on PDP" : undefined,
  };
}

function collectCookies(res, jar) {
  const raw = res.headers.getSetCookie?.() || [];
  const single = res.headers.get("set-cookie");
  const list = raw.length ? raw : single ? [single] : [];
  for (const line of list) {
    const pair = String(line).split(";")[0];
    const eq = pair.indexOf("=");
    if (eq <= 0) continue;
    const name = pair.slice(0, eq).trim();
    const value = pair.slice(eq + 1).trim();
    if (name) jar.set(name, value);
  }
}

function cookieHeader(jar) {
  if (!jar.size) return undefined;
  return [...jar.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
}

function browserHeaders(extra = {}) {
  return {
    "user-agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
    "accept-language": "en-AU,en;q=0.9",
    "cache-control": "no-cache",
    pragma: "no-cache",
    "sec-ch-ua": '"Google Chrome";v="131", "Chromium";v="131", "Not_A Brand";v="24"',
    "sec-ch-ua-mobile": "?0",
    "sec-ch-ua-platform": '"Windows"',
    "sec-fetch-dest": "document",
    "sec-fetch-mode": "navigate",
    "sec-fetch-site": "none",
    "sec-fetch-user": "?1",
    "upgrade-insecure-requests": "1",
    ...extra,
  };
}

/**
 * Fetch PDP and parse stock. Uses undici + optional proxy.
 * When proxyUrl is set, warms www.kmart.com.au first (cookie jar) before PDP.
 * @param {{ url: string; proxyUrl?: string | null; timeoutMs?: number; headers?: Record<string, string>; warmHome?: boolean }} opts
 * @returns {Promise<StockProbeResult>}
 */
async function probeKmartPdp(opts) {
  const url = normalizeKmartPdpUrl(opts.url) || String(opts.url || "").trim();
  if (!url) {
    return {
      ok: false,
      inStock: null,
      title: null,
      sku: null,
      url: "",
      price: null,
      error: "Invalid Kmart PDP URL",
    };
  }

  const timeoutMs = Math.max(5000, Number(opts.timeoutMs) || 20_000);
  const warmHome = opts.warmHome !== false;
  const jar = new Map();

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    let doFetch = globalThis.fetch.bind(globalThis);
    /** @type {unknown} */
    let dispatcher;

    if (opts.proxyUrl) {
      try {
        const { ProxyAgent, fetch: undiciFetch } = require("undici");
        dispatcher = new ProxyAgent(String(opts.proxyUrl));
        doFetch = undiciFetch;
      } catch (e) {
        return {
          ok: false,
          inStock: null,
          title: null,
          sku: extractKeycodeFromUrl(url),
          url,
          price: null,
          error: e?.message || String(e),
        };
      }
    }

    async function get(target, headers) {
      /** @type {RequestInit & { dispatcher?: unknown }} */
      const init = {
        method: "GET",
        headers,
        redirect: "follow",
        signal: controller.signal,
      };
      if (dispatcher) init.dispatcher = dispatcher;
      return doFetch(target, init);
    }

    if (warmHome && opts.proxyUrl) {
      const homeRes = await get(
        "https://www.kmart.com.au/",
        browserHeaders({ ...(opts.headers || {}) }),
      );
      collectCookies(homeRes, jar);
      // Drain body
      await homeRes.text().catch(() => "");
      if (homeRes.status === 403 || homeRes.status === 401) {
        return {
          ok: false,
          inStock: null,
          title: null,
          sku: extractKeycodeFromUrl(url),
          url,
          price: null,
          status: homeRes.status,
          blocked: true,
          error: `home HTTP ${homeRes.status}`,
        };
      }
    }

    const cookie = cookieHeader(jar);
    const pdpHeaders = browserHeaders({
      "sec-fetch-site": warmHome && opts.proxyUrl ? "same-origin" : "none",
      referer: "https://www.kmart.com.au/",
      ...(cookie ? { cookie } : {}),
      ...(opts.headers || {}),
    });

    const res = await get(url, pdpHeaders);
    collectCookies(res, jar);
    const status = res.status;
    const html = await res.text();

    if (status === 403 || status === 401) {
      return {
        ok: false,
        inStock: null,
        title: null,
        sku: extractKeycodeFromUrl(url),
        url,
        price: null,
        status,
        blocked: true,
        error: `HTTP ${status}`,
      };
    }

    // Soft block: 200 HTML that is only Akamai interstitial
    if (/access denied|pardon our interruption/i.test(html) && !/"sku"\s*:\s*"\d{6,9}"/.test(html)) {
      return {
        ok: false,
        inStock: null,
        title: null,
        sku: extractKeycodeFromUrl(url),
        url,
        price: null,
        status,
        blocked: true,
        error: "Akamai interstitial",
      };
    }

    const parsed = parseKmartPdpHtml(html, String(res.url || url));
    parsed.status = status;
    return parsed;
  } catch (e) {
    return {
      ok: false,
      inStock: null,
      title: null,
      sku: extractKeycodeFromUrl(url),
      url,
      price: null,
      error: e?.name === "AbortError" ? "timeout" : e?.message || String(e),
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Lightweight Constructor/search discovery scrape (best-effort).
 * @param {{ query: string; proxyUrl?: string | null; timeoutMs?: number }} opts
 */
async function searchKmartProducts(opts) {
  const q = String(opts.query || "").trim();
  if (!q) return { ok: false, products: [], error: "empty query" };

  const url = `https://www.kmart.com.au/search/?searchTerm=${encodeURIComponent(q)}`;
  const probe = await probeKmartPdp({
    url,
    proxyUrl: opts.proxyUrl,
    timeoutMs: opts.timeoutMs,
  });

  // Re-fetch raw for link extraction — probe already fetched; do a dedicated fetch.
  const timeoutMs = Math.max(3000, Number(opts.timeoutMs) || 15_000);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    /** @type {RequestInit & { dispatcher?: unknown }} */
    const init = {
      method: "GET",
      headers: {
        "user-agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
        accept: "text/html",
        "accept-language": "en-AU,en;q=0.9",
      },
      redirect: "follow",
      signal: controller.signal,
    };
    if (opts.proxyUrl) {
      try {
        const { ProxyAgent, fetch: undiciFetch } = require("undici");
        init.dispatcher = new ProxyAgent(opts.proxyUrl);
        const res = await undiciFetch(url, init);
        const html = await res.text();
        return { ok: true, products: extractSearchProducts(html), blocked: probe.blocked };
      } catch (e) {
        return { ok: false, products: [], error: e?.message || String(e) };
      }
    }
    const res = await fetch(url, init);
    const html = await res.text();
    return { ok: true, products: extractSearchProducts(html), blocked: /access denied/i.test(html) };
  } catch (e) {
    return { ok: false, products: [], error: e?.message || String(e) };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * @param {string} html
 * @returns {{ title: string; url: string; sku: string }[]}
 */
function extractSearchProducts(html) {
  /** @type {Map<string, { title: string; url: string; sku: string }>} */
  const map = new Map();
  const re =
    /href=["'](https?:\/\/(?:www\.)?kmart\.com\.au\/product\/[^"']+-(\d{6,9})\/?)["']/gi;
  let m;
  while ((m = re.exec(html))) {
    const sku = m[2];
    const productUrl = normalizeKmartPdpUrl(m[1]) || m[1];
    if (!map.has(sku)) {
      map.set(sku, { title: `Product ${sku}`, url: productUrl, sku });
    }
  }

  // Try to attach titles from nearby text / JSON
  const titleSku =
    /"name"\s*:\s*"([^"]{3,120})"[\s\S]{0,200}"sku"\s*:\s*"(\d{6,9})"/gi;
  while ((m = titleSku.exec(html))) {
    const title = m[1];
    const sku = m[2];
    const prev = map.get(sku);
    if (prev) prev.title = title;
    else {
      map.set(sku, {
        title,
        url: `https://www.kmart.com.au/product/item-${sku}/`,
        sku,
      });
    }
  }

  return [...map.values()].slice(0, 40);
}

module.exports = {
  parseKmartPdpHtml,
  probeKmartPdp,
  searchKmartProducts,
  extractSearchProducts,
  inferStockFromHtml,
};
