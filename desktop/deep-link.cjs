// Shared Quick Task deep-link helpers (Discord → Desktop, Monitor Feed parity).
// Discord link buttons require http(s); we use a fixed localhost bridge while Electron is open.
// Optional custom protocol j1ms:// also works when registered by the desktop app.

const PROTOCOL = "j1ms";
const BRIDGE_PORT = 17865;
const BRIDGE_HOST = "127.0.0.1";
/** Discord LINK buttons need HTTPS — monitor-host /qt bounces to localhost. */
const DEFAULT_PUBLIC_QT_BASE =
  process.env.QUICKTASK_PUBLIC_BASE ||
  "https://j1ms-bandai-monitor-production.up.railway.app";

function normalizeStoreId(raw) {
  const s = String(raw || "")
    .trim()
    .toLowerCase();
  if (s === "pokemon" || s === "pokemoncenter" || s === "pkc") return "pokemoncentre";
  return s;
}

/**
 * Build the URL Discord (and Feed docs) use for one-click Quick Task.
 * Default: HTTPS public /qt bounce (Discord-safe). Pass scheme:"local" for bridge URL.
 * @param {{ productId?: string, sku?: string, title?: string, areaItemNo?: string, area?: string, reason?: string, pdpUrl?: string, store?: string, locale?: string }} hit
 * @param {{ port?: number, scheme?: "http"|"protocol"|"local"|"public", publicBase?: string, start?: boolean|number|string }} [opts]
 */
