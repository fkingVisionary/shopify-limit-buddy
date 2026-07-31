// node --test desktop/monitor-mute.test.cjs
const { test } = require("node:test");
const assert = require("node:assert/strict");
const {
  normalizeMuteSku,
  isMonitorSkuMuted,
  setMutedSku,
  listMutedSkus,
  parseMutedSkusText,
} = require("./monitor-mute.cjs");

test("normalizeMuteSku uppercases product ids", () => {
  assert.equal(normalizeMuteSku("n2847890001"), "N2847890001");
  assert.equal(normalizeMuteSku("  NAI0815453AU "), "NAI0815453AU");
});

test("isMonitorSkuMuted matches list", () => {
  const settings = { monitorMutedSkus: ["N2847890001"] };
  assert.equal(isMonitorSkuMuted(settings, "N2847890001"), true);
  assert.equal(isMonitorSkuMuted(settings, "n2847890001"), true);
  assert.equal(isMonitorSkuMuted(settings, "N9999999999"), false);
});

test("setMutedSku add/remove", () => {
  let s = setMutedSku({}, "N1", true);
  assert.deepEqual(listMutedSkus(s), ["N1"]);
  s = setMutedSku(s, "N1", false);
  assert.deepEqual(listMutedSkus(s), []);
});

test("parseMutedSkusText ignores blanks and comments", () => {
  assert.deepEqual(
    parseMutedSkusText("N1\n# note\nN2 ; trailing"),
    ["N1", "N2"],
  );
});
