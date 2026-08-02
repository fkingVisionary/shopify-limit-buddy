// Proxy-aware HTTP client.
//
// Transports:
//   undici        — Node TLS; stable, but Hyper docs flag it as detectable for Akamai
//   tls           — in-process node-tls-client chrome_131 (opt-in; can empty-502 Fastify)
//   tls-worker    — same chrome_131 in a child process (crash-isolated; Kmart default via checkout.js)
//
// Module surface:
//   makeDispatcher(proxyUrl) → opaque per-task dispatcher (undici or in-process tls)
//   makeRemoteTlsDispatcher  → child-process chrome_131 dispatcher
//   createJar()              → name-keyed cookie jar (same shape as before)
//   request(url, opts, ctx)  → fetch-Response-like wrapper
//   UA                       → Chrome / macOS user-agent string

import { ProxyAgent, fetch as undiciFetch } from "undici";
import { ensureTlsNativeLib } from "./ensure-tls-native.js";
import { makeRemoteTlsDispatcher as makeRemoteTlsDispatcherInner } from "./tls-bridge.js";
import {
  payForensics,
  classifyPayWireStage,
  PAY_WIRE_HOST_RE,
  ISSUER_PATH_RE,
  ACS_OR_REDIRECT_RE,
} from "./pay-forensics.js";

// Platform-matched Chrome 131 — Mac UA on Windows desktop was a shared tell
// on undici pre-pay / BigPay hops (dual-Revolut angle A presentation).
const UA_WIN =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const UA_MAC =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const UA = process.platform === "win32" ? UA_WIN : UA_MAC;

/** Child-process chrome_131 dispatcher (crash-isolated). Accepts raw proxy strings. */
export async function makeRemoteTlsDispatcher(rawProxy = null, opts = {}) {
  const url = rawProxy ? parseProxy(rawProxy) : null;
  const rawProxyLen = rawProxy ? String(rawProxy).length : 0;
  if (rawProxy && !url) {
    return {
      proxy: null,
      useTls: true,
      remoteTls: null,
      transport: "tls-worker",
      sticky: false,
      rawProxyLen,
      proxyParseFailed: true,
      undiciDispatcher() {
        return undefined;
      },
      async tlsSession() {
        return null;
      },
      async resetUndici() {},
      async close() {},
    };
  }
  const dispatcher = await makeRemoteTlsDispatcherInner(url, opts);
  dispatcher.rawProxyLen = rawProxyLen;
  dispatcher.proxyParseFailed = false;
  dispatcher.sticky = isStickyProxyUrl(url);
  return dispatcher;
}

// Lazy global TLS init. node-tls-client spawns a piscina worker pool that
// hosts the Go shared library; initTLS must be awaited once before the first
// Session is constructed. Cache the promise so concurrent callers share it.
let tlsInitPromise = null;
let tlsClientModulePromise = null;
async function loadTlsClient() {
  if (!tlsClientModulePromise) tlsClientModulePromise = import("node-tls-client");
  return tlsClientModulePromise;
}
async function ensureTls() {
  ensureTlsNativeLib();
  const { initTLS } = await loadTlsClient();
  if (!tlsInitPromise) tlsInitPromise = initTLS();
  return tlsInitPromise;
}

const RAW_TRANSPORT = (process.env.EXECUTOR_HTTP_TRANSPORT ?? "undici").toLowerCase();
export const HTTP_TRANSPORT = RAW_TRANSPORT === "tls" ? "tls" : "undici";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryableNetworkError(error) {
  const msg = String(error?.message ?? error).toLowerCase();
  const causeMsg = String(error?.cause?.message ?? "").toLowerCase();
  const code = error?.code ?? error?.cause?.code;
  const combined = `${msg} ${causeMsg}`;
  return (
    code === "ECONNRESET" ||
    code === "ECONNREFUSED" ||
    code === "UND_ERR_SOCKET" ||
    code === "UND_ERR_CONNECT_TIMEOUT" ||
    code === "UND_ERR_HEADERS_TIMEOUT" ||
    code === "UND_ERR_BODY_TIMEOUT" ||
    combined.includes("client network socket disconnected") ||
    combined.includes("other side closed") ||
    combined.includes("socket hang up") ||
    combined.includes("fetch failed")
  );
}

