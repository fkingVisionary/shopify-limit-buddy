/**
 * Desktop wrapper around executor public NAI resolve (N… → NAI…).
 * Keeps CJS surface for job-runner / monitor handoff.
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

async function loadExecutorNai() {
  const p = path.join(__dirname, "..", "executor", "adapters", "bandai-nai.js");
  return import(pathToFileURL(p).href);
}

/**
 * Resolve N… → NAI… via executor public path (warm + GET /api/products).
 */
async function resolveAreaItemNoHttp(opts = {}) {
  const mod = await loadExecutorNai();
  return mod.resolveAreaItemNoPublicRetry({
    productCode: opts.productCode,
    area: opts.area || "au",
    proxy: toProxyUrl(opts.proxy) || opts.proxy || null,
    timeoutMs: opts.timeoutMs,
    retries: opts.retries ?? 2,
  });
}

module.exports = {
  isBackendAreaItemNo,
  isFrontendProductCode,
  pickAreaItemNo,
  areaItemNoFromHit,
  resolveAreaItemNoHttp,
  toProxyUrl,
};
