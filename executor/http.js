// Proxy-aware HTTP client. Default transport is undici because it is stable and
// returns adapter timelines instead of crashing the executor. The native
// node-tls-client path is still available behind EXECUTOR_HTTP_TRANSPORT=tls or
// per-task transport=tls for controlled TLS experiments, but it is not the
// default after repeated empty 502s from native crashes.
//
// Module surface:
//   makeDispatcher(proxyUrl) → opaque per-task dispatcher (carries the Session)
//   createJar()              → name-keyed cookie jar (same shape as before)
//   request(url, opts, ctx)  → fetch-Response-like wrapper
//   UA                       → Chrome / macOS user-agent string

import { ProxyAgent, fetch as undiciFetch } from "undici";

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

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
    combined.includes("fetch failed") ||
    // d60eeee: ISP undici tunnels often surface these mid-SBSD / mid-nav.
    combined.includes("request was cancelled") ||
    combined.includes("aborted")
  );
}

// Chrome 124 request header order. The exact ordering matters — Akamai
// inspects it as part of the bot score. This matches a real Chrome 124
// navigation/CORS request (cookie always last).
const CHROME_HEADER_ORDER = [
  "host",
  "connection",
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
/**
 * Sticky residential markers in the proxy URL/username.
 * - Noontide / many AU resi: `session-TOKEN`
 * - IP Fist premium: `-sid-TOKEN` (+ optional `-f-country-xx` / `-l-MINS`)
 * - Generic: `sessid=` / `sessionid=`
 *
 * Dedicated ISP (bare IPv4 host) is NOT sticky — exit is the host itself.
 * a1d9f9c only matched session- tokens. Treating bare-IP as sticky (82d750f)
 * forced the residential sensor ladder (5 rounds + tunnel refresh) and broke
 * Hyper solve on static ISP (live: stickyUrl=1 → akamai_unsolved; prior tip
 * sticky=0 on same 45.42.47.235 → akamai_solved).
 */
function isStickyProxyUrl(proxyUrl) {
  return /session-[A-Za-z0-9]+|sessid=|sessionid=|-sid-[A-Za-z0-9]+/i.test(String(proxyUrl || ""));
}

function newStickySessionId() {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Pin a rotating gateway residential proxy to one exit for the whole checkout.
 * Without this, providers like IP Fist rotate mid-run → `_abck` invalid →
 * api.kmart.com.au GraphQL Access Denied after a green WWW solve.
 *
 * - Already-sticky URLs unchanged.
 * - Bare-IP ISP hosts unchanged (credentials must not be mutated).
 * - IP Fist → append `-f-country-au-sid-{id}-l-30` (or refresh existing `-sid-`).
 * - Other gateways → append `-session-{id}` to the username.
 *
 * @returns {{ proxy: string|null, pinned: boolean, reason: string, sessionId: string|null }}
 */
export function ensureStickyProxySession(rawProxy) {
  if (rawProxy == null || String(rawProxy).trim() === "") {
    return { proxy: null, pinned: false, reason: "none", sessionId: null };
  }
  const parsed = parseProxy(rawProxy);
  if (!parsed) {
    return { proxy: String(rawProxy), pinned: false, reason: "unparsed", sessionId: null };
  }
  let u;
  try {
    u = new URL(parsed);
  } catch {
    return { proxy: parsed, pinned: false, reason: "bad_url", sessionId: null };
  }
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(u.hostname)) {
    return { proxy: parsed, pinned: false, reason: "static_ip_host", sessionId: null };
  }
  if (!u.username) {
    return { proxy: parsed, pinned: false, reason: "no_user", sessionId: null };
  }

  let user = decodeURIComponent(u.username);
  const host = u.hostname.toLowerCase();
  const stamp = newStickySessionId();
  const isIpfist = /ipfist|premium-proxy/i.test(host);

  if (isIpfist) {
    if (/-sid-[A-Za-z0-9]+/i.test(user)) {
      user = user.replace(/-sid-[A-Za-z0-9]+/i, `-sid-${stamp}`);
    } else {
      if (!/-f-country-/i.test(user)) user = `${user}-f-country-au`;
      user = `${user}-sid-${stamp}`;
      if (!/-l-\d+/i.test(user)) user = `${user}-l-30`;
    }
  } else if (/session-[A-Za-z0-9]+/i.test(user) || /session-[A-Za-z0-9]+/i.test(parsed)) {
    // Already sticky (password/query) — leave alone.
    return { proxy: parsed, pinned: false, reason: "already_sticky", sessionId: null };
  } else if (/-sid-[A-Za-z0-9]+/i.test(user)) {
    user = user.replace(/-sid-[A-Za-z0-9]+/i, `-sid-${stamp}`);
  } else {
    user = `${user}-session-${stamp}`;
  }

  // URL.username setter handles encoding.
  u.username = user;
  return { proxy: u.toString(), pinned: true, reason: isIpfist ? "ipfist_sid" : "session_pin", sessionId: stamp };
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
    // opts.omitPrefixes / opts.omitNames: drop host-only cookies the browser
    // would not send (name-keyed jar otherwise overshares www → api).
    header(opts = null) {
      const omitNames = opts?.omitNames instanceof Set
        ? opts.omitNames
        : new Set(Array.isArray(opts?.omitNames) ? opts.omitNames : []);
      const omitPrefixes = Array.isArray(opts?.omitPrefixes) ? opts.omitPrefixes : [];
      return [...store.entries()]
        .filter(([k]) => {
          if (omitNames.has(k)) return false;
          for (const p of omitPrefixes) {
            if (p && k.startsWith(p)) return false;
          }
          return true;
        })
        .map(([k, v]) => `${k}=${v}`)
        .join("; ");
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

// Cloudflare `__cf_*` cookies are host-only on www; browsers do not attach them
// to api.kmart.com.au. Our name-keyed jar would otherwise overshare them on
// every api.* XHR (get-token / GraphQL) — slim HAR never lists `__cf_bm` there.
export function cookieHeaderForUrl(jar, url) {
  if (!jar?.header) return "";
  let host = "";
  try {
    host = new URL(url).hostname;
  } catch {
    host = "";
  }
  if (host === "api.kmart.com.au") {
    return jar.header({ omitPrefixes: ["__cf_"] });
  }
  return jar.header();
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

export async function request(url, opts, ctx) {
  const { dispatcher, jar, extraHeaders } = ctx;
  const method = (opts?.method ?? "GET").toUpperCase();

  // Build headers. We let the caller override anything; defaults are minimal
  // because adapters (kmart.js especially) build full Chrome navigation
  // headers themselves. Cookie header is host-scoped so www host-only
  // Cloudflare cookies are not overshared onto api.kmart.com.au.
  const scopedCookie = cookieHeaderForUrl(jar, url);
  const headers = {
    "user-agent": UA,
    accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "accept-language": "en-AU,en;q=0.9",
    ...(scopedCookie ? { cookie: scopedCookie } : {}),
    ...(extraHeaders ?? {}),
    ...(opts?.headers ?? {}),
  };

  if (!dispatcher.useTls) {
    // Proxied residential/ISP sessions often RST mid-SBSD / mid-nav. Retry with
    // the SAME ProxyAgent for sticky exits (session- pinned); only rebuild
    // the agent on the last retry or for non-sticky ISP/datacenter proxies.
    // ISP tunnels also surface undici "Request was cancelled" — give them more
    // attempts than direct so SBSD/script fetch can survive brief blips (d60eeee).
    const attempts = dispatcher.proxy ? 5 : 3;
    let lastError;
    for (let attempt = 0; attempt < attempts; attempt++) {
      try {
        const res = await undiciFetch(url, {
          method,
          headers,
          redirect: "manual",
          dispatcher: dispatcher.undiciDispatcher(),
          ...(opts?.body !== undefined ? { body: opts.body } : {}),
        });
        jar.ingest({ getSetCookie: () => wrapFetchResponse(res, url).headers.getSetCookie() });
        return wrapFetchResponse(res, url);
      } catch (e) {
        lastError = e;
        if (attempt >= attempts - 1 || !isRetryableNetworkError(e)) throw e;
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
  return wrapResponse(res, url);
}

export { UA };
