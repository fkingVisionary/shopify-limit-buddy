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
    const createUrl = buildQuickTaskDeepLink(qtHit, { start: false });
    const setupUrl = buildQuickTaskSetupDeepLink();
    const ebayUrl = buildEbaySoldUrl(qtHit);
    description = [
      `**${reasonLabel}** detected on Premium Bandai AU`,
      "",
      `[⚡ Quick Task](${qtUrl}) · [Create only](${createUrl}) · [Setup presets](${setupUrl}) · [eBay sold](${ebayUrl})`,
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

const DEFAULT_EMBED_FIELDS = Object.freeze({
  product: true,
  store: true,
  price: true,
  profile: true,
  order: true,
  mode: true,
  payment: true,
  source: true,
  email: true,
  proxy: true,
});

function normalizeEmbedFields(raw) {
  const out = { ...DEFAULT_EMBED_FIELDS };
  if (!raw || typeof raw !== "object") return out;
  for (const key of Object.keys(DEFAULT_EMBED_FIELDS)) {
    if (Object.prototype.hasOwnProperty.call(raw, key)) {
      out[key] = raw[key] !== false;
    }
  }
  return out;
}

function storeDisplayName(sid) {
  const s = String(sid || "").toLowerCase();
  if (s === "bandai") return "Premium Bandai";
  if (s === "toymate") return "Toymate AU";
  if (s === "kmart") return "Kmart AU";
  if (s === "disney") return "Disney Store AU";
  return String(sid || "Store");
}

function field(name, value) {
  const v = value == null ? "" : String(value).trim();
  if (!v) return null;
  return { name, value: v.slice(0, 1024), inline: false };
}

function proxyHostOnly(raw) {
  const s = String(raw || "").trim();
  if (!s) return null;
  try {
    if (/^https?:\/\//i.test(s)) {
      return new URL(s).host || null;
    }
  } catch {
    /* fall through */
  }
  const host = s.split(":")[0];
  return host || null;
}

/**
 * Personal checkout / decline / 3DS embeds (Cybersole-style stacked fields).
 * Never includes failedStep / debugError dumps.
 */
function checkoutResultDiscordPayload(result, opts = {}) {
  const kind = opts.kind || classifyCheckoutDiscordKind(result);
  const fieldsOpt = normalizeEmbedFields(opts.embedFields || opts.fields);
  const store = storeDisplayName(opts.store || result?.store || "checkout");
  const product =
    String(opts.label || result?.taskLabel || result?.title || result?.productCode || "task").slice(
      0,
      200,
    );
  const qty = Math.max(1, Number(opts.qty || result?.qty || 1) || 1);
  const image =
    result?.imageUrl && String(result.imageUrl).startsWith("http")
      ? String(result.imageUrl)
      : opts.imageUrl && String(opts.imageUrl).startsWith("http")
        ? String(opts.imageUrl)
        : null;

  const mode = String(
    opts.mode ||
      result?.bandaiCheckoutMode ||
      result?.bandaiMode ||
      result?.mode ||
      "Checkout",
  ).slice(0, 60);
  const source = String(opts.source || result?.source || result?.trigger || "Desktop").slice(0, 80);
  const profile = String(opts.profileName || result?.profileName || "").slice(0, 80);
  const email = String(result?.account?.email || result?.resolvedAccountEmail || "").slice(0, 120);
  const order = result?.orderNumber ? String(result.orderNumber) : "";
  const price =
    result?.price != null
      ? String(result.price)
      : opts.price != null
        ? String(opts.price)
        : "";
  const proxy = proxyHostOnly(opts.proxy || result?.proxyHost || result?.proxy);
  const consumer = String(result?.consumerLabel || result?.error || "").slice(0, 200);

  let title = `${store} checkout failed`;
  let color = 0xe74c3c;
  let description = fieldsOpt.product ? `${qty}x ${product}` : undefined;

  if (kind === "success") {
    title = "Successfully checked out!";
    color = 0x22c55e;
  } else if (kind === "threeds") {
    title = "Waiting for bank approval";
    color = 0xf1c40f;
  } else if (kind === "fail" && isHardDecline(result)) {
    title = "Your card was declined!";
    color = 0xef4444;
  } else if (kind === "fail") {
    title = "Checkout failed";
    color = 0xe74c3c;
  }

  const fields = [];
  const push = (name, value, enabled = true) => {
    if (!enabled) return;
    const f = field(name, value);
    if (f) fields.push(f);
  };

  push("Store", store, fieldsOpt.store);
  push("Price", price, fieldsOpt.price);
  if (kind === "success") {
    push("Profile", profile, fieldsOpt.profile);
    push("Order", order, fieldsOpt.order);
  } else if (kind === "fail" && isHardDecline(result)) {
    push("Profile", profile, fieldsOpt.profile);
  } else if (kind === "fail" && consumer) {
    // Consumer label only — never debugError / failedStep.
    push("Status", consumer, true);
  }
  push("Mode", mode, fieldsOpt.mode);
  push("Payment", "Card", fieldsOpt.payment);
  push("Source", source, fieldsOpt.source);
  push("Email", email, fieldsOpt.email);
  push("Proxy", proxy, fieldsOpt.proxy);

  return {
    username: "Vanta",
    embeds: [
      {
        title,
        description,
        color,
        fields,
        ...(image ? { thumbnail: { url: image } } : {}),
        footer: { text: "Vanta" },
        timestamp: new Date(result?.at || Date.now()).toISOString(),
      },
    ],
  };
}

/** Misc / Smart Action notify — blue Cybersole-style. */
function miscDiscordPayload({ title, description, fields = [], imageUrl } = {}) {
  return {
    username: "Vanta",
    embeds: [
      {
        title: String(title || "Update").slice(0, 250),
        description: description ? String(description).slice(0, 500) : undefined,
        color: 0x3b82f6,
        fields: (Array.isArray(fields) ? fields : [])
          .map((f) => field(f.name, f.value))
          .filter(Boolean)
          .slice(0, 20),
        ...(imageUrl && String(imageUrl).startsWith("http")
          ? { thumbnail: { url: String(imageUrl) } }
          : {}),
        footer: { text: "Vanta" },
        timestamp: new Date().toISOString(),
      },
    ],
  };
}

/**
 * Sanitized body for monitor POST /checkout-win (public feed).
 */
function publicCheckoutWinReport(result, opts = {}) {
  const sku =
    String(opts.sku || result?.productCode || result?.sku || "").trim() ||
    String(opts.pdpUrl || result?.pdpUrl || "").match(
      /\b(N\d{7,}[A-Za-z0-9]*|A\d{7,}[A-Za-z0-9]*)\b/i,
    )?.[1] ||
    "";
  return {
    store: String(opts.store || result?.store || "").slice(0, 40),
    title: String(opts.label || result?.taskLabel || result?.title || sku || "Checkout").slice(
      0,
      200,
    ),
    sku,
    pdpUrl: String(opts.pdpUrl || result?.pdpUrl || "").slice(0, 400),
    mode: String(opts.mode || result?.bandaiCheckoutMode || result?.bandaiMode || "Checkout").slice(
      0,
      60,
    ),
    payment: "Card",
    price: result?.price != null ? String(result.price) : opts.price != null ? String(opts.price) : null,
    imageUrl: result?.imageUrl || opts.imageUrl || null,
    areaItemNo: result?.areaItemNo || opts.areaItemNo || null,
    area: opts.area || "au",
    at: new Date(result?.at || Date.now()).toISOString(),
  };
}

/**
 * Route checkout / monitor pings to the right user webhook.
 * Falls back: specific → success/checkout → legacy keys.
 *
 * @param {object} settings
 * @param {"success"|"fail"|"threeds"|"monitor"} kind
 */
function resolveDiscordWebhookUrl(settings, kind) {
  const s = settings || {};
  const success =
    String(s.discordSuccessWebhook || "").trim() ||
    String(s.discordCheckoutWebhook || "").trim() ||
    String(s.discordWebhookUrl || "").trim() ||
    String(s.discordMonitorWebhook || "").trim();
  const fail = String(s.discordFailWebhook || "").trim();
  const threeds = String(s.discord3dsWebhook || "").trim();
  const monitor = String(s.discordMonitorWebhook || "").trim() || success;

  if (kind === "success") return success || null;
  if (kind === "threeds") return threeds || fail || success || null;
  if (kind === "fail") return fail || success || null;
  if (kind === "monitor") return monitor || null;
  return success || null;
}

/**
 * Classify a finished job for webhook routing.
 * @returns {"success"|"fail"|"threeds"|"skip"}
 */
function classifyCheckoutDiscordKind(result) {
  if (!result) return "skip";
  if (result.accountGen || result.loginCheck) return "skip";
  if (result.monitor === true && !result.checkout) return "skip";
  // Confirmed order only counts as personal Success.
  if (Boolean(result.ok) && result.orderNumber) return "success";
  if (Boolean(result.ok)) return "skip";
  if (looksLike3ds(result)) return "threeds";
  return "fail";
}

function isHardDecline(result) {
  if (!result || result.ok) return false;
  const blob = [
    result.paymentStatus,
    result.consumerCode,
    result.consumerLabel,
    result.error,
    result.checkoutStage,
  ]
    .filter(Boolean)
    .join("\n");
  return /declin|do.?not.?honor|insufficient funds|auth_failed|chargeAuthReject/i.test(blob);
}

function looksLike3ds(result) {
  if (!result || result.ok) return false;
  const stage = String(result.checkoutStage || result.failedStep || "");
  const status = String(result.paymentStatus || result.consumerCode || "");
  const label = String(result.consumerLabel || result.error || "");
  const blob = `${stage} ${status} ${label}`;
  if (/threeds|3ds|acs|waiting for bank|bank approval/i.test(blob)) return true;
  const ps = result.paymentSummary || {};
  if (ps.charge3dsId || ps.acsOk === true) return true;
  if (ps.oneTimeToken && /threeds|3ds|acs/i.test(String(ps.processStatus || ""))) return true;
  return false;
}

module.exports = {
  postDiscordWebhook,
  bandaiRestockDiscordPayload,
  checkoutResultDiscordPayload,
  miscDiscordPayload,
  publicCheckoutWinReport,
  resolveDiscordWebhookUrl,
  classifyCheckoutDiscordKind,
  looksLike3ds,
  isHardDecline,
  normalizeEmbedFields,
  DEFAULT_EMBED_FIELDS,
};
