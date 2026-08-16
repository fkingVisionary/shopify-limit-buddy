/**
 * Detect common TLS/HTTP intercept & packet-capture tooling.
 * When tripped, the desktop app refuses all task / harvest activity system-wide.
 *
 * This is a product integrity gate (stop signal scraping), not DRM against
 * determined reverse engineers — it raises the bar for HTTP Toolkit / mitmproxy
 * / Fiddler / Charles / Wireshark style capture.
 */

const { execFileSync } = require("child_process");
const os = require("os");

const SUSPICIOUS_PROCESS_PATTERNS = [
  /httptoolkit/i,
  /http[-_ ]?toolkit/i,
  /\bfiddler\b/i,
  /\bcharles\b/i,
  /mitmproxy/i,
  /mitmweb/i,
  /mitmdump/i,
  /\bwireshark\b/i,
  /\bdumpcap\b/i,
  /\btshark\b/i,
  /\bproxyman\b/i,
  /burpsuite/i,
  /\bburp\b/i,
  /\breqable\b/i,
  /\bwhistle\b/i,
  /\bpacketbeat\b/i,
  /\btcpdump\b/i,
  /\brawcap\b/i,
  /\bhttpdebugger/i,
  /\bproxifier\b/i,
  /\bnetlimiter\b/i,
  /\bsslkeylog/i,
];

/** Local MITM defaults used by HTTP Toolkit / Charles / Fiddler / mitmproxy. */
const SUSPICIOUS_PROXY_PORTS = new Set([
  8000, 8080, 8081, 8082, 8888, 8889, 8899, 8866, 9090, 9091, 8088, 48080,
]);

let lastScan = {
  blocked: false,
  reasons: [],
  checkedAt: 0,
};

function listProcessNames() {
  try {
    if (process.platform === "win32") {
      const out = execFileSync(
        "tasklist",
        ["/FO", "CSV", "/NH"],
        { encoding: "utf8", windowsHide: true, timeout: 8000, maxBuffer: 8 * 1024 * 1024 },
      );
      return out
        .split(/\r?\n/)
        .map((line) => {
          const m = line.match(/^"([^"]+)"/);
          return m ? m[1] : "";
        })
        .filter(Boolean);
    }
    const out = execFileSync("ps", ["-A", "-o", "comm="], {
      encoding: "utf8",
      timeout: 5000,
      maxBuffer: 4 * 1024 * 1024,
    });
    return out
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

function envCaptureSignals() {
  const reasons = [];
  if (String(process.env.SSLKEYLOGFILE || "").trim()) {
    reasons.push("SSLKEYLOGFILE is set (TLS session keys would be loggable)");
  }
  if (String(process.env.NODE_EXTRA_CA_CERTS || "").trim()) {
    reasons.push("NODE_EXTRA_CA_CERTS is set (custom CA — typical for MITM tools)");
  }
  for (const key of ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"]) {
    const val = String(process.env[key] || "").trim();
    if (!val) continue;
    try {
      const u = new URL(val.includes("://") ? val : `http://${val}`);
      const host = (u.hostname || "").toLowerCase();
      const port = Number(u.port) || (u.protocol === "https:" ? 443 : 80);
      const loopback = host === "127.0.0.1" || host === "localhost" || host === "::1" || host === "0.0.0.0";
      if (loopback && SUSPICIOUS_PROXY_PORTS.has(port)) {
        reasons.push(`${key} points at local intercept port ${port}`);
      } else if (loopback) {
        reasons.push(`${key} points at loopback (${host}:${port})`);
      }
    } catch {
      if (/127\.0\.0\.1|localhost/i.test(val)) {
        reasons.push(`${key} points at loopback`);
      }
    }
  }
  return reasons;
}

function processCaptureSignals(names) {
  const reasons = [];
  for (const name of names) {
    for (const re of SUSPICIOUS_PROCESS_PATTERNS) {
      if (re.test(name)) {
        reasons.push(`Intercept / capture process detected: ${name}`);
        break;
      }
    }
  }
  return reasons;
}

/**
 * @param {{ processNames?: string[] }} [opts] — inject names in tests
 */
function scanIntegrity(opts = {}) {
  const names = Array.isArray(opts.processNames) ? opts.processNames : listProcessNames();
  const reasons = [...envCaptureSignals(), ...processCaptureSignals(names)];
  // Dedupe
  const uniq = [...new Set(reasons)];
  lastScan = {
    blocked: uniq.length > 0,
    reasons: uniq,
    checkedAt: Date.now(),
    platform: process.platform,
    hostname: os.hostname(),
  };
  return { ...lastScan };
}

function getIntegrityStatus() {
  return { ...lastScan };
}

function assertIntegrityClear() {
  const s = lastScan.checkedAt ? lastScan : scanIntegrity();
  if (s.blocked) {
    const detail = (s.reasons || []).slice(0, 3).join("; ") || "intercept tooling detected";
    const err = new Error(
      `Security lock: network capture / MITM tooling detected — all tasks blocked. ${detail}`,
    );
    err.code = "VANTA_INTEGRITY_BLOCK";
    err.reasons = s.reasons;
    throw err;
  }
  return s;
}

function integrityGateResult() {
  try {
    assertIntegrityClear();
    return { ok: true };
  } catch (e) {
    return {
      ok: false,
      error: e?.message || String(e),
      code: e?.code || "VANTA_INTEGRITY_BLOCK",
      reasons: e?.reasons || lastScan.reasons || [],
    };
  }
}

module.exports = {
  scanIntegrity,
  getIntegrityStatus,
  assertIntegrityClear,
  integrityGateResult,
  SUSPICIOUS_PROCESS_PATTERNS,
  SUSPICIOUS_PROXY_PORTS,
};
