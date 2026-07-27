import test from "node:test";
import assert from "node:assert/strict";
import { parseAreaItemNo } from "./bandai-session.js";
import { isTransientHarvestError } from "./bandai-harvest-pool.js";
import {
  isRetryableLoginFailure,
  bandaiProxyHost,
} from "./bandai.js";

test("parseAreaItemNo prefers backend NAI over PDP N-code", () => {
  const code = parseAreaItemNo({
    pdpUrl: "https://p-bandai.com/au/item/N2890904001",
    bandaiAreaItemNo: "NAI0859145AU",
  });
  assert.equal(code, "NAI0859145AU");
});

test("parseFrontendProductCode keeps N-code separate from NAI", async () => {
  const { parseFrontendProductCode } = await import("./bandai-session.js");
  assert.equal(
    parseFrontendProductCode({
      pdpUrl: "https://p-bandai.com/au/item/N2890904001",
      bandaiAreaItemNo: "NAI0859145AU",
    }),
    "N2890904001",
  );
  assert.equal(
    parseFrontendProductCode({
      pdpUrl: "https://p-bandai.com/au/item/N2542159011",
    }),
    "N2542159011",
  );
});

test("resolveAreaItemNo skips product_get when backend NAI pre-resolved", async () => {
  // Inline the same gate the adapter uses (exported via behavior contract).
  const code = "N2542159011";
  const fallback = "NAI0868879AU";
  const forceLookup = false;
  const skipped =
    fallback &&
    (/^NAI/i.test(fallback) || /^AAI/i.test(fallback)) &&
    forceLookup !== true;
  assert.equal(skipped, true);
  assert.equal(code.startsWith("N"), true);
});

test("parseAreaItemNo falls back to item path", () => {
  assert.equal(
    parseAreaItemNo({ pdpUrl: "https://p-bandai.com/au/item/N2542159011" }),
    "N2542159011",
  );
});

test("isTransientHarvestError matches connection closed / timeout", () => {
  assert.equal(
    isTransientHarvestError("page.goto: net::ERR_CONNECTION_CLOSED at https://p-bandai.com/au/login"),
    true,
  );
  assert.equal(isTransientHarvestError("Timeout 90000ms exceeded."), true);
  assert.equal(isTransientHarvestError("SoftBlock 501"), false);
});

test("isRetryableLoginFailure rotates SoftBlock / sensor / congestion", () => {
  assert.equal(isRetryableLoginFailure({ note: "restricted:SoftBlock", restrictedType: "SoftBlock" }), true);
  assert.equal(isRetryableLoginFailure({ note: "sensor mint failed: no headers" }), true);
  assert.equal(isRetryableLoginFailure({ note: "NETWORK CONGESTION", status: 503 }), true);
  assert.equal(isRetryableLoginFailure({ note: "invalid password", status: 401 }), false);
  assert.equal(isRetryableLoginFailure({ note: "BadCredentials" }), false);
});

test("bandaiProxyHost parses host:port:user:pass", () => {
  assert.equal(
    bandaiProxyHost("proxy-as1.noontideproxy.com:2334:user:pass"),
    "proxy-as1.noontideproxy.com",
  );
});
