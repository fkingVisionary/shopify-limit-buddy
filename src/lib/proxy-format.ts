// Shared proxy parsing/validation. Mirrors the normaliser in the
// run-checkout edge function so the UI and the checkout agree on what
// counts as a valid proxy entry.

export type ProxyKind = "template" | "raw" | "invalid";

export type ProxyClassification = {
  kind: ProxyKind;
  /** Normalised URL form (`http://user:pass@host:port`) for raw entries. */
  url?: string;
  /** Reason when `kind === "invalid"`. */
  reason?: string;
};

/**
 * Classify a single proxy entry. Accepts:
 *  - `{url}` templates (e.g. `https://gateway.example.com/fetch?url={url}`)
 *  - `host:port`
 *  - `host:port:user:pass` (premium-proxy style)
 *  - `user:pass:host:port`
 *  - `http(s)://user:pass@host:port`
 *  - `socks5://user:pass@host:port`
 */
export function classifyProxy(entryRaw: string): ProxyClassification {
  const entry = String(entryRaw || "").trim();
  if (!entry) return { kind: "invalid", reason: "empty" };

  if (entry.includes("{url}")) {
    try {
      // Validate base URL (strip placeholder so URL ctor is happy)
      // eslint-disable-next-line no-new
      new URL(entry.replace("{url}", "https://example.com"));
      return { kind: "template" };
    } catch {
      return { kind: "invalid", reason: "template is not a valid URL" };
    }
  }

  // Strip existing scheme
  let p = entry;
  const schemeMatch = p.match(/^(https?|socks5?):\/\//i);
  const scheme = schemeMatch ? schemeMatch[1].toLowerCase() : "http";
  if (schemeMatch) p = p.slice(schemeMatch[0].length);

  // user:pass@host:port
  if (p.includes("@")) {
    const [auth, hostPort] = p.split("@");
    const [host, port] = hostPort.split(":");
    if (!host || !/^\d{1,5}$/.test(port || "")) {
      return { kind: "invalid", reason: "expected host:port after @" };
    }
    return { kind: "raw", url: `${scheme}://${auth}@${host}:${port}` };
  }

  const parts = p.split(":");
  if (parts.length === 2) {
    if (!parts[0] || !/^\d{1,5}$/.test(parts[1])) {
      return { kind: "invalid", reason: "expected host:port" };
    }
    return { kind: "raw", url: `${scheme}://${parts[0]}:${parts[1]}` };
  }
  if (parts.length === 4) {
    const portFirst = /^\d{1,5}$/.test(parts[1]);
    const portLast = /^\d{1,5}$/.test(parts[3]);
    if (portFirst && !portLast) {
      // host:port:user:pass
      return {
        kind: "raw",
        url: `${scheme}://${parts[2]}:${parts[3]}@${parts[0]}:${parts[1]}`,
      };
    }
    if (portLast) {
      // user:pass:host:port
      return {
        kind: "raw",
        url: `${scheme}://${parts[0]}:${parts[1]}@${parts[2]}:${parts[3]}`,
      };
    }
    return { kind: "invalid", reason: "neither segment looks like a port" };
  }
  return {
    kind: "invalid",
    reason: "expected host:port, host:port:user:pass, user:pass:host:port, or a {url} template",
  };
}
