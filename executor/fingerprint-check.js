// Standalone JA3/JA4/H2 fingerprint check.
// Usage: node executor/fingerprint-check.js [proxyUrl]
//
// Hits tls.peet.ws/api/all (Peet's fingerprint reflector) through the same
// node-tls-client Session config used by the Kmart adapter, and prints the
// raw JA3, JA3 hash, JA4, Akamai HTTP/2 fingerprint, and peetprint hash.

import { Session, ClientIdentifier, initTLS } from "node-tls-client";

const PROXY = process.argv[2] || process.env.PROXY_URL || undefined;

const HEADER_ORDER = [
  "host","connection","cache-control","sec-ch-ua","sec-ch-ua-mobile",
  "sec-ch-ua-platform","upgrade-insecure-requests","user-agent","accept",
  "sec-fetch-site","sec-fetch-mode","sec-fetch-user","sec-fetch-dest",
  "accept-encoding","accept-language","priority","cookie",
];

const HEADERS = {
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

// Known-good Chrome 133 (macOS) reference values from peet.ws community samples.
const CHROME_133_REF = {
  ja3_hash: "773906b0efdefa24a7f2b8eb6985bf37",
  ja4: "t13d1516h2_8daaf6152771_b1ff8ab2d16f",
  // Akamai H2 fingerprint for Chrome 124+: SETTINGS|WINDOW_UPDATE|PRIORITY|m,a,s,p
  akamai_h2: "1:65536;2:0;4:6291456;6:262144|15663105|0|m,a,s,p",
};

async function main() {
  console.log("=== JA3/JA4/H2 Fingerprint Check ===");
  console.log("node-tls-client:", (await import("node-tls-client/package.json", { with: { type: "json" } })).default.version);
  console.log("ClientIdentifier: chrome_133");
  console.log("Proxy:", PROXY || "(direct)");
  console.log();

  await initTLS();
  const session = new Session({
    clientIdentifier: ClientIdentifier.chrome_133,
    timeout: 30_000,
    headerOrder: HEADER_ORDER,
    ...(PROXY ? { proxy: PROXY } : {}),
  });

  try {
    const res = await session.get("https://tls.peet.ws/api/all", { headers: HEADERS });
    const body = await res.text();
    let data;
    try { data = JSON.parse(body); } catch { console.log("Non-JSON body:", body.slice(0, 500)); return; }

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

    console.log("--- OBSERVED (what we're sending) ---");
    console.log(JSON.stringify(observed, null, 2));
    console.log();
    console.log("--- REFERENCE Chrome 133 macOS ---");
    console.log(JSON.stringify(CHROME_133_REF, null, 2));
    console.log();
    console.log("--- MATCH ---");
    console.log("JA3 hash match:   ", observed.ja3_hash === CHROME_133_REF.ja3_hash);
    console.log("JA4 match:        ", observed.ja4 === CHROME_133_REF.ja4);
    console.log("Akamai H2 match:  ", observed.akamai_h2 === CHROME_133_REF.akamai_h2);
  } finally {
    try { await session.close(); } catch {}
  }
}

main().catch((e) => { console.error("FAIL:", e); process.exit(1); });
