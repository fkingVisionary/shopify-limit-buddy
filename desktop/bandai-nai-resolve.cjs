/**
 * Pre-resolve Bandai backend ATC id (NAI…) off the drop critical path.
 * Public GET /api/products/{N-code} works after a cheap home warm (no F5).
 */

const path = require("path");
const { pathToFileURL } = require("url");

function isBackendAreaItemNo(code) {
  const s = String(code || "").trim();
  return /^NAI/i.test(s) || /^AAI/i.test(s);
}

function isFrontendProductCode(code) {
  const s = String(code || "").trim();
  if (!s || isBackendAreaItemNo(s)) return false;
  return /^[NA]\d/i.test(s) || /^N\d{7,}/i.test(s) || /^A\d{7,}/i.test(s);
}

/**
 * Prefer explicit Backend PID fields, then hit meta, then NAI-shaped codes.
 */
function pickAreaItemNo(sources = {}) {
  const candidates = [
    sources.bandaiAreaItemNo,
    sources.bandaiBackendPid,
    sources.areaItemNo,
    sources.heldCartAreaItemNo,
    sources.hitAreaItemNo,
    sources.metaAreaItemNo,
    ...(Array.isArray(sources.areaItemNos) ? sources.areaItemNos : []),
    ...(Array.isArray(sources.metaAreaItemNos) ? sources.metaAreaItemNos : []),
  ];
  for (const c of candidates) {
    const s = String(c || "").trim();
    if (isBackendAreaItemNo(s)) return s;
  }
  return null;
}

function areaItemNoFromHit(hit) {
  if (!hit || typeof hit !== "object") return null;
  return pickAreaItemNo({
    hitAreaItemNo: hit.areaItemNo,
    metaAreaItemNo: hit.meta?.areaItemNo,
    areaItemNos: hit.areaItemNos,
    metaAreaItemNos: hit.meta?.areaItemNos,
  });
}

function toProxyUrl(raw) {
  if (!raw) return null;
  if (/^https?:\/\//i.test(raw)) return raw;
  const parts = String(raw).split(":");
  if (parts.length >= 4) {
    const [host, port, user, ...pass] = parts;
    return `http://${encodeURIComponent(user)}:${encodeURIComponent(pass.join(":"))}@${host}:${port}`;
  }
  return raw;
}

/**
 * Resolve N… → NAI… via undici (executor http helpers). Best-effort; never throws.
 */
async function resolveAreaItemNoHttp({
  productCode,
  area = "au",
  proxy = null,
  timeoutMs = 12_000,
} = {}) {
  const code = String(productCode || "").trim();
  if (!code) return { ok: false, error: "product code required" };
  if (isBackendAreaItemNo(code)) {
    return { ok: true, areaItemNo: code, productCode: code, note: "already backend PID" };
  }

  try {
    const httpPath = path.join(__dirname, "..", "executor", "http.js");
    const { createJar, makeDispatcher, request, UA } = await import(pathToFileURL(httpPath).href);
    const region = String(area || "au").toLowerCase().slice(0, 2);
    const jar = createJar();
    const proxyUrl = toProxyUrl(proxy);
    const dispatcher = makeDispatcher(proxyUrl, { forceUndici: true });
    const ctx = { jar, dispatcher };
    const base = `https://p-bandai.com/${region}`;
    const t0 = Date.now();

    try {
      const warm = await request(
        `${base}/`,
        {
          method: "GET",
          headers: {
            "user-agent": UA,
            accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
            "accept-language": region === "fr" ? "fr-FR,fr;q=0.9" : "en-AU,en;q=0.9",
          },
          signal: AbortSignal.timeout(timeoutMs),
        },
        ctx,
      );
      jar.ingest?.(warm.headers);
      if (warm.status >= 400) {
        return { ok: false, error: `warm_${warm.status}`, status: warm.status };
      }

      const prod = await request(
        `https://p-bandai.com/api/products/${encodeURIComponent(code)}`,
        {
          method: "GET",
          headers: {
            "user-agent": UA,
            accept: "application/json, text/plain, */*",
            "accept-language": region === "fr" ? "fr" : "en",
            "x-g1-area-code": region,
            "x-requested-with": "XMLHttpRequest",
            origin: "https://p-bandai.com",
            referer: `${base}/item/${code}`,
          },
          signal: AbortSignal.timeout(timeoutMs),
        },
        ctx,
      );
      jar.ingest?.(prod.headers);
      let json = null;
      try {
        json = await prod.json();
      } catch {
        const text = await prod.text().catch(() => "");
        return {
          ok: false,
          error: `product_not_json status=${prod.status}`,
          status: prod.status,
          ms: Date.now() - t0,
          preview: String(text || "").slice(0, 120),
        };
      }
      const areaItemNo =
        (Array.isArray(json?.areaItemNos) && json.areaItemNos[0]) ||
        Object.keys(json?.areaItemInventoryInfoMap || {})[0] ||
        null;
      if (!areaItemNo) {
        return {
          ok: false,
          error: json?.detail || json?.error || `no areaItemNos (${prod.status})`,
          status: prod.status,
          ms: Date.now() - t0,
        };
      }
      return {
        ok: true,
        areaItemNo: String(areaItemNo),
        productCode: code,
        title: json?.productName || json?.name || null,
        purchaseAvailable: Boolean(json?.purchaseAvailable),
        ms: Date.now() - t0,
        note: `pre-resolved ${areaItemNo}`,
      };
    } finally {
      try {
        await dispatcher?.close?.();
      } catch {
        /* ignore */
      }
    }
  } catch (e) {
    return { ok: false, error: e?.message || String(e) };
  }
}

module.exports = {
  isBackendAreaItemNo,
  isFrontendProductCode,
  pickAreaItemNo,
  areaItemNoFromHit,
  resolveAreaItemNoHttp,
  toProxyUrl,
};
