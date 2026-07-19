// Executor deep-health diagnostics.
//
// Used by POST /health/diagnose so infra failures (proxy CONNECT, TLS
// fingerprint drift, missing Hyper key) can be checked without a full
// checkout task. Safe to call on demand — never places orders.

import { ProxyAgent, fetch as undiciFetch } from "undici";
import { makeDispatcher, createJar, request, UA, HTTP_TRANSPORT } from "./http.js";
import { resolveRunProxy, resiPoolSize } from "./proxy-pool.js";

const CHROME_133_REF = {
  ja3_hash: "773906b0efdefa24a7f2b8eb6985bf37",
  ja4: "t13d1516h2_8daaf6152771_b1ff8ab2d16f",
  akamai_h2: "1:65536;2:0;4:6291456;6:262144|15663105|0|m,a,s,p",
};

const HEADER_ORDER = [
  "host", "connection", "cache-control", "sec-ch-ua", "sec-ch-ua-mobile",
  "sec-ch-ua-platform", "upgrade-insecure-requests", "user-agent", "accept",
  "sec-fetch-site", "sec-fetch-mode", "sec-fetch-user", "sec-fetch-dest",
  "accept-encoding", "accept-language", "priority", "cookie",
];

const FINGERPRINT_HEADERS = {
  "sec-ch-ua": '"Not(A:Brand";v="99", "Google Chrome";v="133", "Chromium";v="133"',
  "sec-ch-ua-mobile": "?0",
  "sec-ch-ua-platform": '"macOS"',
  "upgrade-insecure-requests": "1",
  "user-agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36",
  accept:
    "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7",
  "sec-fetch-site": "none",
  "sec-fetch-mode": "navigate",
  "sec-fetch-user": "?1",
  "sec-fetch-dest": "document",
  "accept-encoding": "gzip, deflate, br, zstd",
  "accept-language": "en-AU,en;q=0.9",
  priority: "u=0, i",
};

