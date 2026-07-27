import test from "node:test";
import assert from "node:assert/strict";
import { isRecoverableDatadomeFail } from "./pokemoncentre-edge.js";

test("isRecoverableDatadomeFail: view=captcha / deviceLink / non-JSON", () => {
  assert.equal(
    isRecoverableDatadomeFail({
      ok: false,
      kind: "interstitial_escalated",
      view: "captcha",
      note: "interstitial returned view=captcha",
    }),
    true,
  );
  assert.equal(
    isRecoverableDatadomeFail({
      ok: false,
      kind: "interstitial",
      note: "DataDome interstitial deviceLink missing",
    }),
    true,
  );
  assert.equal(
    isRecoverableDatadomeFail({
      ok: false,
      kind: "interstitial",
      note: "interstitial POST non-JSON 0",
    }),
    true,
  );
});

test("isRecoverableDatadomeFail: hard ban and success are not recoverable", () => {
  assert.equal(
    isRecoverableDatadomeFail({
      ok: false,
      isIpBanned: true,
      note: "DataDome slider t=bv — hard IP block",
    }),
    false,
  );
  assert.equal(
    isRecoverableDatadomeFail({
      ok: true,
      note: "datadome interstitial view=redirect",
    }),
    false,
  );
  assert.equal(isRecoverableDatadomeFail(null), false);
});
