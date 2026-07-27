/**
 * Public Bandai N… → NAI… resolve (no F5 / no login).
 * Used off the ATC critical path so product_get can be skipped for public-bot tasks
 * that only have a storefront PDP / N-code.
 */

import { createJar, makeDispatcher, request, UA } from "../http.js";

export function isBackendAreaItemNo(code) {
  const s = String(code || "").trim();
  return /^NAI/i.test(s) || /^AAI/i.test(s);
}

export function isFrontendProductCode(code) {
  const s = String(code || "").trim();
  if (!s || isBackendAreaItemNo(s)) return false;
  return /^[NA]\d/i.test(s) || /^N\d{7,}/i.test(s) || /^A\d{7,}/i.test(s);
}

/**
 * Warm home + GET /api/products/{code} via undici.
 * @returns {Promise<{ok:boolean, areaItemNo?:string, productCode?:string, title?:string|null, purchaseAvailable?:boolean, ms?:number, note?:string, error?:string, status?:number}>}
 */
export async function resolveAreaItemNoPublic({
  productCode,
  area = "au",
  proxy = null,
  timeoutMs = 12_000,
  jar = null,
  dispatcher = null,
} = {}) {
  const code = String(productCode || "").trim();
  if (!code) return { ok: false, error: "product code required" };
  if (isBackendAreaItemNo(code)) {
    return { ok: true, areaItemNo: code, productCode: code, note: "already backend PID", ms: 0 };
  }

  const region = String(area || "au").toLowerCase().slice(0, 2);
  const ownDispatcher = !dispatcher;
  const cookieJar = jar || createJar();
  const disp = dispatcher || makeDispatcher(proxy || null, { forceUndici: true });
  const ctx = { jar: cookieJar, dispatcher: disp };
  const base = `https://p-bandai.com/${region}`;
  const t0 = Date.now();
  const signal =
    typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function"
      ? AbortSignal.timeout(timeoutMs)
      : undefined;

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
        ...(signal ? { signal } : {}),
      },
      ctx,
    );
    cookieJar.ingest?.(warm.headers);
    if (warm.status >= 400) {
      return { ok: false, error: `warm_${warm.status}`, status: warm.status, ms: Date.now() - t0 };
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
        ...(signal ? { signal } : {}),
      },
      ctx,
    );
    cookieJar.ingest?.(prod.headers);

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
      note: `public resolve ${areaItemNo}`,
    };
  } catch (e) {
    return { ok: false, error: e?.message || String(e), ms: Date.now() - t0 };
  } finally {
    if (ownDispatcher) {
      try {
        await disp?.close?.();
      } catch {
        /* ignore */
      }
    }
  }
}

/**
 * Retry wrapper for drop SoftBlock / congestion on public resolve.
 */
export async function resolveAreaItemNoPublicRetry(opts = {}) {
  const max = Math.max(1, Math.min(3, Number(opts.retries) || 2));
  let last = null;
  for (let i = 1; i <= max; i++) {
    last = await resolveAreaItemNoPublic({ ...opts, retries: undefined });
    if (last.ok) return { ...last, attempts: i };
    const retryable =
      last.status === 429 ||
      last.status === 501 ||
      last.status === 502 ||
      last.status === 503 ||
      last.status === 504 ||
      /NETWORK CONGESTION|SoftBlock|product_not_json|warm_/i.test(String(last.error || ""));
    if (!retryable || i === max) break;
    await new Promise((r) => setTimeout(r, 250 * i));
  }
  return { ...(last || { ok: false, error: "resolve failed" }), attempts: max };
}

export default {
  isBackendAreaItemNo,
  isFrontendProductCode,
  resolveAreaItemNoPublic,
  resolveAreaItemNoPublicRetry,
};
