/**
 * Vanta operator Discord payloads (Railway monitor).
 * Uses only fields already on the search card — no extra HTTP.
 */

const VANTA_COLOR = 0x000000; // black — restock / main brand
const VANTA_OOS_COLOR = 0xdc2626; // red — out of stock (obviously not a restock)
const VANTA_NAME = "Vanta";

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
          text: isTest ? "Vanta monitor · test restock" : "Vanta · restock alert",
        },
        timestamp: hit?.at || hit?.timestamp
          ? new Date(hit.at || hit.timestamp).toISOString()
          : new Date().toISOString(),
      },
    ],
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
