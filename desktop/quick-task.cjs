// Quick Task helpers — build Bandai (v1) task rows from preset + SKU/URL/monitor hit.
// Pure (no Electron / no network). Main process persists + enqueues.

const DEFAULT_PRESET = {
  store: "bandai",
  bandaiMode: "checkout",
  bandaiCheckoutMode: "fast",
  profileId: null,
  proxyGroupId: null,
  qty: 1,
  quantity: 1,
  placeOrder: true,
  accountAssign: "auto",
  accountId: null,
  startAfterCreate: true,
};

/**
 * Normalize settings.quickTaskPreset with defaults.
 * @param {object} [raw]
 */
function normalizeQuickTaskPreset(raw = {}) {
  const store = String(raw.store || DEFAULT_PRESET.store).toLowerCase() || "bandai";
  const modeRaw = String(raw.bandaiMode || "").toLowerCase();
  // Raffle / Chance applyDraw removed — map legacy tasks to checkout.
  const bandaiMode = ["checkout", "atc", "monitor", "account_gen"].includes(
    modeRaw === "chance" ? "checkout" : modeRaw,
  )
    ? modeRaw === "chance"
      ? "checkout"
      : modeRaw
    : "checkout";
  return {
    store,
    bandaiMode,
    bandaiCheckoutMode: ["fast", "fast_undici", "safe"].includes(
      String(raw.bandaiCheckoutMode || "").toLowerCase(),
    )
      ? String(raw.bandaiCheckoutMode).toLowerCase()
      : "fast",
    profileId: raw.profileId || null,
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
  const title = extra.label || target.title || productId;
  const mode = p.bandaiMode;
  const draft = {
    id: extra.id || undefined,
    store: p.store,
    label: String(title).slice(0, 120),
    pdpUrl: target.pdpUrl || (productId && !/^NAI/i.test(productId)
      ? `https://p-bandai.com/${target.area || "au"}/item/${productId}`
      : ""),
    qty: p.qty,
    quantity: p.quantity,
    profileId: p.profileId,
    proxyGroupId: p.proxyGroupId,
    placeOrder: p.placeOrder,
    enabled: true,
    bandaiMode: mode,
    bandaiCheckoutMode: p.bandaiCheckoutMode,
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
  parseBandaiProductInput,
  targetFromMonitorHit,
  buildQuickTaskDraft,
  contextFromMonitorHit,
  contextFromQuickTask,
};