// Chrome 124 request header order. The exact ordering matters — Akamai
// inspects it as part of the bot score. This matches a real Chrome 124
// navigation/CORS request (cookie always last).
// Chrome-ish CORS/navigation order for node-tls-client. Omit `connection`
// (HTTP/1.1 tell; Chrome H2 does not send it). Include `content-type` so
// sensor POSTs are not appended after cookie.
const CHROME_HEADER_ORDER = [
  "host",
  "cache-control",
  "sec-ch-ua",
  "sec-ch-ua-arch",
  "sec-ch-ua-bitness",
  "sec-ch-ua-full-version",
  "sec-ch-ua-full-version-list",
  "sec-ch-ua-mobile",
  "sec-ch-ua-model",
  "sec-ch-ua-platform",
  "sec-ch-ua-platform-version",
  "upgrade-insecure-requests",
  "user-agent",
  "accept",
  "content-type",
  "origin",
  "sec-fetch-site",
  "sec-fetch-mode",
  "sec-fetch-user",
  "sec-fetch-dest",
  "referer",
  "accept-encoding",
  "accept-language",
  "priority",
  "cookie",
];

// Accept "user:pass@host:port", "host:port:user:pass", "user:pass:host:port",
// "host:port", or full "http://user:pass@host:port". Proxy providers often
// include raw special characters in usernames/passwords, so do not rely on the
// URL constructor until after credentials are split and encoded.
export function parseProxy(raw) {
  if (!raw) return null;
  let s = String(raw).trim();
  if (!s) return null;

  const schemeMatch = s.match(/^(https?|socks5?):\/\//i);
  const scheme = schemeMatch ? schemeMatch[1].toLowerCase() : "http";
  let rest = schemeMatch ? s.slice(schemeMatch[0].length) : s;

  const safeDecode = (value) => {
    try {
      return decodeURIComponent(value);
    } catch {
      return value;
    }
  };
  const build = (host, port, user, pass) => {
    if (!host || !/^\d{1,5}$/.test(String(port ?? ""))) return null;
    const n = Number(port);
    if (n <= 0 || n > 65535) return null;
    const auth = user != null ? `${encodeURIComponent(safeDecode(user))}:${encodeURIComponent(safeDecode(pass ?? ""))}@` : "";
    return `${scheme}://${auth}${host}:${port}`;
  };

  if (rest.includes("@")) {
    const at = rest.lastIndexOf("@");
    const auth = rest.slice(0, at);
    const hostPort = rest.slice(at + 1);
    const colon = hostPort.lastIndexOf(":");
    if (colon <= 0) return null;
    const userColon = auth.indexOf(":");
    if (userColon <= 0) return null;
    return build(hostPort.slice(0, colon), hostPort.slice(colon + 1), auth.slice(0, userColon), auth.slice(userColon + 1));
  }

  const parts = rest.split(":");
  if (parts.length === 2) return build(parts[0], parts[1]);
  if (parts.length >= 4 && /^\d{1,5}$/.test(parts[1])) {
    const [host, port, user, ...passParts] = parts;
    return build(host, port, user, passParts.join(":"));
  }
  if (parts.length >= 4 && /^\d{1,5}$/.test(parts[parts.length - 1])) {
    const port = parts[parts.length - 1];
    const host = parts[parts.length - 2];
    const user = parts[0];
    const pass = parts.slice(1, -2).join(":");
    return build(host, port, user, pass);
  }
  return null;
}

// Per-task dispatcher. Holds the proxy URL and a lazily-constructed Session.
// `close()` should be called from the task entry-point in a finally block
// (see checkout.js / server.js recon handler).
/** Optional hint for undici ProxyAgent reuse only — never a run gate. */
function isStickyProxyUrl(proxyUrl) {
  return /session-[A-Za-z0-9]+|sessid=|sessionid=/i.test(String(proxyUrl || ""));
}

class Dispatcher {
  constructor(proxyUrl, useTls) {
    this.proxy = proxyUrl;
    this.useTls = useTls;
    this.transport = useTls ? "tls" : "undici";
    this.sticky = isStickyProxyUrl(proxyUrl);
    this._tlsSession = null;
    this._proxyAgent = null;
  }
  undiciDispatcher() {
    if (!this.proxy) return undefined;
    if (!this._proxyAgent) {
      // Longer connect timeout for residential CONNECT tunnels.
      this._proxyAgent = new ProxyAgent({
        uri: this.proxy,
        connect: { timeout: this.sticky ? 45_000 : 20_000 },
      });
    }
    return this._proxyAgent;
  }
  async tlsSession() {
    if (this._tlsSession) return this._tlsSession;
    await ensureTls();
    const { Session, ClientIdentifier } = await loadTlsClient();
    this._tlsSession = new Session({
      // node-tls-client@2.1.0 only ships Chrome profiles up to 131. Passing an
      // unsupported identifier silently falls back while our headers still say
      // 133, creating a TLS/UA mismatch that Akamai scores hard.
      clientIdentifier: ClientIdentifier.chrome_131,
      timeout: 30_000,
      headerOrder: CHROME_HEADER_ORDER,
      ...(this.proxy ? { proxy: this.proxy } : {}),
    });
    return this._tlsSession;
  }
  async close() {
    if (this._issuerRemoteTls) {
      try {
        await this._issuerRemoteTls.close?.();
      } catch {
        /* ignore */
      }
      this._issuerRemoteTls = null;
    }
    if (this._tlsSession) {
      try {
        await this._tlsSession.close();
      } catch {
        /* ignore */
      }
      this._tlsSession = null;
    }
    if (this._proxyAgent) {
      try {
        await this._proxyAgent.close();
      } catch {
        /* ignore */
      }
      this._proxyAgent = null;
    }
  }

  async resetUndici() {
    // Sticky residential: recreating the agent can still keep session-id but
    // often drops mid-challenge TCP state; prefer reuse unless forced.
    if (!this._proxyAgent) return;
    try {
      await this._proxyAgent.close();
    } catch {
      /* ignore */
    }
    this._proxyAgent = null;
  }
}

export { isStickyProxyUrl };

export function makeDispatcher(rawProxy, opts = {}) {
  const url = parseProxy(rawProxy);
  // TLS is intentionally opt-in. A native node-tls-client crash can kill the
  // whole process before Fastify serializes an error, which appears upstream as
  // an empty 502. Proxies no longer imply TLS; use EXECUTOR_HTTP_TRANSPORT=tls
  // or per-task transport=tls/forceTls=true when deliberately testing it.
  const useTls = !opts.forceUndici && (opts.forceTls || HTTP_TRANSPORT === "tls");
  // Even direct (no-proxy) requests need a Session so they share the Chrome
  // fingerprint; we always return a Dispatcher, never null.
  const dispatcher = new Dispatcher(url, useTls);
  dispatcher.rawProxyLen = rawProxy ? String(rawProxy).length : 0;
  dispatcher.proxyParseFailed = Boolean(rawProxy) && !url;
  return dispatcher;
}

function abckMarkerIndex(value) {
  const m = String(value ?? "").match(/~(-?\d+)~/);
  return m ? Number(m[1]) : null;
}

// Tiny cookie jar — name-keyed (not domain-keyed) on purpose so the
// www.kmart.com.au → api.kmart.com.au _abck handoff in kmart.js still works
// the way it did under undici.
export function createJar() {
  const store = new Map(); // name -> value
  // SoftBlock Access Denied pages Set-Cookie a fresh `_abck` with ind=-1.
  // Because the jar is name-keyed (no Domain), that clobber wipes a Hyper-
  // solved ~0~ cookie and every later WWW/API call looks unsolved. Refuse
  // demotions once we hold a solved cookie (explicit set/load still wins).
  // Lesson from 203950c / PR #36 — keep this even when rolling tip to a1d9.
  const shouldKeepExistingAbck = (incoming) => {
    const prev = store.get("_abck");
    const prevIdx = abckMarkerIndex(prev);
    const nextIdx = abckMarkerIndex(incoming);
    return prevIdx === 0 && nextIdx !== 0;
  };
  const ingestSetCookie = (arr) => {
    if (!arr) return;
    const list = Array.isArray(arr) ? arr : [arr];
    for (const sc of list) {
      if (!sc) continue;
      const [pair] = String(sc).split(";");
      const eq = pair.indexOf("=");
      if (eq > 0) {
        const name = pair.slice(0, eq).trim();
        const value = pair.slice(eq + 1).trim();
        if (name === "_abck" && shouldKeepExistingAbck(value)) continue;
        store.set(name, value);
      }
    }
  };
  return {
    // Accepts either an object with getSetCookie() (fetch-style) or a plain
    // headers object whose "set-cookie" is a string|string[] (node-tls-client).
    ingest(headers) {
      if (!headers) return;
      if (typeof headers.getSetCookie === "function") {
        ingestSetCookie(headers.getSetCookie());
        return;
      }
      const raw = headers["set-cookie"] ?? headers["Set-Cookie"];
      ingestSetCookie(raw);
    },
    header() {
      return [...store.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
    },
    has(name) {
      return store.has(name);
    },
    get(name) {
      return store.get(name);
    },
    set(name, value) {
      if (!name) return;
      store.set(String(name), String(value ?? ""));
    },
    // Bulk-load name→value cookies (e.g. Playwright context → HTTP jar handoff).
    load(obj) {
      if (!obj || typeof obj !== "object") return 0;
      let n = 0;
      for (const [k, v] of Object.entries(obj)) {
        if (!k || v == null) continue;
        store.set(String(k), String(v));
        n++;
      }
      return n;
    },
    dump() {
      return Object.fromEntries(store);
    },
  };
}

// Wraps a node-tls-client Response so callers see a fetch-Response-like API:
// `.status`, `.url`, `.ok`, `.text()`, `.json()`, `.headers.get(name)`,
// `.headers.getSetCookie()`. The body is already buffered as a string by
// node-tls-client; we just memoize it.
function wrapResponse(res, requestedUrl) {
  const rawHeaders = res.headers ?? {};
  const headers = {
    get(name) {
      const v = rawHeaders[String(name).toLowerCase()];
      if (v == null) return null;
      return Array.isArray(v) ? v.join(", ") : String(v);
    },
    getSetCookie() {
      const v = rawHeaders["set-cookie"] ?? rawHeaders["Set-Cookie"];
      if (!v) return [];
      return Array.isArray(v) ? v : [String(v)];
    },
    raw: rawHeaders,
  };
  return {
    status: res.status,
    ok: res.ok,
    url: res.url ?? requestedUrl,
    headers,
    async text() {
      return res.body ?? (await res.text());
    },
    async json() {
      const txt = res.body ?? (await res.text());
      return JSON.parse(txt);
    },
  };
}

function wrapFetchResponse(res, requestedUrl) {
  return {
    status: res.status,
    ok: res.ok,
    url: res.url || requestedUrl,
    headers: {
      get(name) {
        return res.headers.get(name);
      },
      getSetCookie() {
        if (typeof res.headers.getSetCookie === "function") return res.headers.getSetCookie();
        const v = res.headers.get("set-cookie");
        return v ? [v] : [];
      },
      raw: res.headers,
    },
    text() {
      return res.text();
    },
    json() {
      return res.json();
    },
  };
}

function lowerHeaderMap(existingHeaders = {}) {
  const existing = {};
  for (const [k, v] of Object.entries(existingHeaders || {})) {
    existing[String(k).toLowerCase()] = v;
  }
  return existing;
}

function secFetchSite(host, origin) {
  let site = "cross-site";
  const hostName = String(host || "").replace(/:\d+$/, "");
  if (!origin) return site;
  try {
    const o = new URL(origin);
    if (o.host === host || o.hostname === hostName) return "same-origin";
    const base = (h) => String(h || "").split(".").slice(-2).join(".");
    if (base(o.hostname) && base(o.hostname) === base(hostName)) return "same-site";
  } catch {
    /* keep cross-site */
  }
  return site;
}

/**
 * Chrome Client Hints aligned to the spoofed UA (dual-Revolut angle A).
 * Opt out: PAY_CHROME_CH=0. Callers that already set sec-ch-ua win.
 */
export function chromeClientHints(userAgent = UA, existingHeaders = {}) {
  if (process.env.PAY_CHROME_CH === "0") return {};
  const existing = lowerHeaderMap(existingHeaders);
  if (existing["sec-ch-ua"] != null) return {};
  const ua = String(userAgent || existing["user-agent"] || UA);
  const platform = /Windows NT/i.test(ua)
    ? "Windows"
    : /Macintosh/i.test(ua)
      ? "macOS"
      : "Linux";
  return {
    "sec-ch-ua": `"Google Chrome";v="131", "Chromium";v="131", "Not_A Brand";v="24"`,
    "sec-ch-ua-mobile": "?0",
    "sec-ch-ua-platform": `"${platform}"`,
  };
}

/**
 * Chrome Sec-Fetch-* for pay-host / issuer mutates when the caller omitted them.
 * Covers GE prepay (handleaction/save) and BigPay — not issuer paths only.
 * Opt out: PAY_ISSUER_CHROME_NAV=0. Callers that already set sec-fetch-mode win.
 */
export function chromePayFetchHeaders(url, existingHeaders = {}) {
  if (process.env.PAY_ISSUER_CHROME_NAV === "0") return {};
  const existing = lowerHeaderMap(existingHeaders);
  if (existing["sec-fetch-mode"] != null) return {};
  let host = "";
  let path = "";
  try {
    const u = new URL(String(url || ""));
    host = u.host;
    path = u.pathname;
  } catch {
    return {};
  }
  const issuerLike =
    ISSUER_PATH_RE.test(path) || /payments\.bigcommerce\.com/i.test(host);
  const payHost = PAY_WIRE_HOST_RE.test(host);
  if (!issuerLike && !payHost) return {};

  const ct = String(existing["content-type"] || "");
  const xhrHint = /XMLHttpRequest/i.test(String(existing["x-requested-with"] || ""));
  // JSON/API / XHR pay hops are cors/empty in a real browser — never document-navigate.
  // Toymate BigPay ×1 used cors/empty on the issuer POST. GE HandleCreditCard was
  // classified as document-navigate (form POST) — A/B: match BigPay presentation.
  // Opt out: PAY_ISSUER_FORM_AS_CORS=0 → restore navigate/document for form issuer.
  const issuerFormAsCors =
    issuerLike && process.env.PAY_ISSUER_FORM_AS_CORS !== "0";
  const isJsonOrXhr =
    /application\/json/i.test(ct) ||
    /payments\.bigcommerce\.com/i.test(host) ||
    xhrHint ||
    /checkoutv2\/(handleaction|save)/i.test(path) ||
    issuerFormAsCors;

  const site = secFetchSite(host, existing.origin || "");
  if (isJsonOrXhr) {
    return {
      "sec-fetch-site": site,
      "sec-fetch-mode": "cors",
      "sec-fetch-dest": "empty",
    };
  }

  const out = {
    "sec-fetch-site": site,
    "sec-fetch-mode": "navigate",
    "sec-fetch-dest": "document",
    "sec-fetch-user": "?1",
  };
  if (existing["upgrade-insecure-requests"] == null) {
    out["upgrade-insecure-requests"] = "1";
  }
  if (existing["cache-control"] == null) {
    out["cache-control"] = "max-age=0";
  }
  return out;
}

/** @deprecated use chromePayFetchHeaders — kept for existing imports/tests */
export function chromeIssuerNavigateHeaders(url, existingHeaders = {}) {
  return chromePayFetchHeaders(url, existingHeaders);
}

function parsePayUrl(url) {
  try {
    const u = new URL(String(url || ""));
    return { host: u.host, path: u.pathname };
  } catch {
    return { host: null, path: null };
  }
}

function shouldAuditPayWire(host, pathName) {
  const payHost = Boolean(host && PAY_WIRE_HOST_RE.test(host));
  const issuerLike =
    Boolean(pathName && ISSUER_PATH_RE.test(pathName)) ||
    /payments\.bigcommerce\.com/i.test(String(host || ""));
  const forceAll = process.env.PAY_WIRE_AUDIT === "1";
  // Angle B: always audit pay-host mutates (handleaction/save/BigPay), not only issuer paths.
  return issuerLike || payHost || forceAll;
}

function auditPayWire(url, method, opts) {
  if (!/^(POST|PUT|PATCH|DELETE)$/i.test(method)) return;
  const { host, path: pathName } = parsePayUrl(url);
  if (!host) return;
  const issuerLike =
    ISSUER_PATH_RE.test(pathName || "") || /payments\.bigcommerce\.com/i.test(host);
  const payHost = PAY_WIRE_HOST_RE.test(host);
  if (!shouldAuditPayWire(host, pathName)) return;
  try {
    payForensics("http_mutate", {
      method,
      host,
      path: String(pathName || "").slice(0, 180),
      bodyBytes: opts?.body != null ? String(opts.body).length : 0,
      payHost,
      issuerLike,
      stage: classifyPayWireStage(host, pathName),
      retryOpt:
        opts?.retry === true ? true : opts?.retry === false ? false : null,
      allowMutationRetry: opts?.allowMutationRetry === true,
    });
  } catch {
    /* forensics must never break checkout */
  }
}

/** Angle A/B: response side of pay-host mutates (status + Location, no body). */
function auditPayWireResponse(url, method, opts, resMeta = {}) {
  if (!/^(POST|PUT|PATCH|DELETE)$/i.test(method)) return;
  const { host, path: pathName } = parsePayUrl(url);
  if (!host || !shouldAuditPayWire(host, pathName)) return;
  let locationHost = null;
  let locationPath = null;
  const loc = resMeta.location != null ? String(resMeta.location) : "";
  if (loc) {
    try {
      const abs = /^https?:\/\//i.test(loc) ? loc : new URL(loc, url).href;
      const u = new URL(abs);
      locationHost = u.host;
      locationPath = u.pathname.slice(0, 180);
    } catch {
      locationPath = loc.slice(0, 180);
    }
  }
  try {
    payForensics("http_mutate_response", {
      method,
      host,
      path: String(pathName || "").slice(0, 180),
      status: resMeta.status != null ? Number(resMeta.status) : null,
      locationHost,
      locationPath,
      locationLooksAcs: Boolean(loc && ACS_OR_REDIRECT_RE.test(loc)),
      undiciAttempts:
        resMeta.undiciAttempts != null ? Number(resMeta.undiciAttempts) : null,
      payTransport: resMeta.payTransport || null,
      payHost: PAY_WIRE_HOST_RE.test(host),
      issuerLike:
        ISSUER_PATH_RE.test(pathName || "") ||
        /payments\.bigcommerce\.com/i.test(host),
      stage: classifyPayWireStage(host, pathName),
    });
  } catch {
    /* forensics must never break checkout */
  }
}

function readResponseLocation(res) {
  try {
    if (typeof res?.headers?.get === "function") {
      return res.headers.get("location") || res.headers.get("Location") || "";
    }
    const h = res?.headers;
    if (h && typeof h === "object") {
      return h.location || h.Location || "";
    }
  } catch {
    /* ignore */
  }
  return "";
}

function finalizePayResponse(url, method, opts, res) {
  try {
    auditPayWireResponse(url, method, opts, {
      status: res?.status,
      location: readResponseLocation(res),
      undiciAttempts: res?.undiciAttempts,
      payTransport: res?.payTransport || null,
    });
  } catch {
    /* ignore */
  }
  return res;
}

/**
 * Dual-Revolut: pay hops on chrome_131 tls-worker (Kmart-like bank TLS).
 *
 * Toymate BigPay @14:54 — issuer tls-worker → Revolut×1 (locked).
 * Bandai already ran issuer/prepay/GE-all tls-worker and still ×2 — keep
 * issuer+prepay tls ON and work outward (Sec-Fetch cors parity next).
 * PAY_GE_TLS_WORKER default OFF (GE-all-tls ×2 + gepi EOF flake).
 *
 * Defaults ON:
 *   PAY_ISSUER_TLS_WORKER   — issuer stage (opt out =0)
 *   PAY_PAYHOST_TLS_WORKER  — prepay mutates (opt out =0)
 *   PAY_ISSUER_FORM_AS_CORS — GE form issuer Sec-Fetch cors/empty like BigPay
 * Opt-in:
 *   PAY_GE_TLS_WORKER=1     — any global-e.com hop incl GET
 * Merchant cart ATC stays undici (stage=other).
 */
export function shouldUseIssuerTlsWorker(url, method) {
  const { host, path: pathName } = parsePayUrl(url);
  if (!host) return false;
  // Opt-in only — default off after GE-all-tls scored ×2 and flaked GetCartToken.
  if (/global-e\.com/i.test(host) && process.env.PAY_GE_TLS_WORKER === "1") {
    return true;
  }
  if (!/^(POST|PUT|PATCH|DELETE)$/i.test(method || "")) return false;
  const stage = classifyPayWireStage(host, pathName);
  if (stage === "issuer") {
    return process.env.PAY_ISSUER_TLS_WORKER !== "0";
  }
  if (stage === "prepay") {
    return process.env.PAY_PAYHOST_TLS_WORKER !== "0";
  }
  return false;
}

async function ensureIssuerRemoteTls(dispatcher) {
  if (!dispatcher || dispatcher.remoteTls) return dispatcher?.remoteTls ? dispatcher : null;
  if (dispatcher._issuerRemoteTls?.remoteTls) return dispatcher._issuerRemoteTls;
  if (dispatcher._issuerRemoteTlsFailed) return null;
  try {
    const remote = await makeRemoteTlsDispatcher(dispatcher.proxy || null);
    if (!remote?.remoteTls) {
      dispatcher._issuerRemoteTlsFailed = true;
      payForensics("issuer_tls_worker_init_failed", {
        error: "remoteTls_missing",
        proxy: Boolean(dispatcher.proxy),
      });
      return null;
    }
    dispatcher._issuerRemoteTls = remote;
    payForensics("issuer_tls_worker_ready", {
      proxy: Boolean(dispatcher.proxy),
      sticky: Boolean(dispatcher.sticky),
    });
    return remote;
  } catch (e) {
    dispatcher._issuerRemoteTlsFailed = true;
    payForensics("issuer_tls_worker_init_failed", {
      error: String(e?.message || e).slice(0, 160),
      proxy: Boolean(dispatcher.proxy),
    });
    return null;
  }
}

export async function request(url, opts, ctx) {
  const { dispatcher, jar, extraHeaders } = ctx;
  const method = (opts?.method ?? "GET").toUpperCase();
  auditPayWire(url, method, opts);
  // Optional GE mutate wire log (Bandai double-auth forensics).
  if (process.env.BANDAI_GE_WIRE_TAP === "1") {
    try {
      const u = String(url || "");
      if (/global-e\.com/i.test(u) && method !== "GET" && method !== "HEAD" && method !== "OPTIONS") {
        const fs = await import("node:fs");
        const row = {
          t: new Date().toISOString(),
          method,
          url: u,
          bodyBytes: opts?.body != null ? String(opts.body).length : 0,
          issuer: /HandleCreditCard/i.test(u),
        };
        let arr = [];
        try {
          arr = JSON.parse(fs.readFileSync("/tmp/bandai-ge-wire.json", "utf8"));
        } catch {
          /* ignore */
        }
        arr.push(row);
        fs.writeFileSync("/tmp/bandai-ge-wire.json", JSON.stringify(arr, null, 2));
        console.log("WIRE_TAP", method, u.slice(0, 160), "issuer=" + row.issuer);
      }
    } catch {
      /* ignore */
    }
  }

  // Build headers. We let the caller override anything; defaults are minimal
  // because adapters (kmart.js especially) build full Chrome navigation
  // headers themselves. Pay-host mutates get Chrome CH + Sec-Fetch when omitted
  // (dual-Revolut angle A — presentation shared by Bandai prepay + Toymate BigPay).
  const mergedCallerHeaders = {
    ...(extraHeaders ?? {}),
    ...(opts?.headers ?? {}),
  };
  const callerUa =
    mergedCallerHeaders["user-agent"] ||
    mergedCallerHeaders["User-Agent"] ||
    UA;
  const headers = {
    "user-agent": UA,
    accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "accept-language": "en-AU,en;q=0.9",
    ...(jar.header() ? { cookie: jar.header() } : {}),
    ...chromeClientHints(callerUa, mergedCallerHeaders),
    ...(method === "POST" || method === "PUT"
      ? chromePayFetchHeaders(url, mergedCallerHeaders)
      : {}),
    ...mergedCallerHeaders,
  };

  // Crash-isolated chrome_131 (Hyper TLS-first). Prefer over in-process useTls
  // — native faults stay in the worker and cannot empty-502 Fastify.
  // Dual-Revolut: issuer/pay POSTs prefer tls-worker even when the task dispatcher
  // is undici (Kmart bank was Chromium TLS; post-Kmart modules charged via undici).
  let issuerRemote = null;
  if (!dispatcher?.remoteTls && shouldUseIssuerTlsWorker(url, method)) {
    issuerRemote = await ensureIssuerRemoteTls(dispatcher);
  }
  const remoteTls = dispatcher?.remoteTls || issuerRemote?.remoteTls || null;
  if (remoteTls) {
    try {
      const res = await remoteTls.request(url, {
        method,
        headers,
        body: opts?.body,
      });
      jar.ingest({ getSetCookie: () => res.headers.getSetCookie() });
      if (res && typeof res === "object") res.payTransport = "tls-worker";
      return finalizePayResponse(url, method, opts, res);
    } catch (e) {
      // Issuer tls-worker flake → one undici fallback (still single attempt).
      if (!issuerRemote) throw e;
      payForensics("issuer_tls_worker_fallback_undici", {
        error: String(e?.message || e).slice(0, 160),
        host: parsePayUrl(url).host,
      });
    }
  }

  if (!dispatcher.useTls) {
    // Proxied residential sessions often RST mid-SBSD / mid-nav. Retry GET/HEAD
    // only — NEVER retry POST/PUT/PATCH/DELETE (unless allowMutationRetry).
    // A RST replay after GE/PSP already accepted the pay POST produced paired
    // Revolut auths (app posts=1, two bank lines) on 2026-07-22 labs.
    // `retry:true` alone must NOT re-arm mutation retries.
    const isSafeMethod =
      method === "GET" || method === "HEAD" || method === "OPTIONS";
    const safeRetry = isSafeMethod
      ? opts?.retry !== false
      : opts?.allowMutationRetry === true;
    const attempts = safeRetry ? 3 : 1;
    let lastError;
    let undiciAttempts = 0;
    // Opt-in: fresh ProxyAgent for issuer POST (PAY_ISSUER_FRESH_UNDICI=1).
    // Default off so the tls-worker A/B is not confounded by agent recycle.
    // Use with PAY_ISSUER_TLS_WORKER=0 to test pooled-undici vs fresh-undici alone.
    const wantFreshUndici = process.env.PAY_ISSUER_FRESH_UNDICI === "1";
    if (
      wantFreshUndici &&
      classifyPayWireStage(parsePayUrl(url).host, parsePayUrl(url).path) === "issuer"
    ) {
      try {
        await dispatcher.resetUndici?.();
      } catch {
        /* ignore */
      }
    }
    const timeoutMs = Number(opts?.timeoutMs);
    const headersTimeout =
      Number(opts?.headersTimeout) > 0
        ? Number(opts.headersTimeout)
        : timeoutMs > 0
          ? timeoutMs
          : undefined;
    const bodyTimeout =
      Number(opts?.bodyTimeout) > 0
        ? Number(opts.bodyTimeout)
        : timeoutMs > 0
          ? timeoutMs
          : undefined;
    const signal =
      opts?.signal ||
      (timeoutMs > 0 && typeof AbortSignal !== "undefined" && AbortSignal.timeout
        ? AbortSignal.timeout(timeoutMs)
        : undefined);

    for (let attempt = 0; attempt < attempts; attempt++) {
      try {
        undiciAttempts += 1;
        const res = await undiciFetch(url, {
          method,
          headers,
          redirect: "manual",
          dispatcher: dispatcher.undiciDispatcher(),
          ...(opts?.body !== undefined ? { body: opts.body } : {}),
          ...(signal ? { signal } : {}),
          ...(headersTimeout != null ? { headersTimeout } : {}),
          ...(bodyTimeout != null ? { bodyTimeout } : {}),
        });
        jar.ingest({ getSetCookie: () => wrapFetchResponse(res, url).headers.getSetCookie() });
        const wrapped = wrapFetchResponse(res, url);
        wrapped.undiciAttempts = undiciAttempts;
        wrapped.payTransport = issuerRemote ? "undici-fallback" : "undici";
        return finalizePayResponse(url, method, opts, wrapped);
      } catch (e) {
        lastError = e;
        if (attempt >= attempts - 1 || !isRetryableNetworkError(e)) {
          if (lastError && typeof lastError === "object") {
            lastError.undiciAttempts = undiciAttempts;
            // Surface undici/node cause codes (timeout vs RST) for issuer scoring.
            const cause = lastError.cause;
            if (cause && typeof cause === "object") {
              lastError.causeCode = cause.code || cause.name || null;
              lastError.causeMessage = cause.message || null;
            }
            if (lastError.name === "TimeoutError" || lastError.code === "ABORT_ERR") {
              lastError.timedOut = true;
            }
          }
          throw e;
        }
        const rebuildAgent = !dispatcher.sticky || attempt >= attempts - 2;
        if (rebuildAgent) {
          try { await dispatcher.resetUndici?.(); } catch { /* ignore */ }
        }
        await sleep(500 + attempt * 800);
      }
    }
    throw lastError;
  }

  // Native TLS experiment path. Kept opt-in because a native library failure
  // can terminate the process before Fastify can return JSON.
  const session = await dispatcher.tlsSession();
  const reqOpts = {
    headers,
    followRedirects: false,
    ...(opts?.body !== undefined ? { body: opts.body } : {}),
  };

  let res;
  switch (method) {
    case "GET":
      res = await session.get(url, reqOpts);
      break;
    case "POST":
      res = await session.post(url, reqOpts);
      break;
    case "PUT":
      res = await session.put(url, reqOpts);
      break;
    case "DELETE":
      res = await session.delete(url, reqOpts);
      break;
    case "PATCH":
      res = await session.patch(url, reqOpts);
      break;
    case "HEAD":
      res = await session.head(url, reqOpts);
      break;
    default:
      throw new Error(`unsupported method: ${method}`);
  }

  // Capture cookies from this response into the jar.
  jar.ingest(res.headers);
  const wrappedTls = wrapResponse(res, url);
  if (wrappedTls && typeof wrappedTls === "object") wrappedTls.payTransport = "tls";
  return finalizePayResponse(url, method, opts, wrappedTls);
}

export { UA, UA_WIN, UA_MAC };
