import test from "node:test";
import assert from "node:assert/strict";
import { parseAreaItemNo } from "./bandai-session.js";
import { isTransientHarvestError } from "./bandai-harvest-pool.js";

test("parseAreaItemNo prefers backend NAI over PDP N-code", () => {
  const code = parseAreaItemNo({
    pdpUrl: "https://p-bandai.com/au/item/N2890904001",
    bandaiAreaItemNo: "NAI0859145AU",
  });
  assert.equal(code, "NAI0859145AU");
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
