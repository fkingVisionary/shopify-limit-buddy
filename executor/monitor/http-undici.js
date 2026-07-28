// Undici-only HTTP helpers for Bandai stock monitor (no Playwright / tls-client).
// Keeps the always-on monitor image slim for Railway.

import { ProxyAgent, fetch as undiciFetch } from "undici";

export const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

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
    const auth =
      user != null
        ? `${encodeURIComponent(safeDecode(user))}:${encodeURIComponent(safeDecode(pass ?? ""))}@`
        : "";
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
    return build(
      hostPort.slice(0, colon),
      hostPort.slice(colon + 1),
      auth.slice(0, userColon),
      auth.slice(userColon + 1),
    );
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

function isStickyProxyUrl(proxyUrl) {
  return /session-[A-Za-z0-9]+|sessid=|sessionid=/i.test(String(proxyUrl || ""));
}

class UndiciDispatcher {
  constructor(proxyUrl) {
    this.proxy = proxyUrl;
    this.useTls = false;
    this.transport = "undici";
    this.sticky = isStickyProxyUrl(proxyUrl);
    this._proxyAgent = null;
  }

  undiciDispatcher() {
    if (!this.proxy) return undefined;
    if (!this._proxyAgent) {
      this._proxyAgent = new ProxyAgent(this.proxy);
    }
    return this._proxyAgent;
  }

  async close() {
    if (!this._proxyAgent) return;
    try {
      await this._proxyAgent.close();
    } catch {
      /* ignore */
    }
    this._proxyAgent = null;
  }
}

export function makeDispatcher(rawProxy, _opts = {}) {
  const url = parseProxy(rawProxy);
  const dispatcher = new UndiciDispatcher(url);
  dispatcher.rawProxyLen = rawProxy ? String(rawProxy).length : 0;
  dispatcher.proxyParseFailed = Boolean(rawProxy) && !url;
  return dispatcher;
}

export function createJar() {
  const store = new Map();
  const ingestSetCookie = (arr) => {
    if (!arr) return;
    const list = Array.isArray(arr) ? arr : [arr];
    for (const sc of list) {
      if (!sc) continue;
      const [pair] = String(sc).split(";");
      const eq = pair.indexOf("=");
      if (eq > 0) store.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
    }
  };
  return {
    ingest(headers) {
      if (!headers) return;
      if (typeof headers.getSetCookie === "function") {
        ingestSetCookie(headers.getSetCookie());
        return;
      }
      ingestSetCookie(headers["set-cookie"] ?? headers["Set-Cookie"]);
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

export async function request(url, opts = {}, ctx = {}) {
  const headers = { ...(opts.headers || {}) };
  const cookie = ctx.jar?.header?.();
  if (cookie) headers.cookie = cookie;
  const dispatcher = ctx.dispatcher?.undiciDispatcher?.();
  const res = await undiciFetch(url, {
    method: opts.method || "GET",
    headers,
    body: opts.body,
    dispatcher,
    signal: opts.signal,
  });
  return wrapFetchResponse(res, url);
}
