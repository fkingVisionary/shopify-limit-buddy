/**
 * Proxy group tester — latency + exit IP via HTTP proxy (no extra deps).
 * Uses plain HTTP endpoints so CONNECT/TLS through the proxy isn't required.
 */

const http = require("http");
const { URL } = require("url");
const { normalizeKmartProxy } = require("./proxy-format.cjs");

const IP_ENDPOINTS = [
  "http://api.ipify.org/",
  "http://icanhazip.com/",
  "http://ifconfig.me/ip",
];

/**
 * @param {string} entryRaw
 * @param {{ timeoutMs?: number }} [opts]
 * @returns {Promise<{ entry: string, ok: boolean, ms: number|null, ip: string|null, error: string|null }>}
 */
async function testProxyEntry(entryRaw, opts = {}) {
  const entry = String(entryRaw || "").trim();
  const timeoutMs = Math.max(2_000, Math.min(30_000, Number(opts.timeoutMs) || 8_000));
  if (!entry) {
    return { entry, ok: false, ms: null, ip: null, error: "empty" };
  }
  if (/^socks/i.test(entry) || /socks5?:\/\//i.test(entry)) {
    return { entry, ok: false, ms: null, ip: null, error: "socks_unsupported" };
  }

  const norm = normalizeKmartProxy(entry);
  if (!norm.ok || !norm.proxy) {
    return { entry, ok: false, ms: null, ip: null, error: norm.error || "invalid" };
  }

  const proxyUrl = new URL(norm.proxy);
  let lastErr = "unreachable";
  const t0 = Date.now();

  for (const endpoint of IP_ENDPOINTS) {
    try {
      const ip = await httpGetViaProxy(proxyUrl, endpoint, timeoutMs);
      const cleaned = String(ip || "")
        .trim()
        .split(/\s+/)[0];
      if (!cleaned || !/^[\d.:a-fA-F]+$/.test(cleaned)) {
        lastErr = "bad_ip_body";
        continue;
      }
      return { entry, ok: true, ms: Date.now() - t0, ip: cleaned, error: null };
    } catch (e) {
      lastErr = e?.message || String(e);
    }
  }
  return { entry, ok: false, ms: Date.now() - t0, ip: null, error: lastErr };
}

/**
 * @param {string[]} entries
 * @param {{ timeoutMs?: number, concurrency?: number }} [opts]
 */
async function testProxyEntries(entries, opts = {}) {
  const list = (Array.isArray(entries) ? entries : []).map((e) => String(e || "").trim()).filter(Boolean);
  const concurrency = Math.max(1, Math.min(10, Number(opts.concurrency) || 4));
  const results = new Array(list.length);
  let cursor = 0;

  async function worker() {
    while (cursor < list.length) {
      const i = cursor;
      cursor += 1;
      results[i] = await testProxyEntry(list[i], opts);
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, list.length || 1) }, () => worker()));
  const ok = results.filter((r) => r?.ok).length;
  const dead = results.filter((r) => r && !r.ok);
  return {
    ok: true,
    total: list.length,
    alive: ok,
    dead: dead.length,
    results,
  };
}

function httpGetViaProxy(proxyUrl, targetUrl, timeoutMs) {
  const target = new URL(targetUrl);
  const auth =
    proxyUrl.username || proxyUrl.password
      ? Buffer.from(
          `${decodeURIComponent(proxyUrl.username)}:${decodeURIComponent(proxyUrl.password)}`,
        ).toString("base64")
      : null;

  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: proxyUrl.hostname,
        port: Number(proxyUrl.port) || 80,
        method: "GET",
        path: target.href,
        headers: {
          host: target.host,
          connection: "close",
          "user-agent": "J1msBot-ProxyTest/1.0",
          accept: "text/plain,*/*",
          ...(auth ? { "proxy-authorization": `Basic ${auth}` } : {}),
        },
        timeout: timeoutMs,
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const body = Buffer.concat(chunks).toString("utf8");
          if (res.statusCode >= 400) {
            reject(new Error(`http_${res.statusCode}`));
            return;
          }
          resolve(body);
        });
      },
    );
    req.on("timeout", () => {
      req.destroy();
      reject(new Error("timeout"));
    });
    req.on("error", reject);
    req.end();
  });
}

module.exports = {
  testProxyEntry,
  testProxyEntries,
  IP_ENDPOINTS,
};
