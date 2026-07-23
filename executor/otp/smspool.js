// SMSPool.net SMS OTP helper — store-agnostic.
// Docs: https://www.smspool.net/article/how-to-use-the-smspool-api-0dd6eadf4c
// Base: https://api.smspool.net/  (POST application/x-www-form-urlencoded)
//
// Bandai named service ID = 1733. AU storefront accepts US (+1) / UK (+44)
// numbers for signup (owner-validated). Prefer UK pool (~$0.04) then US (~$0.14).

const DEFAULT_BASE = "https://api.smspool.net";

/** SMSPool service ID for Bandai Namco / p-bandai signup SMS. */
export const SMSPOOL_SERVICE_BANDAI = 1733;

/** Fallback "Not Listed / Other / Any" when a store has no named service. */
export const SMSPOOL_SERVICE_OTHER = 817;

const COUNTRY_PRESETS = {
  US: {
    id: 1,
    short: "US",
    cc: "1",
    countryNo: "+1",
    countryNoName: "United States",
  },
  GB: {
    id: 2,
    short: "GB",
    cc: "44",
    countryNo: "+44",
    countryNoName: "United Kingdom",
  },
  UK: {
    id: 2,
    short: "GB",
    cc: "44",
    countryNo: "+44",
    countryNoName: "United Kingdom",
  },
  AU: {
    id: 159,
    short: "AU",
    cc: "61",
    countryNo: "+61",
    countryNoName: "Australia",
  },
};

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function redactKey(key) {
  const s = String(key || "");
  if (s.length <= 8) return "***";
  return `${s.slice(0, 4)}…${s.slice(-4)}`;
}

/**
 * Resolve SMSPool country preset from id / ISO / dial code.
 * @param {string|number} [raw]
 */
export function resolveSmspoolCountry(raw) {
  if (raw == null || raw === "") return COUNTRY_PRESETS.GB;
  if (typeof raw === "object" && raw.short && COUNTRY_PRESETS[raw.short]) {
    return COUNTRY_PRESETS[raw.short];
  }
  const s = String(raw).trim().toUpperCase();
  if (COUNTRY_PRESETS[s]) return COUNTRY_PRESETS[s];
  const asNum = Number(s);
  for (const p of Object.values(COUNTRY_PRESETS)) {
    if (p.id === asNum || p.cc === s || p.short === s) return p;
  }
  // Dial forms: +44 / +1
  const digits = s.replace(/\D/g, "");
  for (const p of Object.values(COUNTRY_PRESETS)) {
    if (p.cc === digits) return p;
  }
  return COUNTRY_PRESETS.GB;
}

/**
 * National phone digits for Bandai phone1.phoneNo (no leading 0 / country code).
 */
export function normalizeMsisdn(raw, country = "GB") {
  const preset = resolveSmspoolCountry(country);
  let d = String(raw || "").replace(/\D/g, "");
  if (preset.cc === "1") {
    // NANP: 1 + 10 digits
    if (d.length === 11 && d.startsWith("1")) d = d.slice(1);
  } else if (d.startsWith(preset.cc) && d.length >= preset.cc.length + 9) {
    d = d.slice(preset.cc.length);
  }
  if (preset.cc === "61" || preset.cc === "44") {
    if (d.startsWith("0") && d.length >= 10) d = d.slice(1);
  }
  return d;
}

/** Bandai phone1 shape for US / UK / AU numbers. */
export function toBandaiPhone1(raw, country = "GB") {
  const preset = resolveSmspoolCountry(country);
  return {
    countryNo: preset.countryNo,
    phoneNo: normalizeMsisdn(raw, preset.short),
    countryNoName: preset.countryNoName,
  };
}

/**
 * @param {object} opts
 * @param {string} opts.apikey
 * @param {string} [opts.baseUrl]
 * @param {typeof fetch} [opts.fetchImpl]
 */
