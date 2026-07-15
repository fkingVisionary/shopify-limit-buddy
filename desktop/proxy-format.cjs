// Mirrors src/lib/proxy-format.ts so desktop payloads match the web → Fly path.

function validPort(port) {
  if (!/^\d{1,5}$/.test(port || "")) return false;
  const n = Number(port);
  return n > 0 && n <= 65535;
}

function safeDecode(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function buildProxyUrl(scheme, host, port, user, pass) {
  if (!host || !validPort(port)) return { kind: "invalid", reason: "expected host:port with a valid port" };
  if (user !== undefined || pass !== undefined) {
    if (!user || pass === undefined || pass === "") {
      return { kind: "invalid", reason: "expected non-empty username and password" };
    }
    return {
      kind: "raw",
      url: `${scheme}://${encodeURIComponent(user)}:${encodeURIComponent(pass)}@${host}:${port}`,
    };
  }
  return { kind: "raw", url: `${scheme}://${host}:${port}` };
}

/**
 * Classify a single proxy entry — same rules as the dashboard Kmart lane.
 */
function classifyProxy(entryRaw) {
  const entry = String(entryRaw || "").trim();
  if (!entry) return { kind: "invalid", reason: "empty" };

  if (entry.includes("{url}")) {
    try {
      // eslint-disable-next-line no-new
      new URL(entry.replace("{url}", "https://example.com"));
      return { kind: "template" };
    } catch {
      return { kind: "invalid", reason: "template is not a valid URL" };
    }
  }

  let p = entry;
  const schemeMatch = p.match(/^(https?|socks5?):\/\//i);
  const scheme = schemeMatch ? schemeMatch[1].toLowerCase() : "http";
  if (schemeMatch) p = p.slice(schemeMatch[0].length);

  if (p.includes("@")) {
    const at = p.lastIndexOf("@");
    const auth = p.slice(0, at);
    const hostPort = p.slice(at + 1);
    const [user, ...passParts] = auth.split(":");
    const [host, port] = hostPort.split(":");
    return buildProxyUrl(scheme, host, port, safeDecode(user || ""), safeDecode(passParts.join(":")));
  }

  const parts = p.split(":");
  if (parts.length === 2) {
    return buildProxyUrl(scheme, parts[0], parts[1]);
  }
  // host:port:user:pass — password may contain ':' (join remainder).
  if (parts.length >= 4 && validPort(parts[1])) {
    const [host, port, user, ...passParts] = parts;
    return buildProxyUrl(scheme, host, port, user, passParts.join(":"));
  }
  if (parts.length >= 4 && validPort(parts[parts.length - 1])) {
    const port = parts[parts.length - 1];
    const host = parts[parts.length - 2];
    const user = parts[0];
    const pass = parts.slice(1, -2).join(":");
    return buildProxyUrl(scheme, host, port, user, pass);
  }
  return {
    kind: "invalid",
    reason: "expected host:port, host:port:user:pass, user:pass:host:port, or a {url} template",
  };
}

/** Same normalisation as src/lib/kmart-task.ts buildKmartExecutorPayload. */
function normalizeKmartProxy(raw) {
  const proxy = String(raw || "").trim();
  if (!proxy) return { ok: true, proxy: null };
  const classified = classifyProxy(proxy);
  if (classified.kind === "invalid") {
    return { ok: false, error: `Proxy invalid: ${classified.reason ?? "unrecognized"}` };
  }
  if (classified.kind === "template") {
    return { ok: false, error: "URL-template proxies are not supported on the Kmart lane" };
  }
  return { ok: true, proxy: classified.kind === "raw" ? classified.url ?? null : null };
}

module.exports = { classifyProxy, normalizeKmartProxy };
