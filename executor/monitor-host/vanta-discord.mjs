/**
 * Vanta operator restock Discord payload (shared shape for Railway monitor).
 * Uses only fields already on the search card — no extra HTTP.
 */

const VANTA_COLOR = 0x7c3aed; // violet accent
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

/**
 * @param {object} hit
 * @param {{ area?: string, test?: boolean, source?: string }} [opts]
 */
export function vantaRestockDiscordBody(hit, opts = {}) {
  const area = String(opts.area || "au").toLowerCase();
  const productId = String(hit?.productId || "?").trim() || "?";
  const title = pickTitle(hit) || productId;
  const reason = String(hit?.reason || "restock").replace(/_/g, " ");
  const pdp = `https://p-bandai.com/${area}/item/${productId}`;
  const nai = hit?.areaItemNo || hit?.meta?.areaItemNo || null;
  const image = pickImage(hit);
  const price = pickPrice(hit);
  const productType = hit?.meta?.productType || hit?.productType || null;
  const isTest = opts.test === true;

  const reasonLabel =
    reason === "new in stock" ? "New in stock" : reason === "restock" ? "Restock" : reason;

  const fields = [
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
  ];

  return {
    username: VANTA_NAME,
    // Discord ignores custom avatar_url unless webhook allows; fine if omitted.
    embeds: [
      {
        author: {
          name: isTest ? `${VANTA_NAME} · test ping` : `${VANTA_NAME} · Bandai AU`,
        },
        title: title.slice(0, 250),
        url: pdp,
        description: `**${reasonLabel}** detected on Premium Bandai AU`,
        color: VANTA_COLOR,
        fields,
        ...(image
          ? {
              thumbnail: { url: image },
              image: { url: image },
            }
          : {}),
        footer: {
          text: isTest ? "Vanta monitor · test event" : "Vanta global stock monitor",
        },
        timestamp: hit?.at || hit?.timestamp
          ? new Date(hit.at || hit.timestamp).toISOString()
          : new Date().toISOString(),
      },
    ],
  };
}

export { VANTA_NAME, VANTA_COLOR, pickTitle, pickImage, pickPrice };
