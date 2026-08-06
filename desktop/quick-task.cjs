// Quick Task helpers — build Bandai (v1) task rows from preset + SKU/URL/monitor hit.
// Pure (no Electron / no network). Main process persists + enqueues.

const {
  parseBandaiStoreSelection,
  normalizeBandaiAreaCode,
} = require("./bandai-regions.cjs");

const DEFAULT_PRESET = {
  store: "bandai",
  bandaiArea: "au",
  bandaiMode: "checkout",
  bandaiCheckoutMode: "fast",
  paymentMethod: "credit_card",
  profileSource: "single",
  profileId: null,
  profileGroup: null,
  profileIds: [],
  proxyGroupId: null,
  qty: 1,
  quantity: 1,
  placeOrder: true,
  accountAssign: "auto",
  accountId: null,
  startAfterCreate: true,
};

function normalizeProfileIdList(raw) {
  const fromArr = Array.isArray(raw?.profileIds)
    ? raw.profileIds.map((id) => String(id || "").trim()).filter(Boolean)
    : [];
  return [...new Set(fromArr)].slice(0, 200);
}

/**
 * Normalize settings.quickTaskPreset with defaults.
 * @param {object} [raw]
 */
function normalizeQuickTaskPreset(raw = {}) {
  const parsed = parseBandaiStoreSelection(
    raw.store || DEFAULT_PRESET.store,
    raw.bandaiArea || DEFAULT_PRESET.bandaiArea,
  );
  const store = parsed.store || "bandai";
  const bandaiArea =
    store === "bandai"
      ? normalizeBandaiAreaCode(parsed.bandaiArea || raw.bandaiArea) || "au"
      : undefined;
  const modeRaw = String(raw.bandaiMode || "").toLowerCase();
  // Raffle / Chance applyDraw removed — map legacy tasks to checkout.
  const bandaiMode = ["checkout", "atc", "monitor", "account_gen"].includes(
    modeRaw === "chance" ? "checkout" : modeRaw,
  )
    ? modeRaw === "chance"
      ? "checkout"
      : modeRaw
    : "checkout";
  const payRaw = String(raw.paymentMethod || "credit_card").toLowerCase();
  const paymentMethod =
    payRaw === "paypal_guest" || payRaw === "paypal_manual" ? payRaw : "credit_card";
  const profileIds = normalizeProfileIdList(raw);
  const profileGroup = String(raw.profileGroup || "").trim().slice(0, 80) || null;
  const profileId = raw.profileId || profileIds[0] || null;
  let profileSource = String(raw.profileSource || "").toLowerCase();
  if (!["single", "group", "multi"].includes(profileSource)) {
    if (profileGroup) profileSource = "group";
    else if (profileIds.length > 1) profileSource = "multi";
    else profileSource = "single";
  }
  return {
    store,
    bandaiArea,
    bandaiMode,
    bandaiCheckoutMode: (() => {
      const m = String(raw.bandaiCheckoutMode || "").toLowerCase();
      if (m === "test" || m === "fast_test") return "autocheckout_test";
      if (["fast", "fast_undici", "safe", "autocheckout_test"].includes(m)) return m;
      return "fast";
    })(),
    paymentMethod,
    profileSource,
    profileId: profileSource === "single" ? profileId : profileId || null,
    profileGroup: profileSource === "group" ? profileGroup : null,
    profileIds: profileSource === "multi" ? profileIds : [],
    proxyGroupId: raw.proxyGroupId || null,
    qty: Math.max(1, Math.min(20, Number(raw.qty) || 1)),
    quantity: Math.max(1, Math.min(50, Number(raw.quantity) || 1)),
    placeOrder: raw.placeOrder !== false,
    accountAssign: ["auto", "manual"].includes(String(raw.accountAssign || "").toLowerCase())
      ? String(raw.accountAssign).toLowerCase()
      : "auto",
    accountId: raw.accountId || null,
    startAfterCreate: raw.startAfterCreate !== false,
  };
}

/**
 * Resolve preset profile selection into concrete profile slots.
 * @param {object} preset
 * @param {Array<{ id: string, name?: string, email?: string, profileGroup?: string }>} profiles
 * @returns {Array<{ profileId: string, name: string }>}
 */