// Mirror http.js / playwright proxy parsing enough for CONNECT probes.
function normalizeProxyUrl(raw) {
  if (!raw) return null;
  let s = String(raw).trim();
  if (!s) return null;

  const schemeMatch = s.match(/^(https?|socks5?):\/\//i);
  const scheme = schemeMatch ? schemeMatch[1].toLowerCase() : "http";
  let rest = schemeMatch ? s.slice(schemeMatch[0].length) : s;

  const safeDecode = (value) => {
    try { return decodeURIComponent(value); } catch { return value; }
  };
  const build = (host, port, user, pass) => {
    if (!host || !/^\d{1,5}$/.test(String(port ?? ""))) return null;
    const n = Number(port);
    if (n <= 0 || n > 65535) return null;
    const auth = user != null
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
  if (parts.length >= 4) {
    const [host, port, user, ...passParts] = parts;
    return build(host, port, user, passParts.join(":"));
  }
  if (parts.length === 2) return build(parts[0], parts[1]);
  return null;
}

function maskProxy(url) {
  if (!url) return null;
  try {
    const u = new URL(url);
    const user = u.username ? `${decodeURIComponent(u.username).slice(0, 3)}…` : "(no-auth)";
    return `${u.protocol}//${user}@${u.hostname}:${u.port || "80"}`;
  } catch {
    return "(unparseable)";
  }
}

export async function checkFingerprint(proxyRaw = null) {
  const t0 = Date.now();
  const proxyUrl = normalizeProxyUrl(proxyRaw);
  try {
    const { Session, ClientIdentifier, initTLS } = await import("node-tls-client");
    await initTLS();
    const session = new Session({
      clientIdentifier: ClientIdentifier.chrome_133,
      timeout: 30_000,
      headerOrder: HEADER_ORDER,
      ...(proxyUrl ? { proxy: proxyUrl } : {}),
    });
    try {
      const res = await session.get("https://tls.peet.ws/api/all", { headers: FINGERPRINT_HEADERS });
      const body = await res.text();
      let data;
      try {
        data = JSON.parse(body);
      } catch {
        return {
          ok: false,
          elapsedMs: Date.now() - t0,
          error: `non-JSON fingerprint body (${body.slice(0, 120)})`,
          usedProxy: Boolean(proxyUrl),
        };
      }
      const tls = data.tls || {};
      const h2 = data.http2 || {};
      const observed = {
        ja3: tls.ja3,
        ja3_hash: tls.ja3_hash,
        ja4: tls.ja4,
        peetprint: tls.peetprint_hash,
        akamai_h2: h2.akamai_fingerprint,
        akamai_h2_hash: h2.akamai_fingerprint_hash,
      };
      const match = {
        ja3_hash: observed.ja3_hash === CHROME_133_REF.ja3_hash,
        ja4: observed.ja4 === CHROME_133_REF.ja4,
        akamai_h2: observed.akamai_h2 === CHROME_133_REF.akamai_h2,
      };
      return {
        ok: true,
        elapsedMs: Date.now() - t0,
        usedProxy: Boolean(proxyUrl),
        proxy: maskProxy(proxyUrl),
        observed,
        reference: CHROME_133_REF,
        match,
        allMatch: match.ja3_hash && match.ja4 && match.akamai_h2,
      };
    } finally {
      try { await session.close(); } catch { /* ignore */ }
    }
  } catch (e) {
    return {
      ok: false,
      elapsedMs: Date.now() - t0,
      usedProxy: Boolean(proxyUrl),
      proxy: maskProxy(proxyUrl),
      error: e?.message ?? String(e),
    };
  }
}

export async function probeProxyConnect({
  proxy: proxyRaw = null,
  targetUrl = "https://www.kmart.com.au/",
  ipUrl = "https://api.ipify.org?format=json",
} = {}) {
  const t0 = Date.now();
  const proxyUrl = normalizeProxyUrl(proxyRaw);
  if (!proxyUrl) {
    return {
      ok: false,
      elapsedMs: Date.now() - t0,
      error: proxyRaw ? "could not parse proxy string" : "proxy required for CONNECT probe",
      parsed: false,
    };
  }

  const agent = new ProxyAgent(proxyUrl);
  const out = {
    ok: false,
    elapsedMs: 0,
    parsed: true,
    proxy: maskProxy(proxyUrl),
    egressIp: null,
    target: { url: targetUrl, status: null, error: null, bytes: null },
  };

  try {
    // 1) Prove CONNECT + egress IP via a simple HTTPS hop.
    const ipRes = await undiciFetch(ipUrl, {
      method: "GET",
      dispatcher: agent,
      headers: { "user-agent": UA, accept: "application/json" },
      signal: AbortSignal.timeout(20_000),
    });
    const ipBody = await ipRes.text();
    if (!ipRes.ok) {
      out.error = `egress IP probe HTTP ${ipRes.status}`;
      out.elapsedMs = Date.now() - t0;
      return out;
    }
    try {
      out.egressIp = JSON.parse(ipBody)?.ip ?? null;
    } catch {
      out.egressIp = ipBody.match(/\b(?:\d{1,3}\.){3}\d{1,3}\b/)?.[0] ?? null;
    }
    if (!out.egressIp) {
      out.error = "egress IP probe returned no IP";
      out.elapsedMs = Date.now() - t0;
      return out;
    }

    // 2) CONNECT to the retail target (HEAD/GET). This is the same failure
    // mode Playwright surfaces as net::ERR_CONNECTION_CLOSED.
    try {
      const targetRes = await undiciFetch(targetUrl, {
        method: "GET",
        dispatcher: agent,
        headers: {
          "user-agent": UA,
          accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          "accept-language": "en-AU,en;q=0.9",
        },
        signal: AbortSignal.timeout(25_000),
      });
      const body = await targetRes.text();
      out.target.status = targetRes.status;
      out.target.bytes = body.length;
      out.target.ok = targetRes.status > 0 && targetRes.status < 500;
      if (!out.target.ok) out.target.error = `HTTP ${targetRes.status}`;
    } catch (e) {
      out.target.error = e?.message ?? String(e);
      out.target.ok = false;
    }

    out.ok = Boolean(out.egressIp) && out.target.ok !== false;
    out.elapsedMs = Date.now() - t0;
    return out;
  } catch (e) {
    out.error = e?.message ?? String(e);
    out.elapsedMs = Date.now() - t0;
    return out;
  } finally {
    try { await agent.close(); } catch { /* ignore */ }
  }
}

export async function probeDirectTarget(targetUrl = "https://www.kmart.com.au/") {
  const t0 = Date.now();
  const dispatcher = makeDispatcher(null, { forceUndici: true });
  const jar = createJar();
  try {
    const res = await request(
      targetUrl,
      {
        method: "GET",
        headers: {
          "user-agent": UA,
          accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          "accept-language": "en-AU,en;q=0.9",
        },
      },
      { dispatcher, jar },
    );
    const body = await res.text();
    return {
      ok: res.status > 0 && res.status < 500,
      elapsedMs: Date.now() - t0,
      status: res.status,
      bytes: body.length,
      cookies: Object.keys(jar.dump()),
      transport: dispatcher.transport,
    };
  } catch (e) {
    return {
      ok: false,
      elapsedMs: Date.now() - t0,
      error: e?.message ?? String(e),
      transport: dispatcher.transport,
    };
  } finally {
    try { await dispatcher?.close?.(); } catch { /* ignore */ }
  }
}

export async function runDeepHealth({
  proxy = null,
  targetUrl = "https://www.kmart.com.au/",
  fingerprint = true,
  proxyProbe = true,
  directProbe = true,
} = {}) {
  const t0 = Date.now();
  // Prefer explicit diagnose proxy; else round-robin from resi pool / legacy secret.
  let resolvedProxy = null;
  let proxySource = "none";
  if (proxy?.trim?.()) {
    resolvedProxy = proxy.trim();
    proxySource = "request.proxy";
  } else if (proxy === undefined || proxy === null || proxy === "") {
    const picked = resolveRunProxy({ useProxy: true });
    resolvedProxy = picked.proxy;
    proxySource = picked.source;
  }

  const checks = {};

  checks.env = {
    ok: true,
    hyperApiKey: Boolean(process.env.HYPER_API_KEY),
    executorToken: Boolean(process.env.EXECUTOR_TOKEN),
    proxyUrlResiConfigured: Boolean(process.env.PROXY_URL_RESI),
    proxyPoolSize: resiPoolSize(),
    proxySource,
    httpTransport: HTTP_TRANSPORT,
    node: process.version,
  };
  if (!checks.env.hyperApiKey) checks.env.ok = false;

  if (directProbe) {
    checks.direct = await probeDirectTarget(targetUrl);
  }

  if (proxyProbe) {
    if (resolvedProxy) {
      checks.proxy = await probeProxyConnect({ proxy: resolvedProxy, targetUrl });
    } else {
      checks.proxy = {
        ok: false,
        skipped: true,
        error: "no proxy supplied and resi pool empty (resi.proxies / PROXY_RESI_LIST / PROXY_URL_RESI)",
      };
    }
  }

  if (fingerprint) {
    // Fingerprint through the same proxy the checkout would use when available.
    checks.fingerprint = await checkFingerprint(resolvedProxy);
  }

  const parts = [checks.env, checks.direct, checks.proxy, checks.fingerprint].filter(Boolean);
  const ok = parts.every((p) => p.ok || p.skipped);

  return {
    ok,
    elapsedMs: Date.now() - t0,
    ts: Date.now(),
    proxyUsed: maskProxy(normalizeProxyUrl(resolvedProxy)),
    checks,
    hint: !checks.proxy?.ok && !checks.proxy?.skipped
      ? "Proxy CONNECT failed — this usually matches Playwright net::ERR_CONNECTION_CLOSED. Fix proxy auth/plan/region before retrying checkout."
      : !checks.env.hyperApiKey
        ? "HYPER_API_KEY missing on executor — antibot handlers will fail."
        : checks.fingerprint && !checks.fingerprint.allMatch && checks.fingerprint.ok
          ? "TLS fingerprint diverges from Chrome 133 reference — review node-tls-client version / ClientIdentifier."
          : null,
  };
}
