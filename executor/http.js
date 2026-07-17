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
//   UA                       → Chrome / Windows user-agent string (HAR-aligned)

import { ProxyAgent, fetch as undiciFetch } from "undici";

// Match kmart-slim.har OS family (Windows) + node-tls-client chrome_131 profile.
// Hyper: UA / sec-ch-ua / TLS profile majors must agree.
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

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
// bogdanfinn pool can stick in a bad CONNECT state after undici ProxyAgent
// activity or a proxy 403 — destroy + re-init before opening a fresh Session.
async function refreshTlsPool() {
  const mod = await loadTlsClient();
  try {
    if (typeof mod.destroyTLS === "function") await mod.destroyTLS();
  } catch {
    /* ignore */
  }
  tlsInitPromise = null;
  await ensureTls();
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
    code === "UND_ERR_ABORTED" ||
    code === "ABORT_ERR" ||
    combined.includes("client network socket disconnected") ||
    combined.includes("other side closed") ||
    combined.includes("socket hang up") ||
    combined.includes("fetch failed") ||
    combined.includes("request was cancelled") ||
    combined.includes("aborted")
  );
}

// Chrome header order for node-tls-client (undici ignores this list).
// Hyper tls-and-headers.md: when `priority` is present, `cookie` MUST sit
// immediately before it — TLS clients auto-append cookie last, so omitting
// cookie from the order yields `…, priority, cookie` (bot tell).
// Navigation shape (low-entropy CH only; high-entropy omitted until Accept-CH).
const CHROME_HEADER_ORDER = [
  "host",
  "connection",
  "cache-control",
  "sec-ch-ua",
  "sec-ch-ua-mobile",
  "sec-ch-ua-platform",
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
  "cookie",
  "priority",
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
class Dispatcher {
  constructor(proxyUrl, useTls) {
    this.proxy = proxyUrl;
    this.useTls = useTls;
    this.transport = useTls ? "tls" : "undici";
    this._tlsSession = null;
    this._proxyAgent = null;
    this._tlsBootstrapped = false;
  }
  undiciDispatcher() {
    if (!this.proxy) return undefined;
    if (!this._proxyAgent) {
      // Connect timeout only — ISP tunnels otherwise abort as "Request was cancelled".
      this._proxyAgent = new ProxyAgent({
        uri: this.proxy,
        connect: { timeout: 20_000 },
      });
    }
    return this._proxyAgent;
  }
  async tlsSession({ refresh = false } = {}) {
    if (this._tlsSession && !refresh) return this._tlsSession;
    if (this._tlsSession) {
      try {
        await this._tlsSession.close();
      } catch {
        /* ignore */
      }
      this._tlsSession = null;
    }
    // First Session on a dispatcher (and explicit refresh) re-inits the pool.
    // IP resolve runs undici first; without a refresh, CONNECT often 403s.
    if (refresh || !this._tlsBootstrapped) {
      await refreshTlsPool();
      this._tlsBootstrapped = true;
    } else {
      await ensureTls();
    }
    const { Session, ClientIdentifier } = await loadTlsClient();
    // node-tls-client (bogdanfinn) rejects CONNECT on some ISP proxies unless
    // the proxy URL has a trailing slash — undici ProxyAgent does not want it.
    const tlsProxy = this.proxy
      ? (this.proxy.endsWith("/") ? this.proxy : `${this.proxy}/`)
      : undefined;
    this._tlsSession = new Session({
      // node-tls-client@2.1.0 only ships Chrome profiles up to 131. Passing an
      // unsupported identifier silently falls back while our headers still say
      // 133, creating a TLS/UA mismatch that Akamai scores hard.
      clientIdentifier: ClientIdentifier.chrome_131,
      timeout: 30_000,
      headerOrder: CHROME_HEADER_ORDER,
      // Hyper tls-and-headers.md baseline: randomize TLS extension order.
      randomTlsExtensionOrder: true,
      ...(tlsProxy ? { proxy: tlsProxy } : {}),
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
    if (!this._proxyAgent) return;
    try {
      await this._proxyAgent.close();
    } catch {
      /* ignore */
    }
    this._proxyAgent = null;
  }
}

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

export async function request(url, opts, ctx) {
  const { dispatcher, jar, extraHeaders } = ctx;
  const method = (opts?.method ?? "GET").toUpperCase();

  // Build headers. We let the caller override anything; defaults are minimal
  // because adapters (kmart.js especially) build full Chrome navigation
  // headers themselves.
  const headers = {
    "user-agent": UA,
    accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "accept-language": "en-AU,en;q=0.9",
    ...(jar.header() ? { cookie: jar.header() } : {}),
    ...(extraHeaders ?? {}),
    ...(opts?.headers ?? {}),
  };

  if (!dispatcher.useTls) {
    // Proxied residential sessions often RST mid-SBSD / mid-nav. Retry GETs
    // and POSTs a few times with a fresh ProxyAgent — Akamai "other side
    // closed" is usually the tunnel dying, not a permanent 403.
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
        try { await dispatcher.resetUndici?.(); } catch { /* ignore */ }
        await sleep(400 + attempt * 700);
      }
    }
    throw lastError;
  }

  // Native TLS experiment path. Kept opt-in because a native library failure
  // can terminate the process before Fastify can return JSON.
  const reqOpts = {
    headers,
    followRedirects: false,
    ...(opts?.body !== undefined ? { body: opts.body } : {}),
  };

  const doTls = async (refresh) => {
    const session = await dispatcher.tlsSession({ refresh });
    switch (method) {
      case "GET":
        return session.get(url, reqOpts);
      case "POST":
        return session.post(url, reqOpts);
      case "PUT":
        return session.put(url, reqOpts);
      case "DELETE":
        return session.delete(url, reqOpts);
      case "PATCH":
        return session.patch(url, reqOpts);
      case "HEAD":
        return session.head(url, reqOpts);
      default:
        throw new Error(`unsupported method: ${method}`);
    }
  };

  let res = await doTls(false);
  const bodyPreview = String(res?.body ?? res?.text ?? "");
  const proxyDenied =
    (res?.status === 0 || res?.status === 403) &&
    /Proxy responded with non 200|CONNECT/i.test(bodyPreview);
  if (proxyDenied) {
    await sleep(200);
    res = await doTls(true);
  }

  // Capture cookies from this response into the jar.
  jar.ingest(res.headers);
  return wrapResponse(res, url);
}

export { UA };
