// Standalone JA3/JA4/H2 fingerprint check.
// Usage: node executor/fingerprint-check.js [proxyUrl]
//
// Hits tls.peet.ws/api/all through the same node-tls-client Session config
// used by the Kmart adapter, and prints the observed JA3/JA4/H2 values.

import { checkFingerprint } from "./health.js";

const PROXY = process.argv[2] || process.env.PROXY_URL || undefined;

async function main() {
  console.log("=== JA3/JA4/H2 Fingerprint Check ===");
  console.log("Proxy:", PROXY || "(direct)");
  console.log();

  const result = await checkFingerprint(PROXY || null);
  if (!result.ok) {
    console.error("FAIL:", result.error);
    process.exit(1);
  }

  console.log("--- OBSERVED (what we're sending) ---");
  console.log(JSON.stringify(result.observed, null, 2));
  console.log();
  console.log("--- REFERENCE Chrome 133 macOS ---");
  console.log(JSON.stringify(result.reference, null, 2));
  console.log();
  console.log("--- MATCH ---");
  console.log("JA3 hash match:   ", result.match.ja3_hash);
  console.log("JA4 match:        ", result.match.ja4);
  console.log("Akamai H2 match:  ", result.match.akamai_h2);
  console.log("All match:        ", result.allMatch);
  console.log(`elapsed=${result.elapsedMs}ms`);
}

main().catch((e) => { console.error("FAIL:", e); process.exit(1); });