export function createSmspoolClient(opts = {}) {
  const apikey = String(opts.apikey || opts.key || "").trim();
  const baseUrl = String(opts.baseUrl || DEFAULT_BASE).replace(/\/$/, "");
  const fetchImpl = opts.fetchImpl || globalThis.fetch;

  if (!apikey) {
    throw new Error("SMSPool API key required");
  }

  async function api(pathname, params = {}) {
    const path = pathname.startsWith("/") ? pathname : `/${pathname}`;
    const body = new URLSearchParams();
    body.set("key", apikey);
    for (const [k, v] of Object.entries(params)) {
      if (v == null || v === "") continue;
      body.set(k, String(v));
    }
    const res = await fetchImpl(`${baseUrl}${path}`, {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/x-www-form-urlencoded",
      },
      body: body.toString(),
    });
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      json = { raw: text };
    }
    return { status: res.status, json, text };
  }

  async function getBalance() {
    const { status, json } = await api("/request/balance");
    const balance = json?.balance != null ? Number(json.balance) : null;
    if (json?.success === 0 || /invalid|wrong.?key|unauthorized/i.test(String(json?.message || ""))) {
      return {
        ok: false,
        error: String(json?.message || "balance_failed"),
        balance,
        status,
        json,
      };
    }
    return {
      ok: status >= 200 && status < 300 && balance != null && !Number.isNaN(balance),
      balance,
      status,
      json,
      error: null,
    };
  }

  /**
   * Purchase a one-shot SMS number.
   * @param {object} p
   * @param {string|number} [p.country="GB"] — SMSPool country id or US/GB/UK
   * @param {number|string} [p.service=1733] — Bandai default
   * @param {number|string} [p.pool] — optional pool id
   * @param {number|string} [p.maxPrice] — optional max USD
   */
  async function acquireNumber(p = {}) {
    const preset = resolveSmspoolCountry(p.country ?? p.smspoolCountry ?? "GB");
    const service = p.service ?? p.smspoolService ?? SMSPOOL_SERVICE_BANDAI;
    const params = {
      country: preset.id,
      service,
    };
    if (p.pool != null) params.pool = p.pool;
    if (p.maxPrice != null || p.max_price != null) {
      params.max_price = p.maxPrice ?? p.max_price;
    }

    const { status, json } = await api("/purchase/sms", params);
    const success = json?.success === 1 || json?.success === true;
    const orderId = json?.order_id || json?.orderid || null;
    const number =
      json?.phonenumber ||
      json?.number ||
      (json?.cc && json?.number ? String(json.number) : null);

    if (!success || !orderId || number == null) {
      const err =
        json?.type ||
        json?.message ||
        (typeof json?.raw === "string" ? json.raw.slice(0, 120) : null) ||
        "purchase_sms_failed";
      return {
        ok: false,
        error: String(err).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim(),
        status,
        json,
      };
    }

    const national = normalizeMsisdn(number, preset);
    const e164 =
      json?.number && String(json.number).length > national.length
        ? String(json.number).replace(/\D/g, "")
        : `${preset.cc}${national}`;

    return {
      ok: true,
      mode: "smspool",
      provider: "smspool",
      // Alias for OnlineSim-shaped callers
      tzid: orderId,
      orderId: String(orderId),
      number: national,
      rawNumber: number,
      e164,
      cc: preset.cc,
      country: preset.short,
      countryNo: preset.countryNo,
      countryNoName: preset.countryNoName,
      pool: json?.pool ?? null,
      expiresIn: json?.expires_in ?? null,
      phone1: {
        countryNo: preset.countryNo,
        phoneNo: national,
        countryNoName: preset.countryNoName,
      },
      status,
      json,
    };
  }

  /**
   * Single order status via /sms/check (ok for low volume).
   * Prefer waitForSms which uses /request/active when possible.
   */
  async function checkOrder(orderId) {
    const id = String(orderId || "").trim();
    if (!id) return { ok: false, error: "orderid_required" };
    const { status, json } = await api("/sms/check", { orderid: id });
    return { ok: status < 400, status, json };
  }

  /** List active orders (preferred poll surface). */
  async function listActive() {
    const { status, json } = await api("/request/active");
    const rows = Array.isArray(json) ? json : [];
    return { ok: status < 400, status, json, rows };
  }

  /**
   * Poll until SMS code arrives.
   * @param {object} p
   * @param {string} p.orderId — or p.tzid
   * @param {RegExp|string} [p.regex]
   * @param {number} [p.timeoutMs=180000]
   * @param {number} [p.intervalMs=5000]
   */
  async function waitForSms(p = {}) {
    const orderId = String(p.orderId || p.tzid || "").trim();
    if (!orderId) return { ok: false, error: "orderid_required" };
    const timeoutMs = Number(p.timeoutMs) || 180_000;
    const intervalMs = Number(p.intervalMs) || 5_000;
    const re =
      p.regex instanceof RegExp ? p.regex : new RegExp(p.regex || "\\b(\\d{4,8})\\b");

    const deadline = Date.now() + timeoutMs;
    let lastJson = null;

    while (Date.now() < deadline) {
      // Prefer /request/active (SMSPool guidance for volume / efficiency)
      const active = await listActive();
      lastJson = active.json;
      const row = (active.rows || []).find(
        (r) =>
          String(r?.order_code || r?.orderid || r?.order_id || "") === orderId,
      );
      if (row) {
        const codeRaw = row.code != null && String(row.code) !== "0" ? String(row.code) : "";
        const full = String(row.full_code || row.sms || row.message || "");
        const fromFull = full.match(re);
        if (codeRaw && /^\d{4,8}$/.test(codeRaw)) {
          return {
            ok: true,
            code: codeRaw,
            message: full || codeRaw,
            orderId,
            tzid: orderId,
            json: row,
          };
        }
        if (fromFull) {
          return {
            ok: true,
            code: String(fromFull[1] || fromFull[0]),
            message: full,
            orderId,
            tzid: orderId,
            json: row,
          };
        }
      }

      // Fallback single-order check
      const checked = await checkOrder(orderId);
      lastJson = checked.json;
      const statusId = Number(checked.json?.status ?? checked.json?.status_id);
      // status 3 = completed (common SMSPool); also accept sms/code fields
      const smsText = String(
        checked.json?.sms ||
          checked.json?.full_code ||
          checked.json?.message ||
          checked.json?.code ||
          "",
      );
      const directCode =
        checked.json?.code != null && String(checked.json.code) !== "0"
          ? String(checked.json.code)
          : "";
      if (directCode && /^\d{4,8}$/.test(directCode) && statusId !== 6) {
        return {
          ok: true,
          code: directCode,
          message: smsText || directCode,
          orderId,
          tzid: orderId,
          json: checked.json,
        };
      }
      const m = smsText.match(re);
      if (m && statusId !== 6 && !/refund|cancel|expired/i.test(smsText)) {
        return {
          ok: true,
          code: String(m[1] || m[0]),
          message: smsText,
          orderId,
          tzid: orderId,
          json: checked.json,
        };
      }
      // 6 = refunded / cancelled
      if (statusId === 6) {
        return {
          ok: false,
          error: "order_refunded",
          orderId,
          tzid: orderId,
          json: checked.json,
        };
      }

      await sleep(intervalMs);
    }

    return { ok: false, error: "sms_timeout", orderId, tzid: orderId, json: lastJson };
  }

  /** Cancel + refund unused order. */
  async function release(orderIdOrTzid) {
    const orderId = String(orderIdOrTzid || "").trim();
    if (!orderId) return { ok: false, error: "orderid_required" };
    const { status, json } = await api("/sms/cancel", { orderid: orderId });
    const success = json?.success === 1 || json?.success === true;
    return {
      ok: success || /already|refund|cancel/i.test(String(json?.message || "")),
      status,
      json,
      error: success ? null : String(json?.message || "cancel_failed"),
    };
  }

  return {
    provider: "smspool",
    apikeyHint: redactKey(apikey),
    getBalance,
    acquireNumber,
    waitForSms,
    release,
    checkOrder,
    listActive,
    api,
  };
}

export { COUNTRY_PRESETS };
export default createSmspoolClient;
