/**
 * Smoke: undici issuer path without GE UI.
 * Needs /tmp/bandai-ge-issuer-capture.json from a prior browser GE run.
 * Does NOT invent a fresh GUID/Forter — expects capture (stale session may 4xx).
 */
import fs from "node:fs";
import {
  extractGeCheckoutGuid,
  loadIssuerCapture,
  replayCapturedIssuerHttp,
} from "../adapters/bandai-ge-http.js";

const cap = loadIssuerCapture();
console.log(
  "capture",
  cap
    ? {
        url: String(cap.url || "").slice(0, 120),
        bodyBytes: String(cap.body || "").length,
        contentType: cap.contentType,
        at: cap.at,
        guid: extractGeCheckoutGuid(cap.url || ""),
      }
    : null,
);

if (!cap) {
  console.log(
    "NO_CAPTURE — run bandai-ge-once-lab / pool lab first so Pay writes /tmp/bandai-ge-issuer-capture.json",
  );
  console.log(
    JSON.stringify({
      ok: false,
      error: "no_capture",
      blockers: ["checkout_guid", "card_iframe_state", "forter", "fingerprintjs", "gem_boot"],
      next: "Keep browser GE for GEM boot; replay issuer via undici once tokens are HTTP-fresh",
    }),
  );
  process.exit(0);
}

if (process.env.BANDAI_GE_HTTP_POST !== "1") {
  console.log("Dry inspect only — set BANDAI_GE_HTTP_POST=1 to actually POST (may charge/decline).");
  process.exit(0);
}

const out = await replayCapturedIssuerHttp();
fs.writeFileSync("/tmp/bandai-ge-http-smoke-result.json", JSON.stringify(out, null, 2));
console.log("RESULT", JSON.stringify(out, null, 2));
process.exit(out.ok ? 0 : 1);
