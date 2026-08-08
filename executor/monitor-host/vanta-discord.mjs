/**
 * Vanta operator Discord payloads (Railway monitor).
 * Uses only fields already on the search card — no extra HTTP.
 *
 * Restock embeds: one Quick Task link (+ Setup presets / eBay sold).
 * HTTPS /qt and /qt-setup bounce to the local Electron bridge.
 */

const VANTA_COLOR = 0x000000; // black — restock / main brand
const VANTA_OOS_COLOR = 0xdc2626; // red — out of stock
const VANTA_PKC_PRELOAD_COLOR = 0x2563eb; // blue — preorder / preload
const VANTA_PKC_SOFT_LIST_COLOR = 0xd97706; // amber — soft-listed hours ahead (not buyable yet)
const VANTA_NAME = "Vanta";
const PC_ORIGIN = "https://www.pokemoncenter.com";

/** Must match desktop/deep-link.cjs BRIDGE_PORT — Discord → local Electron. */
export const QUICKTASK_BRIDGE_PORT = 17865;

/**
 * Public HTTPS base for Discord LINK buttons / markdown links.
 */
export function quickTaskPublicBase() {
  const fromEnv =
    process.env.QUICKTASK_PUBLIC_BASE ||
    (process.env.RAILWAY_PUBLIC_DOMAIN
      ? `https://${String(process.env.RAILWAY_PUBLIC_DOMAIN).replace(/^https?:\/\//, "")}`
      : "");
  return String(
    fromEnv || "https://j1ms-bandai-monitor-production.up.railway.app",
  ).replace(/\/+$/, "");
}

function pickTitle(hit) {
  const t = hit?.title || hit?.meta?.title || hit?.productName;
  if (typeof t === "string" && t.trim()) return t.trim();
  if (t && typeof t === "object") return t.en || t.fr || Object.values(t)[0] || null;
  return null;
}

function pickImage(hit) {
  const direct = hit?.imageUrl || hit?.meta?.imageUrl || hit?.thumbnailUrl;
  if (direct) {
    const s = String(direct);
    return s.startsWith("http") ? s : `https://p-bandai.com/${s.replace(/^\//, "")}`;
  }
  const imgs = hit?.meta?.productImages || hit?.productImages;
  const file = Array.isArray(imgs) ? imgs.find((i) => i?.fileUrl)?.fileUrl : null;
  if (!file) return null;
  const s = String(file);
  return s.startsWith("http") ? s : `https://p-bandai.com/${s.replace(/^\//, "")}`;
}

function pickPrice(hit) {
  if (hit?.price || hit?.meta?.price) return String(hit.price || hit.meta.price);
  const fp = hit?.meta?.fixedListPrice || hit?.fixedListPrice;
  if (fp?.amount != null) {
    const cur = fp.currency || "AUD";
    const n = Number(fp.amount);
    return `${cur} ${n.toFixed(n % 1 ? 2 : 0)}`;
  }
  return null;
}

function normalizeQtStore(raw) {
  const s = String(raw || "")
    .trim()
    .toLowerCase();
  if (s === "pokemon" || s === "pokemoncenter" || s === "pkc") return "pokemoncentre";
  return s;
}

/**
 * Query string shared by public /qt bounce and local desktop bridge.
 * Bandai: sku / nai / area. PKC: store=pokemoncentre + sku + url (+ locale).
 */
