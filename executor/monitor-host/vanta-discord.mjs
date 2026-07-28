/**
 * Vanta operator Discord payloads (Railway monitor).
 * Uses only fields already on the search card — no extra HTTP.
 *
 * Restock embeds include a Discord LINK button → http://127.0.0.1:17865/quicktask
 * which the J1m's Bot desktop app listens on while open (Quick Task from presets).
 */

const VANTA_COLOR = 0x000000; // black — restock / main brand
const VANTA_OOS_COLOR = 0xdc2626; // red — out of stock
const VANTA_NAME = "Vanta";

/** Must match desktop/deep-link.cjs BRIDGE_PORT — Discord → local Electron Quick Task. */
export const QUICKTASK_BRIDGE_PORT = 17865;

/**
 * Public HTTPS base for Discord LINK buttons.
 * Discord rejects/strips localhost button URLs on many webhooks — /qt on the
 * monitor host serves a tiny page that bounces to 127.0.0.1:17865.
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
  // Prefer requested SKU when catalog fallback used a different row.
  if (opts.sku && String(opts.sku).trim()) {
    params.set("sku", String(opts.sku).trim());
  }
  let qs = params.toString();
  if (`http://127.0.0.1:${QUICKTASK_BRIDGE_PORT}/quicktask?${qs}`.length > 480) {
    const slim = new URLSearchParams();
    const sku = params.get("sku");
    if (sku) slim.set("sku", sku);
    if (nai) slim.set("nai", String(nai));
    slim.set("area", area);
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
 * Discord LINK button URL — HTTPS public /qt (test + live restock pings).
 * Desktop must be open; /qt bounces the browser to localhost.
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

function quickTaskComponents(hit, area) {
  const qtUrl = buildQuickTaskBridgeUrl(hit, { area });
  const productId = String(hit?.productId || "?").trim() || "?";
  const pdp = `https://p-bandai.com/${area}/item/${productId}`;
  return [
    {
      type: 1,
      components: [
        {
          type: 2,
          style: 5,
          label: "⚡ Quick Task",
          url: qtUrl,
        },
        {
          type: 2,
          style: 5,
          label: "Open PDP",
          url: pdp,
        },
      ],
    },
  ];
}

function baseFields(hit, area, productId, { includeQuickTaskLink = false } = {}) {
  const nai = hit?.areaItemNo || hit?.meta?.areaItemNo || null;
  const price = pickPrice(hit);
  const productType = hit?.meta?.productType || hit?.productType || null;
  const pdp = `https://p-bandai.com/${area}/item/${productId}`;
  const qtUrl = includeQuickTaskLink ? buildQuickTaskBridgeUrl(hit, { area }) : null;
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
      ...(qtUrl
        ? [
            {
              name: "Desktop",
              value: `[⚡ Quick Task](${qtUrl}) — needs J1m's Bot open on this PC`,
              inline: false,
            },
          ]
        : []),
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
  const { pdp, fields } = baseFields(hit, area, productId, { includeQuickTaskLink: true });

  const reasonLabel =
    reason === "new in stock" ? "New in stock" : reason === "restock" ? "Restock" : reason;

  return {
    username: VANTA_NAME,
    embeds: [
      {
        author: {
          name: isTest ? `${VANTA_NAME} · test restock` : `${VANTA_NAME} · Restock`,
        },
        title: title.slice(0, 250),
        url: pdp,
        description: `**${reasonLabel}** · Premium Bandai AU`,
        color: VANTA_COLOR,
        fields,
        ...(image
          ? {
              thumbnail: { url: image },
              image: { url: image },
            }
          : {}),
        footer: {
          text: isTest
            ? "Vanta monitor · test restock · Quick Task needs desktop open"
            : "Vanta · restock · Quick Task needs desktop open",
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
  const { pdp, fields } = baseFields(hit, area, productId, { includeQuickTaskLink: false });

  return {
    username: VANTA_NAME,
    embeds: [
      {
        author: {
          name: isTest ? `${VANTA_NAME} · test OOS` : `${VANTA_NAME} · OUT OF STOCK`,
        },
        title: `OOS · ${title}`.slice(0, 250),
        url: pdp,
        description: "**OUT OF STOCK** — no longer purchaseable on Premium Bandai AU",
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
  };
}

export { VANTA_NAME, VANTA_COLOR, VANTA_OOS_COLOR, pickTitle, pickImage, pickPrice };
