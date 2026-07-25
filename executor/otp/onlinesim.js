// OnlineSim SMS OTP helper — store-agnostic.
// Docs: https://onlinesim.io/openapi_docs/Onlinesim-API-UN/info
// Auth: apikey query param. Country 61 = Australia.
//
// Bandai is not in OnlineSim's named service list. Prefer rent mode, or
// configure onlinesimServiceSlug (e.g. "other") once validated with a live key.

const DEFAULT_BASE = "https://onlinesim.io";

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function redactKey(key) {
  const s = String(key || "");
  if (s.length <= 8) return "***";
  return `${s.slice(0, 4)}…${s.slice(-4)}`;
}

/**
 * @param {object} opts
 * @param {string} opts.apikey
 * @param {string} [opts.baseUrl]
 * @param {typeof fetch} [opts.fetchImpl]
 */
export function createOnlinesimClient(opts = {}) {
  const apikey = String(opts.apikey || "").trim();
  const baseUrl = String(opts.baseUrl || DEFAULT_BASE).replace(/\/$/, "");
  const fetchImpl = opts.fetchImpl || globalThis.fetch;

  if (!apikey) {
    throw new Error("OnlineSim apikey required");
  }

  async function api(pathname, params = {}) {
    const u = new URL(pathname.startsWith("http") ? pathname : `${baseUrl}${pathname}`);
    u.searchParams.set("apikey", apikey);
    u.searchParams.set("lang", params.lang || "en");
    for (const [k, v] of Object.entries(params)) {
      if (k === "lang") continue;
      if (v == null || v === "") continue;
      u.searchParams.set(k, String(v));
    }
    const res = await fetchImpl(u.toString(), {
      method: "GET",
      headers: { accept: "application/json" },
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
    const { status, json } = await api("/api/getBalance.php");
    const balance = json?.balance ?? json?.zbalance ?? null;
    const response = String(json?.response ?? "");
    if (response === "ERROR_WRONG_KEY" || json?.response === -2) {
      return { ok: false, error: "ERROR_WRONG_KEY", balance: null, status, json };
    }
    if (response === "WARNING_LOW_BALANCE") {
      return { ok: false, error: "WARNING_LOW_BALANCE", balance, status, json };
    }
    return {
      ok: status >= 200 && status < 300 && (balance != null || response === "1" || response === 1),
      balance,
      status,
      json,
      error: null,
    };
  }

  /**
   * Acquire an AU number.
   * @param {object} p
   * @param {"rent"|"activation"} [p.mode] — rent preferred for Bandai
   * @param {number|string} [p.country=61]
   * @param {string} [p.service] — activation service slug
   * @param {number} [p.rentTime] — rent hours
   */
  async function acquireNumber(p = {}) {
    const country = p.country ?? 61;
    const mode = String(p.mode || "rent").toLowerCase();

    if (mode === "activation" || mode === "single") {
      const service = p.service || p.onlinesimServiceSlug || "other";
      const { status, json } = await api("/api/getNum.php", {
        service,
        country,
        number: true,
      });
      const response = json?.response;
      if (response === "WARNING_LOW_BALANCE" || response === "ERROR_WRONG_KEY") {
        return { ok: false, error: String(response), status, json };
      }
      const tzid = json?.tzid ?? (typeof response === "number" ? response : null);
      const number = json?.number || json?.phone || null;
      if (!tzid) {
        return {
          ok: false,
          error: typeof response === "string" ? response : "getNum_failed",
          status,
          json,
        };
      }
      return {
        ok: true,
        mode: "activation",
        tzid,
        number: normalizeAuMsisdn(number),
        rawNumber: number,
        status,
        json,
      };
    }

    // Rent path
    const { status, json } = await api("/api/rent/getRentNum.php", {
      country,
      number: true,
      ...(p.rentTime != null ? { time: p.rentTime } : {}),
    });
    // Some deployments still expose legacy /api/getRentNum.php
    let final = { status, json };
    if (
      !json?.tzid &&
      !json?.number &&
      (status === 404 || /not found|404/i.test(String(json?.response || json?.raw || "")))
    ) {
      final = await api("/api/getRentNum.php", {
        country,
        number: true,
        ...(p.rentTime != null ? { time: p.rentTime } : {}),
      });
    }

    const response = final.json?.response;
    if (response === "WARNING_LOW_BALANCE" || response === "ERROR_WRONG_KEY") {
      return { ok: false, error: String(response), status: final.status, json: final.json };
    }
    const tzid = final.json?.tzid ?? (typeof response === "number" ? response : null);
    const number = final.json?.number || final.json?.phone || final.json?.tel || null;
    if (!tzid || !number) {
      return {
        ok: false,
        error: typeof response === "string" ? response : "getRentNum_failed",
        status: final.status,
        json: final.json,
      };
    }
    return {
      ok: true,
      mode: "rent",
      tzid,
      number: normalizeAuMsisdn(number),
      rawNumber: number,
      status: final.status,
      json: final.json,
    };
  }

  /**
   * Poll until SMS arrives matching regex.
   * @param {object} p
   * @param {string|number} p.tzid
   * @param {"rent"|"activation"} [p.mode]
   * @param {RegExp|string} [p.regex]
   * @param {number} [p.timeoutMs=180000]
   * @param {number} [p.intervalMs=5000]
   */
  async function waitForSms(p = {}) {
    const tzid = p.tzid;
    if (tzid == null) return { ok: false, error: "tzid_required" };
    const mode = String(p.mode || "rent").toLowerCase();
    const timeoutMs = Number(p.timeoutMs) || 180_000;
    const intervalMs = Number(p.intervalMs) || 5_000;
    const re =
      p.regex instanceof RegExp
        ? p.regex
        : new RegExp(p.regex || "\\b(\\d{4,8})\\b");

    const deadline = Date.now() + timeoutMs;
    let lastJson = null;
    while (Date.now() < deadline) {
      const path =
        mode === "activation" || mode === "single"
          ? "/api/getState.php"
          : "/api/rent/getRentState.php";
      let { status, json } = await api(path, { tzid, message_to_code: 1 });
      // Legacy rent state fallback
      if (mode !== "activation" && mode !== "single" && status === 404) {
        ({ status, json } = await api("/api/getRentState.php", { tzid, message_to_code: 1 }));
      }
      lastJson = json;

      const messages = extractMessages(json);
      for (const msg of messages) {
        const text = typeof msg === "string" ? msg : msg?.msg || msg?.message || msg?.text || "";
        const m = String(text).match(re);
        if (m) {
          const code = m[1] || m[0];
          return { ok: true, code: String(code), message: String(text), tzid, json };
        }
        // OnlineSim sometimes returns code field directly
        const direct = msg?.code || msg?.msg_code;
        if (direct && /^\d{4,8}$/.test(String(direct))) {
          return { ok: true, code: String(direct), message: String(text || direct), tzid, json };
        }
      }

      // getState can return array of states
      if (Array.isArray(json) || Array.isArray(json?.response)) {
        const rows = Array.isArray(json) ? json : json.response;
        for (const row of rows) {
          if (String(row?.tzid) === String(tzid) || !row?.tzid) {
            const text = row?.msg || row?.message || "";
            const m = String(text).match(re);
            if (m) {
              return { ok: true, code: String(m[1] || m[0]), message: String(text), tzid, json };
            }
          }
        }
      }

      await sleep(intervalMs);
    }
    return { ok: false, error: "sms_timeout", tzid, json: lastJson };
  }

  /** Close / settle activation or rent. */
  async function release(tzid, p = {}) {
    if (tzid == null) return { ok: false, error: "tzid_required" };
    const mode = String(p.mode || "rent").toLowerCase();
    if (mode === "activation" || mode === "single") {
      const { status, json } = await api("/api/setOperationOk.php", { tzid });
      return { ok: status < 400, status, json };
    }
    // Rent close — best effort
    let result = await api("/api/rent/closeRentNum.php", { tzid });
    if (result.status === 404) {
      result = await api("/api/closeRentNum.php", { tzid });
    }
    return { ok: result.status < 400, status: result.status, json: result.json };
  }

  return {
    apikeyHint: redactKey(apikey),
    getBalance,
    acquireNumber,
    waitForSms,
    release,
  };
}

/** Strip country code / non-digits → national AU mobile without leading 0 preference for Bandai phoneNo. */
export function normalizeAuMsisdn(raw) {
  let d = String(raw || "").replace(/\D/g, "");
  if (d.startsWith("61") && d.length >= 11) d = d.slice(2);
  if (d.startsWith("0") && d.length === 10) d = d.slice(1);
  return d;
}

/** Bandai phone1 shape — countryNo is ISO code (AU), matching storefront selects. */
export function toBandaiPhone1(raw) {
  const phoneNo = normalizeAuMsisdn(raw);
  return { countryNo: "AU", phoneNo, countryNoName: "Australia" };
}

function extractMessages(json) {
  if (!json) return [];
  if (Array.isArray(json?.messages)) return json.messages;
  if (Array.isArray(json?.msg)) return json.msg;
  if (typeof json?.msg === "string" && json.msg) return [json.msg];
  if (typeof json?.message === "string" && json.message) return [json.message];
  if (Array.isArray(json?.response)) {
    const out = [];
    for (const row of json.response) {
      if (row?.msg) out.push(row.msg);
      if (Array.isArray(row?.messages)) out.push(...row.messages);
    }
    return out;
  }
  if (json?.response && typeof json.response === "object" && json.response.msg) {
    return [json.response.msg];
  }
  return [];
}

export default createOnlinesimClient;