function buildQuickTaskDeepLink(hit = {}, opts = {}) {
  const sku = String(hit.productId || hit.sku || "").trim();
  const params = new URLSearchParams();
  const store = normalizeStoreId(hit.store || opts.store);
  if (store) params.set("store", store);
  if (sku) params.set("sku", sku);
  const title = String(hit.title || "").trim();
  if (title) params.set("title", title.slice(0, 120));
  const nai = hit.areaItemNo || hit.nai || null;
  if (nai) params.set("nai", String(nai));
  const area = String(hit.area || "au").toLowerCase();
  if (!store || store === "bandai") {
    if (area) params.set("area", area);
  }
  const locale = String(hit.locale || opts.locale || "").trim().toLowerCase();
  if (store === "pokemoncentre" && locale) params.set("locale", locale);
  const reason = hit.reason ? String(hit.reason) : "";
  if (reason) params.set("reason", reason.slice(0, 40));
  const pdp = hit.pdpUrl || hit.url || "";
  if (pdp && /^https?:\/\//i.test(pdp)) params.set("url", pdp);
  // start=0 → create tasks from preset without auto-starting
  if (opts.start === false || opts.start === 0 || opts.start === "0") {
    params.set("start", "0");
  }

  let qs = params.toString();
  // Keep Discord button URLs under 512; drop title/url/reason first.
  const schemeProbe =
    opts.scheme === "protocol"
      ? `${PROTOCOL}://quicktask?`
      : opts.scheme === "local" || opts.scheme === "http"
        ? `http://${BRIDGE_HOST}:${Number(opts.port) || BRIDGE_PORT}/quicktask?`
        : `${String(opts.publicBase || DEFAULT_PUBLIC_QT_BASE).replace(/\/+$/, "")}/qt?`;
  if (`${schemeProbe}${qs}`.length > 480) {
    const slim = new URLSearchParams();
    if (store) slim.set("store", store);
    if (sku) slim.set("sku", sku);
    if (nai) slim.set("nai", String(nai));
    if (!store || store === "bandai") slim.set("area", area);
    if (store === "pokemoncentre" && locale) slim.set("locale", locale);
    if (params.get("start") === "0") slim.set("start", "0");
    qs = slim.toString();
  }

  if (opts.scheme === "protocol") {
    return `${PROTOCOL}://quicktask${qs ? `?${qs}` : ""}`;
  }
  const port = Number(opts.port) || BRIDGE_PORT;
  if (opts.scheme === "local" || opts.scheme === "http") {
    return `http://${BRIDGE_HOST}:${port}/quicktask${qs ? `?${qs}` : ""}`;
  }
  // Default / "public" — HTTPS /qt for Discord buttons (test + live)
  const base = String(opts.publicBase || DEFAULT_PUBLIC_QT_BASE).replace(/\/+$/, "");
  return `${base}/qt${qs ? `?${qs}` : ""}`;
}

/**
 * Parse j1ms://quicktask?… or http://127.0.0.1:PORT/quicktask?… into a QT payload.
 * @param {string} rawUrl
 */
function parseQuickTaskDeepLink(rawUrl) {
  const raw = String(rawUrl || "").trim();
  if (!raw) return { ok: false, error: "empty url" };

  let url;
  try {
    // Node URL needs a base for some custom schemes; normalize j1ms://
    if (/^j1ms:/i.test(raw)) {
      url = new URL(raw.replace(/^j1ms:/i, "http:"));
    } else {
      url = new URL(raw);
    }
  } catch {
    return { ok: false, error: "invalid url" };
  }

  const path = String(url.pathname || "").replace(/\/+$/, "").toLowerCase();
  const hostPath = `${url.hostname}${path}`.toLowerCase();
  const isQt =
    path === "/quicktask" ||
    path === "quicktask" ||
    hostPath === "quicktask" ||
    hostPath.endsWith("/quicktask") ||
    // j1ms://quicktask → hostname becomes "quicktask" with http: rewrite
    String(url.hostname || "").toLowerCase() === "quicktask";
  if (!isQt && !url.searchParams.get("sku") && !url.searchParams.get("url")) {
    return { ok: false, error: "not a quicktask link" };
  }

  const sku = (url.searchParams.get("sku") || "").trim();
  const title = (url.searchParams.get("title") || "").trim();
  const nai = (url.searchParams.get("nai") || "").trim();
  const area = (url.searchParams.get("area") || "au").trim().toLowerCase() || "au";
  const locale = (url.searchParams.get("locale") || "").trim().toLowerCase();
  const store = normalizeStoreId(url.searchParams.get("store") || "");
  const reason = (url.searchParams.get("reason") || "discord").trim();
  const pdpUrl = (url.searchParams.get("url") || "").trim();
  const startRaw = String(url.searchParams.get("start") || "1").trim().toLowerCase();
  const start = !(startRaw === "0" || startRaw === "false" || startRaw === "no");

  if (!sku && !pdpUrl) {
    return { ok: false, error: "missing sku" };
  }

  const hit = sku
    ? {
        productId: sku,
        title: title || sku,
        areaItemNo: nai || null,
        reason: reason || "discord",
        pdpUrl: pdpUrl || null,
        store: store || undefined,
        locale: locale || undefined,
      }
    : null;

  return {
    ok: true,
    payload: {
      hit,
      input: pdpUrl || sku,
      sku,
      title: title || undefined,
      area,
      locale: locale || undefined,
      store: store || undefined,
      label: title || sku || undefined,
      start,
      source: "deep_link",
    },
  };
}

function buildQuickTaskSetupDeepLink(opts = {}) {
  const base = String(opts.publicBase || DEFAULT_PUBLIC_QT_BASE).replace(/\/+$/, "");
  return `${base}/qt-setup`;
}

function buildEbaySoldUrl(hit = {}, opts = {}) {
  const title = String(hit.title || "").trim();
  const sku = String(hit.productId || hit.sku || "").trim();
  let q = (title || sku || "bandai")
    .replace(/\b(premium\s+bandai|p-bandai|bandai\s+spirits|tamashii)\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);
  const site = String(opts.site || "ebay.com.au");
  const params = new URLSearchParams({
    _nkw: q || sku || "bandai",
    LH_Sold: "1",
    LH_Complete: "1",
    rt: "nc",
  });
  return `https://www.${site}/sch/i.html?${params.toString()}`;
}

/**
 * Discord LINK buttons: Quick Task + Create only + Setup + eBay.
 * (PDP stays in embed fields — Discord max 5 buttons/row.)
 */
function quickTaskDiscordComponents(hit, opts = {}) {
  const withStore = { ...hit, store: hit.store || opts.store };
  let qtUrl = buildQuickTaskDeepLink(withStore, { port: opts.port || BRIDGE_PORT, ...opts });
  if (qtUrl.length > 512) {
    qtUrl = buildQuickTaskDeepLink(
      { ...withStore, title: "" },
      { port: opts.port || BRIDGE_PORT, ...opts },
    );
  }
  let createUrl = buildQuickTaskDeepLink(withStore, {
    port: opts.port || BRIDGE_PORT,
    ...opts,
    start: false,
  });
  if (createUrl.length > 512) {
    createUrl = buildQuickTaskDeepLink(
      { ...withStore, title: "" },
      { port: opts.port || BRIDGE_PORT, ...opts, start: false },
    );
  }
  return buildComponents(qtUrl, createUrl, withStore, opts);
}

function buildComponents(qtUrl, createUrl, hit, opts = {}) {
  const setupUrl = buildQuickTaskSetupDeepLink(opts);
  const ebayUrl = buildEbaySoldUrl(hit, opts);
  const row = {
    type: 1,
    components: [
      { type: 2, style: 5, label: "⚡ Quick Task", url: String(qtUrl).slice(0, 512) },
      { type: 2, style: 5, label: "Create only", url: String(createUrl).slice(0, 512) },
      { type: 2, style: 5, label: "Setup presets", url: String(setupUrl).slice(0, 512) },
      { type: 2, style: 5, label: "eBay sold", url: String(ebayUrl).slice(0, 512) },
    ],
  };
  return [row];
}

module.exports = {
  PROTOCOL,
  BRIDGE_PORT,
  BRIDGE_HOST,
  buildQuickTaskDeepLink,
  buildQuickTaskSetupDeepLink,
  buildEbaySoldUrl,
  parseQuickTaskDeepLink,
  quickTaskDiscordComponents,
};