function resolveQuickTaskProfiles(preset, profiles = []) {
  const p = normalizeQuickTaskPreset(preset);
  const list = Array.isArray(profiles) ? profiles : [];
  const byId = new Map(list.map((row) => [row.id, row]));

  if (p.profileSource === "group") {
    const key = String(p.profileGroup || "")
      .trim()
      .toLowerCase();
    if (!key) return [];
    return list
      .filter((row) => String(row.profileGroup || "").trim().toLowerCase() === key)
      .map((row) => ({
        profileId: row.id,
        name: row.name || row.email || row.id,
      }));
  }

  if (p.profileSource === "multi") {
    const ids = p.profileIds.length ? p.profileIds : p.profileId ? [p.profileId] : [];
    return ids
      .map((id) => {
        const row = byId.get(id);
        if (!row) return null;
        return { profileId: id, name: row.name || row.email || id };
      })
      .filter(Boolean);
  }

  if (!p.profileId) return [];
  const row = byId.get(p.profileId);
  return [
    {
      profileId: p.profileId,
      name: row?.name || row?.email || p.profileId,
    },
  ];
}

/**
 * Parse a pasted SKU, NAI…, or Bandai PDP URL into product target fields.
 * @param {string} input
 * @param {{ area?: string }} [opts]
 */
function parseBandaiProductInput(input, opts = {}) {
  const area = String(opts.area || "au").toLowerCase();
  const raw = String(input || "").trim();
  if (!raw) return { ok: false, error: "Paste a Bandai SKU or PDP URL" };

  const urlMatch = raw.match(/p-bandai\.com\/([a-z]{2})\/item\/([A-Za-z0-9_-]+)/i);
  if (urlMatch) {
    const region = urlMatch[1].toLowerCase();
    const productId = urlMatch[2];
    return {
      ok: true,
      productId,
      pdpUrl: `https://p-bandai.com/${region}/item/${productId}`,
      area: region,
      areaItemNo: /^NAI/i.test(productId) ? productId : null,
    };
  }

  const itemPath = raw.match(/\/item\/([A-Za-z0-9_-]+)/i);
  if (itemPath) {
    const productId = itemPath[1];
    return {
      ok: true,
      productId,
      pdpUrl: `https://p-bandai.com/${area}/item/${productId}`,
      area,
      areaItemNo: /^NAI/i.test(productId) ? productId : null,
    };
  }

  const code = raw.match(/\b(N\d{7,}[A-Z0-9]*|A\d{7,}[A-Z0-9]*|NAI[A-Z0-9]+)\b/i);
  if (code) {
    const productId = code[1].toUpperCase();
    const isNai = /^NAI/i.test(productId);
    return {
      ok: true,
      productId,
      pdpUrl: isNai ? "" : `https://p-bandai.com/${area}/item/${productId}`,
      area,
      areaItemNo: isNai ? productId : null,
      inputOnly: isNai,
    };
  }

  // Bare alphanumeric fallback (user pasted a code we don't recognize pattern for)
  if (/^[A-Za-z0-9_-]{4,40}$/.test(raw) && !/\s/.test(raw)) {
    const productId = raw.toUpperCase();
    return {
      ok: true,
      productId,
      pdpUrl: `https://p-bandai.com/${area}/item/${productId}`,
      area,
      areaItemNo: null,
    };
  }

  return { ok: false, error: "Could not parse Bandai SKU or URL" };
}

/**
 * Build product target from a monitor feed hit.
 * @param {object} hit
 * @param {{ area?: string }} [opts]
 */
function targetFromMonitorHit(hit, opts = {}) {
  const area = String(opts.area || "au").toLowerCase();
  const productId = String(hit?.productId || hit?.productCode || "").trim();
  if (!productId) return { ok: false, error: "Hit missing productId" };
  const areaItemNo = hit?.areaItemNo || hit?.meta?.areaItemNo || null;
  return {
    ok: true,
    productId,
    pdpUrl: `https://p-bandai.com/${area}/item/${productId}`,
    area,
    areaItemNo: areaItemNo || (/^NAI/i.test(productId) ? productId : null),
    title: hit?.title || hit?.productName || hit?.meta?.title || null,
    reason: hit?.reason || null,
  };
}

/**
 * Build a task draft for upsert from preset + product target.
 * @param {object} preset
 * @param {object} target — from parseBandaiProductInput / targetFromMonitorHit
 * @param {{ label?: string, id?: string }} [extra]
 */
