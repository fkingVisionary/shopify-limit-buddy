// Discord incoming webhook helper (no deps). Used by Desktop + monitor host patterns.

/**
 * @param {string} webhookUrl
 * @param {{ content?: string, embeds?: object[] }} body
 */
async function postDiscordWebhook(webhookUrl, body) {
  const url = String(webhookUrl || "").trim();
  if (!url || !/^https:\/\/(discord\.com|discordapp\.com)\/api\/webhooks\//i.test(url)) {
    return { ok: false, skipped: true, error: "invalid_or_missing_webhook" };
  }
  const payload = {
    username: body.username != null ? String(body.username).slice(0, 80) : undefined,
    content: body.content != null ? String(body.content).slice(0, 1900) : undefined,
    embeds: Array.isArray(body.embeds) ? body.embeds.slice(0, 10) : undefined,
    components: Array.isArray(body.components) ? body.components.slice(0, 5) : undefined,
  };
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      return { ok: false, status: res.status, error: text.slice(0, 200) || `http_${res.status}` };
    }
    return { ok: true, status: res.status };
  } catch (e) {
    return { ok: false, error: e?.message || String(e) };
  }
}

/**
 * Build a restock embed for Bandai monitor hits (operator Railway channel only).
 * @param {object} hit
 * @param {{ area?: string, source?: string }} [opts]
 */
function bandaiRestockDiscordPayload(hit, opts = {}) {
  // Keep CJS helper aligned with Vanta Railway embeds (operator channel).
  const productId = String(hit?.productId || "").trim() || "?";
  const area = String(opts.area || "au").toLowerCase();
  const title = String(hit?.title || hit?.meta?.title || productId).slice(0, 250);
  const reason = String(hit?.reason || "restock").replace(/_/g, " ");
  const nai = hit?.areaItemNo || hit?.meta?.areaItemNo || null;
  const pdp = `https://p-bandai.com/${area}/item/${productId}`;
  let image = hit?.imageUrl || hit?.meta?.imageUrl || null;
  if (image && !String(image).startsWith("http")) {
    image = `https://p-bandai.com/${String(image).replace(/^\//, "")}`;
  }
  const price = hit?.price || hit?.meta?.price || null;
  const productType = hit?.meta?.productType || hit?.productType || null;
  const reasonLabel =
    reason === "new in stock" ? "New in stock" : reason === "restock" ? "Restock" : reason;

  let components;
  let description = `**${reasonLabel}** detected on Premium Bandai AU`;
  try {
    const {
      buildQuickTaskDeepLink,
      buildQuickTaskSetupDeepLink,
      buildEbaySoldUrl,
      quickTaskDiscordComponents,
    } = require("./deep-link.cjs");
    const qtHit = {
      productId,
      title,
      areaItemNo: nai,
      area,
      reason: hit?.reason || "restock",
      pdpUrl: pdp,
    };
    components = quickTaskDiscordComponents(qtHit, { area });
    const qtUrl = buildQuickTaskDeepLink(qtHit);
    const setupUrl = buildQuickTaskSetupDeepLink();
    const ebayUrl = buildEbaySoldUrl(qtHit);
    description = [
      `**${reasonLabel}** detected on Premium Bandai AU`,
      "",
      `[⚡ Quick Task](${qtUrl}) · [Setup presets](${setupUrl}) · [eBay sold](${ebayUrl})`,
    ].join("\n");
  } catch {
    components = undefined;
  }

  return {
    username: "Vanta",
    embeds: [
      {
        author: { name: opts.test ? "Vanta · test ping" : "Vanta · Bandai AU" },
        title,
        url: pdp,
        description,
        color: 0x7c3aed,
        fields: [
          { name: "SKU", value: `\`${productId}\``, inline: true },
          ...(nai ? [{ name: "Backend PID", value: `\`${nai}\``, inline: true }] : []),
          ...(price ? [{ name: "Price", value: String(price), inline: true }] : []),
          ...(productType ? [{ name: "Type", value: String(productType), inline: true }] : []),
          { name: "Region", value: area.toUpperCase(), inline: true },
          { name: "PDP", value: `[Open on Premium Bandai](${pdp})` },
        ],
        ...(image ? { thumbnail: { url: image }, image: { url: image } } : {}),
        footer: {
          text: opts.test ? "Vanta monitor · test event" : "Vanta global stock monitor",
        },
        timestamp: hit?.at || new Date().toISOString(),
      },
    ],
    ...(components ? { components } : {}),
  };
}

/**
 * Per-user checkout success / fail ping (never used for global restock feed).
 * @param {object} result — finished job result
 * @param {{ store?: string, label?: string }} [opts]
 */
function checkoutResultDiscordPayload(result, opts = {}) {
  const ok = Boolean(result?.ok);
  const store = String(opts.store || result?.store || "checkout");
  const label = String(opts.label || result?.taskLabel || result?.taskId || "task").slice(0, 120);
  const stage = result?.checkoutStage || result?.failedStep || (ok ? "complete" : "failed");
  const err = String(result?.consumerLabel || result?.error || result?.debugError || "").slice(0, 300);
  const order = result?.orderNumber || null;
  const email = result?.account?.email || result?.resolvedAccountEmail || null;
  return {
    embeds: [
      {
        title: ok ? `${store} checkout OK` : `${store} checkout failed`,
        description: label,
        color: ok ? 0x2ecc71 : 0xe74c3c,
        fields: [
          { name: "Stage", value: String(stage), inline: true },
          ...(order ? [{ name: "Order", value: String(order), inline: true }] : []),
          ...(email ? [{ name: "Account", value: String(email), inline: true }] : []),
          ...(!ok && err ? [{ name: "Detail", value: err }] : []),
        ],
        timestamp: new Date(result?.at || Date.now()).toISOString(),
      },
    ],
  };
}

module.exports = {
  postDiscordWebhook,
  bandaiRestockDiscordPayload,
  checkoutResultDiscordPayload,
};