export function buildQuickTaskQuery(hit, opts = {}) {
  const store = normalizeQtStore(opts.store || hit?.store);
  const area = String(opts.area || hit?.area || "au").toLowerCase();
  const locale = String(opts.locale || hit?.locale || "")
    .trim()
    .toLowerCase();
  const productId = String(hit?.productId || hit?.sku || opts.sku || "").trim();
  const params = new URLSearchParams();
  if (store) params.set("store", store);
  if (productId) params.set("sku", productId);
  const title = pickTitle(hit);
  if (title) params.set("title", String(title).slice(0, 120));
  const nai = hit?.areaItemNo || hit?.meta?.areaItemNo || null;
  if (nai) params.set("nai", String(nai));
  if (!store || store === "bandai") params.set("area", area);
  if (store === "pokemoncentre" && locale) params.set("locale", locale);
  const pdp = String(hit?.pdpUrl || hit?.url || opts.url || "").trim();
  if (pdp && /^https?:\/\//i.test(pdp)) params.set("url", pdp);
  if (hit?.reason) params.set("reason", String(hit.reason).slice(0, 40));
  if (opts.sku && String(opts.sku).trim()) {
    params.set("sku", String(opts.sku).trim());
  }
  if (opts.start === false || opts.start === 0 || opts.start === "0") {
    params.set("start", "0");
  }
  let qs = params.toString();
  if (`http://127.0.0.1:${QUICKTASK_BRIDGE_PORT}/quicktask?${qs}`.length > 480) {
    const slim = new URLSearchParams();
    const sku = params.get("sku");
    if (store) slim.set("store", store);
    if (sku) slim.set("sku", sku);
    if (nai) slim.set("nai", String(nai));
    if (!store || store === "bandai") slim.set("area", area);
    if (store === "pokemoncentre" && locale) slim.set("locale", locale);
    if (params.get("start") === "0") slim.set("start", "0");
    qs = slim.toString();
  }
  return qs;
}

/** Local desktop bridge URL (after /qt bounce). */
export function buildQuickTaskLocalUrl(hit, opts = {}) {
  const port = Number(opts.port) || QUICKTASK_BRIDGE_PORT;
  const qs = buildQuickTaskQuery(hit, opts);
  return `http://127.0.0.1:${port}/quicktask${qs ? `?${qs}` : ""}`;
}

/**
 * Discord Quick Task URL — HTTPS public /qt.
 */
export function buildQuickTaskBridgeUrl(hit, opts = {}) {
  const base = String(opts.publicBase || quickTaskPublicBase()).replace(/\/+$/, "");
  const qs = buildQuickTaskQuery(hit, opts);
  let url = `${base}/qt${qs ? `?${qs}` : ""}`;
  if (url.length > 512) {
    const slimHit = { ...hit, title: undefined, reason: undefined };
    const slimQs = buildQuickTaskQuery(slimHit, { ...opts, title: "" });
    url = `${base}/qt?${slimQs}`;
  }
  return url;
}

/** Opens Desktop → Settings → Quick Task preset (via /qt-setup bounce). */
export function buildQuickTaskSetupUrl(opts = {}) {
  const base = String(opts.publicBase || quickTaskPublicBase()).replace(/\/+$/, "");
  return `${base}/qt-setup`;
}

/**
 * eBay AU completed/sold listings search from product title (or SKU fallback).
 */
export function buildEbaySoldUrl(hit, opts = {}) {
  const title = pickTitle(hit);
  const sku = String(hit?.productId || hit?.sku || "").trim();
  let q = String(title || sku || "").trim();
  // Trim common Bandai noise for better sold comps
  q = q
    .replace(/\b(premium\s+bandai|p-bandai|bandai\s+spirits|tamashii)\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);
  if (!q) q = sku || "bandai";
  const site = String(opts.site || "ebay.com.au");
  const params = new URLSearchParams({
    _nkw: q,
    LH_Sold: "1",
    LH_Complete: "1",
    rt: "nc",
  });
  return `https://www.${site}/sch/i.html?${params.toString()}`;
}

function restockActionLinks(hit, opts = {}) {
  const area = String(opts.area || "au").toLowerCase();
  const store = normalizeQtStore(opts.store || hit?.store);
  const locale = opts.locale || hit?.locale;
  const qtOpts = { area, store: store || undefined, locale: locale || undefined };
  const qtUrl = buildQuickTaskBridgeUrl(hit, qtOpts);
  const createUrl = buildQuickTaskBridgeUrl(hit, { ...qtOpts, start: false });
  const setupUrl = buildQuickTaskSetupUrl();
  const ebayUrl = buildEbaySoldUrl(hit);
  return { qtUrl, createUrl, setupUrl, ebayUrl };
}

function quickTaskComponents(hit, opts = {}) {
  const area = typeof opts === "string" ? opts : opts.area;
  const linkOpts = typeof opts === "string" ? { area: opts } : opts || {};
  if (area && !linkOpts.area) linkOpts.area = area;
  const { qtUrl, createUrl, setupUrl, ebayUrl } = restockActionLinks(hit, linkOpts);
  // Discord: max 5 buttons/row. QT + Create only + Setup + eBay (PDP in fields).
  return [
    {
      type: 1,
      components: [
        { type: 2, style: 5, label: "⚡ Quick Task", url: qtUrl.slice(0, 512) },
        { type: 2, style: 5, label: "Create only", url: createUrl.slice(0, 512) },
        { type: 2, style: 5, label: "Setup presets", url: setupUrl.slice(0, 512) },
        { type: 2, style: 5, label: "eBay sold", url: ebayUrl.slice(0, 512) },
      ],
    },
  ];
}

/** Flux-style stock pill: green = buyable / listed live, red = not buyable. */
function stockEmoji(inStock) {
  return inStock ? "🟢" : "🔴";
}

function buildStockxSearchUrl(hit) {
  const title = pickTitle(hit);
  const sku = String(hit?.productId || hit?.sku || "").trim();
  const q = String(title || sku || "").trim().slice(0, 80);
  return `https://stockx.com/search?s=${encodeURIComponent(q || "pokemon")}`;
}

function buildSnkrDunkSearchUrl(hit) {
  const title = pickTitle(hit);
  const sku = String(hit?.productId || hit?.sku || "").trim();
  const q = String(title || sku || "").trim().slice(0, 80);
  return `https://snkrdunk.com/en/search?keyword=${encodeURIComponent(q || "pokemon")}`;
}

/**
 * Compact monitor fields (Flux / Zephyr style):
 * Price · Type · SKU · Stock · optional Cart Limit / Invite Only · Links
 */
function monitorCompactFields({
  productId,
  price,
  typeLabel,
  inStock,
  cartLimit,
  inviteOnly,
  linksMarkdown,
  extraInline,
}) {
  const fields = [
    { name: "Price", value: price ? String(price) : "N/A", inline: true },
    { name: "Type", value: String(typeLabel || "Restock"), inline: true },
    { name: "SKU", value: String(productId || "?"), inline: true },
    { name: "Stock", value: stockEmoji(inStock), inline: true },
  ];
  if (cartLimit != null && cartLimit !== "") {
    fields.push({ name: "Cart Limit", value: String(cartLimit), inline: true });
  }
  if (inviteOnly != null) {
    fields.push({ name: "Invite Only", value: inviteOnly ? "🟢" : "🔴", inline: true });
  }
  if (Array.isArray(extraInline)) {
    for (const f of extraInline) {
      if (f?.name && f?.value != null) fields.push({ ...f, inline: f.inline !== false });
    }
  }
  if (linksMarkdown) {
    fields.push({ name: "Links", value: String(linksMarkdown), inline: false });
  }
  return fields;
}

function bandaiTypeLabel(reason) {
  const r = String(reason || "restock").toLowerCase().replace(/_/g, " ");
  if (r === "new in stock") return "New Product";
  if (r === "went oos" || r === "oos") return "Out of Stock";
  if (r === "restock") return "Restock";
  return r.replace(/\b\w/g, (c) => c.toUpperCase());
}

/**
 * @param {object} hit
 * @param {{ area?: string, test?: boolean, source?: string }} [opts]
 */
export function vantaRestockDiscordBody(hit, opts = {}) {
  const area = String(opts.area || "au").toLowerCase();
  const productId = String(hit?.productId || "?").trim() || "?";
  const title = pickTitle(hit) || productId;
  const reason = String(hit?.reason || "restock");
  const image = pickImage(hit);
  const isTest = opts.test === true;
  const pdp = `https://p-bandai.com/${area}/item/${productId}`;
  const price = pickPrice(hit);
  const nai = hit?.areaItemNo || hit?.meta?.areaItemNo || null;
  const typeLabel = bandaiTypeLabel(reason);
  const { qtUrl, ebayUrl } = restockActionLinks(hit, { area, store: "bandai" });

  const fields = monitorCompactFields({
    productId,
    price,
    typeLabel,
    inStock: true,
    linksMarkdown: `[eBay](${ebayUrl}) · [⚡ Quick Task](${qtUrl})`,
    extraInline: nai ? [{ name: "Backend PID", value: String(nai), inline: true }] : [],
  });

  return {
    username: VANTA_NAME,
    embeds: [
      {
        author: {
          name: isTest ? `Premium Bandai AU · test` : "Premium Bandai AU",
        },
        title: title.slice(0, 250),
        url: pdp,
        color: VANTA_COLOR,
        fields,
        ...(image ? { thumbnail: { url: image } } : {}),
        footer: {
          text: isTest
            ? `Vanta · test · [Create only] · [Setup]`
            : `Vanta · ${typeLabel} · eBay · Quick Task`,
        },
        timestamp: hit?.at || hit?.timestamp
          ? new Date(hit.at || hit.timestamp).toISOString()
          : new Date().toISOString(),
      },
    ],
    components: quickTaskComponents(hit, { area, store: "bandai" }),
  };
}

/**
 * Went out of stock — red accent, clearly not a restock (no @role).
 * @param {object} hit
 * @param {{ area?: string, test?: boolean }} [opts]
 */
export function vantaOosDiscordBody(hit, opts = {}) {
  const area = String(opts.area || "au").toLowerCase();
  const productId = String(hit?.productId || "?").trim() || "?";
  const title = pickTitle(hit) || productId;
  const image = pickImage(hit);
  const isTest = opts.test === true;
  const pdp = `https://p-bandai.com/${area}/item/${productId}`;
  const price = pickPrice(hit);
  const ebayUrl = buildEbaySoldUrl(hit);
  const fields = monitorCompactFields({
    productId,
    price,
    typeLabel: "Out of Stock",
    inStock: false,
    linksMarkdown: `[eBay](${ebayUrl}) · [Open PDP](${pdp})`,
  });

  return {
    username: VANTA_NAME,
    embeds: [
      {
        author: {
          name: isTest ? "Premium Bandai AU · test" : "Premium Bandai AU",
        },
        title: title.slice(0, 250),
        url: pdp,
        color: VANTA_OOS_COLOR,
        fields,
        ...(image ? { thumbnail: { url: image } } : {}),
        footer: {
          text: isTest ? "Vanta monitor · test OOS" : "Vanta · out of stock",
        },
        timestamp: hit?.at || hit?.timestamp
          ? new Date(hit.at || hit.timestamp).toISOString()
          : new Date().toISOString(),
      },
    ],
    components: [
      {
        type: 1,
        components: [
          { type: 2, style: 5, label: "eBay sold", url: ebayUrl.slice(0, 512) },
          { type: 2, style: 5, label: "Open PDP", url: pdp.slice(0, 512) },
        ],
      },
    ],
  };
}

const VANTA_CHECKOUT_COLOR = 0x22c55e; // green — public checkout feed

/**
 * Pokémon Centre PDP URL from catalog hit.
 * @param {object} hit
 * @param {string} [locale]
 */
export function pcPdpUrl(hit, locale = "en-au") {
  const direct = hit?.pdpUrl || hit?.meta?.pdpUrl || hit?.url;
  if (direct && /^https?:\/\//i.test(String(direct))) return String(direct);
  const loc = String(locale || hit?.locale || "en-au")
    .trim()
    .toLowerCase()
    .replace(/_/g, "-");
  const sku = String(hit?.productId || hit?.sku || "").trim();
  if (!sku) return `${PC_ORIGIN}/${loc || "en-au"}`;
  const slug = String(hit?.slug || hit?.meta?.slug || "").trim().replace(/^\/+|\/+$/g, "");
  const base = `${PC_ORIGIN}/${loc || "en-au"}/product/${encodeURIComponent(sku)}`;
  return slug ? `${base}/${slug}` : base;
}

/** Same imagery shape as Bandai (absolute Pokémon Centre URLs). */
function pickPcImage(hit) {
  const direct = hit?.imageUrl || hit?.meta?.imageUrl || hit?.thumbnailUrl;
  if (direct) {
    const s = String(direct);
    if (s.startsWith("http")) return s;
    if (s.startsWith("//")) return `https:${s}`;
    return `${PC_ORIGIN}${s.startsWith("/") ? "" : "/"}${s}`;
  }
  const imgs = hit?.meta?.productImages || hit?.productImages || hit?.images;
  if (Array.isArray(imgs) && imgs.length) {
    const first = imgs[0];
    const url = typeof first === "string" ? first : first?.url || first?.fileUrl;
    if (url) {
      const s = String(url);
      if (s.startsWith("http")) return s;
      if (s.startsWith("//")) return `https:${s}`;
      return `${PC_ORIGIN}${s.startsWith("/") ? "" : "/"}${s}`;
    }
  }
  return null;
}

function pkcTypeLabel({ isSoftListed, isPreload, reason }) {
  if (isSoftListed) return "Potential Upcoming Restock";
  if (isPreload) return "Preorder";
  const r = String(reason || "").toLowerCase().replace(/_/g, " ");
  if (r === "new in stock") return "New Product";
  if (r === "restock") return "Restock";
  if (r === "went oos" || r === "oos") return "Out of Stock";
  return r ? r.replace(/\b\w/g, (c) => c.toUpperCase()) : "Restock";
}

function pkcRegionLabel(locale) {
  const loc = String(locale || "en-au").toLowerCase();
  if (loc === "en-au") return "Pokemon Center AU";
  if (loc === "en-nz") return "Pokemon Center NZ";
  if (loc === "en-us") return "Pokemon Center US";
  if (loc === "en-gb") return "Pokemon Center UK";
  if (loc === "en-ca") return "Pokemon Center CA";
  if (loc === "en-de" || loc === "de") return "Pokemon Center DE";
  return "Pokemon Center";
}

/**
 * PKC — Flux-style compact embed (Price / Type / SKU / Stock / Links).
 * soft_listed → Type "Potential Upcoming Restock" (hours-ahead soft load).
 * @param {object} hit
 * @param {{ locale?: string, test?: boolean, preload?: boolean, softListed?: boolean }} [opts]
 */
export function vantaPkcDiscordBody(hit, opts = {}) {
  const locale = String(opts.locale || hit?.locale || "en-au").toLowerCase();
  const productId = String(hit?.productId || hit?.sku || "?").trim() || "?";
  const title = pickTitle(hit) || productId;
  const reason = String(hit?.reason || "restock");
  const image = pickPcImage(hit);
  const isTest = opts.test === true;
  const isSoftListed =
    opts.softListed === true ||
    hit?.softListed === true ||
    /soft[_ ]?list/i.test(String(hit?.reason || ""));
  const isPreload =
    !isSoftListed &&
    (opts.preload === true ||
      hit?.preorder === true ||
      /preorder|preload/i.test(String(hit?.reason || "")) ||
      /PRE[_-]?ORDER/i.test(String(hit?.availability || hit?.meta?.availability || "")));
  const pdp = pcPdpUrl(hit, locale);
  const price = pickPrice(hit);
  const qtHit = {
    ...hit,
    productId,
    store: "pokemoncentre",
    locale,
    pdpUrl: pdp,
    title,
  };
  const { qtUrl, ebayUrl } = restockActionLinks(qtHit, {
    store: "pokemoncentre",
    locale,
  });
  const stockxUrl = buildStockxSearchUrl(hit);
  const snkrUrl = buildSnkrDunkSearchUrl(hit);
  const typeLabel = pkcTypeLabel({ isSoftListed, isPreload, reason });
  // Prefer explicit hit.inStock — soft_listed reason alone used to paint live PDPs 🔴.
  const inStock = isSoftListed
    ? false
    : hit?.inStock === false
      ? false
      : true;
  const cartLimit = hit?.cartLimit ?? hit?.quantityLimit ?? hit?.meta?.quantityLimit ?? null;
  const inviteOnly =
    hit?.inviteOnly != null
      ? Boolean(hit.inviteOnly)
      : hit?.meta?.inviteOnly != null
        ? Boolean(hit.meta.inviteOnly)
        : false;

  // Flux uses blue accent for soft + new product pings.
  const color = isSoftListed
    ? VANTA_PKC_PRELOAD_COLOR
    : isPreload
      ? VANTA_PKC_PRELOAD_COLOR
      : VANTA_COLOR;

  const fields = monitorCompactFields({
    productId,
    price,
    typeLabel,
    inStock,
    cartLimit: cartLimit != null ? cartLimit : undefined,
    inviteOnly,
    linksMarkdown: `[StockX](${stockxUrl}) · [SnkrDunk](${snkrUrl}) · [eBay](${ebayUrl}) · [⚡ Quick Task](${qtUrl})`,
  });

  return {
    username: VANTA_NAME,
    embeds: [
      {
        author: {
          name: isTest ? `${pkcRegionLabel(locale)} · test` : pkcRegionLabel(locale),
        },
        title: title.slice(0, 250),
        url: pdp,
        color,
        fields,
        ...(image ? { thumbnail: { url: image } } : {}),
        footer: {
          text: isTest
            ? `Vanta · test · [Create only] · [Setup]`
            : `Vanta · ${typeLabel} · eBay · Quick Task`,
        },
        timestamp: hit?.at || hit?.timestamp
          ? new Date(hit.at || hit.timestamp).toISOString()
          : new Date().toISOString(),
      },
    ],
    // Same QT stack as Bandai (PDP / StockX stay in Links field).
    components: quickTaskComponents(qtHit, { store: "pokemoncentre", locale }),
  };
}

/**
 * PKC OOS — same compact Flux field layout, red accent.
 * @param {object} hit
 * @param {{ locale?: string, test?: boolean }} [opts]
 */
export function vantaPkcOosDiscordBody(hit, opts = {}) {
  const locale = String(opts.locale || hit?.locale || "en-au").toLowerCase();
  const productId = String(hit?.productId || hit?.sku || "?").trim() || "?";
  const title = pickTitle(hit) || productId;
  const image = pickPcImage(hit);
  const isTest = opts.test === true;
  const pdp = pcPdpUrl(hit, locale);
  const price = pickPrice(hit);
  const ebayUrl = buildEbaySoldUrl(hit);
  const stockxUrl = buildStockxSearchUrl(hit);
  const snkrUrl = buildSnkrDunkSearchUrl(hit);
  const fields = monitorCompactFields({
    productId,
    price,
    typeLabel: "Out of Stock",
    inStock: false,
    inviteOnly: false,
    linksMarkdown: `[StockX](${stockxUrl})`,
  });

  return {
    username: VANTA_NAME,
    embeds: [
      {
        author: {
          name: isTest ? `${pkcRegionLabel(locale)} · test` : pkcRegionLabel(locale),
        },
        title: title.slice(0, 250),
        url: pdp,
        color: VANTA_OOS_COLOR,
        fields,
        ...(image ? { thumbnail: { url: image } } : {}),
        footer: {
          text: `SnkrDunk | Ebay | Vanta${isTest ? " · test" : ""}`,
        },
        timestamp: hit?.at || hit?.timestamp
          ? new Date(hit.at || hit.timestamp).toISOString()
          : new Date().toISOString(),
      },
    ],
    components: [
      {
        type: 1,
        components: [
          { type: 2, style: 5, label: "Open PDP", url: pdp.slice(0, 512) },
          { type: 2, style: 5, label: "StockX", url: stockxUrl.slice(0, 512) },
          { type: 2, style: 5, label: "eBay", url: ebayUrl.slice(0, 512) },
          { type: 2, style: 5, label: "SnkrDunk", url: snkrUrl.slice(0, 512) },
        ],
      },
    ],
  };
}

/**
 * Public checkout feed — no profile / email / order / proxy / address.
 * Posted by monitor-host after Desktop reports a win (server holds the webhook).
 */
export function vantaPublicCheckoutDiscordBody(win, opts = {}) {
  const store = String(win?.store || "store").trim() || "store";
  const title = String(win?.title || win?.sku || "Checkout").slice(0, 250);
  const sku = String(win?.sku || "").trim();
  const pdp = String(win?.pdpUrl || "").trim();
  const mode = String(win?.mode || "").trim();
  const payment = String(win?.payment || "Card").trim() || "Card";
  const price = win?.price != null && String(win.price).trim() ? String(win.price) : null;
  const image = win?.imageUrl && String(win.imageUrl).startsWith("http") ? String(win.imageUrl) : null;
  const isTest = opts.test === true;

  let qtLine = "";
  if (sku && /^N\d|^A\d/i.test(sku)) {
    const qtHit = {
      productId: sku,
      title,
      areaItemNo: win?.areaItemNo || null,
      area: win?.area || "au",
      pdpUrl: pdp || undefined,
    };
    const qtUrl = buildQuickTaskBridgeUrl(qtHit, { area: win?.area || "au" });
    const setupUrl = buildQuickTaskSetupUrl();
    qtLine = `[⚡ Quick Task](${qtUrl}) · [Setup presets](${setupUrl})`;
  }

  const fields = [
    { name: "Store", value: storeDisplay(store), inline: true },
    ...(sku ? [{ name: "SKU", value: `\`${sku}\``, inline: true }] : []),
    ...(price ? [{ name: "Price", value: price, inline: true }] : []),
    ...(mode ? [{ name: "Mode", value: mode, inline: true }] : []),
    { name: "Payment", value: payment, inline: true },
    ...(pdp ? [{ name: "Query", value: `[Open product](${pdp})` }] : []),
  ];

  return {
    username: VANTA_NAME,
    embeds: [
      {
        author: {
          name: isTest ? `${VANTA_NAME} · test checkout feed` : `${VANTA_NAME} · Public Checkout Feed`,
        },
        title,
        url: pdp || undefined,
        description: qtLine || undefined,
        color: VANTA_CHECKOUT_COLOR,
        fields,
        ...(image ? { thumbnail: { url: image } } : {}),
        footer: {
          text: isTest ? "Vanta · test public checkout" : "Vanta Public Checkout Feed",
        },
        timestamp: win?.at ? new Date(win.at).toISOString() : new Date().toISOString(),
      },
    ],
  };
}

function storeDisplay(sid) {
  const s = String(sid || "").toLowerCase();
  if (s === "bandai") return "Premium Bandai";
  if (s === "toymate") return "Toymate AU";
  if (s === "kmart") return "Kmart AU";
  if (s === "disney") return "Disney Store AU";
  if (s === "pokemoncentre" || s === "pkc" || s === "pokemon-centre") {
    return "Pokémon Centre AU";
  }
  return String(sid || "Store");
}

export {
  VANTA_NAME,
  VANTA_COLOR,
  VANTA_OOS_COLOR,
  VANTA_PKC_PRELOAD_COLOR,
  VANTA_PKC_SOFT_LIST_COLOR,
  VANTA_CHECKOUT_COLOR,
  pickTitle,
  pickImage,
  pickPrice,
};
