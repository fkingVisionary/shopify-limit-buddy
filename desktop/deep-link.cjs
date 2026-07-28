// Shared Quick Task deep-link helpers (Discord → Desktop, Monitor Feed parity).
// Discord link buttons require http(s); we use a fixed localhost bridge while Electron is open.
// Optional custom protocol j1ms:// also works when registered by the desktop app.

const PROTOCOL = "j1ms";
const BRIDGE_PORT = 17865;
const BRIDGE_HOST = "127.0.0.1";

/**
 * Build the URL Discord (and Feed docs) use for one-click Quick Task.
 * @param {{ productId?: string, sku?: string, title?: string, areaItemNo?: string, area?: string, reason?: string, pdpUrl?: string }} hit
 * @param {{ port?: number, scheme?: "http"|"protocol" }} [opts]
 */
function buildQuickTaskDeepLink(hit = {}, opts = {}) {
  const sku = String(hit.productId || hit.sku || "").trim();
  const params = new URLSearchParams();
  if (sku) params.set("sku", sku);
  const title = String(hit.title || "").trim();
  if (title) params.set("title", title.slice(0, 120));
  const nai = hit.areaItemNo || hit.nai || null;
  if (nai) params.set("nai", String(nai));
  const area = String(hit.area || "au").toLowerCase();
  if (area) params.set("area", area);
  const reason = hit.reason ? String(hit.reason) : "";
  if (reason) params.set("reason", reason.slice(0, 40));
  const pdp = hit.pdpUrl || hit.url || "";
  if (pdp && /^https?:\/\//i.test(pdp)) params.set("url", pdp);

  const qs = params.toString();
  if (opts.scheme === "protocol") {
    return `${PROTOCOL}://quicktask${qs ? `?${qs}` : ""}`;
  }
  const port = Number(opts.port) || BRIDGE_PORT;
  return `http://${BRIDGE_HOST}:${port}/quicktask${qs ? `?${qs}` : ""}`;
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
  const reason = (url.searchParams.get("reason") || "discord").trim();
  const pdpUrl = (url.searchParams.get("url") || "").trim();

  if (!sku && !pdpUrl) {
    return { ok: false, error: "missing sku" };
  }

  const hit = sku
    ? {
        productId: sku,
        title: title || sku,
        areaItemNo: nai || null,
        reason: reason || "discord",
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
      label: title || sku || undefined,
      start: true,
      source: "deep_link",
    },
  };
}

/**
 * Discord message components: LINK button row for Quick Task (+ optional PDP).
 * Discord requires http(s) for style=5 buttons — localhost bridge while app is open.
 */
function quickTaskDiscordComponents(hit, opts = {}) {
  const qtUrl = buildQuickTaskDeepLink(hit, { port: opts.port || BRIDGE_PORT });
  if (qtUrl.length > 512) {
    // Discord button URL max 512 — drop title if needed
    const slim = buildQuickTaskDeepLink(
      { ...hit, title: "" },
      { port: opts.port || BRIDGE_PORT },
    );
    return buildComponents(slim, hit, opts);
  }
  return buildComponents(qtUrl, hit, opts);
}

function buildComponents(qtUrl, hit, opts = {}) {
  const area = String(opts.area || hit.area || "au").toLowerCase();
  const productId = String(hit.productId || hit.sku || "").trim();
  const pdp =
    hit.pdpUrl ||
    (productId ? `https://p-bandai.com/${area}/item/${productId}` : null);
  const row = {
    type: 1,
    components: [
      {
        type: 2,
        style: 5,
        label: "⚡ Quick Task",
        url: qtUrl,
      },
    ],
  };
  if (pdp && String(pdp).length <= 512) {
    row.components.push({
      type: 2,
      style: 5,
      label: "Open PDP",
      url: pdp,
    });
  }
  return [row];
}

module.exports = {
  PROTOCOL,
  BRIDGE_PORT,
  BRIDGE_HOST,
  buildQuickTaskDeepLink,
  parseQuickTaskDeepLink,
  quickTaskDiscordComponents,
};
