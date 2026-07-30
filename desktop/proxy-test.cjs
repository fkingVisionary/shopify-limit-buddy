/**
 * Proxy group tester — latency + exit IP, or optional site reachability.
 * HTTP IP endpoints for exit IP; HTTPS store presets via CONNECT.
 */

const http = require("http");
const https = require("https");
const { URL } = require("url");
const { normalizeKmartProxy } = require("./proxy-format.cjs");

const IP_ENDPOINTS = [
  "http://api.ipify.org/",
  "http://icanhazip.com/",
  "http://ifconfig.me/ip",
];

/** Preset probe targets for the Proxies UI dropdown. */
const PROXY_TEST_PRESETS = [
  { id: "ip", label: "Exit IP (any)", url: "", mode: "ip" },
  { id: "bandai", label: "Bandai AU", url: "https://p-bandai.com/au/", mode: "site" },
  { id: "toymate", label: "Toymate AU", url: "https://www.toymate.com.au/", mode: "site" },
  {
    id: "pokemoncentre",
    label: "Pokémon Center AU",
    url: "https://www.pokemoncenter.com/en-au",
    mode: "site",
  },
  { id: "custom", label: "Custom URL…", url: "", mode: "custom" },
];

/**
 * @param {string} entryRaw
 * @param {{ timeoutMs?: number, targetUrl?: string }} [opts]
 * @returns {Promise<{ entry: string, ok: boolean, ms: number|null, ip: string|null, status: number|null, error: string|null, target: string|null }>}
 */
async function testProxyEntry(entryRaw, opts = {}) {
  const entry = String(entryRaw || "").trim();
  const timeoutMs = Math.max(2_000, Math.min(30_000, Number(opts.timeoutMs) || 8_000));
  const targetUrl = String(opts.targetUrl || "").trim();
  if (!entry) {
    return { entry, ok: false, ms: null, ip: null, status: null, error: "empty", target: null };
  }
  if (/^socks/i.test(entry) || /socks5?:\/\//i.test(entry)) {
    return {
      entry,
      ok: false,
      ms: null,
      ip: null,
      status: null,
      error: "socks_unsupported",
      target: targetUrl || null,
    };
  }

  const norm = normalizeKmartProxy(entry);
  if (!norm.ok || !norm.proxy) {
    return {
      entry,
      ok: false,
      ms: null,
      ip: null,
      status: null,
      error: norm.error || "invalid",
      target: targetUrl || null,
    };
  }

  const proxyUrl = new URL(norm.proxy);
  const t0 = Date.now();

  if (targetUrl) {
    try {
      const probed = await probeUrlViaProxy(proxyUrl, targetUrl, timeoutMs);
      return {
        entry,
        ok: probed.ok,
        ms: Date.now() - t0,
        ip: null,
        status: probed.status,
        error: probed.ok ? null : probed.error || `http_${probed.status || "?"}`,
        target: targetUrl,
      };
    } catch (e) {
      return {
        entry,
        ok: false,
        ms: Date.now() - t0,
        ip: null,
        status: null,
        error: e?.message || String(e),
        target: targetUrl,
      };
    }
  }

  let lastErr = "unreachable";
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
      return {
        entry,
        ok: true,
        ms: Date.now() - t0,
        ip: cleaned,
        status: 200,
        error: null,
        target: null,
      };
    } catch (e) {
      lastErr = e?.message || String(e);
    }
  }
  return {
    entry,
    ok: false,
    ms: Date.now() - t0,
    ip: null,
    status: null,
    error: lastErr,
    target: null,
  };
}

/**
 * @param {string[]} entries
 * @param {{ timeoutMs?: number, concurrency?: number, targetUrl?: string }} [opts]
 */
async function testProxyEntries(entries, opts = {}) {
  const list = (Array.isArray(entries) ? entries : []).map((e) => String(e || "").trim()).filter(Boolean);
  const concurrency = Math.max(1, Math.min(20, Number(opts.concurrency) || 20));
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
    target: String(opts.targetUrl || "").trim() || null,
    results,
  };
}

function probeUrlViaProxy(proxyUrl, targetUrl, timeoutMs) {
  const target = new URL(targetUrl);
  if (target.protocol === "http:") {
    return httpGetViaProxy(proxyUrl, targetUrl, timeoutMs).then(() => ({
      ok: true,
      status: 200,
      error: null,
    }));
  }
  if (target.protocol === "https:") {
    return httpsGetViaProxy(proxyUrl, target, timeoutMs);
  }
  return Promise.reject(new Error("unsupported_protocol"));
}

function proxyAuthHeader(proxyUrl) {
  if (!proxyUrl.username && !proxyUrl.password) return null;
  return Buffer.from(
    `${decodeURIComponent(proxyUrl.username)}:${decodeURIComponent(proxyUrl.password)}`,
  ).toString("base64");
}

function httpGetViaProxy(proxyUrl, targetUrl, timeoutMs) {
  const target = new URL(targetUrl);
  const auth = proxyAuthHeader(proxyUrl);

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
          "user-agent": "Vanta-ProxyTest/1.0",
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

/** HTTPS GET through an HTTP CONNECT proxy. Soft-ok on 2xx/3xx/403/429 (reachable). */
function httpsGetViaProxy(proxyUrl, target, timeoutMs) {
  const auth = proxyAuthHeader(proxyUrl);
  const port = Number(target.port) || 443;
  const connectPath = `${target.hostname}:${port}`;

  return new Promise((resolve, reject) => {
    const connectReq = http.request({
      host: proxyUrl.hostname,
      port: Number(proxyUrl.port) || 80,
      method: "CONNECT",
      path: connectPath,
      headers: {
        host: connectPath,
        connection: "close",
        ...(auth ? { "proxy-authorization": `Basic ${auth}` } : {}),
      },
      timeout: timeoutMs,
    });

    connectReq.on("connect", (res, socket) => {
      if (res.statusCode !== 200) {
        socket.destroy();
        reject(new Error(`connect_${res.statusCode || "?"}`));
        return;
      }
      const req = https.request(
        {
          host: target.hostname,
          servername: target.hostname,
          path: `${target.pathname || "/"}${target.search || ""}`,
          method: "GET",
          headers: {
            host: target.host,
            connection: "close",
            "user-agent": "Vanta-ProxyTest/1.0",
            accept: "text/html,*/*",
          },
          socket,
          agent: false,
          timeout: timeoutMs,
        },
        (tres) => {
          tres.resume();
          tres.on("end", () => {
            const status = Number(tres.statusCode) || 0;
            // Reachable through proxy even if WAF/challenge.
            const ok = status > 0 && status < 500;
            resolve({
              ok,
              status,
              error: ok ? null : `http_${status}`,
            });
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

    connectReq.on("timeout", () => {
      connectReq.destroy();
      reject(new Error("timeout"));
    });
    connectReq.on("error", reject);
    connectReq.end();
  });
}

module.exports = {
  testProxyEntry,
  testProxyEntries,
  IP_ENDPOINTS,
  PROXY_TEST_PRESETS,
};
