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
    content: body.content != null ? String(body.content).slice(0, 1900) : undefined,
    embeds: Array.isArray(body.embeds) ? body.embeds.slice(0, 10) : undefined,
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
  const productId = String(hit?.productId || "").trim() || "?";
  const area = String(opts.area || "au").toLowerCase();
  const title = String(hit?.title || productId).slice(0, 200);
  const reason = String(hit?.reason || "restock");
  const nai = hit?.areaItemNo || null;
  const url = `https://p-bandai.com/${area}/item/${productId}`;
  return {
    content: null,
    embeds: [
      {
        title: `Bandai ${reason}: ${productId}`,
        description: title,
        url,
        color: 0x2ecc71,
        fields: [
          { name: "SKU", value: productId, inline: true },
          ...(nai ? [{ name: "NAI", value: String(nai), inline: true }] : []),
          { name: "Source", value: String(opts.source || "monitor"), inline: true },
        ],
        timestamp: hit?.at || new Date().toISOString(),
      },
    ],
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
