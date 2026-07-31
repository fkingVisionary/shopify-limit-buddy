import assert from "node:assert/strict";
import { test } from "node:test";
import { normalizeMuteSku, parseMutedSkus, isSkuMuted, mutedSkusText } from "./muted-skus.mjs";

test("normalizeMuteSku uppercases and extracts product ids", () => {
  assert.equal(normalizeMuteSku("n2847890001"), "N2847890001");
  assert.equal(normalizeMuteSku("  NAI0815453AU  "), "NAI0815453AU");
});

test("parseMutedSkus dedupes and ignores comments", () => {
  assert.deepEqual(
    parseMutedSkus("N2847890001\nn2847890001\n# spam\nNAI0815453AU"),
    ["N2847890001", "NAI0815453AU"],
  );
});

test("isSkuMuted matches admin list", () => {
  const muted = parseMutedSkus("N2847890001");
  assert.equal(isSkuMuted(muted, "N2847890001"), true);
  assert.equal(isSkuMuted(muted, "n2847890001"), true);
  assert.equal(isSkuMuted(muted, "N9999999999"), false);
});

test("mutedSkusText round-trips", () => {
  assert.equal(mutedSkusText(["n2847890001", "NAI0815453AU"]), "N2847890001\nNAI0815453AU");
});
