// Proxy-aware HTTP client. Default transport is undici because it is stable and
// returns adapter timelines instead of crashing the executor. The native
// node-tls-client path is still available behind EXECUTOR_HTTP_TRANSPORT=tls for
// controlled TLS experiments, but it is not the default after repeated empty
// 502s from native crashes.
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

const TRANSPORT = (process.env.EXECUTOR_HTTP_TRANSPORT ?? "undici").toLowerCase();

// Oxylabs Web Unblocker — https://developers.oxylabs.io/scraper-apis/web-unblocker
// Proxy-style endpoint. Handles TLS/JA3, Akamai sensor generation, and
// residential IP rotation for us. When enabled, all outbound requests go
// through it and the adapter can skip its own antibot solves.
const OXY_HOST = process.env.OXYLABS_UNBLOCKER_HOST ?? "unblock.oxylabs.io";
const OXY_PORT = process.env.OXYLABS_UNBLOCKER_PORT ?? "60000";
const OXY_USER = process.env.OXYLABS_UNBLOCKER_USER ?? "";
const OXY_PASS = process.env.OXYLABS_UNBLOCKER_PASS ?? "";
const OXY_GEO = process.env.OXYLABS_UNBLOCKER_GEO ?? "Australia";
export const OXYLABS_ENABLED = TRANSPORT === "oxylabs" && OXY_USER && OXY_PASS;
function oxyProxyUrl() {
  return `http://${encodeURIComponent(OXY_USER)}:${encodeURIComponent(OXY_PASS)}@${OXY_HOST}:${OXY_PORT}`;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryableNetworkError(error) {
  const msg = String(error?.message ?? error).toLowerCase();
  const code = error?.code ?? error?.cause?.code;
  return (
    code === "ECONNRESET" ||
    code === "UND_ERR_SOCKET" ||
    code === "UND_ERR_CONNECT_TIMEOUT" ||
    msg.includes("client network socket disconnected") ||
    msg.includes("fetch failed")
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

// Accept "user:pass@host:port" or "host:port" or full "http://user:pass@host:port".
function parseProxy(raw) {
  if (!raw) return null;
  let s = String(raw).trim();

  // Common proxy-list format: host:port:user:pass. Convert it before URL
  // parsing; otherwise URL treats the third segment as part of an invalid port
  // and the request silently falls back to direct egress.
  if (!/^https?:\/\//i.test(s) && !/^socks5?:\/\//i.test(s) && !s.includes("@")) {
    const parts = s.split(":");
    if (parts.length >= 4 && /^\d{1,5}$/.test(parts[1])) {
      const [host, port, user, ...passParts] = parts;
      const pass = passParts.join(":");
      s = `http://${encodeURIComponent(user)}:${encodeURIComponent(pass)}@${host}:${port}`;
    }
  }
  if (!/^https?:\/\//i.test(s)) s = `http://${s}`;
  try {
    return new URL(s).toString();
  } catch {
    return null;
  }
}

// Per-task dispatcher. Holds the proxy URL and a lazily-constructed Session.
// `close()` should be called from the task entry-point in a finally block
// (see checkout.js / server.js recon handler).
class Dispatcher {
  constructor(proxyUrl) {
    this.proxy = proxyUrl;
    this._tlsSession = null;
    this._proxyAgent = null;
  }
  undiciDispatcher() {
    if (!this.proxy) return undefined;
    if (!this._proxyAgent) this._proxyAgent = new ProxyAgent(this.proxy);
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
    if (!this._proxyAgent) return;
    try {
      await this._proxyAgent.close();
    } catch {
      /* ignore */
    }
    this._proxyAgent = null;
  }
}

export function makeDispatcher(rawProxy) {
  const url = parseProxy(rawProxy);
  // Even direct (no-proxy) requests need a Session so they share the Chrome
  // fingerprint; we always return a Dispatcher, never null.
  return new Dispatcher(url);
}

// Tiny cookie jar — name-keyed (not domain-keyed) on purpose so the
// www.kmart.com.au → api.kmart.com.au _abck handoff in kmart.js still works
// the way it did under undici.
export function createJar() {
  const store = new Map(); // name -> value
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
      const v = rawHeaders["set-cookie"];
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

  if (TRANSPORT !== "tls") {
    const attempts = method === "GET" || method === "HEAD" ? 2 : 1;
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
        await sleep(250 + attempt * 500);
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