function buildQuickTaskDraft(preset, target, extra = {}) {
  const p = normalizeQuickTaskPreset(preset);
  if (!target?.ok && target?.productId == null) {
    return { ok: false, error: target?.error || "missing product target" };
  }
  const productId = target.productId;
  const mode = p.bandaiMode;
  const { resolveTaskLabel } = require("./task-label.cjs");
  const area = normalizeBandaiAreaCode(target.area || p.bandaiArea) || "au";
  const draft = {
    id: extra.id || undefined,
    store: p.store,
    bandaiArea: p.store === "bandai" ? area : undefined,
    label: resolveTaskLabel({
      store: p.store,
      label: extra.label || "",
      title: target.title || "",
      productName: target.title || "",
      bandaiWatchSku: productId,
      productId,
      bandaiMode: mode,
      pdpUrl: target.pdpUrl || "",
      bandaiAreaItemNo: target.areaItemNo || "",
    }),
    pdpUrl: target.pdpUrl || (productId && !/^NAI/i.test(productId)
      ? `https://p-bandai.com/${area}/item/${productId}`
      : ""),
    qty: p.qty,
    quantity: p.quantity,
    profileId: p.profileId,
    proxyGroupId: p.proxyGroupId,
    placeOrder: p.placeOrder,
    enabled: true,
    bandaiMode: mode,
    bandaiCheckoutMode: p.bandaiCheckoutMode,
    paymentMethod: p.store === "bandai" ? p.paymentMethod : undefined,
    accountAssign: p.accountAssign,
    accountId: p.accountAssign === "manual" ? p.accountId : null,
  };
  if (target.areaItemNo) {
    draft.bandaiAreaItemNo = String(target.areaItemNo);
  }
  if (mode === "monitor") {
    draft.bandaiMonitorMode = "global";
    draft.bandaiWatchSku = productId;
    draft.bandaiCheckoutOnHit = true;
  } else if (!draft.pdpUrl && productId) {
    // NAI-only: still set input via pdpUrl empty + areaItemNo; upsert uses pdpUrl.
    draft.pdpUrl = `https://p-bandai.com/${target.area || "au"}/item/${productId}`;
  }
  return { ok: true, task: draft, startAfterCreate: p.startAfterCreate };
}

/**
 * Event context shape shared by Monitor Feed → QT / Smart Actions.
 * @param {object} hit
 * @param {{ store?: string, area?: string }} [opts]
 */
function contextFromMonitorHit(hit, opts = {}) {
  const area = String(opts.area || "au").toLowerCase();
  const productId = String(hit?.productId || "").trim();
  const title = hit?.title || hit?.productName || hit?.meta?.title || productId;
  const taskGroup = String(hit?.taskGroup || hit?.group || title || productId)
    .trim()
    .slice(0, 80);
  const inStock =
    hit?.inStock != null
      ? Boolean(hit.inStock)
      : hit?.meta?.inStock != null
        ? Boolean(hit.meta.inStock)
        : null;
  return {
    store: opts.store || "bandai",
    title,
    sku: productId,
    productId,
    taskGroup,
    group: taskGroup,
    url: productId ? `https://p-bandai.com/${area}/item/${productId}` : "",
    pdpUrl: productId ? `https://p-bandai.com/${area}/item/${productId}` : "",
    reason: hit?.reason || "restock",
    price: hit?.price || hit?.meta?.price || null,
    productType: hit?.productType || hit?.meta?.productType || null,
    inStock,
    areaItemNo: hit?.areaItemNo || hit?.meta?.areaItemNo || null,
    hit: hit || null,
    source: "product_monitor",
  };
}

/**
 * Context from a Quick Task paste.
 * @param {object} target — parseBandaiProductInput result
 * @param {{ store?: string, label?: string }} [opts]
 */
function contextFromQuickTask(target, opts = {}) {
  return {
    store: opts.store || "bandai",
    title: opts.label || target.title || target.productId || "",
    sku: target.productId || "",
    productId: target.productId || "",
    url: target.pdpUrl || "",
    pdpUrl: target.pdpUrl || "",
    reason: "quicktask",
    areaItemNo: target.areaItemNo || null,
    hit: null,
    source: "quicktask",
  };
}

module.exports = {
  DEFAULT_PRESET,
  normalizeQuickTaskPreset,
  resolveQuickTaskProfiles,
  parseBandaiProductInput,
  targetFromMonitorHit,
  buildQuickTaskDraft,
  contextFromMonitorHit,
  contextFromQuickTask,
};
