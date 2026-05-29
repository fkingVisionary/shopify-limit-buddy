// Proxy-aware HTTP client built on undici.
// Every request goes through the per-task ProxyAgent so the residential IP
// (not the host machine's IP) is what Shopify / Cloudflare / Akamai see.

import { Agent, ProxyAgent, fetch as undiciFetch, setGlobalDispatcher } from "undici";

// Default dispatcher: no proxy, but with sane keepalive + TLS.
setGlobalDispatcher(new Agent({ keepAliveTimeout: 30_000, connect: { rejectUnauthorized: true } }));

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

// Accept "user:pass@host:port" or "host:port" or full "http://user:pass@host:port".
function parseProxy(raw) {
  if (!raw) return null;
  let s = raw.trim();
  if (!/^https?:\/\//i.test(s)) s = `http://${s}`;
  try {
    const u = new URL(s);
    return u.toString();
  } catch {
    return null;
  }
}

export function makeDispatcher(rawProxy) {
  const url = parseProxy(rawProxy);
  if (!url) return null;
  return new ProxyAgent({ uri: url, keepAliveTimeout: 30_000, connect: { rejectUnauthorized: true } });
}

// Tiny cookie jar — collects Set-Cookie headers and emits a Cookie string.
export function createJar() {
  const store = new Map(); // name -> value
  return {
    ingest(headers) {
      // undici exposes headers.getSetCookie() for multi-cookie support
      const setCookies = typeof headers.getSetCookie === "function" ? headers.getSetCookie() : [];
      for (const sc of setCookies) {
        const [pair] = sc.split(";");
        const eq = pair.indexOf("=");
        if (eq > 0) {
          const name = pair.slice(0, eq).trim();
          const value = pair.slice(eq + 1).trim();
          store.set(name, value);
        }
      }
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

export async function request(url, opts, ctx) {
  const { dispatcher, jar, extraHeaders } = ctx;
  const headers = {
    "user-agent": UA,
    accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "accept-language": "en-AU,en;q=0.9",
    ...(jar.header() ? { cookie: jar.header() } : {}),
    ...(extraHeaders ?? {}),
    ...(opts?.headers ?? {}),
  };
  const res = await undiciFetch(url, {
    ...opts,
    headers,
    dispatcher: dispatcher ?? undefined,
    redirect: "manual", // we follow manually so we can capture cookies + intermediate URLs
  });
  jar.ingest(res.headers);
  return res;
}

export { UA };
