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

/**
 * Query string shared by public /qt bounce and local desktop bridge.
 */
export function buildQuickTaskQuery(hit, opts = {}) {
  const area = String(opts.area || "au").toLowerCase();
  const productId = String(hit?.productId || hit?.sku || "").trim();
  const params = new URLSearchParams();
  if (productId) params.set("sku", productId);
  const title = pickTitle(hit);
  if (title) params.set("title", String(title).slice(0, 120));
  const nai = hit?.areaItemNo || hit?.meta?.areaItemNo || null;
  if (nai) params.set("nai", String(nai));
  params.set("area", area);
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
    if (sku) slim.set("sku", sku);
    if (nai) slim.set("nai", String(nai));
    slim.set("area", area);
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

function restockActionLinks(hit, area) {
  const qtUrl = buildQuickTaskBridgeUrl(hit, { area });
  const createUrl = buildQuickTaskBridgeUrl(hit, { area, start: false });
  const setupUrl = buildQuickTaskSetupUrl();
  const ebayUrl = buildEbaySoldUrl(hit);
  return { qtUrl, createUrl, setupUrl, ebayUrl };
}

function quickTaskComponents(hit, area) {
  const { qtUrl, createUrl, setupUrl, ebayUrl } = restockActionLinks(hit, area);
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

function baseFields(hit, area, productId) {
  const nai = hit?.areaItemNo || hit?.meta?.areaItemNo || null;
  const price = pickPrice(hit);
  const productType = hit?.meta?.productType || hit?.productType || null;
  const pdp = `https://p-bandai.com/${area}/item/${productId}`;
  return {
    pdp,
    fields: [
      { name: "SKU", value: `\`${productId}\``, inline: true },
      ...(nai ? [{ name: "Backend PID", value: `\`${nai}\``, inline: true }] : []),
      ...(price ? [{ name: "Price", value: price, inline: true }] : []),
      ...(productType ? [{ name: "Type", value: String(productType), inline: true }] : []),
      { name: "Region", value: area.toUpperCase(), inline: true },
      {
        name: "PDP",
        value: `[Open on Premium Bandai](${pdp})`,
        inline: false,
      },
    ],
  };
}

/**
 * @param {object} hit
 * @param {{ area?: string, test?: boolean, source?: string }} [opts]
 */
export function vantaRestockDiscordBody(hit, opts = {}) {
  const area = String(opts.area || "au").toLowerCase();
  const productId = String(hit?.productId || "?").trim() || "?";
  const title = pickTitle(hit) || productId;
  const reason = String(hit?.reason || "restock").replace(/_/g, " ");
  const image = pickImage(hit);
  const isTest = opts.test === true;
  const { pdp, fields } = baseFields(hit, area, productId);

  const reasonLabel =
    reason === "new in stock" ? "New in stock" : reason === "restock" ? "Restock" : reason;
  const { qtUrl, createUrl, setupUrl, ebayUrl } = restockActionLinks(hit, area);

  // One QT mention in description (not duplicated in fields). Buttons mirror the same links.
  const description = [
    `**${reasonLabel}** · Premium Bandai AU`,
    "",
    `[⚡ Quick Task](${qtUrl}) · [Create only](${createUrl}) · [Setup presets](${setupUrl}) · [eBay sold](${ebayUrl})`,
  ].join("\n");

  return {
    username: VANTA_NAME,
    embeds: [
      {
        author: {
          name: isTest ? `${VANTA_NAME} · test restock` : `${VANTA_NAME} · Restock`,
        },
        title: title.slice(0, 250),
        url: pdp,
        description,
        color: VANTA_COLOR,
        fields,
        ...(image
          ? {
              thumbnail: { url: image },
              image: { url: image },
            }
          : {}),
        footer: {
          text: isTest ? "Vanta monitor · test restock" : "Vanta · restock",
        },
        timestamp: hit?.at || hit?.timestamp
          ? new Date(hit.at || hit.timestamp).toISOString()
          : new Date().toISOString(),
      },
    ],
    components: quickTaskComponents(hit, area),
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
  const { pdp, fields } = baseFields(hit, area, productId);
  const ebayUrl = buildEbaySoldUrl(hit);

  return {
    username: VANTA_NAME,
    embeds: [
      {
        author: {
          name: isTest ? `${VANTA_NAME} · test OOS` : `${VANTA_NAME} · OUT OF STOCK`,
        },
        title: `OOS · ${title}`.slice(0, 250),
        url: pdp,
        description: [
          "**OUT OF STOCK** — no longer purchaseable on Premium Bandai AU",
          "",
          `[eBay sold](${ebayUrl})`,
        ].join("\n"),
        color: VANTA_OOS_COLOR,
        fields: [{ name: "Status", value: "`OOS`", inline: true }, ...fields],
        ...(image ? { thumbnail: { url: image } } : {}),
        footer: {
          text: isTest ? "Vanta monitor · test OOS" : "Vanta · out of stock alert",
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
 * Pokémon Centre PDP URL from catalog hit (no Bandai QT / Setup links).
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

/**
 * PKC restock / preload ping — plain embed (no Bandai Quick Task).
 * @param {object} hit
 * @param {{ locale?: string, test?: boolean, preload?: boolean }} [opts]
 */
export function vantaPkcDiscordBody(hit, opts = {}) {
  const locale = String(opts.locale || hit?.locale || "en-au").toLowerCase();
  const productId = String(hit?.productId || hit?.sku || "?").trim() || "?";
  const title = pickTitle(hit) || productId;
  const reason = String(hit?.reason || "restock").replace(/_/g, " ");
  const image = (() => {
    const direct = hit?.imageUrl || hit?.meta?.imageUrl || hit?.thumbnailUrl;
    if (!direct) return null;
    const s = String(direct);
    return s.startsWith("http") ? s : `${PC_ORIGIN}${s.startsWith("/") ? "" : "/"}${s}`;
  })();
  const isTest = opts.test === true;
  const isPreload =
    opts.preload === true ||
    hit?.preorder === true ||
    /preorder|preload/i.test(String(hit?.reason || "")) ||
    /PRE[_-]?ORDER/i.test(String(hit?.availability || hit?.meta?.availability || ""));
  const pdp = pcPdpUrl(hit, locale);
  const avail = hit?.availability || hit?.meta?.availability || null;
  const price = pickPrice(hit);

  const reasonLabel = isPreload
    ? "Preorder / preload"
    : reason === "new in stock"
      ? "New in stock"
      : reason === "restock"
        ? "Restock"
        : reason;

  return {
    username: VANTA_NAME,
    embeds: [
      {
        author: {
          name: isTest
            ? `${VANTA_NAME} · test PKC ${isPreload ? "preload" : "stock"}`
            : `${VANTA_NAME} · PKC ${isPreload ? "preload" : "stock"}`,
        },
        title: (isPreload ? `PKC preorder / preload · ${title}` : `PKC stock · ${title}`).slice(
          0,
          250,
        ),
        url: pdp,
        description: [
          `**${reasonLabel}** · Pokémon Centre ${locale.toUpperCase()}`,
          "",
          `[Open PDP](${pdp})`,
        ].join("\n"),
        color: isPreload ? VANTA_PKC_PRELOAD_COLOR : VANTA_COLOR,
        fields: [
          { name: "SKU", value: `\`${productId}\``, inline: true },
          { name: "Locale", value: locale, inline: true },
          ...(avail ? [{ name: "Availability", value: String(avail), inline: true }] : []),
          ...(price ? [{ name: "Price", value: String(price), inline: true }] : []),
          { name: "Store", value: "Pokémon Centre", inline: true },
        ],
        ...(image ? { thumbnail: { url: image } } : {}),
        footer: {
          text: isTest
            ? `Vanta PKC · test ${isPreload ? "preload" : "stock"}`
            : `Vanta · PKC ${isPreload ? "preorder / preload" : "stock"}`,
        },
        timestamp: hit?.at || hit?.timestamp
          ? new Date(hit.at || hit.timestamp).toISOString()
          : new Date().toISOString(),
      },
    ],
    components: [
      {
        type: 1,
        components: [{ type: 2, style: 5, label: "Open PDP", url: pdp.slice(0, 512) }],
      },
    ],
  };
}

/**
 * PKC went OOS — red accent (no Bandai QT).
 * @param {object} hit
 * @param {{ locale?: string, test?: boolean }} [opts]
 */
export function vantaPkcOosDiscordBody(hit, opts = {}) {
  const locale = String(opts.locale || hit?.locale || "en-au").toLowerCase();
  const productId = String(hit?.productId || hit?.sku || "?").trim() || "?";
  const title = pickTitle(hit) || productId;
  const image = (() => {
    const direct = hit?.imageUrl || hit?.meta?.imageUrl || hit?.thumbnailUrl;
    if (!direct) return null;
    const s = String(direct);
    return s.startsWith("http") ? s : `${PC_ORIGIN}${s.startsWith("/") ? "" : "/"}${s}`;
  })();
  const isTest = opts.test === true;
  const pdp = pcPdpUrl(hit, locale);

  return {
    username: VANTA_NAME,
    embeds: [
      {
        author: {
          name: isTest ? `${VANTA_NAME} · test PKC OOS` : `${VANTA_NAME} · PKC OUT OF STOCK`,
        },
        title: `OOS · ${title}`.slice(0, 250),
        url: pdp,
        description: [
          "**OUT OF STOCK** — no longer purchaseable on Pokémon Centre",
          "",
          `[Open PDP](${pdp})`,
        ].join("\n"),
        color: VANTA_OOS_COLOR,
        fields: [
          { name: "Status", value: "`OOS`", inline: true },
          { name: "SKU", value: `\`${productId}\``, inline: true },
          { name: "Locale", value: locale, inline: true },
        ],
        ...(image ? { thumbnail: { url: image } } : {}),
        footer: {
          text: isTest ? "Vanta PKC · test OOS" : "Vanta · PKC out of stock",
        },
        timestamp: hit?.at || hit?.timestamp
          ? new Date(hit.at || hit.timestamp).toISOString()
          : new Date().toISOString(),
      },
    ],
    components: [
      {
        type: 1,
        components: [{ type: 2, style: 5, label: "Open PDP", url: pdp.slice(0, 512) }],
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
  VANTA_CHECKOUT_COLOR,
  pickTitle,
  pickImage,
  pickPrice,
};
