import test from "node:test";
import assert from "node:assert/strict";
import {
  isBackendAreaItemNo,
  isFrontendProductCode,
  resolveAreaItemNoPublic,
} from "./bandai-nai.js";

test("backend / frontend classifiers", () => {
  assert.equal(isBackendAreaItemNo("NAI0868879AU"), true);
  assert.equal(isFrontendProductCode("N2542159011"), true);
  assert.equal(isFrontendProductCode("NAI0868879AU"), false);
});

test("resolveAreaItemNoPublic short-circuits backend PID", async () => {
  const r = await resolveAreaItemNoPublic({ productCode: "NAI0868879AU" });
  assert.equal(r.ok, true);
  assert.equal(r.areaItemNo, "NAI0868879AU");
  assert.equal(r.ms, 0);
});
